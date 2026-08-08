/**
 * Public entry point.
 *
 * Builds a fully-wired connector from configuration. This is the only place
 * that decides between the live Asana transport and the in-memory demo
 * transport, which keeps that branch out of the connector, the actions and
 * every adapter.
 */

import { createConnector, type AsanaConnector } from './connector.js';
import { getConfig, type AppConfig } from './config.js';
import { createDemoFetch, DemoStore } from './demo/demo-api.js';
import { createLogger, silentLogger, type Logger } from './runtime/logger.js';

export interface BootstrapOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  /** Suppress logging entirely — used by the MCP adapter, where stdout is the protocol. */
  readonly silent?: boolean;
}

export interface Bootstrapped {
  readonly connector: AsanaConnector;
  readonly config: AppConfig;
  readonly logger: Logger;
  /**
   * The demo store, present only in demo mode.
   *
   * Exposed so the console can drive fault injection and reset the data. In
   * live mode this is undefined, which makes it impossible for a UI control to
   * accidentally mutate real Asana data.
   */
  readonly demoStore: DemoStore | undefined;
}

export function bootstrap(options: BootstrapOptions = {}): Bootstrapped {
  const config = options.config ?? getConfig();

  const logger =
    options.logger ??
    (options.silent === true
      ? silentLogger
      : createLogger({ level: config.logLevel, json: config.isProduction }));

  if (config.mode === 'demo') {
    const demoStore = new DemoStore();
    const connector = createConnector({
      config,
      logger,
      fetch: createDemoFetch(demoStore),
    });

    logger.info('Connector started in DEMO mode', { reason: config.modeReason });
    return { connector, config, logger, demoStore };
  }

  const connector = createConnector({ config, logger });
  logger.info('Connector started in LIVE mode', { reason: config.modeReason });

  return { connector, config, logger, demoStore: undefined };
}

/* Re-exports for consumers of the connector as a library. */
export { createConnector, AsanaConnector, type DooConnector } from './connector.js';
export { MANIFEST, buildManifest, type ConnectorManifest } from './manifest.js';
export { ACTIONS, REQUIRED_ACTION_IDS, getAction, listActionIds } from './actions/index.js';
export { ConnectorError, type ConnectorErrorJson } from './errors/ConnectorError.js';
export { ERROR_CODES, type ErrorCode, type RetryStrategy } from './errors/codes.js';
export type {
  ConnectorExecutionRequest,
  ConnectorExecutionResult,
} from './runtime/execute.js';
export type { ConnectionTestResult } from './auth/types.js';
export { getConfig, describeConfig, type AppConfig } from './config.js';
export { DemoStore, type DemoFault } from './demo/demo-api.js';
export type { Project, Task, Comment, Workspace, User } from './schemas/asana.js';
