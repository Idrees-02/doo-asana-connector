/**
 * Error normalization.
 *
 * Converts every kind of failure into a ConnectorError:
 *   - Asana HTTP error responses      -> normalizeHttpError
 *   - transport faults (DNS/TLS/abort) -> normalizeThrown
 *   - schema violations               -> normalizeZodError
 *
 * The safety-critical rule lives here, in `applyWriteSafety`: a failure on a
 * NON-IDEMPOTENT write is never reported as automatically retryable, even when
 * the underlying status (429, 500, timeout) normally would be. A timed-out
 * `POST /tasks` may already have created the task; retrying it produces a
 * duplicate. The connector refuses to make that call on the user's behalf and
 * hands the decision back with `manual_with_idempotency_key`.
 */

import { z } from 'zod';
import {
  ERROR_CODES,
  codeForHttpStatus,
  type ErrorCode,
} from './codes.js';
import { ConnectorError, type ErrorDetail } from './ConnectorError.js';

export interface NormalizeContext {
  readonly action?: string | undefined;
  readonly requestId?: string | undefined;
  /**
   * Whether repeating the failed request is safe.
   *
   * true  — GET, or PUT with a fixed body (same request => same end state).
   * false — POST /tasks, POST /stories. Repeating may duplicate data.
   */
  readonly idempotent: boolean;
}

/* -------------------------------------------------------------------------- */
/* Asana error bodies                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Asana's documented error envelope.
 *
 * Everything is optional because an error body is exactly the situation where
 * a provider is least likely to honour its own schema — a 502 from a load
 * balancer arrives as HTML, not JSON. Parsing must never throw here, or the
 * real error gets replaced by a parse error.
 */
const asanaErrorBodySchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        phrase: z.string().optional(),
        help: z.string().optional(),
      }),
    )
    .optional(),
});

interface ParsedAsanaError {
  readonly message: string | undefined;
  readonly phrase: string | undefined;
  readonly details: readonly ErrorDetail[];
}

function parseAsanaErrorBody(body: unknown): ParsedAsanaError {
  const parsed = asanaErrorBodySchema.safeParse(body);
  if (!parsed.success || parsed.data.errors === undefined || parsed.data.errors.length === 0) {
    return { message: undefined, phrase: undefined, details: [] };
  }

  const errors = parsed.data.errors;
  const first = errors[0];

  // Asana encodes field problems as "workspace: Missing input". Split that so
  // the console can highlight the offending input instead of showing prose.
  const details: ErrorDetail[] = errors
    .filter((e): e is { message: string } => typeof e.message === 'string')
    .map((e) => {
      const match = /^([a-z_][a-z0-9_.]*):\s*(.+)$/i.exec(e.message);
      return match !== null && match[1] !== undefined && match[2] !== undefined
        ? { field: match[1], message: match[2] }
        : { message: e.message };
    });

  return {
    message: first?.message,
    phrase: errors.find((e) => typeof e.phrase === 'string')?.phrase,
    details,
  };
}

/* -------------------------------------------------------------------------- */
/* Retry-After                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a `Retry-After` header, which may be seconds or an HTTP date.
 *
 * Asana's docs are explicit that rejected requests still count against the
 * quota, so honouring this value rather than guessing a backoff genuinely
 * matters — retrying early makes the situation worse, not better.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - now);
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Write safety                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Downgrade retry advice for non-idempotent operations.
 *
 * This is the one place the connector decides whether an automatic retry is
 * permitted, and it deliberately refuses for writes whose outcome is unknown.
 */
function applyWriteSafety(
  error: ConnectorError,
  idempotent: boolean,
): ConnectorError {
  if (idempotent || !error.retryable) return error;

  return new ConnectorError(error.code, {
    message: error.message,
    action: error.action ?? undefined,
    requestId: error.requestId,
    httpStatus: error.httpStatus ?? undefined,
    // Not automatically retryable: the request may already have taken effect.
    retryable: false,
    retryStrategy: 'manual_with_idempotency_key',
    retryAfterMs: error.retryAfterMs ?? undefined,
    details: error.details,
    providerPhrase: error.providerPhrase ?? undefined,
    severity: error.severity,
    guidance:
      'This write may or may not have been applied in Asana. Do not blindly retry: check whether it took effect, ' +
      'then re-submit with an idempotency key if it did not.',
    cause: error.cause,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

export interface HttpErrorInput {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: string | null | undefined;
  /** Asana's own diagnostic phrase, if it was surfaced in a header. */
  readonly statusText?: string | undefined;
}

/** Convert a non-2xx Asana response into a ConnectorError. */
export function normalizeHttpError(input: HttpErrorInput, ctx: NormalizeContext): ConnectorError {
  const code = codeForHttpStatus(input.status);
  const { message, phrase, details } = parseAsanaErrorBody(input.body);
  const retryAfterMs = parseRetryAfter(input.retryAfter);

  const error = new ConnectorError(code, {
    message: buildMessage(code, message, input.status),
    action: ctx.action,
    requestId: ctx.requestId,
    httpStatus: input.status,
    retryAfterMs,
    details,
    providerPhrase: phrase,
  });

  return applyWriteSafety(error, ctx.idempotent);
}

/**
 * Prefer Asana's own wording when it is informative, since it names the actual
 * field or object. Fall back to our generic message when it is empty or noise.
 */
function buildMessage(code: ErrorCode, providerMessage: string | undefined, status: number): string | undefined {
  if (providerMessage === undefined || providerMessage.trim().length === 0) return undefined;

  // Asana echoes plain status text for some gateway errors; that adds nothing.
  const noise = /^(bad gateway|service unavailable|internal server error|not found|forbidden)$/i;
  if (noise.test(providerMessage.trim())) return undefined;

  if (code === ERROR_CODES.RATE_LIMITED) {
    return `Asana rate limit exceeded: ${providerMessage}`;
  }
  if (status >= 500) {
    return `Asana server error: ${providerMessage}`;
  }
  return providerMessage;
}

/** Convert a thrown transport-level failure into a ConnectorError. */
export function normalizeThrown(thrown: unknown, ctx: NormalizeContext): ConnectorError {
  // Already normalized — just attach whatever context we now have.
  if (ConnectorError.isConnectorError(thrown)) {
    return thrown.withContext({ action: ctx.action, requestId: ctx.requestId });
  }

  if (thrown instanceof z.ZodError) {
    return normalizeZodError(thrown, ctx);
  }

  const code = classifyThrown(thrown);
  const error = new ConnectorError(code, {
    message: code === ERROR_CODES.TIMEOUT ? 'The request to Asana timed out.' : undefined,
    action: ctx.action,
    requestId: ctx.requestId,
    cause: thrown,
  });

  return applyWriteSafety(error, ctx.idempotent);
}

function classifyThrown(thrown: unknown): ErrorCode {
  if (!(thrown instanceof Error)) return ERROR_CODES.UNKNOWN_ERROR;

  // fetch + AbortController surfaces our own timeout as an AbortError.
  if (thrown.name === 'AbortError' || thrown.name === 'TimeoutError') {
    return ERROR_CODES.TIMEOUT;
  }

  // Node's fetch wraps socket/DNS/TLS failures in a TypeError with a cause.
  const cause = (thrown as { cause?: unknown }).cause;
  const causeCode =
    cause !== null && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : undefined;

  if (causeCode !== undefined) {
    if (['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT'].includes(causeCode)) {
      return ERROR_CODES.TIMEOUT;
    }
    if (
      ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(
        causeCode,
      )
    ) {
      return ERROR_CODES.NETWORK_ERROR;
    }
  }

  if (thrown instanceof TypeError && /fetch failed|network|socket/i.test(thrown.message)) {
    return ERROR_CODES.NETWORK_ERROR;
  }

  return ERROR_CODES.UNKNOWN_ERROR;
}

/** Convert a Zod validation failure into a ConnectorError with field details. */
export function normalizeZodError(
  error: z.ZodError,
  ctx: Pick<NormalizeContext, 'action' | 'requestId'>,
  options: { readonly code?: ErrorCode; readonly message?: string } = {},
): ConnectorError {
  const details: ErrorDetail[] = error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : undefined,
    message: issue.message,
    reason: issue.code,
  }));

  const summary =
    details.length === 1 && details[0] !== undefined
      ? details[0].field !== undefined
        ? `Invalid value for "${details[0].field}": ${details[0].message}`
        : details[0].message
      : `Input validation failed for ${details.length} fields.`;

  return new ConnectorError(options.code ?? ERROR_CODES.VALIDATION_ERROR, {
    message: options.message ?? summary,
    action: ctx.action,
    requestId: ctx.requestId,
    details,
    // Validation runs before any network call, so nothing can have happened
    // in Asana yet — this is always safe to report as a pure client error.
    httpStatus: 400,
  });
}
