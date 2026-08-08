/**
 * The Asana HTTP client.
 *
 * Hand-written rather than using the generated `asana` npm package, because
 * the behaviour under review here *is* the transport: pagination, throttling,
 * retry classification, deprecation capture and error normalization. A
 * generated client hides exactly those decisions.
 *
 * Responsibilities:
 *   - authenticate every request (token resolved per-call, so OAuth refresh works)
 *   - pace requests under Asana's rate limits before sending
 *   - bound concurrency
 *   - enforce a timeout
 *   - retry ONLY what is provably safe to retry
 *   - unwrap Asana's `{ data, next_page }` envelope
 *   - convert every failure into a ConnectorError
 *
 * It does not know what an "action" is. That separation is what lets all five
 * actions share one execution path.
 */

import { z } from 'zod';
import type { AsanaApiConfig } from './config.js';
import { ERROR_CODES } from './errors/codes.js';
import { ConnectorError } from './errors/ConnectorError.js';
import { normalizeHttpError, normalizeThrown, normalizeZodError } from './errors/normalize.js';
import type { Deprecation, RateLimitMeta } from './schemas/common.js';
import { Semaphore, TokenBucket, backoffDelay, defaultSleep, type SleepFn } from './runtime/throttle.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Resolves the bearer token for a request. Async so OAuth can refresh first. */
export type TokenProvider = () => Promise<string>;

export interface AsanaClientDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: SleepFn;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface RequestOptions<T extends z.ZodTypeAny> {
  readonly method: HttpMethod;
  /** Path relative to the API base, e.g. `/projects` or `/tasks/123`. */
  readonly path: string;
  /** Schema for the contents of Asana's `data` field. */
  readonly schema: T;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  readonly body?: unknown;
  /**
   * Whether repeating this exact request is safe.
   *
   * This is the single most important flag in the client. When false, the
   * client will not retry under ANY circumstance — not on 429, not on 500, not
   * on timeout — because the request may already have taken effect and a retry
   * would create a duplicate task or comment.
   */
  readonly idempotent: boolean;
  readonly actionId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AsanaResult<T> {
  readonly data: T;
  /** Cursor for the next page, or null when the result set is complete. */
  readonly nextOffset: string | null;
  readonly attempts: number;
  readonly httpStatus: number;
  readonly deprecations: readonly Deprecation[];
  readonly throttledMs: number;
  readonly durationMs: number;
}

/** Runtime counters, surfaced on the Health page. */
export interface ClientStats {
  readonly totalRequests: number;
  readonly totalRetries: number;
  readonly rateLimitHits: number;
  readonly inFlight: number;
}

const MAX_ATTEMPTS_IDEMPOTENT = 3;

/** Statuses worth retrying when — and only when — the request is idempotent. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export class AsanaClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly bucket: TokenBucket;
  private readonly semaphore: Semaphore;

  private totalRequests = 0;
  private totalRetries = 0;
  private rateLimitHits = 0;

  constructor(
    private readonly config: AsanaApiConfig,
    private readonly getToken: TokenProvider,
    deps: AsanaClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.bucket = new TokenBucket(config.rateLimitRpm, this.sleep, this.now);
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  get stats(): ClientStats {
    return {
      totalRequests: this.totalRequests,
      totalRetries: this.totalRetries,
      rateLimitHits: this.rateLimitHits,
      inFlight: this.semaphore.inFlight,
    };
  }

  get rateLimit(): RateLimitMeta {
    return {
      limitRpm: this.bucket.limitRpm,
      remaining: this.bucket.remaining,
      throttledMs: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Public request                                                      */
  /* ------------------------------------------------------------------ */

  async request<T extends z.ZodTypeAny>(options: RequestOptions<T>): Promise<AsanaResult<z.infer<T>>> {
    const started = this.now();
    const maxAttempts = options.idempotent ? MAX_ATTEMPTS_IDEMPOTENT : 1;

    let throttledMs = 0;
    let lastError: ConnectorError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Pace before sending: rejected requests still consume Asana quota.
      throttledMs += await this.bucket.acquire();

      const release = await this.semaphore.acquire();
      try {
        const outcome = await this.attempt(options, attempt);

        if (outcome.kind === 'success') {
          return {
            data: outcome.data as z.infer<T>,
            nextOffset: outcome.nextOffset,
            attempts: attempt,
            httpStatus: outcome.status,
            deprecations: outcome.deprecations,
            throttledMs,
            durationMs: this.now() - started,
          };
        }

        lastError = outcome.error;

        if (!this.shouldRetry(outcome, options, attempt, maxAttempts)) {
          throw outcome.error;
        }
      } finally {
        release();
      }

      // Retrying: honour Asana's Retry-After when present, otherwise back off.
      this.totalRetries += 1;
      const explicitDelay = lastError?.retryAfterMs;
      const delay =
        explicitDelay !== null && explicitDelay !== undefined
          ? explicitDelay
          : backoffDelay(attempt, { random: this.random });
      await this.sleep(delay);
    }

    throw lastError ?? new ConnectorError(ERROR_CODES.UNKNOWN_ERROR, { requestId: options.requestId });
  }

  private shouldRetry<T extends z.ZodTypeAny>(
    outcome: FailureOutcome,
    options: RequestOptions<T>,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    // The rule that prevents duplicate tasks and comments.
    if (!options.idempotent) return false;
    if (attempt >= maxAttempts) return false;
    if (options.signal?.aborted === true) return false;

    if (outcome.status !== undefined) {
      return RETRYABLE_STATUSES.has(outcome.status);
    }

    // Transport faults: retry timeouts and network errors, nothing else.
    return (
      outcome.error.code === ERROR_CODES.TIMEOUT || outcome.error.code === ERROR_CODES.NETWORK_ERROR
    );
  }

  /* ------------------------------------------------------------------ */
  /* Single attempt                                                      */
  /* ------------------------------------------------------------------ */

  private async attempt<T extends z.ZodTypeAny>(
    options: RequestOptions<T>,
    attempt: number,
  ): Promise<SuccessOutcome | FailureOutcome> {
    const url = this.buildUrl(options.path, options.query);
    const ctx = {
      action: options.actionId,
      requestId: options.requestId,
      idempotent: options.idempotent,
    };

    this.totalRequests += 1;

    // Our own timeout, composed with any caller-supplied cancellation.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.config.timeoutMs);
    const signal =
      options.signal !== undefined
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;

    let response: Response;
    try {
      const token = await this.getToken();

      response = await this.fetchImpl(url, {
        method: options.method,
        headers: this.buildHeaders(token, options.body !== undefined),
        body: options.body === undefined ? null : JSON.stringify({ data: options.body }),
        signal,
      });
    } catch (thrown) {
      // A caller-initiated abort is a cancellation, not a provider failure.
      if (options.signal?.aborted === true) {
        return { kind: 'failure', error: normalizeThrown(thrown, ctx), status: undefined, attempt };
      }
      return { kind: 'failure', error: normalizeThrown(thrown, ctx), status: undefined, attempt };
    } finally {
      clearTimeout(timeoutId);
    }

    const deprecations = parseDeprecations(response.headers);
    const rawBody = await readBody(response);

    if (!response.ok) {
      if (response.status === 429) this.rateLimitHits += 1;

      return {
        kind: 'failure',
        error: normalizeHttpError(
          {
            status: response.status,
            body: rawBody,
            retryAfter: response.headers.get('retry-after'),
          },
          ctx,
        ),
        status: response.status,
        attempt,
      };
    }

    // Unwrap Asana's envelope.
    const envelope = envelopeSchema.safeParse(rawBody);
    if (!envelope.success) {
      throw new ConnectorError(ERROR_CODES.INVALID_RESPONSE, {
        message: 'Asana returned a response without the expected "data" envelope.',
        action: options.actionId,
        requestId: options.requestId,
        httpStatus: response.status,
      });
    }

    const parsed = options.schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw normalizeZodError(
        parsed.error,
        { action: options.actionId, requestId: options.requestId },
        {
          code: ERROR_CODES.INVALID_RESPONSE,
          message: 'Asana returned data that does not match the expected shape.',
        },
      );
    }

    return {
      kind: 'success',
      data: parsed.data,
      nextOffset: envelope.data.next_page?.offset ?? null,
      status: response.status,
      deprecations,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private buildUrl(
    path: string,
    query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
  ): string {
    const url = new URL(`${this.config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private buildHeaders(token: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'doo-asana-connector/1.0.0',
    };
    if (hasBody) headers['content-type'] = 'application/json';
    return headers;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface SuccessOutcome {
  readonly kind: 'success';
  readonly data: unknown;
  readonly nextOffset: string | null;
  readonly status: number;
  readonly deprecations: readonly Deprecation[];
}

interface FailureOutcome {
  readonly kind: 'failure';
  readonly error: ConnectorError;
  readonly status: number | undefined;
  readonly attempt: number;
}

/**
 * Asana's response envelope.
 *
 * `next_page` is present only when `limit` was supplied, and is null on the
 * final page — so it is optional *and* nullable, not one or the other.
 */
const envelopeSchema = z.object({
  data: z.unknown(),
  next_page: z
    .object({
      offset: z.string(),
      path: z.string().optional(),
      uri: z.string().optional(),
    })
    .nullable()
    .optional(),
});

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Gateways return HTML for 502/503. Preserve it as text so the normalizer
    // can still classify by status instead of failing on the parse.
    return text;
  }
}

/**
 * Parse `Asana-Change` headers.
 *
 * Asana announces upcoming breaking changes here, with `affected=true` when
 * the current request is impacted. Surfacing these rather than discarding them
 * is the difference between finding out about a deprecation now and finding
 * out when it breaks in production.
 *
 * Format: `name=new_task_lists;info=https://asa.na/api-changes;affected=true`
 * The header may appear multiple times.
 */
export function parseDeprecations(headers: Headers): Deprecation[] {
  const raw = headers.get('asana-change');
  if (raw === null || raw.trim().length === 0) return [];

  // Multiple notices arrive comma-separated; each notice is semicolon-delimited.
  return raw
    .split(',')
    .map((notice) => notice.trim())
    .filter((notice) => notice.length > 0)
    .map((notice) => {
      const fields = new Map<string, string>();
      for (const part of notice.split(';')) {
        const [key, ...rest] = part.split('=');
        if (key === undefined) continue;
        fields.set(key.trim().toLowerCase(), rest.join('=').trim());
      }
      return {
        name: fields.get('name') ?? 'unknown',
        info: fields.get('info') ?? null,
        affected: fields.get('affected') === 'true',
      };
    })
    .filter((d) => d.name !== 'unknown' || d.info !== null);
}
