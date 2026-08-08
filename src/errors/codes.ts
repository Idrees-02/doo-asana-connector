/**
 * Normalized error codes.
 *
 * Every failure surfaced by this connector — validation, transport, provider,
 * or policy — is reduced to exactly one of these codes. Callers (the console,
 * the MCP adapter, an LLM agent) can branch on a stable string instead of
 * pattern-matching Asana's prose, which changes without notice.
 */

export const ERROR_CODES = {
  /** Input failed schema validation before any network call was made. */
  VALIDATION_ERROR: 'ASANA_VALIDATION_ERROR',
  /** Asana rejected the request as malformed (HTTP 400). */
  BAD_REQUEST: 'ASANA_BAD_REQUEST',
  /** Token missing, invalid, expired, or the app is disabled (HTTP 401). */
  AUTHENTICATION_ERROR: 'ASANA_AUTHENTICATION_ERROR',
  /** The feature requires a paid Asana plan (HTTP 402). */
  PAYMENT_REQUIRED: 'ASANA_PAYMENT_REQUIRED',
  /** Authenticated, but not permitted to touch this object (HTTP 403). */
  PERMISSION_DENIED: 'ASANA_PERMISSION_DENIED',
  /** No such object, or it is invisible to this token (HTTP 404). */
  NOT_FOUND: 'ASANA_NOT_FOUND',
  /**
   * Optimistic-concurrency failure. Connector-generated: raised by the
   * stale-write guard in `asana.update_task` when the task changed after the
   * caller read it. Asana itself does not return 409 for tasks.
   */
  CONFLICT: 'ASANA_CONFLICT',
  /** Blocked for legal reasons, e.g. an embargoed IP (HTTP 451). */
  UNAVAILABLE_LEGAL: 'ASANA_UNAVAILABLE_LEGAL',
  /** Rate limit exceeded (HTTP 429). Carries `retryAfterMs`. */
  RATE_LIMITED: 'ASANA_RATE_LIMITED',
  /** Asana server fault (HTTP 500). Carries Asana's diagnostic `phrase`. */
  SERVER_ERROR: 'ASANA_SERVER_ERROR',
  /** Upstream gateway fault (HTTP 502). */
  BAD_GATEWAY: 'ASANA_BAD_GATEWAY',
  /** Asana temporarily unavailable (HTTP 503/504). */
  SERVICE_UNAVAILABLE: 'ASANA_SERVICE_UNAVAILABLE',
  /** Our own timeout elapsed before Asana responded. */
  TIMEOUT: 'ASANA_TIMEOUT',
  /** DNS, TLS, socket, or offline failure — no HTTP response at all. */
  NETWORK_ERROR: 'ASANA_NETWORK_ERROR',
  /** A write action was invoked without the required approval flag. */
  APPROVAL_REQUIRED: 'ASANA_APPROVAL_REQUIRED',
  /** No action is registered under the requested id. */
  UNKNOWN_ACTION: 'ASANA_UNKNOWN_ACTION',
  /** Asana returned a body that does not match its documented shape. */
  INVALID_RESPONSE: 'ASANA_INVALID_RESPONSE',
  /** Anything genuinely unclassified. Should be rare; investigate if seen. */
  UNKNOWN_ERROR: 'ASANA_UNKNOWN_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.values(ERROR_CODES);

/**
 * How a caller should respond to a failure.
 *
 * This is the connector's most safety-critical piece of metadata. `retryable`
 * alone is not enough: a create-task call that times out may well have
 * succeeded, and blindly retrying it produces a duplicate task. The strategy
 * says what to actually do.
 */
export type RetryStrategy =
  /** Do not retry. The outcome will not change. */
  | 'none'
  /** Safe to retry immediately — the operation has no side effects. */
  | 'immediate'
  /** Retry with exponential backoff and jitter. */
  | 'backoff'
  /** Wait for the duration Asana specified (`retryAfterMs`), then retry. */
  | 'after_delay'
  /**
   * The request may or may not have taken effect, and repeating it could
   * duplicate a task or comment. A human (or an agent with an idempotency
   * key) must decide. The connector will never do this automatically.
   */
  | 'manual_with_idempotency_key';

/** Severity, used by the console to choose presentation. */
export type ErrorSeverity = 'warning' | 'error';

interface ErrorCodeMeta {
  readonly retryable: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly severity: ErrorSeverity;
  /** Shown to the user as the suggested next step. */
  readonly guidance: string;
}

/**
 * Default classification per code.
 *
 * Note these are defaults for *read* operations. `normalizeError` downgrades
 * anything retryable to `manual_with_idempotency_key` when the failed request
 * was a non-idempotent write — see the retry policy in `client.ts`.
 */
export const ERROR_CODE_META: Readonly<Record<ErrorCode, ErrorCodeMeta>> = {
  [ERROR_CODES.VALIDATION_ERROR]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'Correct the highlighted fields and submit again.',
  },
  [ERROR_CODES.BAD_REQUEST]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'Asana rejected the request parameters. Check the field values and try again.',
  },
  [ERROR_CODES.AUTHENTICATION_ERROR]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance:
      'Re-authenticate. If you are using a Personal Access Token, generate a new one at app.asana.com/0/my-apps and update ASANA_ACCESS_TOKEN in .env.',
  },
  [ERROR_CODES.PAYMENT_REQUIRED]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'This feature requires a paid Asana plan. Retrying will not help.',
  },
  [ERROR_CODES.PERMISSION_DENIED]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance:
      'The authenticated account cannot access this object. Check that it is a member of the workspace and project.',
  },
  [ERROR_CODES.NOT_FOUND]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'Verify the id. The object may have been deleted, or may not be visible to this account.',
  },
  [ERROR_CODES.CONFLICT]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'warning',
    guidance: 'Someone else changed this task after you loaded it. Refresh to see their changes, then reapply yours.',
  },
  [ERROR_CODES.UNAVAILABLE_LEGAL]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'Asana blocked this request for legal or regional reasons.',
  },
  [ERROR_CODES.RATE_LIMITED]: {
    retryable: true,
    retryStrategy: 'after_delay',
    severity: 'warning',
    guidance:
      'Asana rate limit reached. Wait for the indicated interval before retrying — rejected requests still count against the quota.',
  },
  [ERROR_CODES.SERVER_ERROR]: {
    retryable: true,
    retryStrategy: 'backoff',
    severity: 'error',
    guidance: 'An Asana-side fault. Retry shortly; quote the diagnostic phrase if you contact Asana support.',
  },
  [ERROR_CODES.BAD_GATEWAY]: {
    retryable: true,
    retryStrategy: 'backoff',
    severity: 'error',
    guidance: 'Transient upstream fault. Retry shortly.',
  },
  [ERROR_CODES.SERVICE_UNAVAILABLE]: {
    retryable: true,
    retryStrategy: 'backoff',
    severity: 'error',
    guidance: 'Asana is temporarily unavailable. Retry shortly.',
  },
  [ERROR_CODES.TIMEOUT]: {
    retryable: true,
    retryStrategy: 'backoff',
    severity: 'error',
    guidance: 'The request exceeded the configured timeout. Retry, or raise ASANA_TIMEOUT_MS.',
  },
  [ERROR_CODES.NETWORK_ERROR]: {
    retryable: true,
    retryStrategy: 'backoff',
    severity: 'error',
    guidance: 'Could not reach Asana. Check network connectivity and retry.',
  },
  [ERROR_CODES.APPROVAL_REQUIRED]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'warning',
    guidance: 'This action changes data in Asana. Re-submit with approval to proceed.',
  },
  [ERROR_CODES.UNKNOWN_ACTION]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'Check the action id against the connector manifest.',
  },
  [ERROR_CODES.INVALID_RESPONSE]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance:
      'Asana returned an unexpected response shape. This usually means the API changed — check for an Asana-Change deprecation header.',
  },
  [ERROR_CODES.UNKNOWN_ERROR]: {
    retryable: false,
    retryStrategy: 'none',
    severity: 'error',
    guidance: 'An unclassified error occurred. Check the request id in the activity log for details.',
  },
};

/** Map an HTTP status to its normalized code. */
export function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.BAD_REQUEST;
    case 401:
      return ERROR_CODES.AUTHENTICATION_ERROR;
    case 402:
      return ERROR_CODES.PAYMENT_REQUIRED;
    case 403:
      return ERROR_CODES.PERMISSION_DENIED;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    case 451:
      return ERROR_CODES.UNAVAILABLE_LEGAL;
    case 502:
      return ERROR_CODES.BAD_GATEWAY;
    case 503:
    case 504:
      return ERROR_CODES.SERVICE_UNAVAILABLE;
    default:
      break;
  }

  if (status >= 500) return ERROR_CODES.SERVER_ERROR;
  if (status >= 400) return ERROR_CODES.BAD_REQUEST;
  return ERROR_CODES.UNKNOWN_ERROR;
}
