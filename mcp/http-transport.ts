/**
 * Streamable HTTP transport for the MCP server.
 *
 * stdio is the default and is what Claude Desktop uses locally. This module
 * exists so the same adapter can be exposed over HTTPS when deployed, without
 * a second implementation — it wraps the identical `McpServer` built in
 * `server.ts`.
 *
 * It is written as a request handler first and a server second, so the console
 * process can mount it at /mcp instead of running a second process on a second
 * port. `startHttpTransport` is the standalone wrapper around that handler.
 *
 * One transport and one `McpServer` are created per MCP session, keyed by the
 * session id the SDK issues at initialize. stdio is inherently single-client —
 * one process, one pipe — but HTTP is not, and a single shared transport
 * answers the second client's initialize with "Server already initialized".
 *
 * Deployment note: terminate TLS at the platform's load balancer and route to
 * this process. It speaks plain HTTP on purpose — managing certificates
 * in-process would be worse than letting the platform do what it does well.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const MCP_PATH = '/mcp';
const SESSION_HEADER = 'mcp-session-id';

/** A request body larger than this is a mistake or an attack, not a tool call. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/*
 * An HTTP client can vanish without sending DELETE — it crashes, the tab
 * closes, the network drops — and nothing tells the server. Without a reaper
 * those sessions are never released: a stress run of 200 clients left 362
 * transports resident. Sessions are therefore evicted once idle.
 */
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;

export interface McpHandlerOptions {
  /**
   * Hosts accepted by DNS-rebinding protection. Clients send Host with the
   * port, so port-qualified forms must be listed or every request is refused.
   * An empty list disables the check — correct only behind a proxy that
   * already fixes the host, and never a substitute for `authToken`.
   */
  readonly allowedHosts: readonly string[];
  /** When set, every MCP request must carry `Authorization: Bearer <token>`. */
  readonly authToken?: string | undefined;
}

export interface McpHandler {
  /** Serves one MCP request. The caller has already matched the path. */
  readonly handleMcp: (req: IncomingMessage, res: ServerResponse) => void;
  /** Liveness, deliberately unauthenticated so platform probes work. */
  readonly handleHealth: (res: ServerResponse) => void;
  readonly sessionCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * The transport as a plain request handler, so it can live inside an existing
 * HTTP server. Deploying one process is cheaper than two, and it keeps the
 * console and the MCP endpoint on the same origin.
 */
export function createMcpHandler(
  // A factory, not an instance: each session needs its own server object.
  createServerInstance: () => McpServer,
  options: McpHandlerOptions,
): McpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, transport] of sessions) {
      if ((lastSeen.get(id) ?? 0) > cutoff) continue;
      sessions.delete(id);
      lastSeen.delete(id);
      void transport.close();
    }
  }, SESSION_SWEEP_MS);
  // The sweeper must never be the reason the process stays alive.
  sweeper.unref();

  /**
   * The endpoint executes real writes against a real workspace using the
   * server's own credential, so an open deployment is an open door. Compared
   * in constant time: a byte-by-byte early exit leaks the token by timing.
   */
  function authorized(req: IncomingMessage): boolean {
    const expected = options.authToken;
    if (expected === undefined) return true;

    const supplied = header(req, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) {
      res.setHeader('www-authenticate', 'Bearer');
      json(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: a bearer token is required.' },
        id: null,
      });
      return;
    }

    const sessionId = header(req, SESSION_HEADER);
    if (sessionId !== undefined) lastSeen.set(sessionId, Date.now());

    // GET (SSE stream) and DELETE (session teardown) only ever address an
    // established session.
    if (req.method !== 'POST') {
      const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (existing === undefined) {
        json(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Unknown or missing MCP session id.' },
          id: null,
        });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (existing !== undefined) {
      await existing.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      json(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'No valid MCP session id. Send an initialize request first.',
        },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Without this, a malicious page in the user's browser could reach a
      // locally-bound MCP server through a hostname it controls.
      enableDnsRebindingProtection: options.allowedHosts.length > 0,
      allowedHosts: [...options.allowedHosts],
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
        lastSeen.set(id, Date.now());
      },
    });

    // Drop the session as soon as the client goes away, so a long-running
    // deployment does not accumulate transports for clients that have left.
    transport.onclose = (): void => {
      if (transport.sessionId === undefined) return;
      sessions.delete(transport.sessionId);
      lastSeen.delete(transport.sessionId);
    };

    /*
     * The MCP SDK declares Transport.onclose as a required property that it
     * then leaves unset, which `exactOptionalPropertyTypes` correctly objects
     * to. The mismatch is in the SDK's type declaration, not in behaviour, so
     * it is cast at this single boundary rather than relaxing strictness
     * project-wide.
     */
    const server = createServerInstance();
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, body);
  }

  return {
    handleMcp: (req, res) => {
      void route(req, res).catch(() => {
        if (res.headersSent) return;
        json(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error.' },
          id: null,
        });
      });
    },

    handleHealth: (res) => {
      json(res, 200, {
        status: 'ok',
        transport: 'streamable-http',
        sessions: sessions.size,
        authRequired: options.authToken !== undefined,
      });
    },

    sessionCount: () => sessions.size,

    close: async () => {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((t) => t.close()));
      sessions.clear();
      lastSeen.clear();
    },
  };
}

/** What the caller needs in order to observe and stop the standalone server. */
export interface HttpTransportHandle {
  /** The bound address, so a caller that passed port 0 can discover the port. */
  readonly address: () => AddressInfo | string | null;
  readonly close: () => Promise<void>;
}

/** Standalone mode: the handler above, given a port of its own. */
export async function startHttpTransport(
  createServerInstance: () => McpServer,
  port: number,
  options?: Partial<McpHandlerOptions>,
): Promise<HttpTransportHandle> {
  // Port 0 means "any free port", so the real one is only known after listen.
  // Sessions are created later, so the allowlist is read then, not now.
  let boundPort = port;
  const allowed = options?.allowedHosts;

  const handler = createMcpHandler(createServerInstance, {
    get allowedHosts() {
      return (
        allowed ?? [
          '127.0.0.1',
          'localhost',
          `127.0.0.1:${boundPort}`,
          `localhost:${boundPort}`,
          '[::1]',
          `[::1]:${boundPort}`,
        ]
      );
    },
    authToken: options?.authToken,
  });

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      handler.handleHealth(res);
      return;
    }
    if (url.pathname !== MCP_PATH) {
      json(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
      return;
    }
    handler.handleMcp(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      const bound = httpServer.address();
      if (bound !== null && typeof bound !== 'string') boundPort = bound.port;
      process.stderr.write(`asana-connector MCP server ready (http) on :${boundPort}${MCP_PATH}\n`);
      resolve();
    });
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return {
    address: () => httpServer.address(),
    close: async () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Returns undefined when it has already answered the request itself. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request body too large.' },
        id: null,
      });
      return undefined;
    }
    chunks.push(buf);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    json(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: body is not valid JSON.' },
      id: null,
    });
    return undefined;
  }
}
