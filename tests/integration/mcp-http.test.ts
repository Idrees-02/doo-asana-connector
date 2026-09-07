/**
 * MCP Streamable HTTP transport tests.
 *
 * stdio is one client per process, so it cannot express the failure these
 * cover: over HTTP, many clients share one port. Two bugs shipped here and
 * were only found by driving the transport with real concurrent clients —
 *
 *   1. `allowedHosts` listed bare hosts, but clients send `Host` with the
 *      port, so DNS-rebinding protection rejected every single request.
 *   2. One shared transport meant the second client's initialize was answered
 *      with "Server already initialized".
 *
 * Both are silent under any single-client smoke test, hence these.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHandler, startHttpTransport } from '../../mcp/http-transport.js';
import { createMcpServer } from '../../mcp/server.js';
import { buildConfig } from '../../src/config.js';
import { createConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';
import { inert } from '../helpers/inert.js';

const started: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function startServer(options?: { authToken?: string }): Promise<URL> {
  const store = new DemoStore();
  const connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    fetch: createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 }),
  });

  // Port 0: the OS picks a free port, so parallel test files never collide.
  //
  // The unauthenticated cases must now SAY they are unauthenticated: since
  // the fail-closed change, `createMcpHandler` refuses to build an open
  // handler by accident. These tests are exercising transport mechanics
  // (sessions, DNS-rebinding hosts, body limits) rather than auth, so they
  // opt out explicitly — which is exactly the property being enforced.
  const handle = await startHttpTransport(
    () => createMcpServer(connector),
    0,
    options?.authToken === undefined
      ? { allowUnauthenticated: true }
      : { authToken: options.authToken },
  );
  started.push(handle);

  const { port } = handle.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connectClient(url: URL, token?: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    url,
    token === undefined
      ? undefined
      : { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  // Same SDK type mismatch the transport module documents: `sessionId` is
  // declared required and left optional. Cast at the boundary, not globally.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

describe('MCP Streamable HTTP transport', () => {
  it('accepts a client whose Host header carries the port', async () => {
    const url = await startServer();
    const client = await connectClient(url);

    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('serves concurrent clients, each in its own session', async () => {
    const url = await startServer();

    // Ten at once: one shared transport fails this on the second initialize.
    const clients = await Promise.all(Array.from({ length: 10 }, () => connectClient(url)));

    const results = await Promise.all(
      clients.map((client) => client.callTool({ name: 'asana_list_projects', arguments: {} })),
    );

    expect(results.every((r) => r.isError !== true)).toBe(true);
    await Promise.all(clients.map((client) => client.close()));
  });

  it('rejects a non-initialize request that carries no session id', async () => {
    const url = await startServer();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/session/i);
  });

  it('refuses an unauthenticated request when a token is configured', async () => {
    const url = await startServer({ authToken: inert('secret-token') });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    // The deployed endpoint drives a real workspace with the server's own
    // credential, so an open door here is the whole risk.
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('accepts the configured bearer token', async () => {
    const url = await startServer({ authToken: inert('secret-token') });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${inert('secret-token')}`,
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

    expect(response.status).toBe(200);
  });

  it('rejects a token of the wrong value but the right length', async () => {
    const url = await startServer({ authToken: inert('secret-token') });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret-tokeX',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    expect(response.status).toBe(401);
  });

  it('leaves the liveness probe open so platform health checks work', async () => {
    const url = await startServer({ authToken: inert('secret-token') });

    const response = await fetch(new URL('/health', url));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authRequired: true });
  });

  it('answers the liveness probe without an MCP handshake', async () => {
    const url = await startServer();

    const response = await fetch(new URL('/health', url));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', transport: 'streamable-http' });
  });
});

/* -------------------------------------------------------------------------- */
/* Authentication hardening                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The token used throughout. Long enough to satisfy the production policy so
 * these cases exercise a realistic value rather than a toy one.
 */
const TOKEN = 'f'.repeat(64);

/** POST an unauthenticated-looking initialize with whatever headers are given. */
async function initialize(
  url: URL,
  headers: Record<string, string> = {},
  body: unknown = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  },
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('MCP HTTP authentication', () => {
  it('refuses to build an unauthenticated handler unless told to explicitly', () => {
    // The regression guard for the original finding. Previously,
    // `authToken: undefined` silently meant "authorize everyone".
    expect(() =>
      createMcpHandler(() => createMcpServer({} as never), { allowedHosts: [] }),
    ).toThrow(/unauthenticated/i);
  });

  it.each<[string, Record<string, string>]>([
    ['no Authorization header at all', {}],
    ['an empty Authorization header', { authorization: '' }],
    ['a bare token with no scheme', { authorization: TOKEN }],
    ['the wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['a malformed header', { authorization: 'Bearer' }],
    ['Bearer with an empty token', { authorization: 'Bearer ' }],
    ['a token with trailing junk', { authorization: `Bearer ${TOKEN} extra` }],
    ['a wrong token of the same length', { authorization: `Bearer ${'e'.repeat(64)}` }],
    ['a wrong token of a different length', { authorization: 'Bearer short' }],
  ])('rejects %s', async (_name, headers) => {
    const url = await startServer({ authToken: TOKEN });

    const response = await initialize(url, headers);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('accepts the token regardless of scheme casing', async () => {
    const url = await startServer({ authToken: TOKEN });

    // RFC 7235 makes the scheme case-insensitive; a client that sends "bearer"
    // is not an attacker and must not be treated as one.
    const response = await initialize(url, { authorization: `bearer ${TOKEN}` });

    expect(response.status).toBe(200);
  });

  it('never echoes the token in the 401 body', async () => {
    const url = await startServer({ authToken: TOKEN });

    const response = await initialize(url, { authorization: `Bearer ${'e'.repeat(64)}` });
    const text = await response.text();

    // Neither the expected token nor the one that was tried.
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('e'.repeat(64));
  });

  it('does not disclose the token or session ids on the open health probe', async () => {
    const url = await startServer({ authToken: TOKEN });

    const body = await (await fetch(new URL('/health', url))).text();

    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body) as unknown).toMatchObject({ authRequired: true, sessions: 0 });
  });

  /*
   * THE CONTROL THAT MATTERS MOST.
   *
   * `approved: true` is write consent carried inside a request body. It is not
   * a credential and must never behave like one. These two cases assert that
   * from both directions: approval cannot buy admission, and admission does
   * not imply approval.
   */
  it('does NOT accept approved:true as a substitute for authentication', async () => {
    const url = await startServer({ authToken: TOKEN });

    const response = await initialize(url, {}, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'asana_create_task',
        arguments: { projectId: '900000000001001', name: 'must never be created', approved: true },
      },
    });

    // Rejected at the transport, before the body is even parsed as a tool call.
    expect(response.status).toBe(401);
  });

  it('still requires approval AFTER a caller authenticates', async () => {
    const url = await startServer({ authToken: TOKEN });
    const client = await connectClient(url, TOKEN);

    // `approved: false` rather than omitted: omitting it is caught earlier by
    // the tool's own schema, and the point here is that the CONNECTOR's
    // approval gate rejects an authenticated caller who has not consented.
    const result = await client.callTool({
      name: 'asana_create_task',
      arguments: {
        projectId: '900000000001001',
        name: 'must never be created',
        approved: false,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASANA_APPROVAL_REQUIRED');
    await client.close();
  });

  it('lets an authenticated AND approved write through', async () => {
    const url = await startServer({ authToken: TOKEN });
    const client = await connectClient(url, TOKEN);

    const result = await client.callTool({
      name: 'asana_create_task',
      arguments: { projectId: '900000000001001', name: 'Authorized and approved', approved: true },
    });

    // Both controls satisfied, and only then does the write happen.
    expect(result.isError).not.toBe(true);
    await client.close();
  });

  it('rejects a body larger than the transport will accept', async () => {
    const url = await startServer({ authToken: TOKEN });

    // The transport answers 413 and then destroys the request stream, so the
    // client sees either the response or a reset — both are the limit
    // working. What must NOT happen is the upload being accepted in full.
    const outcome = await fetch(url, {
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
        pad: 'x'.repeat(5 * 1024 * 1024),
      }),
    }).then(
      (r) => r.status,
      () => 'reset' as const,
    );

    expect([413, 'reset']).toContain(outcome);
  });
});
