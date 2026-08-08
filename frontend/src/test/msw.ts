/**
 * Mock API for console tests.
 *
 * Returns the connector's real envelope shapes — including the normalized
 * error format with retry classification — so the components are tested
 * against the contract they actually consume rather than a convenient
 * simplification of it.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const mockProject = {
  id: '900000000001001',
  name: 'Product Launch',
  archived: false,
  color: 'light-orange',
  notes: '',
  url: 'https://app.asana.com/0/900000000001001',
  workspace: { id: '900000000000001', name: 'Demo Workspace' },
  owner: null,
  team: null,
  dueOn: null,
  createdAt: '2026-05-02T09:00:00.000Z',
  modifiedAt: '2026-08-01T14:30:00.000Z',
};

export const mockTask = {
  id: '900000000002001',
  name: 'Prepare launch documentation',
  notes: 'Write the README.',
  completed: false,
  completedAt: null,
  dueOn: '2026-08-20',
  dueAt: null,
  startOn: null,
  assignee: { id: '900000000000101', name: 'Idrees Khaled', email: 'idrees@example.invalid' },
  workspace: { id: '900000000000001', name: 'Demo Workspace' },
  parent: null,
  projects: [{ id: '900000000001001', name: 'Product Launch' }],
  tags: [],
  subtaskCount: 0,
  resourceSubtype: 'default_task',
  url: 'https://app.asana.com/0/900000000001001/900000000002001',
  createdAt: '2026-07-15T08:00:00.000Z',
  modifiedAt: '2026-08-06T16:45:00.000Z',
};

const meta = {
  requestId: 'req_test123',
  actionId: 'asana.list_projects',
  provider: 'asana',
  mode: 'demo',
  demoData: true,
  startedAt: '2026-08-08T12:00:00.000Z',
  durationMs: 42,
  upstreamCalls: 1,
  attempts: 1,
  deprecations: [],
};

export function successEnvelope(data: unknown, actionId = 'asana.list_projects') {
  return { ok: true, data, meta: { ...meta, actionId } };
}

/** Build a normalized error envelope matching the connector's real shape. */
export function errorEnvelope(
  code: string,
  overrides: Partial<{
    message: string;
    guidance: string;
    retryable: boolean;
    retryStrategy: string;
    httpStatus: number;
    details: Array<{ field?: string; message: string }>;
  }> = {},
) {
  return {
    ok: false,
    error: {
      code,
      message: overrides.message ?? 'Something failed.',
      provider: 'asana',
      action: 'asana.list_projects',
      requestId: 'req_test123',
      httpStatus: overrides.httpStatus ?? 500,
      retryable: overrides.retryable ?? false,
      retryStrategy: overrides.retryStrategy ?? 'none',
      retryAfterMs: null,
      severity: 'error',
      guidance: overrides.guidance ?? 'Try again.',
      details: overrides.details ?? [],
      providerPhrase: null,
      occurredAt: '2026-08-08T12:00:00.000Z',
    },
    meta,
  };
}

export const defaultHandlers = [
  http.get('/api/connector/status', () =>
    HttpResponse.json({
      connector: {
        name: 'asana-connector',
        displayName: 'Asana Connector',
        version: '1.0.0',
        provider: 'asana',
        builder: 'Idrees Khaled',
      },
      config: {
        mode: 'demo',
        modeReason: 'No Asana credentials found, so the connector started in demo mode.',
        nodeEnv: 'test',
        asana: {
          baseUrl: 'https://app.asana.com/api/1.0',
          rateLimitRpm: 140,
          timeoutMs: 15000,
          maxConcurrency: 8,
          defaultWorkspace: null,
        },
        auth: {
          patConfigured: false,
          oauthConfigured: false,
          oauthRedirectUri: null,
          oauthScopes: [],
          credentialFingerprint: null,
        },
        server: { port: 8787, corsOrigin: 'http://localhost:5173' },
        mcp: { transport: 'stdio', httpPort: 8788 },
        credentialEncryptionEnabled: false,
      },
      demoMode: true,
      demoControls: { fault: 'none', latencyMs: [0, 0] },
      client: { totalRequests: 0, totalRetries: 0, rateLimitHits: 0, inFlight: 0 },
    }),
  ),

  http.post('/api/connector/test', () =>
    HttpResponse.json({
      connected: true,
      provider: 'asana',
      mode: 'demo',
      account: { id: '1', name: 'Idrees Khaled', email: 'idrees@example.invalid' },
      workspaces: [{ id: '900000000000001', name: 'Demo Workspace', isOrganization: true }],
      auth: {
        type: 'pat',
        fingerprint: 'fp_abc123def456',
        scopes: [],
        expiresAt: null,
        canRefresh: false,
      },
      checkedAt: '2026-08-08T12:00:00.000Z',
      latencyMs: 42,
      error: null,
    }),
  ),

  http.post('/api/actions/asana.list_projects', () =>
    HttpResponse.json(
      successEnvelope({
        projects: [mockProject],
        workspace: { id: '900000000000001', name: 'Demo Workspace' },
        pagination: { nextCursor: null, hasMore: false, pageSize: 50, returned: 1 },
      }),
    ),
  ),

  http.post('/api/actions/asana.list_project_tasks', () =>
    HttpResponse.json(
      successEnvelope(
        {
          tasks: [mockTask],
          projectId: '900000000001001',
          pagination: { nextCursor: null, hasMore: false, pageSize: 50, returned: 1 },
        },
        'asana.list_project_tasks',
      ),
    ),
  ),

  http.get('/api/activity', () => HttpResponse.json({ entries: [] })),

  http.get('/api/metrics', () =>
    HttpResponse.json({
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      successRate: null,
      averageLatencyMs: null,
      p95LatencyMs: null,
      requestsByAction: {},
      rateLimitHits: 0,
      client: {},
    }),
  ),
];

export const server = setupServer(...defaultHandlers);
