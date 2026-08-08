/**
 * asana.create_task — create a new Asana task.
 *
 * Asana endpoint: POST /tasks
 *
 * WRITE ACTION. This is the most consequential of the five, because a
 * duplicate is both easy to produce and annoying to clean up. Three
 * protections apply, and it is worth being precise about what each one does:
 *
 *   1. The transport layer will NOT retry this request. Not on 429, not on
 *      5xx, not on timeout. A create that times out may well have succeeded.
 *   2. It requires explicit approval, so it cannot fire as an incidental
 *      side effect of an agent exploring the action list.
 *   3. An optional idempotency key deduplicates deliberate retries — within
 *      this process only. See docs/WRITE-SAFETY.md for the limits.
 */

import { z } from 'zod';
import { TASK_OPT_FIELDS, rawTaskSchema, taskSchema, toTask } from '../schemas/asana.js';
import { dateOnlySchema, dateTimeSchema, gidSchema } from '../schemas/common.js';
import type { ConnectorAction } from './types.js';

const inputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'A task name is required.')
      .max(1024, 'Task names are limited to 1024 characters.')
      .describe('The task title.'),
    notes: z
      .string()
      .max(65_535, 'Notes are limited to 65535 characters.')
      .optional()
      .describe('Plain-text task description.'),
    projectId: gidSchema
      .optional()
      .describe('Project to add the task to. Either projectId or workspace is required.'),
    workspace: gidSchema
      .optional()
      .describe('Workspace to create the task in. Required when projectId is omitted.'),
    assignee: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Assignee as a user gid, an email address, or the literal "me".'),
    dueOn: dateOnlySchema.optional().describe('Due date (YYYY-MM-DD). Mutually exclusive with dueAt.'),
    dueAt: dateTimeSchema
      .optional()
      .describe('Due date-time (ISO 8601). Mutually exclusive with dueOn.'),
    followers: z
      .array(z.string().trim().min(1))
      .max(50)
      .optional()
      .describe('User gids or email addresses to add as followers.'),
  })
  /*
   * Asana requires a workspace unless the task is created directly into a
   * project. Catching that here converts a confusing 400 into a precise,
   * field-level message before any network call is made.
   */
  .refine((v) => v.projectId !== undefined || v.workspace !== undefined, {
    message: 'Either projectId or workspace must be provided.',
    path: ['projectId'],
  })
  /*
   * Asana rejects both date fields together. Enforcing it locally also stops
   * a caller silently losing whichever value the API decides to drop.
   */
  .refine((v) => !(v.dueOn !== undefined && v.dueAt !== undefined), {
    message: 'Provide either dueOn or dueAt, not both.',
    path: ['dueAt'],
  });

const outputSchema = z.object({
  task: taskSchema,
  created: z.literal(true),
});

export type CreateTaskInput = z.infer<typeof inputSchema>;
export type CreateTaskOutput = z.infer<typeof outputSchema>;

export const createTaskAction: ConnectorAction<CreateTaskInput, CreateTaskOutput> = {
  id: 'asana.create_task',
  name: 'Create Task',
  description: 'Create a new task in an Asana project or workspace.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks'],
  safety: {
    write: true,
    idempotent: false,
    risk: 'medium',
    requiresApproval: true,
    duplicateBehavior:
      'Asana has no server-side deduplication: calling this twice creates two separate tasks with different gids.',
    retryBehavior:
      'NEVER retried automatically. A failed create may already have succeeded (particularly on timeout), so the connector reports retryStrategy=manual_with_idempotency_key and leaves the decision to the caller.',
    idempotencyBehavior:
      'Supply idempotencyKey to make deliberate retries safe: a repeated key replays the original result instead of creating a second task. Process-local and 15-minute TTL — it does not survive a restart.',
  },
  inputSchema,
  outputSchema,
  examples: [
    {
      title: 'Minimal task in a project',
      input: { projectId: '1201234567890123', name: 'Prepare launch documentation' },
    },
    {
      title: 'Full task',
      input: {
        projectId: '1201234567890123',
        name: 'Validate MCP endpoint',
        notes: 'Confirm all five tools are exposed and schemas match the connector.',
        assignee: 'me',
        dueOn: '2026-09-01',
      },
    },
  ],

  async run(input, ctx) {
    /*
     * Build the payload from only the fields the caller supplied. Sending
     * explicit nulls for untouched fields would ask Asana to clear them.
     */
    const body: Record<string, unknown> = { name: input.name };

    if (input.notes !== undefined) body['notes'] = input.notes;
    if (input.projectId !== undefined) body['projects'] = [input.projectId];
    if (input.workspace !== undefined) body['workspace'] = input.workspace;
    if (input.assignee !== undefined) body['assignee'] = input.assignee;
    if (input.dueOn !== undefined) body['due_on'] = input.dueOn;
    if (input.dueAt !== undefined) body['due_at'] = input.dueAt;
    if (input.followers !== undefined) body['followers'] = input.followers;

    const result = await ctx.client.request({
      method: 'POST',
      path: '/tasks',
      schema: rawTaskSchema,
      query: { opt_fields: TASK_OPT_FIELDS.join(',') },
      body,
      // The single most important flag in this file.
      idempotent: false,
      actionId: 'asana.create_task',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const task = toTask(result.data);
    ctx.logger.info('Created Asana task', { taskId: task.id, project: input.projectId });

    return { task, created: true };
  },
};
