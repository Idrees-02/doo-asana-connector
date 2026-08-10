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
 */

import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

import type { Bootstrapped } from '../../src/index.js';
import { createMcpServer } from '../../mcp/server.js';
import { createMcpHandler } from '../../mcp/http-transport.js';

export function registerMcpRoute(app: Express, runtime: Bootstrapped): void {
  const { connector, config, logger } = runtime;

  const hosts = allowedHosts(
    config.server.corsOrigin,
    config.server.port,
    config.mcp.allowedHosts,
  );

  const handler = createMcpHandler(() => createMcpServer(connector), {
    allowedHosts: hosts,
    authToken: config.mcp.authToken,
  });

  /*
   * An unauthenticated public endpoint would let anyone drive a real Asana
   * workspace with this server's credential. Local development is a different
   * risk, so the warning names the deployed case specifically.
   */
  if (config.mcp.authToken === undefined && config.nodeEnv === 'production') {
    logger.warn(
      'MCP endpoint is unauthenticated. Set MCP_AUTH_TOKEN before exposing this deployment.',
    );
  }

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
    authRequired: config.mcp.authToken !== undefined,
    allowedHosts: hosts.join(','),
  });
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
