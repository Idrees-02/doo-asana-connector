/**
 * The DooConnector implementation.
 *
 * This is the object every consumer talks to — the HTTP API, the MCP adapter,
 * the examples, the tests. It owns the manifest, the connection test, the
 * action list and the single execution path.
 *
 * Deliberately, it does NOT know about HTTP servers, MCP, or React. Those are
 * adapters over this; none of them may reimplement anything found here.
 */

import { AsanaClient } from './client.js';
import type { AppConfig } from './config.js';
import { MANIFEST, type ConnectorManifest } from './manifest.js';
import { ACTIONS, type AnyConnectorAction } from './actions/index.js';
import type { ConnectorError } from './errors/ConnectorError.js';
import { normalizeThrown } from './errors/normalize.js';
import {
  ActionExecutor,
  type ConnectorExecutionRequest,
  type ConnectorExecutionResult,
} from './runtime/execute.js';
import { createLogger, silentLogger, type Logger } from './runtime/logger.js';
import { IdempotencyCache } from './runtime/idempotency.js';
import { generateRequestId } from './runtime/request-id.js';
import {
  NoCredentialProvider,
  OAuthCredentialProvider,
  PatCredentialProvider,
} from './auth/providers.js';
import { createCredentialStore } from './auth/credential-store.js';
import type { CredentialStore } from './auth/credential-store.js';
import type { ConnectionTestResult, CredentialProvider } from './auth/types.js';
import { USER_OPT_FIELDS, rawUserSchema, rawWorkspaceSchema } from './schemas/asana.js';
import { z } from 'zod';

/**
 * A fixed, non-secret marker used as the bearer token in demo mode.
 *
 * Named explicitly so that if it ever appeared in a log or a request against
 * real Asana, it would be immediately recognisable as a bug rather than
 * looking like a redacted credential.
 */
export const DEMO_MODE_TOKEN = 'demo-mode-no-credential-required';

export interface DooConnector {
  readonly manifest: ConnectorManifest;
  testConnection(): Promise<ConnectionTestResult>;
  listActions(): readonly AnyConnectorAction[];
  execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult>;
}

export interface CreateConnectorOptions {
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly credentialStore?: CredentialStore;
  /**
   * Transport override.
   *
   * Demo mode supplies an in-memory Asana API here rather than a parallel
   * code path. The consequence is that demo requests traverse the real
   * client, the real actions, the real validation and the real error
   * normalization — so demo behaviour cannot drift from live behaviour, and
   * the demo data exercises the same code the mentor is reviewing.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export class AsanaConnector implements DooConnector {
  readonly manifest = MANIFEST;

  private readonly client: AsanaClient;
  private readonly executor: ActionExecutor;
  private readonly credentials: CredentialProvider;
  private readonly logger: Logger;
  readonly credentialStore: CredentialStore;

  constructor(private readonly options: CreateConnectorOptions) {
    const { config } = options;

    this.logger = options.logger ?? silentLogger;
    this.credentialStore = options.credentialStore ?? createCredentialStore(config.credentialEncryptionKey);
    this.credentials = this.buildCredentialProvider();

    this.client = new AsanaClient(
      config.asana,
      () => this.credentials.getToken(),
      options.fetch !== undefined ? { fetch: options.fetch } : {},
    );

    this.executor = new ActionExecutor({
      config,
      client: this.client,
      logger: this.logger,
      idempotencyCache: new IdempotencyCache<unknown>(),
    });
  }

  /**
   * Choose how requests are authenticated.
   *
   * PAT wins over OAuth when both are configured: an explicitly-set
   * ASANA_ACCESS_TOKEN is an unambiguous instruction, whereas OAuth
   * credentials may simply be leftover configuration with no live session.
   */
  private buildCredentialProvider(): CredentialProvider {
    const { config } = this.options;

    // Demo mode still needs *a* token, because requests take the real code
    // path — they simply terminate at the in-memory API rather than Asana.
    // The value is a fixed non-secret marker, never a credential.
    if (config.mode === 'demo') return new PatCredentialProvider(DEMO_MODE_TOKEN);
    if (config.accessToken !== undefined) return new PatCredentialProvider(config.accessToken);
    if (config.oauth !== undefined) {
      return new OAuthCredentialProvider(
        config.oauth,
        this.credentialStore,
        this.options.fetch !== undefined ? { fetch: this.options.fetch } : {},
      );
    }
    return new NoCredentialProvider();
  }

  listActions(): readonly AnyConnectorAction[] {
    return ACTIONS;
  }

  execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult> {
    // One path for both modes. See CreateConnectorOptions.fetch.
    return this.executor.execute(request);
  }

  /**
   * Verify authentication without side effects.
   *
   * Implemented as a single `GET /users/me`, which reads the authenticated
   * account and the workspaces it can see. The assignment requires that this
   * creates nothing, modifies nothing and deletes nothing, so the choice of a
   * read-only endpoint is the whole design — and a test asserts that the call
   * log contains no non-GET request, rather than trusting the comment.
   *
   * The returned workspace list doubles as the data source for workspace
   * selectors in the console, which avoids inventing a sixth action.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const requestId = generateRequestId();
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const mode = this.options.config.mode;

    const authInfo = await this.credentials.describe();

    if (this.credentials.type === 'none') {
      return {
        connected: false,
        provider: 'asana',
        mode,
        account: null,
        workspaces: [],
        auth: { ...authInfo, scopes: [...authInfo.scopes] },
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: {
          code: 'ASANA_AUTHENTICATION_ERROR',
          message: 'No Asana credentials are configured.',
          guidance:
            'Add ASANA_ACCESS_TOKEN to .env (see the README for how to create one), or connect via OAuth in Settings.',
        },
      };
    }

    try {
      const result = await this.client.request({
        method: 'GET',
        path: '/users/me',
        schema: rawUserSchema.extend({
          workspaces: z.array(rawWorkspaceSchema).optional(),
        }),
        query: { opt_fields: USER_OPT_FIELDS.join(',') },
        idempotent: true,
        actionId: 'connector.test',
        requestId,
      });

      const user = result.data;

      return {
        connected: true,
        provider: 'asana',
        mode,
        account: {
          id: user.gid,
          name: user.name ?? null,
          email: user.email ?? null,
        },
        workspaces: (user.workspaces ?? []).map((w) => ({
          id: w.gid,
          name: w.name ?? null,
          isOrganization: w.is_organization ?? null,
        })),
        auth: { ...authInfo, scopes: [...authInfo.scopes] },
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (thrown) {
      const error: ConnectorError = normalizeThrown(thrown, {
        action: 'connector.test',
        requestId,
        idempotent: true,
      });

      this.logger.warn('Connection test failed', { code: error.code });

      return {
        connected: false,
        provider: 'asana',
        mode,
        account: null,
        workspaces: [],
        auth: { ...authInfo, scopes: [...authInfo.scopes] },
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: {
          code: error.code,
          message: error.message,
          guidance: error.guidance,
        },
      };
    }
  }

  /** Runtime counters for the Health page. */
  get stats() {
    return this.client.stats;
  }
}

export function createConnector(options: CreateConnectorOptions): AsanaConnector {
  return new AsanaConnector(options);
}

export { createLogger };
export type { ConnectorExecutionRequest, ConnectorExecutionResult, ConnectionTestResult };
