/**
 * asana.list_projects — retrieve projects available to the authenticated account.
 *
 * Asana endpoint: GET /projects
 */

import { z } from 'zod';
import {
  PROJECT_OPT_FIELDS,
  projectSchema,
  rawProjectSchema,
  rawWorkspaceSchema,
  toProject,
} from '../schemas/asana.js';
import { gidSchema, paginationInputSchema, paginationOutputSchema } from '../schemas/common.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';
import type { ActionContext, ConnectorAction } from './types.js';

const inputSchema = paginationInputSchema.extend({
  workspace: gidSchema
    .optional()
    .describe(
      'Workspace gid to list projects from. Optional: if the account has exactly one workspace it is resolved automatically.',
    ),
  archived: z
    .boolean()
    .optional()
    .describe('Filter by archived state. Omit to return both archived and active projects.'),
});

const outputSchema = z.object({
  projects: z.array(projectSchema),
  workspace: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable()
    .describe('The workspace that was queried, including one resolved automatically.'),
  pagination: paginationOutputSchema,
});

export type ListProjectsInput = z.infer<typeof inputSchema>;
export type ListProjectsOutput = z.infer<typeof outputSchema>;

/**
 * Resolve which workspace to query.
 *
 * `GET /projects` without a workspace fails with Asana's terse
 * "workspace: Missing input" whenever the token can see more than one. Rather
 * than pass that through, we resolve it: one workspace means there is no real
 * choice to make, and several means the caller genuinely has to pick — so we
 * tell them what the options are instead of making them go and look.
 */
async function resolveWorkspace(
  input: ListProjectsInput,
  ctx: ActionContext,
): Promise<string | undefined> {
  if (input.workspace !== undefined) return input.workspace;
  if (ctx.config.asana.defaultWorkspace !== undefined) return ctx.config.asana.defaultWorkspace;

  const result = await ctx.client.request({
    method: 'GET',
    path: '/workspaces',
    schema: z.array(rawWorkspaceSchema),
    query: { limit: 100, opt_fields: 'name,is_organization' },
    idempotent: true,
    actionId: 'asana.list_projects',
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  ctx.recordUpstream(1, result.attempts);

  const workspaces = result.data;

  if (workspaces.length === 0) {
    throw new ConnectorError(ERROR_CODES.NOT_FOUND, {
      message: 'This Asana account is not a member of any workspace.',
      requestId: ctx.requestId,
      action: 'asana.list_projects',
      guidance: 'Join or create a workspace in Asana, then try again.',
    });
  }

  if (workspaces.length === 1 && workspaces[0] !== undefined) {
    ctx.logger.debug('Resolved the single available workspace', { workspace: workspaces[0].gid });
    return workspaces[0].gid;
  }

  throw new ConnectorError(ERROR_CODES.VALIDATION_ERROR, {
    message:
      'This account belongs to several workspaces, so "workspace" must be specified. ' +
      `Available: ${workspaces.map((w) => `${w.name ?? 'unnamed'} (${w.gid})`).join(', ')}`,
    requestId: ctx.requestId,
    action: 'asana.list_projects',
    details: [{ field: 'workspace', message: 'Required when the account has multiple workspaces.' }],
    guidance: 'Pass one of the listed workspace ids, or set ASANA_DEFAULT_WORKSPACE in .env.',
  });
}

export const listProjectsAction: ConnectorAction<ListProjectsInput, ListProjectsOutput> = {
  id: 'asana.list_projects',
  name: 'List Projects',
  description: 'Fetch the Asana projects visible to the authenticated account, with pagination.',
  category: 'projects',
  supportsPagination: true,
  scopes: ['projects:read', 'workspaces:read'],
  endpoints: ['GET /projects', 'GET /workspaces'],
  safety: {
    write: false,
    idempotent: true,
    risk: 'low',
    requiresApproval: false,
    duplicateBehavior: 'None. Reads have no side effects, so repeating this action changes nothing.',
    retryBehavior:
      'Safe to retry automatically. The client retries 429 and 5xx up to 3 attempts with backoff, honouring Retry-After.',
    idempotencyBehavior: 'Not applicable — this action never modifies data.',
  },
  inputSchema,
  outputSchema,
  examples: [
    { title: 'First page', description: 'Resolves the workspace automatically.', input: {} },
    {
      title: 'Active projects in a workspace',
      input: { workspace: '1201234567890123', archived: false, limit: 25 },
    },
    {
      title: 'Next page',
      description: 'Cursors must come from a previous response.',
      input: { cursor: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9' },
    },
  ],

  async run(input, ctx) {
    const workspace = await resolveWorkspace(input, ctx);

    const result = await ctx.client.request({
      method: 'GET',
      path: '/projects',
      schema: z.array(rawProjectSchema),
      query: {
        workspace,
        archived: input.archived,
        limit: input.limit,
        offset: input.cursor,
        opt_fields: PROJECT_OPT_FIELDS.join(','),
      },
      idempotent: true,
      actionId: 'asana.list_projects',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const projects = result.data.map(toProject);

    return {
      projects,
      workspace:
        workspace === undefined
          ? null
          : {
              id: workspace,
              // Prefer a name from the returned projects over a second lookup.
              name: projects.find((p) => p.workspace?.id === workspace)?.workspace?.name ?? null,
            },
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: projects.length,
      },
    };
  },
};
