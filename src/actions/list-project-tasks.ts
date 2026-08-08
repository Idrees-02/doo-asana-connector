/**
 * asana.list_project_tasks — retrieve tasks belonging to a project.
 *
 * Asana endpoint: GET /projects/{project_gid}/tasks
 */

import { z } from 'zod';
import { TASK_OPT_FIELDS, rawTaskSchema, taskSchema, toTask } from '../schemas/asana.js';
import {
  dateTimeSchema,
  gidSchema,
  paginationInputSchema,
  paginationOutputSchema,
} from '../schemas/common.js';
import type { ConnectorAction } from './types.js';

const inputSchema = paginationInputSchema
  .extend({
    projectId: gidSchema.describe('The Asana project gid whose tasks should be returned.'),
    includeCompleted: z
      .boolean()
      .default(true)
      .describe(
        'When false, only incomplete tasks are returned (implemented via completed_since=now).',
      ),
    completedSince: z
      .union([dateTimeSchema, z.literal('now')])
      .optional()
      .describe(
        'Return incomplete tasks plus those completed since this time. Takes precedence over includeCompleted.',
      ),
  })
  .describe('Tasks for a single Asana project.');

const outputSchema = z.object({
  tasks: z.array(taskSchema),
  projectId: z.string(),
  pagination: paginationOutputSchema,
});

export type ListProjectTasksInput = z.infer<typeof inputSchema>;
export type ListProjectTasksOutput = z.infer<typeof outputSchema>;

export const listProjectTasksAction: ConnectorAction<
  ListProjectTasksInput,
  ListProjectTasksOutput
> = {
  id: 'asana.list_project_tasks',
  name: 'List Project Tasks',
  description: 'Fetch tasks in an Asana project, with optional completion filtering and pagination.',
  category: 'tasks',
  supportsPagination: true,
  scopes: ['tasks:read'],
  endpoints: ['GET /projects/{project_gid}/tasks'],
  safety: {
    write: false,
    idempotent: true,
    risk: 'low',
    requiresApproval: false,
    duplicateBehavior: 'None. Reads have no side effects.',
    retryBehavior:
      'Safe to retry automatically. The client retries 429 and 5xx up to 3 attempts with backoff, honouring Retry-After.',
    idempotencyBehavior: 'Not applicable — this action never modifies data.',
  },
  inputSchema,
  outputSchema,
  examples: [
    { title: 'All tasks in a project', input: { projectId: '1201234567890123' } },
    {
      title: 'Incomplete tasks only',
      input: { projectId: '1201234567890123', includeCompleted: false, limit: 25 },
    },
    {
      title: 'Recently completed and open tasks',
      input: { projectId: '1201234567890123', completedSince: '2026-08-01T00:00:00Z' },
    },
  ],

  async run(input, ctx) {
    /*
     * Asana has no "only incomplete" flag. `completed_since` returns tasks that
     * are incomplete OR were completed after the given time, so passing `now`
     * yields incomplete tasks only. Expressing that as a plain boolean spares
     * every caller from having to know the trick.
     */
    const completedSince =
      input.completedSince ?? (input.includeCompleted ? undefined : 'now');

    const result = await ctx.client.request({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/tasks`,
      schema: z.array(rawTaskSchema),
      query: {
        limit: input.limit,
        offset: input.cursor,
        completed_since: completedSince,
        opt_fields: TASK_OPT_FIELDS.join(','),
      },
      idempotent: true,
      actionId: 'asana.list_project_tasks',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const tasks = result.data.map(toTask);

    return {
      tasks,
      projectId: input.projectId,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: tasks.length,
      },
    };
  },
};
