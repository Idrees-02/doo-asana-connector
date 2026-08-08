/**
 * The shared execution pipeline.
 *
 * Every action invocation — from the HTTP API, the MCP adapter, an example
 * script, or a test — passes through this one function. Actions never
 * authenticate, validate, log, time, gate on approval, or normalize errors
 * themselves; they receive an already-validated input and a ready client.
 *
 * The pipeline, in order:
 *
 *   1. resolve the action            -> ASANA_UNKNOWN_ACTION
 *   2. mint a request id             (Asana provides none)
 *   3. validate input                -> ASANA_VALIDATION_ERROR (before any network call)
 *   4. approval gate for writes      -> ASANA_APPROVAL_REQUIRED
 *   5. idempotency replay for writes
 *   6. run the action
 *   7. validate output               (strict in dev/test, warn in production)
 *   8. wrap in an envelope with meta
 *   9. normalize any failure
 *
 * Step 4 is placed before step 5 on purpose: an unapproved write must be
 * rejected outright, never recorded against an idempotency key.
 */

import type { AsanaClient } from '../client.js';
import type { AppConfig } from '../config.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError, type ConnectorErrorJson } from '../errors/ConnectorError.js';
import { normalizeThrown, normalizeZodError } from '../errors/normalize.js';
import { getAction, type AnyConnectorAction } from '../actions/index.js';
import type { ActionContext } from '../actions/types.js';
import type { ExecutionMeta } from '../schemas/common.js';
import { IdempotencyCache } from './idempotency.js';
import { generateRequestId } from './request-id.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface ConnectorExecutionRequest {
  readonly actionId: string;
  readonly input: unknown;
  /**
   * Explicit approval for a write action.
   *
   * Required rather than inferred, so that an agent enumerating the action
   * list cannot create tasks as a side effect of exploration.
   */
  readonly approved?: boolean | undefined;
  /** Deduplicates deliberate retries of a write. */
  readonly idempotencyKey?: string | undefined;
  readonly requestId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ConnectorExecutionSuccess<T = unknown> {
  readonly ok: true;
  readonly data: T;
  readonly meta: ExecutionMeta;
}

export interface ConnectorExecutionFailure {
  readonly ok: false;
  readonly error: ConnectorErrorJson;
  readonly meta: ExecutionMeta;
}

export type ConnectorExecutionResult<T = unknown> =
  | ConnectorExecutionSuccess<T>
  | ConnectorExecutionFailure;

export interface ExecutorDeps {
  readonly config: AppConfig;
  readonly client: AsanaClient;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly idempotencyCache?: IdempotencyCache<unknown>;
}

/* -------------------------------------------------------------------------- */
/* Executor                                                                    */
/* -------------------------------------------------------------------------- */

export class ActionExecutor {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idempotency: IdempotencyCache<unknown>;

  constructor(private readonly deps: ExecutorDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.idempotency = deps.idempotencyCache ?? new IdempotencyCache<unknown>();
  }

  async execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult> {
    const requestId = request.requestId ?? generateRequestId();
    const startedAtMs = this.now();
    const startedAt = new Date().toISOString();

    // Counters mutated by the action through recordUpstream, so the returned
    // meta reflects real upstream work rather than an assumption of one call.
    let upstreamCalls = 0;
    let attempts = 0;

    const recordUpstream = (calls: number, callAttempts: number): void => {
      upstreamCalls += calls;
      attempts = callAttempts;
    };

    const buildMeta = (): ExecutionMeta => ({
      requestId,
      actionId: request.actionId,
      provider: 'asana',
      mode: this.deps.config.mode,
      demoData: this.deps.config.mode === 'demo',
      startedAt,
      durationMs: this.now() - startedAtMs,
      upstreamCalls,
      attempts,
      rateLimit: {
        ...this.deps.client.rateLimit,
      },
      deprecations: [],
    });

    const logger = this.logger.child({ requestId, action: request.actionId });

    try {
      /* 1. Resolve ------------------------------------------------------- */
      const action = getAction(request.actionId);
      if (action === undefined) {
        throw new ConnectorError(ERROR_CODES.UNKNOWN_ACTION, {
          message: `No connector action with id "${request.actionId}".`,
          requestId,
          details: [{ field: 'actionId', message: 'Unknown action id.' }],
        });
      }

      /* 2. Validate input ------------------------------------------------ */
      const parsed = action.inputSchema.safeParse(request.input);
      if (!parsed.success) {
        throw normalizeZodError(parsed.error, { action: action.id, requestId });
      }
      const input = parsed.data;

      /* 3. Approval gate ------------------------------------------------- */
      if (action.safety.requiresApproval && request.approved !== true) {
        throw new ConnectorError(ERROR_CODES.APPROVAL_REQUIRED, {
          message: `"${action.name}" modifies data in Asana and requires explicit approval.`,
          requestId,
          action: action.id,
          guidance: `${action.safety.duplicateBehavior} Re-submit with approved: true to proceed.`,
        });
      }

      /* 4. Run (with idempotency replay for writes) ---------------------- */
      const context: ActionContext = {
        client: this.deps.client,
        config: this.deps.config,
        requestId,
        logger,
        signal: request.signal,
        recordUpstream,
      };

      logger.debug('Executing action', {
        write: action.safety.write,
        idempotencyKey: request.idempotencyKey !== undefined,
      });

      const output = await this.idempotency.run(
        // Only writes are deduplicated. Replaying a cached read would serve
        // stale data from a "refresh" the user explicitly asked for.
        action.safety.write ? scopedKey(action, request.idempotencyKey) : undefined,
        () => action.run(input, context),
      );

      /* 5. Validate output ----------------------------------------------- */
      const validated = this.validateOutput(action, output, requestId, logger);

      logger.info('Action succeeded', { durationMs: this.now() - startedAtMs });

      return { ok: true, data: validated, meta: buildMeta() };
    } catch (thrown) {
      const error = normalizeThrown(thrown, {
        action: request.actionId,
        requestId,
        // The action's own transport calls have already applied write safety;
        // treating this outer boundary as idempotent avoids double-downgrading
        // an error that is already correctly classified.
        idempotent: true,
      });

      // Full detail (including stack) to the server log; never to the caller.
      logger.warn('Action failed', {
        code: error.code,
        httpStatus: error.httpStatus,
        retryStrategy: error.retryStrategy,
      });
      logger.debug('Failure detail', error.toDebugJSON());

      return { ok: false, error: error.toJSON(), meta: buildMeta() };
    }
  }

  /**
   * Validate an action's output against its declared schema.
   *
   * Strict in development and tests, where a mismatch is a bug worth failing
   * on immediately. Lenient in production, where breaking a working user
   * request because Asana added a field would be a self-inflicted outage —
   * the discrepancy is logged instead.
   */
  private validateOutput(
    action: AnyConnectorAction,
    output: unknown,
    requestId: string,
    logger: Logger,
  ): unknown {
    const result = action.outputSchema.safeParse(output);

    if (result.success) return result.data;

    if (this.deps.config.isProduction) {
      logger.error('Action output failed its own schema — returning it unvalidated', {
        action: action.id,
        issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return output;
    }

    throw normalizeZodError(
      result.error,
      { action: action.id, requestId },
      {
        code: ERROR_CODES.INVALID_RESPONSE,
        message: `Action "${action.id}" produced output that does not match its declared schema.`,
      },
    );
  }
}

/**
 * Namespace idempotency keys per action.
 *
 * Without this, the same key reused across two different actions would replay
 * the wrong result — a create returning a comment, for instance.
 */
function scopedKey(action: AnyConnectorAction, key: string | undefined): string | undefined {
  return key === undefined ? undefined : `${action.id}:${key}`;
}
