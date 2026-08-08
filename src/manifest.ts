/**
 * The connector manifest.
 *
 * Derived from the action registry rather than written by hand, so it cannot
 * describe an action that does not exist or miss one that does. `connector.yaml`
 * is generated from this same object.
 */

import { ACTIONS } from './actions/index.js';
import type { RiskLevel } from './actions/types.js';

export const CONNECTOR_VERSION = '1.0.0';

export interface ManifestAction {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly type: 'read' | 'write';
  readonly risk: RiskLevel;
  readonly requiresApproval: boolean;
  readonly idempotent: boolean;
  readonly supportsPagination: boolean;
  readonly scopes: readonly string[];
  readonly endpoints: readonly string[];
  readonly safety: {
    readonly duplicateBehavior: string;
    readonly retryBehavior: string;
    readonly idempotencyBehavior: string;
  };
}

export interface ConnectorManifest {
  readonly provider: 'asana';
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly builder: string;
  readonly category: string;
  readonly authentication: {
    readonly types: readonly ['pat', 'oauth2'];
    readonly default: 'pat';
    readonly scopes: readonly string[];
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly revokeUrl: string;
    readonly notes: string;
  };
  readonly capabilities: {
    readonly pagination: 'cursor';
    readonly rateLimiting: boolean;
    readonly retries: boolean;
    readonly idempotencyKeys: boolean;
    readonly webhooks: false;
    readonly demoMode: boolean;
    readonly testConnection: boolean;
  };
  readonly rateLimits: {
    readonly freeTierRpm: number;
    readonly paidTierRpm: number;
    readonly concurrentReads: number;
    readonly concurrentWrites: number;
    readonly costBased: boolean;
    readonly notes: string;
  };
  readonly actions: readonly ManifestAction[];
  readonly writeActions: readonly string[];
  readonly readActions: readonly string[];
}

/**
 * Union of every scope any action needs.
 *
 * Computed, not listed, so the connector cannot silently request more
 * permission than its actions actually use. Notably absent: any `:delete`
 * scope — deletion is not one of the five assigned actions.
 */
function requiredScopes(): readonly string[] {
  return [...new Set(ACTIONS.flatMap((a) => a.scopes))].sort();
}

export function buildManifest(): ConnectorManifest {
  const actions: ManifestAction[] = ACTIONS.map((action) => ({
    id: action.id,
    name: action.name,
    description: action.description,
    category: action.category,
    type: action.safety.write ? 'write' : 'read',
    risk: action.safety.risk,
    requiresApproval: action.safety.requiresApproval,
    idempotent: action.safety.idempotent,
    supportsPagination: action.supportsPagination,
    scopes: action.scopes,
    endpoints: action.endpoints,
    safety: {
      duplicateBehavior: action.safety.duplicateBehavior,
      retryBehavior: action.safety.retryBehavior,
      idempotencyBehavior: action.safety.idempotencyBehavior,
    },
  }));

  return {
    provider: 'asana',
    name: 'asana-connector',
    displayName: 'Asana Connector',
    version: CONNECTOR_VERSION,
    description:
      'Production-oriented Asana connector providing project and task operations with typed schemas, normalized errors, cursor pagination and rate-limit handling.',
    builder: 'Idrees Khaled',
    category: 'Project Management',
    authentication: {
      types: ['pat', 'oauth2'],
      default: 'pat',
      scopes: requiredScopes(),
      authorizationUrl: 'https://app.asana.com/-/oauth_authorize',
      tokenUrl: 'https://app.asana.com/-/oauth_token',
      revokeUrl: 'https://app.asana.com/-/oauth_revoke',
      notes:
        'A Personal Access Token carries the full permissions of its creating user; Asana does not scope PATs. OAuth 2.0 supports the granular scopes listed above and is preferred for multi-user deployments.',
    },
    capabilities: {
      pagination: 'cursor',
      rateLimiting: true,
      retries: true,
      idempotencyKeys: true,
      webhooks: false,
      demoMode: true,
      testConnection: true,
    },
    rateLimits: {
      freeTierRpm: 150,
      paidTierRpm: 1500,
      concurrentReads: 50,
      concurrentWrites: 15,
      costBased: true,
      notes:
        'Asana counts rejected requests against the quota, so this connector paces requests client-side before sending rather than reacting to 429 alone. Cost-based limits also apply: wide opt_fields selections consume more quota per request.',
    },
    actions,
    writeActions: actions.filter((a) => a.type === 'write').map((a) => a.id),
    readActions: actions.filter((a) => a.type === 'read').map((a) => a.id),
  };
}

export const MANIFEST: ConnectorManifest = buildManifest();
