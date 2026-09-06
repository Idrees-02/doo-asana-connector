/**
 * Startup security, asserted through the real application.
 *
 * `tests/unit/mcp-security.test.ts` tests the POLICY as a pure function. This
 * file tests that the policy is actually WIRED IN — that building the real
 * Express app with an insecure configuration throws, and that a secure one
 * produces a working, authenticated endpoint.
 *
 * The distinction matters. The original finding was not that the policy was
 * wrong; it was that `server/routes/mcp.ts` logged a warning and carried on.
 * A correct policy nobody consults is worth nothing, so the wiring needs its
 * own test.
 */

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConfig } from '../../src/config.js';
import { bootstrap } from '../../src/index.js';
import { createApp } from '../../server/app.js';
import { InsecureMcpConfigurationError } from '../../src/runtime/mcp-security.js';

/** 64 hex characters — what the documented generator produces. */
const TOKEN = 'b'.repeat(64);

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/**
 * Reserve a free port, then release it.
 *
 * The port has to be known BEFORE the app is built: /mcp's DNS-rebinding
 * protection derives its allowed-host list from `PORT`, and clients send
 * `Host` with the port attached — so binding to an ephemeral port the config
 * never heard of produces a (correct) 403 that has nothing to do with the
 * security posture under test.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Build the real app from an environment record.
 *
 * `ASANA_MODE: 'demo'` throughout: these tests are about the HTTP surface's
 * security, and requiring a credential to test that would be backwards.
 */
function build(env: Record<string, string>) {
  const config = buildConfig({ ASANA_MODE: 'demo', ...env });
  return createApp(bootstrap({ config, silent: true }));
}

/** Build and serve on a port the app's own config already knows about. */
async function serve(env: Record<string, string> = {}): Promise<URL> {
  const port = await freePort();
  const { app } = build({ PORT: String(port), ...env });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return new URL(`http://127.0.0.1:${port}`);
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

describe('the application refuses to start insecurely', () => {
  it('production without MCP_AUTH_TOKEN throws instead of serving', () => {
    // The whole finding, in one assertion. Previously this logged a warning
    // and served an open endpoint.
    expect(() => build({ NODE_ENV: 'production' })).toThrow(InsecureMcpConfigurationError);
  });

  it('production with a blank MCP_AUTH_TOKEN throws', () => {
    expect(() => build({ NODE_ENV: 'production', MCP_AUTH_TOKEN: '' })).toThrow(
      InsecureMcpConfigurationError,
    );
  });

  it('production with a whitespace MCP_AUTH_TOKEN throws', () => {
    expect(() => build({ NODE_ENV: 'production', MCP_AUTH_TOKEN: '  \t  ' })).toThrow(
      InsecureMcpConfigurationError,
    );
  });

  it('an externally-bound development server without a token throws', () => {
    expect(() => build({ NODE_ENV: 'development', HOST: '0.0.0.0' })).toThrow(
      InsecureMcpConfigurationError,
    );
  });

  it('the unauthenticated bypass cannot be switched on in production', () => {
    expect(() =>
      build({ NODE_ENV: 'production', MCP_ALLOW_UNAUTHENTICATED: 'true' }),
    ).toThrow(InsecureMcpConfigurationError);
  });

  it('the unauthenticated bypass cannot be switched on for an external bind', () => {
    expect(() =>
      build({ NODE_ENV: 'development', HOST: '0.0.0.0', MCP_ALLOW_UNAUTHENTICATED: 'true' }),
    ).toThrow(InsecureMcpConfigurationError);
  });

  it('names the remediation in the error, not just the problem', () => {
    const thrown = (() => {
      try {
        build({ NODE_ENV: 'production' });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(thrown?.message).toContain('MCP_AUTH_TOKEN');
    expect(thrown?.message).toMatch(/randomBytes/);
  });

  it('never puts the token in the thrown message', () => {
    // A short token is refused; the message must say so without echoing it.
    const thrown = (() => {
      try {
        build({ NODE_ENV: 'production', MCP_AUTH_TOKEN: 'short-secret-x' });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(thrown?.message).not.toContain('short-secret-x');
    expect(thrown?.message).toMatch(/at least/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Successes                                                                   */
/* -------------------------------------------------------------------------- */

describe('the application starts when the configuration is secure', () => {
  it('production WITH a token starts and requires that token', async () => {
    const base = await serve({ NODE_ENV: 'production', MCP_AUTH_TOKEN: TOKEN });

    const anonymous = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(anonymous.status).toBe(401);

    const authenticated = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });
    expect(authenticated.status).toBe(200);
  });

  it('an external bind WITH a token starts', () => {
    expect(() => build({ HOST: '0.0.0.0', MCP_AUTH_TOKEN: TOKEN })).not.toThrow();
  });

  it('local development with the explicit flag runs unauthenticated', async () => {
    const base = await serve({ MCP_ALLOW_UNAUTHENTICATED: 'true' });

    const response = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
  });

  it('local development WITHOUT the flag is authenticated by default', async () => {
    // The secure default. An unauthenticated request must be refused even
    // though no token was configured anywhere.
    const base = await serve();

    const response = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    expect(response.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics never leak                                                      */
/* -------------------------------------------------------------------------- */

describe('diagnostic endpoints report posture without exposing credentials', () => {
  it('/api/ready states the posture and no secret', async () => {
    const base = await serve({ NODE_ENV: 'production', MCP_AUTH_TOKEN: TOKEN });

    const response = await fetch(new URL('/api/ready', base));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text) as unknown).toMatchObject({
      status: 'ready',
      mcp: { authRequired: true, authSource: 'configured' },
    });
  });

  it('/api/connector/status reports authRequired without the token', async () => {
    const base = await serve({ NODE_ENV: 'production', MCP_AUTH_TOKEN: TOKEN });

    const text = await (await fetch(new URL('/api/connector/status', base))).text();

    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as { config: { mcp: Record<string, unknown> } };
    expect(body.config.mcp['authRequired']).toBe(true);
    expect(body.config.mcp['authSource']).toBe('configured');
    // There is no field capable of carrying the token — assert that too.
    expect(Object.keys(body.config.mcp)).not.toContain('authToken');
  });

  it('/mcp/health answers a probe without a credential and discloses nothing', async () => {
    const base = await serve({ NODE_ENV: 'production', MCP_AUTH_TOKEN: TOKEN });

    const response = await fetch(new URL('/mcp/health', base));
    const text = await response.text();

    // Platform probes have to work; that is why it is open. So it must carry
    // nothing worth having.
    expect(response.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text) as unknown).toMatchObject({ status: 'ok', authRequired: true });
  });

  it('the ephemeral development token never reaches an HTTP response', async () => {
    const base = await serve();

    // Minted in-process and printed to stderr only. If it were exposed over
    // HTTP, the "authenticated by default" property would be theatre.
    for (const path of ['/api/ready', '/api/connector/status', '/mcp/health']) {
      const text = await (await fetch(new URL(path, base))).text();
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The API server is only the API server                                       */
/* -------------------------------------------------------------------------- */

describe('the API process does not also start a stdio MCP server', () => {
  it('mounts /mcp without connecting a stdio transport', async () => {
    /*
     * A real bug this caught: `mcp/server.ts` guarded its `main()` with
     * `process.argv[1]?.includes('server')`, which is TRUE for
     * `node dist/server/index.js`. Starting the API therefore also started a
     * stdio MCP server inside the same process, writing JSON-RPC framing to
     * the API's stdout.
     *
     * The guard now compares resolved module URLs. Importing the module — as
     * `server/routes/mcp.ts` does — must have no side effect at all.
     */
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const base = await serve({ MCP_ALLOW_UNAUTHENTICATED: 'true' });

      // The endpoint is mounted and serving...
      expect((await fetch(new URL('/mcp/health', base))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    // ...and nothing wrote a stdio-transport banner or JSON-RPC frame.
    const stdout = written.join('');
    expect(stdout).not.toContain('ready (stdio');
    expect(stdout).not.toContain('"jsonrpc"');
  });
});
