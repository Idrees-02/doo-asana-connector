/**
 * The single error type this connector throws and returns.
 *
 * Nothing else escapes the execution pipeline: transport faults, Asana error
 * bodies, schema violations and policy refusals are all converted into a
 * ConnectorError before they reach a caller. That is what makes the error
 * contract in the manifest and OpenAPI spec actually true.
 *
 * A ConnectorError is safe to serialize by construction — it carries no
 * stack trace into `toJSON()`, and every string it holds has been redacted.
 */

import {
  ERROR_CODE_META,
  ERROR_CODES,
  type ErrorCode,
  type ErrorSeverity,
  type RetryStrategy,
} from './codes.js';
import { redactString, redactValue } from '../runtime/redact.js';

/** A field-level problem, used to drive inline form validation in the console. */
export interface ErrorDetail {
  /** Dotted path to the offending input field, e.g. `patch.dueOn`. */
  readonly field?: string | undefined;
  readonly message: string;
  /** Machine-readable reason, e.g. `too_small`, `invalid_type`. */
  readonly reason?: string | undefined;
}

/** The wire shape. This is exactly what an API or MCP caller receives. */
export interface ConnectorErrorJson {
  readonly code: ErrorCode;
  readonly message: string;
  readonly provider: 'asana';
  readonly action: string | null;
  readonly requestId: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryAfterMs: number | null;
  readonly severity: ErrorSeverity;
  /** What the user should do next, in plain language. */
  readonly guidance: string;
  readonly details: readonly ErrorDetail[];
  /** Asana's diagnostic phrase, present on 500s. Quote it to Asana support. */
  readonly providerPhrase: string | null;
  readonly occurredAt: string;
}

export interface ConnectorErrorOptions {
  readonly message?: string | undefined;
  readonly action?: string | undefined;
  readonly requestId?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly retryStrategy?: RetryStrategy | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly details?: readonly ErrorDetail[] | undefined;
  readonly providerPhrase?: string | undefined;
  readonly guidance?: string | undefined;
  readonly severity?: ErrorSeverity | undefined;
  /** Original throwable, kept for server-side debug logs only. Never serialized. */
  readonly cause?: unknown;
}

export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly provider = 'asana' as const;
  readonly action: string | null;
  readonly requestId: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryAfterMs: number | null;
  readonly severity: ErrorSeverity;
  readonly guidance: string;
  readonly details: readonly ErrorDetail[];
  readonly providerPhrase: string | null;
  readonly occurredAt: string;

  constructor(code: ErrorCode, options: ConnectorErrorOptions = {}) {
    const meta = ERROR_CODE_META[code];
    const message = redactString(options.message ?? defaultMessageFor(code));

    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = 'ConnectorError';
    this.code = code;
    this.action = options.action ?? null;
    this.requestId = options.requestId ?? 'req_unassigned';
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = options.retryable ?? meta.retryable;
    this.retryStrategy = options.retryStrategy ?? meta.retryStrategy;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.severity = options.severity ?? meta.severity;
    this.guidance = options.guidance ?? meta.guidance;
    this.providerPhrase = options.providerPhrase ?? null;
    this.occurredAt = new Date().toISOString();

    this.details = (options.details ?? []).map((d) => ({
      field: d.field,
      message: redactString(d.message),
      reason: d.reason,
    }));

    // Keep the constructor out of the captured stack for cleaner debug output.
    if (Error.captureStackTrace) Error.captureStackTrace(this, ConnectorError);
  }

  /**
   * The client-safe representation.
   *
   * Note what is absent: no stack trace, no `cause`, no request headers, no
   * token. The brief forbids leaking those to normal users, and the only way
   * to guarantee it is for the serializer to have no access to them at all.
   */
  toJSON(): ConnectorErrorJson {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      action: this.action,
      requestId: this.requestId,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      retryStrategy: this.retryStrategy,
      retryAfterMs: this.retryAfterMs,
      severity: this.severity,
      guidance: this.guidance,
      details: this.details,
      providerPhrase: this.providerPhrase,
      occurredAt: this.occurredAt,
    };
  }

  /** Debug view for server-side logs only. Never returned over the wire. */
  toDebugJSON(): Record<string, unknown> {
    return {
      ...this.toJSON(),
      stack: this.stack,
      cause: this.cause === undefined ? undefined : redactValue(this.cause),
    };
  }

  /** Return a copy carrying request context that was not known at throw time. */
  withContext(context: { action?: string | undefined; requestId?: string | undefined }): ConnectorError {
    if (
      (context.action === undefined || context.action === this.action) &&
      (context.requestId === undefined || context.requestId === this.requestId)
    ) {
      return this;
    }

    return new ConnectorError(this.code, {
      message: this.message,
      action: context.action ?? this.action ?? undefined,
      requestId: context.requestId ?? this.requestId,
      httpStatus: this.httpStatus ?? undefined,
      retryable: this.retryable,
      retryStrategy: this.retryStrategy,
      retryAfterMs: this.retryAfterMs ?? undefined,
      details: this.details,
      providerPhrase: this.providerPhrase ?? undefined,
      guidance: this.guidance,
      severity: this.severity,
      cause: this.cause,
    });
  }

  static isConnectorError(value: unknown): value is ConnectorError {
    return value instanceof ConnectorError;
  }
}

function defaultMessageFor(code: ErrorCode): string {
  switch (code) {
    case ERROR_CODES.VALIDATION_ERROR:
      return 'The request input failed validation.';
    case ERROR_CODES.BAD_REQUEST:
      return 'Asana rejected the request as malformed.';
    case ERROR_CODES.AUTHENTICATION_ERROR:
      return 'Asana authentication is invalid or expired.';
    case ERROR_CODES.PAYMENT_REQUIRED:
      return 'This Asana feature requires a paid plan.';
    case ERROR_CODES.PERMISSION_DENIED:
      return 'The authenticated Asana account does not have access to this resource.';
    case ERROR_CODES.NOT_FOUND:
      return 'The requested Asana resource was not found.';
    case ERROR_CODES.CONFLICT:
      return 'The task was modified after it was loaded.';
    case ERROR_CODES.UNAVAILABLE_LEGAL:
      return 'Asana blocked this request for legal reasons.';
    case ERROR_CODES.RATE_LIMITED:
      return 'Asana rate limit exceeded.';
    case ERROR_CODES.SERVER_ERROR:
      return 'Asana encountered an internal error.';
    case ERROR_CODES.BAD_GATEWAY:
      return 'Asana returned a bad gateway response.';
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return 'Asana is temporarily unavailable.';
    case ERROR_CODES.TIMEOUT:
      return 'The request to Asana timed out.';
    case ERROR_CODES.NETWORK_ERROR:
      return 'Could not reach the Asana API.';
    case ERROR_CODES.APPROVAL_REQUIRED:
      return 'This action modifies Asana data and requires explicit approval.';
    case ERROR_CODES.UNKNOWN_ACTION:
      return 'No such connector action.';
    case ERROR_CODES.INVALID_RESPONSE:
      return 'Asana returned an unexpected response shape.';
    case ERROR_CODES.UNKNOWN_ERROR:
      return 'An unexpected error occurred.';
    default:
      return 'An unexpected error occurred.';
  }
}
