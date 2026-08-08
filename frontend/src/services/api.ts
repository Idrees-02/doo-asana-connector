/**
 * The API service layer.
 *
 * Every network call the console makes goes through here. Two consequences
 * worth stating:
 *
 *   - No component ever calls `fetch` directly, so error handling, request
 *     cancellation and typing exist in one place rather than 12.
 *   - The console has no Asana credentials and no way to acquire them. It
 *     talks only to the connector API on the same origin, which attaches
 *     authentication server-side.
 */

import type {
  ActionSummary,
  ActivityEntry,
  ActivityMetrics,
  ConnectionTestResult,
  ConnectorErrorPayload,
  ConnectorManifest,
  ConnectorStatus,
  ExecutionEnvelope,
  HealthReport,
  SchemaBundle,
} from '@/types/api';

const BASE = '/api';

/**
 * A failed request, carrying the connector's normalized error.
 *
 * Components can rely on `payload.code`, `payload.guidance` and
 * `payload.details` rather than string-matching a message.
 */
export class ApiError extends Error {
  constructor(
    readonly payload: ConnectorErrorPayload,
    readonly httpStatus: number,
  ) {
    super(payload.message);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.payload.code;
  }
  get guidance(): string {
    return this.payload.guidance;
  }
  get retryable(): boolean {
    return this.payload.retryable;
  }
  /** True when a write may already have taken effect and must not be retried blindly. */
  get needsManualRetry(): boolean {
    return this.payload.retryStrategy === 'manual_with_idempotency_key';
  }
}

/** Fallback error for transport failures, where the server never responded. */
function transportError(message: string, guidance: string): ApiError {
  return new ApiError(
    {
      code: 'CONSOLE_NETWORK_ERROR',
      message,
      provider: 'asana',
      action: null,
      requestId: 'req_console',
      httpStatus: null,
      retryable: true,
      retryStrategy: 'backoff',
      severity: 'error',
      guidance,
      details: [],
      providerPhrase: null,
      occurredAt: new Date().toISOString(),
    },
    0,
  );
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Passed through from TanStack Query so navigating away cancels in-flight work. */
  readonly signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
  } catch (error) {
    // An aborted request is a cancellation, not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;

    throw transportError(
      'Could not reach the connector API.',
      'Check that the API is running on port 8787 (npm run dev starts both).',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as { error?: ConnectorErrorPayload } | null;
    if (envelope?.error !== undefined) {
      throw new ApiError(envelope.error, response.status);
    }
    throw transportError(
      `The API returned ${response.status}.`,
      'Check the API server logs for details.',
    );
  }

  return payload as T;
}

/* -------------------------------------------------------------------------- */
/* Connector                                                                   */
/* -------------------------------------------------------------------------- */

export const api = {
  getStatus: (signal?: AbortSignal) =>
    request<ConnectorStatus>('/connector/status', signal === undefined ? {} : { signal }),

  getManifest: (signal?: AbortSignal) =>
    request<ConnectorManifest>('/connector/manifest', signal === undefined ? {} : { signal }),

  getActions: (signal?: AbortSignal) =>
    request<{ actions: ActionSummary[] }>(
      '/connector/actions',
      signal === undefined ? {} : { signal },
    ),

  getSchema: (actionId: string, signal?: AbortSignal) =>
    request<SchemaBundle>(
      `/connector/schemas/${actionId}`,
      signal === undefined ? {} : { signal },
    ),

  testConnection: (signal?: AbortSignal) =>
    request<ConnectionTestResult>('/connector/test', {
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }),

  /**
   * Execute a connector action.
   *
   * `approved` is explicit rather than defaulted to true. A UI that silently
   * approved every write would defeat the connector's approval gate, which
   * exists precisely so writes cannot happen incidentally.
   */
  execute: <T>(
    actionId: string,
    input: unknown,
    options: { approved?: boolean; idempotencyKey?: string; signal?: AbortSignal } = {},
  ) =>
    request<ExecutionEnvelope<T>>(`/actions/${actionId}`, {
      method: 'POST',
      body: {
        input,
        ...(options.approved === undefined ? {} : { approved: options.approved }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  /* Operations ---------------------------------------------------------- */

  getActivity: (params: { limit?: number; actionId?: string; status?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.actionId !== undefined) query.set('actionId', params.actionId);
    if (params.status !== undefined) query.set('status', params.status);
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : '';

    return request<{ entries: ActivityEntry[] }>(
      `/activity${suffix}`,
      signal === undefined ? {} : { signal },
    );
  },

  getActivityEntry: (requestId: string, signal?: AbortSignal) =>
    request<ActivityEntry>(`/activity/${requestId}`, signal === undefined ? {} : { signal }),

  getMetrics: (signal?: AbortSignal) =>
    request<ActivityMetrics & { client: Record<string, number> }>(
      '/metrics',
      signal === undefined ? {} : { signal },
    ),

  getHealth: (signal?: AbortSignal) =>
    request<HealthReport>('/health', signal === undefined ? {} : { signal }),

  /* Demo controls — these endpoints exist only when the API is in demo mode. */

  setDemoFault: (fault: string) =>
    request<{ fault: string }>('/demo/fault', { method: 'POST', body: { fault } }),

  resetDemo: () => request<{ reset: boolean }>('/demo/reset', { method: 'POST' }),

  disconnect: () =>
    request<{ disconnected: boolean; note: string }>('/auth/disconnect', { method: 'POST' }),
};
