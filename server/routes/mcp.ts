/**
 * The MCP endpoint, mounted inside the console's own server.
 *
 * Running MCP as a second process on a second port would mean a second
 * deployment to pay for and keep alive. It is the same adapter over the same
 * connector either way, so it is mounted here at /mcp and the standalone
 * process in `mcp/server.ts` remains available for stdio and local use.
 *
 * This module owns no MCP logic. It resolves configuration, then hands every
 * request to the transport unchanged.
 *
 * It is also the enforcement point for the transport's security policy. The
 * previous version logged a warning when a production deployment had no token
 * and then served the endpoint anyway. It now calls `resolveMcpSecurity`,
 * which THROWS for any configuration that would expose an unauthenticated
 * endpoint. The throw propagates through `createApp` and out of
 * `server/index.ts`, so the process exits before `listen` is ever reached —
 * there is no code path that starts an insecure production MCP server.
 */

import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

import type { Bootstrapped } from '../../src/index.js';
import { createMcpServer } from '../../mcp/server.js';
import { createMcpHandler } from '../../mcp/http-transport.js';
import {
  describeEphemeralToken,
  resolveMcpSecurity,
  type McpSecurityDecision,
} from '../../src/runtime/mcp-security.js';

/**
 * Mount /mcp, or refuse to start.
 *
 * Returns the resolved security decision so the status endpoint can report
 * the posture without recomputing (and therefore without being the place an
 * insecure configuration is discovered).
 */
export function registerMcpRoute(app: Express, runtime: Bootstrapped): McpSecurityDecision {
  const { connector, config, logger } = runtime;

  /*
   * FAIL CLOSED. This throws — it does not warn — when the configuration
   * would expose an unauthenticated endpoint. See src/runtime/mcp-security.ts
   * for the full policy and the reasoning behind each rule.
   */
  const security = resolveMcpSecurity({
    nodeEnv: config.nodeEnv,
    authToken: config.mcp.authToken,
    allowUnauthenticated: config.mcp.allowUnauthenticated,
    bindHost: config.server.host,
  });

  const hosts = allowedHosts(
    config.server.corsOrigin,
    config.server.port,
    config.mcp.allowedHosts,
  );

  const handler = createMcpHandler(() => createMcpServer(connector), {
    allowedHosts: hosts,
    authToken: security.token,
    allowUnauthenticated: !security.authRequired,
  });

  // A token minted for this process is useless if nobody can see it. stderr,
  // not stdout: stdout is the JSON-RPC channel for the stdio transport.
  const banner = describeEphemeralToken(security, '/mcp');
  if (banner !== '') process.stderr.write(banner);

  // Liveness first: it must answer even when a probe sends no credential.
  app.get('/mcp/health', (_req: Request, res: Response) => {
    handler.handleHealth(res);
  });

  /*
   * This route is mounted ahead of the app-wide limiter (it must precede the
   * body parser), so it needs its own or it would be the one unmetered door in
   * the deployment. The ceiling is generous: a legitimate agent session is
   * chatty, with an initialize, a tools/list and a call per turn.
   */
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests.' },
      id: null,
    },
  });

  app.all('/mcp', limiter, (req: Request, res: Response) => {
    handler.handleMcp(req, res);
  });

  /*
   * The host list is logged because getting it wrong produces a 403 that names
   * the rejected host and nothing else — which is a confusing way to find out
   * that the endpoint is reached on a name CORS_ORIGIN does not mention.
   */
  logger.info('MCP endpoint mounted', {
    path: '/mcp',
    authRequired: security.authRequired,
    // The SOURCE of the token, never the token. `describeConfig` has the same
    // property: there is no field here capable of carrying a secret.
    authSource: security.source,
    bindHost: config.server.host,
    allowedHosts: hosts.join(','),
  });

  if (!security.authRequired) {
    logger.warn('MCP endpoint is UNAUTHENTICATED', { reason: security.reason });
  }

  return security;
}

/**
 * Hosts the transport will accept.
 *
 * Derived from the console's own origin, which a deployment already has to set
 * correctly for CORS — so there is no second variable to forget. Localhost is
 * always included so development and tests need no configuration at all.
 */
function allowedHosts(
  corsOrigin: string,
  port: number,
  extra: readonly string[],
): string[] {
  const hosts = new Set<string>([
    'localhost',
    '127.0.0.1',
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    '[::1]',
    `[::1]:${port}`,
  ]);

  for (const host of extra) hosts.add(host);

  for (const origin of corsOrigin.split(',')) {
    const trimmed = origin.trim();
    if (trimmed === '' || trimmed === '*') continue;
    try {
      const { host, hostname } = new URL(trimmed);
      hosts.add(host);
      hosts.add(hostname);
    } catch {
      // Not a URL — treat it as a bare host, which is how it will arrive.
      hosts.add(trimmed);
    }
  }

  return [...hosts];
}
