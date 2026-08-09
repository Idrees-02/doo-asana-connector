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

import { startHttpTransport } from '../../mcp/http-transport.js';
import { createMcpServer } from '../../mcp/server.js';
import { buildConfig } from '../../src/config.js';
import { createConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';

const started: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function startServer(): Promise<URL> {
  const store = new DemoStore();
  const connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    fetch: createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 }),
  });

  // Port 0: the OS picks a free port, so parallel test files never collide.
  const handle = await startHttpTransport(() => createMcpServer(connector), 0);
  started.push(handle);

  const { port } = handle.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connectClient(url: URL): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
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

  it('answers the liveness probe without an MCP handshake', async () => {
    const url = await startServer();

    const response = await fetch(new URL('/health', url));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', transport: 'streamable-http' });
  });
});
