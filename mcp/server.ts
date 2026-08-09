#!/usr/bin/env node
/**
 * MCP adapter.
 *
 * A THIN adapter, and structurally so: it iterates `connector.listActions()`
 * and registers each one as an MCP tool. There is no Asana endpoint, no
 * schema, no error handling and no business logic in this file — every tool
 * body is a single delegation to `connector.execute`.
 *
 * The consequence is that the adapter cannot drift from the connector. Add an
 * action and it appears here automatically; change a schema and MCP sees the
 * change immediately. `tests/integration/mcp.test.ts` asserts that the exposed
 * tool ids equal the connector's action ids, so drift fails the build.
 *
 * Transports:
 *   stdio (default) — for Claude Desktop, MCP Inspector and local clients.
 *   http            — Streamable HTTP, for a deployed endpoint. Selected with
 *                     MCP_TRANSPORT=http.
 *
 * IMPORTANT: on stdio, stdout carries the JSON-RPC protocol. Nothing here may
 * print to stdout — the connector logs to stderr for exactly this reason, and
 * the adapter runs the connector in silent mode by default.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { bootstrap } from '../src/index.js';
import { CONNECTOR_VERSION } from '../src/manifest.js';
import type { AsanaConnector } from '../src/connector.js';
import type { AnyConnectorAction } from '../src/actions/index.js';

/* -------------------------------------------------------------------------- */
/* Tool registration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Extra arguments every write tool accepts.
 *
 * Approval is explicit rather than implied so that a model enumerating tools,
 * or "trying one to see what it does", cannot create a task or post a comment
 * as a side effect. The description states the consequence plainly, because
 * that text is what the model actually reasons about.
 */
function writeControlSchema(action: AnyConnectorAction) {
  return {
    approved: z
      .boolean()
      .describe(
        `REQUIRED to proceed. ${action.safety.duplicateBehavior} Set true only when the user has asked for this change.`,
      ),
    idempotencyKey: z
      .string()
      .optional()
      .describe(
        'Optional. Reuse the same key when retrying so the operation is not applied twice.',
      ),
  };
}

/**
 * Build the MCP description for an action.
 *
 * Safety metadata is folded into the text because MCP annotations are advisory
 * and not every client surfaces them, whereas the description is always seen.
 */
function describeTool(action: AnyConnectorAction): string {
  const lines = [action.description];

  if (action.safety.write) {
    lines.push(
      `WRITE ACTION (risk: ${action.safety.risk}). Requires approved=true.`,
      `Duplicates: ${action.safety.duplicateBehavior}`,
      `Retries: ${action.safety.retryBehavior}`,
    );
  } else {
    lines.push('Read-only. Has no side effects.');
  }

  if (action.supportsPagination) {
    lines.push('Paginated: pass the returned pagination.nextCursor as `cursor` for the next page.');
  }

  return lines.join('\n');
}

export function registerConnectorTools(server: McpServer, connector: AsanaConnector): void {
  for (const action of connector.listActions()) {
    // The action's own Zod schema is the tool's input schema — one definition,
    // used by the runtime, OpenAPI, the console and MCP alike.
    const inputShape = extractShape(action);

    server.registerTool(
      // Asana action ids contain a dot; MCP tool names are conventionally
      // snake_case, so normalise while keeping the mapping obvious.
      action.id.replace(/\./g, '_'),
      {
        title: action.name,
        description: describeTool(action),
        inputSchema: action.safety.write
          ? { ...inputShape, ...writeControlSchema(action) }
          : inputShape,
        annotations: {
          title: action.name,
          readOnlyHint: !action.safety.write,
          // Nothing this connector does is destructive: there is no delete
          // action, and updates are additive or reversible by the user.
          destructiveHint: false,
          idempotentHint: action.safety.idempotent,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        // The entire adapter body. No Asana call, no business logic.
        const { approved, idempotencyKey, ...input } = args;

        const result = await connector.execute({
          actionId: action.id,
          input,
          approved: typeof approved === 'boolean' ? approved : undefined,
          idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.ok ? result.data : result.error, null, 2),
            },
          ],
          // Surfaces the failure to the model as an error rather than as text
          // that merely happens to describe one.
          isError: !result.ok,
          structuredContent: result.ok ? (result.data as Record<string, unknown>) : undefined,
        };
      },
    );
  }
}

/**
 * Get the raw Zod shape an action's input schema is built from.
 *
 * The MCP SDK wants a shape (a record of Zod types), not a ZodObject. Actions
 * whose schemas end in `.refine(...)` are wrapped in ZodEffects, so the object
 * has to be unwrapped to reach it.
 */
function extractShape(action: AnyConnectorAction): z.ZodRawShape {
  let schema: unknown = action.inputSchema;

  // Unwrap however many effect layers the refinements added.
  for (let i = 0; i < 10; i++) {
    if (schema instanceof z.ZodObject) return schema.shape;

    const inner = (schema as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    const next = inner?.schema ?? inner?.innerType;
    if (next === undefined) break;
    schema = next;
  }

  throw new Error(
    `Could not extract an object shape from the input schema of "${action.id}". ` +
      'MCP tool registration requires a ZodObject at the root.',
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function createMcpServer(connector: AsanaConnector): McpServer {
  const server = new McpServer({
    name: 'asana-connector',
    version: CONNECTOR_VERSION,
  });

  registerConnectorTools(server, connector);
  return server;
}

async function main(): Promise<void> {
  // Silent: on stdio, any stdout write corrupts the JSON-RPC stream.
  const { connector, config } = bootstrap({ silent: true });

  if (config.mcp.transport === 'http') {
    const { startHttpTransport } = await import('./http-transport.js');
    // HTTP serves many clients at once, so it builds a server per session
    // rather than sharing one. stdio is one client by construction.
    await startHttpTransport(() => createMcpServer(connector), config.mcp.httpPort);
    return;
  }

  const server = createMcpServer(connector);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostics go to stderr, which MCP clients treat as log output.
  process.stderr.write(
    `asana-connector MCP server ready (stdio, ${config.mode} mode, ${connector.listActions().length} tools)\n`,
  );
}

// Only run when executed directly, so tests can import the builders above.
if (process.argv[1]?.includes('server') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`MCP server failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
