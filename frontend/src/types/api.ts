/**
 * API types.
 *
 * The domain shapes (Project, Task, Comment) are imported as TYPES ONLY from
 * the connector core. `import type` is erased at compile time, so this gives
 * the console a single source of truth for shapes while guaranteeing that no
 * server code — and therefore no credential-handling code — can ever end up in
 * the browser bundle.
 */

import type { Project, Task, Comment, Workspace, User } from '../../../src/schemas/asana';

export type { Project, Task, Comment, Workspace, User };

/* -------------------------------------------------------------------------- */
/* Errors and envelopes                                                        */
/* -------------------------------------------------------------------------- */

export type RetryStrategy =
  | 'none'
  | 'immediate'
  | 'backoff'
  | 'after_delay'
  | 'manual_with_idempotency_key';

export interface ErrorDetail {
  readonly field?: string;
  readonly message: string;
  readonly reason?: string;
}

export interface ConnectorErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly provider: string;
  readonly action: string | null;
  readonly requestId: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryAfterMs?: number | null;
  readonly severity: 'warning' | 'error';
  readonly guidance: string;
  readonly details: readonly ErrorDetail[];
  readonly providerPhrase: string | null;
  readonly occurredAt: string;
}

export interface ExecutionMeta {
  readonly requestId: string;
  readonly actionId: string;
  readonly provider: string;
  readonly mode: 'live' | 'demo';
  readonly demoData: boolean;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly upstreamCalls: number;
  readonly attempts: number;
  readonly rateLimit?: { limitRpm: number; remaining: number; throttledMs: number };
  readonly deprecations: ReadonlyArray<{ name: string; info: string | null; affected: boolean }>;
}

export type ExecutionEnvelope<T> =
  | { readonly ok: true; readonly data: T; readonly meta: ExecutionMeta }
  | { readonly ok: false; readonly error: ConnectorErrorPayload; readonly meta: ExecutionMeta };

/* -------------------------------------------------------------------------- */
/* Action payloads                                                             */
/* -------------------------------------------------------------------------- */

export interface Pagination {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly pageSize: number;
  readonly returned: number;
}

export interface ListProjectsResult {
  readonly projects: Project[];
  readonly workspace: { id: string; name: string | null } | null;
  readonly pagination: Pagination;
}

export interface ListTasksResult {
  readonly tasks: Task[];
  readonly projectId: string;
  readonly pagination: Pagination;
}

export interface CreateTaskResult {
  readonly task: Task;
  readonly created: true;
}

export interface UpdateTaskResult {
  readonly task: Task;
  readonly updatedFields: string[];
}

export interface AddCommentResult {
  readonly comment: Comment;
  readonly taskId: string;
}

/* -------------------------------------------------------------------------- */
/* Connector metadata                                                          */
/* -------------------------------------------------------------------------- */

export interface SafetyMetadata {
  readonly write: boolean;
  readonly idempotent: boolean;
  readonly risk: 'low' | 'medium' | 'high';
  readonly requiresApproval: boolean;
  readonly duplicateBehavior: string;
  readonly retryBehavior: string;
  readonly idempotencyBehavior: string;
}

export interface ActionSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: 'projects' | 'tasks' | 'comments' | 'sections' | 'users' | 'tags';
  readonly type: 'read' | 'write';
  readonly safety: SafetyMetadata;
  readonly supportsPagination: boolean;
  readonly scopes: string[];
  readonly endpoints: string[];
  readonly examples: ReadonlyArray<{ title: string; description?: string; input: unknown }>;
}

export interface SchemaBundle {
  readonly actionId: string;
  readonly name: string;
  readonly description: string;
  readonly safety: SafetyMetadata;
  readonly examples: ReadonlyArray<{ title: string; description?: string; input: unknown }>;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
}

export interface ConnectorStatus {
  readonly connector: {
    readonly name: string;
    readonly displayName: string;
    readonly version: string;
    readonly provider: string;
    readonly builder: string;
  };
  readonly config: {
    readonly mode: 'live' | 'demo';
    readonly modeReason: string;
    readonly nodeEnv: string;
    readonly asana: {
      readonly baseUrl: string;
      readonly rateLimitRpm: number;
      readonly timeoutMs: number;
      readonly maxConcurrency: number;
      readonly defaultWorkspace: string | null;
    };
    readonly auth: {
      readonly patConfigured: boolean;
      readonly oauthConfigured: boolean;
      readonly oauthRedirectUri: string | null;
      readonly oauthScopes: string[];
      readonly credentialFingerprint: string | null;
    };
    readonly server: { readonly port: number; readonly corsOrigin: string };
    readonly mcp: { readonly transport: string; readonly httpPort: number };
    readonly credentialEncryptionEnabled: boolean;
  };
  readonly demoMode: boolean;
  readonly demoControls: { readonly fault: string; readonly latencyMs: [number, number] } | null;
  readonly client: {
    readonly totalRequests: number;
    readonly totalRetries: number;
    readonly rateLimitHits: number;
    readonly inFlight: number;
  };
}

export interface ConnectorManifest {
  readonly provider: string;
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly builder: string;
  readonly category: string;
  readonly authentication: {
    readonly types: string[];
    readonly default: string;
    readonly scopes: string[];
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly revokeUrl: string;
    readonly notes: string;
  };
  readonly capabilities: Record<string, unknown>;
  readonly rateLimits: {
    readonly freeTierRpm: number;
    readonly paidTierRpm: number;
    readonly concurrentReads: number;
    readonly concurrentWrites: number;
    readonly costBased: boolean;
    readonly notes: string;
  };
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly type: 'read' | 'write';
    readonly risk: string;
    readonly requiresApproval: boolean;
    readonly idempotent: boolean;
    readonly supportsPagination: boolean;
    readonly scopes: string[];
    readonly endpoints: string[];
    readonly safety: {
      readonly duplicateBehavior: string;
      readonly retryBehavior: string;
      readonly idempotencyBehavior: string;
    };
  }>;
  readonly writeActions: string[];
  readonly readActions: string[];
}

export interface ConnectionTestResult {
  readonly connected: boolean;
  readonly provider: string;
  readonly mode: 'live' | 'demo';
  readonly account: { id: string; name: string | null; email: string | null } | null;
  readonly workspaces: ReadonlyArray<{
    id: string;
    name: string | null;
    isOrganization: boolean | null;
  }>;
  readonly auth: {
    readonly type: 'pat' | 'oauth' | 'none';
    readonly fingerprint: string | null;
    readonly scopes: string[];
    readonly expiresAt: string | null;
    readonly canRefresh: boolean;
  };
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly error: { code: string; message: string; guidance: string } | null;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export interface ActivityEntry {
  readonly requestId: string;
  readonly actionId: string;
  readonly status: 'success' | 'error';
  readonly timestamp: string;
  readonly durationMs: number;
  readonly mode: 'live' | 'demo';
  readonly demoData: boolean;
  readonly summary: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly httpStatus: number | null;
    readonly retryable: boolean;
    readonly retryStrategy: string;
    readonly guidance: string;
  } | null;
  readonly upstreamCalls: number;
  readonly attempts: number;
}

export interface ActivityMetrics {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  /** Null when nothing has run — distinct from a 0% success rate. */
  readonly successRate: number | null;
  readonly averageLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly requestsByAction: Record<string, number>;
  readonly rateLimitHits: number;
}

export type ComponentStatus = 'healthy' | 'warning' | 'offline' | 'auth_required';

export interface HealthReport {
  readonly status: 'healthy' | 'degraded' | 'unauthenticated';
  readonly checkedAt: string;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly status: ComponentStatus;
    readonly detail: string;
    readonly latencyMs: number | null;
  }>;
}

/** The five action ids fixed by the assignment. Never renamed or reordered. */
export const REQUIRED_ACTION_IDS = [
  'asana.list_projects',
  'asana.list_project_tasks',
  'asana.create_task',
  'asana.update_task',
  'asana.add_comment',
] as const;

export type RequiredActionId = (typeof REQUIRED_ACTION_IDS)[number];

/** Any of the connector's 35 action ids. Not a fixed literal union — the
 *  connector is additive, so this is deliberately just `string` rather than
 *  a union that would need editing every time an action is added. */
export type ActionId = string;
