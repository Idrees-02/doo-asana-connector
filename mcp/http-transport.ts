/**
 * Streamable HTTP transport for the MCP server.
 *
 * stdio is the default and is what the mentor and Claude Desktop use locally.
 * This module exists so the same adapter can be exposed over HTTPS when
 * deployed, without a second implementation — it wraps the identical
 * `McpServer` built in `server.ts`.
 *
 * Loaded lazily (dynamic import) so a local stdio run never pays for the HTTP
 * stack.
 *
 * Deployment note: terminate TLS at the platform's load balancer or reverse
 * proxy and route to this port. The process speaks plain HTTP on purpose —
 * managing certificates in-process would be worse than letting the platform do
 * what it already does well.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MCP_PATH = '/mcp';

export async function startHttpTransport(server: McpServer, port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // DNS-rebinding protection: without it, a malicious page in the user's
    // browser could reach a locally-bound MCP server via a hostname it
    // controls. Harmless to enable, and the failure mode it prevents is severe.
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
  });

  /*
   * The MCP SDK declares Transport.onclose as a required property that it then
   * leaves unset, which `exactOptionalPropertyTypes` correctly objects to. The
   * mismatch is in the SDK's type declaration, not in behaviour, so it is cast
   * at this single boundary rather than relaxing strictness project-wide.
   */
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // A liveness probe that does not require an MCP handshake, so platform
    // health checks do not need to speak the protocol.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http' }));
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${MCP_PATH}.` }));
      return;
    }

    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      process.stderr.write(`asana-connector MCP server ready (http) on :${port}${MCP_PATH}\n`);
      resolve();
    });
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
