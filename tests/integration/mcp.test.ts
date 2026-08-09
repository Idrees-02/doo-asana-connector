/**
 * MCP adapter tests.
 *
 * The point of these is structural, not behavioural: they prove the adapter
 * stays THIN. The assignment forbids duplicating connector logic inside the
 * MCP server, and a comment saying "this is thin" is not evidence. These tests
 * are.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../../mcp/server.js';
import { buildConfig } from '../../src/config.js';
import { createConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';
import { REQUIRED_ACTION_IDS } from '../../src/actions/index.js';

function buildHarness() {
  const store = new DemoStore();
  const connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    fetch: createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 }),
  });
  return { store, connector, server: createMcpServer(connector) };
}

async function connectClient(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('MCP adapter — thinness guarantees', () => {
  it('exposes exactly the connector action list, and nothing else', async () => {
    const { connector, server } = buildHarness();
    const client = await connectClient(server);

    const { tools } = await client.listTools();

    // The adapter derives its tools by iterating the registry, so this is the
    // property that must hold for it to be impossible to drift.
    expect(tools.map((t) => t.name).sort()).toEqual(
      connector.listActions().map((a) => a.id.replace(/\./g, '_')).sort(),
    );
    // The count is derived, not hardcoded: adding an action must not require
    // touching this test, but dropping one from MCP must fail it.
    expect(tools).toHaveLength(connector.listActions().length);
    expect(tools.length).toBeGreaterThanOrEqual(REQUIRED_ACTION_IDS.length);
  });

  it('maps every required action id to a tool', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);

    const names = (await client.listTools()).tools.map((t) => t.name);

    for (const id of REQUIRED_ACTION_IDS) {
      expect(names).toContain(id.replace(/\./g, '_'));
    }
  });

  it('contains no Asana API calls or endpoint knowledge in the adapter source', () => {
    // A blunt but effective guard: if someone reimplements an Asana call
    // inside the MCP server, this fails.
    const source = readFileSync(
      fileURLToPath(new URL('../../mcp/server.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toContain('app.asana.com');
    expect(source).not.toContain('/api/1.0');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('opt_fields');
    // The one sanctioned way for a tool to do anything.
    expect(source).toContain('connector.execute');
  });
});

describe('MCP adapter — tool metadata', () => {
  it('annotates reads as read-only and writes as not read-only', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);
    const tools = (await client.listTools()).tools;

    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get('asana_list_projects')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('asana_create_task')?.annotations?.readOnlyHint).toBe(false);
  });

  it('marks nothing as destructive, because nothing here deletes', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);

    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('reflects idempotency accurately, so a client can reason about retries', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    expect(byName.get('asana_create_task')?.annotations?.idempotentHint).toBe(false);
    expect(byName.get('asana_add_comment')?.annotations?.idempotentHint).toBe(false);
    expect(byName.get('asana_update_task')?.annotations?.idempotentHint).toBe(true);
  });

  it('warns about duplicate consequences in write tool descriptions', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    // The model reads the description, so the consequence must be stated there.
    expect(byName.get('asana_add_comment')?.description).toMatch(/two separate comments/i);
    expect(byName.get('asana_create_task')?.description).toMatch(/two separate tasks/i);
  });

  it('requires an approved flag on write tools only', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    const createProps = byName.get('asana_create_task')?.inputSchema.properties ?? {};
    const listProps = byName.get('asana_list_projects')?.inputSchema.properties ?? {};

    expect(Object.keys(createProps)).toContain('approved');
    expect(Object.keys(createProps)).toContain('idempotencyKey');
    expect(Object.keys(listProps)).not.toContain('approved');
  });
});

describe('MCP adapter — tool execution', () => {
  it('runs a read tool and returns connector data', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'asana_list_projects', arguments: {} });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Product Launch');
  });

  it('refuses a write without approval, reporting it as an error', async () => {
    const { store, server } = buildHarness();
    const client = await connectClient(server);
    const before = store.listTasks('900000000001001', null).length;

    const result = await client.callTool({
      name: 'asana_create_task',
      arguments: { projectId: '900000000001001', name: 'Should not exist', approved: false },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
      'ASANA_APPROVAL_REQUIRED',
    );
    // The important assertion: nothing was created.
    expect(store.listTasks('900000000001001', null)).toHaveLength(before);
  });

  it('performs a write when approved', async () => {
    const { store, server } = buildHarness();
    const client = await connectClient(server);
    const before = store.listTasks('900000000001001', null).length;

    const result = await client.callTool({
      name: 'asana_create_task',
      arguments: { projectId: '900000000001001', name: 'Created via MCP', approved: true },
    });

    expect(result.isError).toBeFalsy();
    expect(store.listTasks('900000000001001', null)).toHaveLength(before + 1);
  });

  it('rejects schema-invalid input at the protocol boundary, using the connector schema', async () => {
    /*
     * Because the tool's input schema IS the action's Zod schema, the MCP SDK
     * enforces it before the handler runs. A malformed gid therefore never
     * reaches Asana — or even the connector. That is the single-source-of-truth
     * property paying off, so the test asserts the rejection rather than
     * insisting the error arrive in our own envelope.
     */
    const { store, server } = buildHarness();
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'asana_list_project_tasks',
      arguments: { projectId: 'not-a-gid' },
    });

    expect(result.isError).toBe(true);

    // The rejection quotes the connector's own schema message verbatim, which
    // is the clearest possible evidence that MCP and the runtime validate
    // against one definition rather than two that merely agree today.
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Must be an Asana global id');
    expect(text).toContain('projectId');

    // Nothing was mutated as a result.
    expect(store.listTasks('900000000001001', null).length).toBeGreaterThan(0);
  });

  it('reports semantic failures as structured connector errors', async () => {
    // A well-formed gid that does not exist passes schema validation and
    // reaches the connector, so this is where our normalized error shows up.
    const { server } = buildHarness();
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'asana_list_project_tasks',
      arguments: { projectId: '111111111111111' },
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      code: string;
      retryable: boolean;
      requestId: string;
    };
    expect(payload.code).toBe('ASANA_NOT_FOUND');
    expect(payload.retryable).toBe(false);
    expect(payload.requestId).toMatch(/^req_/);
  });

  it('never leaks a token through a tool response', async () => {
    const { server } = buildHarness();
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'asana_list_projects', arguments: {} });

    expect(JSON.stringify(result)).not.toContain('demo-mode-no-credential-required');
  });
});
