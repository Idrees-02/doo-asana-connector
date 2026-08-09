/**
 * Extended task actions (12).
 *
 * Reads:   get_task, list_tasks, search_tasks, list_subtasks
 * Mutates: complete_task, reopen_task, assign_task, set_task_due_date,
 *          set_task_description
 * Creates: create_subtask
 * Links:   add_task_to_project, remove_task_from_project
 *
 * The five "mutate" actions are all `PUT /tasks/{gid}` underneath. They exist
 * as separate actions because a caller — especially a model — reasons far more
 * reliably about `complete_task` than about constructing the right patch for
 * `update_task`. They share one helper so the transport behaviour cannot drift
 * between them.
 */

import { z } from 'zod';
import {
  TASK_OPT_FIELDS,
  rawTaskSchema,
  taskSchema,
  toTask,
} from '../schemas/asana.js';
import {
  associationResultSchema,
  association,
  rawEmptySchema,
} from '../schemas/asana-extended.js';
import {
  dateOnlySchema,
  dateTimeSchema,
  gidSchema,
  paginationInputSchema,
  paginationOutputSchema,
} from '../schemas/common.js';
import { associateSafety, createSafety, mutateSafety, readSafety } from './safety.js';
import type { ActionContext, ConnectorAction } from './types.js';

const OPT = TASK_OPT_FIELDS.join(',');

/**
 * Shared implementation for the single-field task mutations.
 *
 * Sends only the named fields, exactly like `update_task`, so a targeted
 * change can never clobber an unrelated property.
 */
async function patchTask(
  taskId: string,
  body: Record<string, unknown>,
  actionId: string,
  ctx: ActionContext,
) {
  const result = await ctx.client.request({
    method: 'PUT',
    path: `/tasks/${encodeURIComponent(taskId)}`,
    schema: rawTaskSchema,
    query: { opt_fields: OPT },
    body,
    // PUT with a fixed body is genuinely idempotent.
    idempotent: true,
    actionId,
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  ctx.recordUpstream(1, result.attempts);
  return toTask(result.data);
}

const taskOutput = z.object({ task: taskSchema });

/* ========================================================================== */
/* asana.get_task                                                              */
/* ========================================================================== */

const getTaskInput = z.object({ taskId: gidSchema.describe('The Asana task gid to fetch.') });

export const getTaskAction: ConnectorAction<z.infer<typeof getTaskInput>, z.infer<typeof taskOutput>> = {
  id: 'asana.get_task',
  name: 'Get Task',
  description: 'Fetch a single Asana task by id, with assignee, due date, projects and tags.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:read'],
  endpoints: ['GET /tasks/{task_gid}'],
  safety: readSafety(),
  inputSchema: getTaskInput,
  outputSchema: taskOutput,
  examples: [{ title: 'Fetch a task', input: { taskId: '1201234567890123' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(input.taskId)}`,
      schema: rawTaskSchema,
      query: { opt_fields: OPT },
      idempotent: true,
      actionId: 'asana.get_task',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);
    return { task: toTask(result.data) };
  },
};

/* ========================================================================== */
/* asana.list_tasks                                                            */
/* ========================================================================== */

const listTasksInput = paginationInputSchema
  .extend({
    project: gidSchema.optional().describe('Filter to a project.'),
    section: gidSchema.optional().describe('Filter to a section.'),
    tag: gidSchema.optional().describe('Filter to a tag.'),
    assignee: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('User gid, email or "me". Must be combined with workspace.'),
    workspace: gidSchema.optional().describe('Required when filtering by assignee.'),
    completedSince: z
      .union([dateTimeSchema, z.literal('now')])
      .optional()
      .describe('Return incomplete tasks plus those completed since this time.'),
  })
  /*
   * Asana rejects an unfiltered /tasks call with a terse "project: Missing
   * input". Enforcing the documented combinations here turns that into a
   * precise message before any network call is made.
   */
  .refine(
    (v) =>
      v.project !== undefined ||
      v.section !== undefined ||
      v.tag !== undefined ||
      (v.assignee !== undefined && v.workspace !== undefined),
    {
      message:
        'Provide one of: project, section, tag, or assignee together with workspace. Asana rejects an unfiltered task list.',
      path: ['project'],
    },
  );

const listTasksOutput = z.object({
  tasks: z.array(taskSchema),
  pagination: paginationOutputSchema,
});

export const listTasksAction: ConnectorAction<
  z.infer<typeof listTasksInput>,
  z.infer<typeof listTasksOutput>
> = {
  id: 'asana.list_tasks',
  name: 'List Tasks',
  description:
    'List tasks filtered by project, section, tag, or assignee within a workspace. At least one filter is required by Asana.',
  category: 'tasks',
  supportsPagination: true,
  scopes: ['tasks:read'],
  endpoints: ['GET /tasks'],
  safety: readSafety(),
  inputSchema: listTasksInput,
  outputSchema: listTasksOutput,
  examples: [
    { title: 'Tasks in a project', input: { project: '1201234567890123', limit: 25 } },
    { title: 'My open tasks', input: { assignee: 'me', workspace: '1201234567890000', completedSince: 'now' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: '/tasks',
      schema: z.array(rawTaskSchema),
      query: {
        project: input.project,
        section: input.section,
        tag: input.tag,
        assignee: input.assignee,
        workspace: input.workspace,
        completed_since: input.completedSince,
        limit: input.limit,
        offset: input.cursor,
        opt_fields: OPT,
      },
      idempotent: true,
      actionId: 'asana.list_tasks',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const tasks = result.data.map(toTask);
    return {
      tasks,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: tasks.length,
      },
    };
  },
};

/* ========================================================================== */
/* asana.search_tasks                                                          */
/* ========================================================================== */

const searchTasksInput = z.object({
  workspace: gidSchema.describe('Workspace to search within. Required by Asana.'),
  text: z.string().trim().min(1).optional().describe('Full-text search across task names and descriptions.'),
  assignee: z.string().trim().min(1).optional().describe('Comma-separated user gids, emails, or "me".'),
  projects: z.string().trim().min(1).optional().describe('Comma-separated project gids.'),
  completed: z.boolean().optional().describe('Filter by completion state.'),
  sortBy: z
    .enum(['due_date', 'created_at', 'completed_at', 'likes', 'modified_at', 'relevance'])
    .default('relevance')
    .describe('Sort field.'),
  sortAscending: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum results (1–100).'),
});

const searchTasksOutput = z.object({
  tasks: z.array(taskSchema),
  returned: z.number().int(),
  /** Search has no stable cursor, so this is surfaced rather than faked. */
  paginated: z
    .literal(false)
    .describe(
      'Asana search results are not stable across queries, so cursor pagination is unavailable. Narrow the query or raise limit instead.',
    ),
});

export const searchTasksAction: ConnectorAction<
  z.infer<typeof searchTasksInput>,
  z.infer<typeof searchTasksOutput>
> = {
  id: 'asana.search_tasks',
  name: 'Search Tasks',
  description:
    'Full-text search for tasks in a workspace. Requires an Asana premium plan — free accounts receive ASANA_PAYMENT_REQUIRED.',
  category: 'tasks',
  // Genuinely false: Asana states search results are unstable across queries,
  // so offering a cursor would hand out one that cannot be relied upon.
  supportsPagination: false,
  scopes: ['tasks:read'],
  endpoints: ['GET /workspaces/{workspace_gid}/tasks/search'],
  safety: readSafety(),
  inputSchema: searchTasksInput,
  outputSchema: searchTasksOutput,
  examples: [
    { title: 'Search by text', input: { workspace: '1201234567890000', text: 'launch documentation' } },
    {
      title: 'My incomplete tasks',
      description: 'Sorted by due date.',
      input: { workspace: '1201234567890000', assignee: 'me', completed: false, sortBy: 'due_date', sortAscending: true },
    },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/workspaces/${encodeURIComponent(input.workspace)}/tasks/search`,
      schema: z.array(rawTaskSchema),
      query: {
        text: input.text,
        'assignee.any': input.assignee,
        'projects.any': input.projects,
        completed: input.completed,
        sort_by: input.sortBy,
        sort_ascending: input.sortAscending,
        limit: input.limit,
        opt_fields: OPT,
      },
      idempotent: true,
      actionId: 'asana.search_tasks',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const tasks = result.data.map(toTask);
    return { tasks, returned: tasks.length, paginated: false as const };
  },
};

/* ========================================================================== */
/* asana.list_subtasks                                                         */
/* ========================================================================== */

const listSubtasksInput = paginationInputSchema.extend({
  taskId: gidSchema.describe('Parent task gid.'),
});

const listSubtasksOutput = z.object({
  subtasks: z.array(taskSchema),
  parentTaskId: z.string(),
  pagination: paginationOutputSchema,
});

export const listSubtasksAction: ConnectorAction<
  z.infer<typeof listSubtasksInput>,
  z.infer<typeof listSubtasksOutput>
> = {
  id: 'asana.list_subtasks',
  name: 'List Subtasks',
  description: 'List the subtasks of an Asana task.',
  category: 'tasks',
  supportsPagination: true,
  scopes: ['tasks:read'],
  endpoints: ['GET /tasks/{task_gid}/subtasks'],
  safety: readSafety(),
  inputSchema: listSubtasksInput,
  outputSchema: listSubtasksOutput,
  examples: [{ title: 'Subtasks of a task', input: { taskId: '1201234567890123' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(input.taskId)}/subtasks`,
      schema: z.array(rawTaskSchema),
      query: { limit: input.limit, offset: input.cursor, opt_fields: OPT },
      idempotent: true,
      actionId: 'asana.list_subtasks',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const subtasks = result.data.map(toTask);
    return {
      subtasks,
      parentTaskId: input.taskId,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: subtasks.length,
      },
    };
  },
};

/* ========================================================================== */
/* Single-field mutations                                                      */
/* ========================================================================== */

const completeInput = z.object({ taskId: gidSchema });

export const completeTaskAction: ConnectorAction<
  z.infer<typeof completeInput>,
  z.infer<typeof taskOutput>
> = {
  id: 'asana.complete_task',
  name: 'Complete Task',
  description: 'Mark an Asana task as complete.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['PUT /tasks/{task_gid}'],
  safety: mutateSafety('the task is complete either way'),
  inputSchema: completeInput,
  outputSchema: taskOutput,
  examples: [{ title: 'Complete a task', input: { taskId: '1201234567890123' } }],
  async run(input, ctx) {
    return { task: await patchTask(input.taskId, { completed: true }, 'asana.complete_task', ctx) };
  },
};

export const reopenTaskAction: ConnectorAction<
  z.infer<typeof completeInput>,
  z.infer<typeof taskOutput>
> = {
  id: 'asana.reopen_task',
  name: 'Reopen Task',
  description: 'Mark a completed Asana task as incomplete.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['PUT /tasks/{task_gid}'],
  safety: mutateSafety('the task is incomplete either way'),
  inputSchema: completeInput,
  outputSchema: taskOutput,
  examples: [{ title: 'Reopen a task', input: { taskId: '1201234567890123' } }],
  async run(input, ctx) {
    return { task: await patchTask(input.taskId, { completed: false }, 'asana.reopen_task', ctx) };
  },
};

const assignInput = z.object({
  taskId: gidSchema,
  assignee: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('User gid, email, or "me". Pass null to unassign the task.'),
});

export const assignTaskAction: ConnectorAction<
  z.infer<typeof assignInput>,
  z.infer<typeof taskOutput>
> = {
  id: 'asana.assign_task',
  name: 'Assign Task',
  description: 'Assign an Asana task to a user, or unassign it with null.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['PUT /tasks/{task_gid}'],
  safety: mutateSafety('the task ends with the same assignee'),
  inputSchema: assignInput,
  outputSchema: taskOutput,
  examples: [
    { title: 'Assign to me', input: { taskId: '1201234567890123', assignee: 'me' } },
    { title: 'Unassign', input: { taskId: '1201234567890123', assignee: null } },
  ],
  async run(input, ctx) {
    // null passes through to Asana, which clears the assignee.
    return {
      task: await patchTask(input.taskId, { assignee: input.assignee }, 'asana.assign_task', ctx),
    };
  },
};

const dueDateInput = z
  .object({
    taskId: gidSchema,
    dueOn: dateOnlySchema.nullable().optional().describe('Date (YYYY-MM-DD). Null clears it.'),
    dueAt: dateTimeSchema.nullable().optional().describe('Date-time (ISO 8601). Null clears it.'),
  })
  .refine((v) => v.dueOn !== undefined || v.dueAt !== undefined, {
    message: 'Provide dueOn or dueAt. Pass null to clear the due date.',
    path: ['dueOn'],
  })
  // Asana rejects both together, and sending both would silently lose one.
  .refine(
    (v) =>
      !(v.dueOn !== null && v.dueOn !== undefined && v.dueAt !== null && v.dueAt !== undefined),
    { message: 'Provide either dueOn or dueAt, not both.', path: ['dueAt'] },
  );

export const setTaskDueDateAction: ConnectorAction<
  z.infer<typeof dueDateInput>,
  z.infer<typeof taskOutput>
> = {
  id: 'asana.set_task_due_date',
  name: 'Set Task Due Date',
  description: 'Set or clear the due date of an Asana task.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['PUT /tasks/{task_gid}'],
  safety: mutateSafety('the task ends with the same due date'),
  inputSchema: dueDateInput,
  outputSchema: taskOutput,
  examples: [
    { title: 'Set a due date', input: { taskId: '1201234567890123', dueOn: '2026-09-01' } },
    { title: 'Clear the due date', input: { taskId: '1201234567890123', dueOn: null } },
  ],
  async run(input, ctx) {
    // Only the key the caller actually supplied is sent.
    const body: Record<string, unknown> = {};
    if ('dueOn' in input && input.dueOn !== undefined) body['due_on'] = input.dueOn;
    if ('dueAt' in input && input.dueAt !== undefined) body['due_at'] = input.dueAt;

    return { task: await patchTask(input.taskId, body, 'asana.set_task_due_date', ctx) };
  },
};

const descriptionInput = z.object({
  taskId: gidSchema,
  notes: z
    .string()
    .max(65_535)
    .describe('The new plain-text description. An empty string clears it.'),
});

export const setTaskDescriptionAction: ConnectorAction<
  z.infer<typeof descriptionInput>,
  z.infer<typeof taskOutput>
> = {
  id: 'asana.set_task_description',
  name: 'Set Task Description',
  description: 'Replace the plain-text description (notes) of an Asana task.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['PUT /tasks/{task_gid}'],
  safety: mutateSafety('the task ends with the same description'),
  inputSchema: descriptionInput,
  outputSchema: taskOutput,
  examples: [
    { title: 'Set a description', input: { taskId: '1201234567890123', notes: 'Revised scope.' } },
  ],
  async run(input, ctx) {
    return {
      task: await patchTask(input.taskId, { notes: input.notes }, 'asana.set_task_description', ctx),
    };
  },
};

/* ========================================================================== */
/* asana.create_subtask                                                        */
/* ========================================================================== */

const createSubtaskInput = z.object({
  taskId: gidSchema.describe('Parent task gid.'),
  name: z.string().trim().min(1, 'A subtask name is required.').max(1024),
  notes: z.string().max(65_535).optional(),
  assignee: z.string().trim().min(1).optional().describe('User gid, email, or "me".'),
  dueOn: dateOnlySchema.optional(),
});

const createSubtaskOutput = z.object({ subtask: taskSchema, parentTaskId: z.string(), created: z.literal(true) });

export const createSubtaskAction: ConnectorAction<
  z.infer<typeof createSubtaskInput>,
  z.infer<typeof createSubtaskOutput>
> = {
  id: 'asana.create_subtask',
  name: 'Create Subtask',
  description: 'Create a subtask beneath an existing Asana task.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks/{task_gid}/subtasks'],
  safety: createSafety('subtask'),
  inputSchema: createSubtaskInput,
  outputSchema: createSubtaskOutput,
  examples: [
    { title: 'Add a subtask', input: { taskId: '1201234567890123', name: 'Draft the outline' } },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = { name: input.name };
    if (input.notes !== undefined) body['notes'] = input.notes;
    if (input.assignee !== undefined) body['assignee'] = input.assignee;
    if (input.dueOn !== undefined) body['due_on'] = input.dueOn;

    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/subtasks`,
      schema: rawTaskSchema,
      query: { opt_fields: OPT },
      body,
      // Never retried: a repeat creates a second subtask.
      idempotent: false,
      actionId: 'asana.create_subtask',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return { subtask: toTask(result.data), parentTaskId: input.taskId, created: true as const };
  },
};

/* ========================================================================== */
/* Task <-> project association                                                */
/* ========================================================================== */

const addToProjectInput = z.object({
  taskId: gidSchema,
  projectId: gidSchema.describe('Project to add the task to.'),
  section: gidSchema.optional().describe('Optional section within the project.'),
});

export const addTaskToProjectAction: ConnectorAction<
  z.infer<typeof addToProjectInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.add_task_to_project',
  name: 'Add Task to Project',
  description: 'Add an existing Asana task to a project, optionally into a specific section.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks/{task_gid}/addProject'],
  safety: associateSafety('a task is either in the project or it is not.'),
  inputSchema: addToProjectInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Add to a project', input: { taskId: '1201234567890123', projectId: '1201234567890999' } },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = { project: input.projectId };
    if (input.section !== undefined) body['section'] = input.section;

    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/addProject`,
      // Asana returns an empty data block for association changes.
      schema: rawEmptySchema,
      body,
      idempotent: true,
      actionId: 'asana.add_task_to_project',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('task', input.taskId, 'project', input.projectId);
  },
};

const removeFromProjectInput = z.object({ taskId: gidSchema, projectId: gidSchema });

export const removeTaskFromProjectAction: ConnectorAction<
  z.infer<typeof removeFromProjectInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.remove_task_from_project',
  name: 'Remove Task from Project',
  description:
    'Remove a task from a project. The task itself is not deleted — it remains in Asana and in any other projects.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks/{task_gid}/removeProject'],
  safety: associateSafety('a task is either in the project or it is not.'),
  inputSchema: removeFromProjectInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Remove from a project', input: { taskId: '1201234567890123', projectId: '1201234567890999' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/removeProject`,
      schema: rawEmptySchema,
      body: { project: input.projectId },
      idempotent: true,
      actionId: 'asana.remove_task_from_project',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('task', input.taskId, 'project', input.projectId);
  },
};
