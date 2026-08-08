/**
 * asana.update_task — update an existing Asana task.
 *
 * Asana endpoint: PUT /tasks/{task_gid}
 *
 * Two correctness problems dominate this action, and both are easy to get
 * subtly wrong:
 *
 * 1. CLEARING vs LEAVING ALONE.
 *    Asana updates only the keys present in the request body. So the request
 *    must distinguish "the caller did not mention dueOn" (send nothing) from
 *    "the caller wants dueOn cleared" (send null). Collapsing the two either
 *    makes it impossible to clear a field, or — far worse — silently wipes
 *    fields the caller never touched. The patch schema therefore uses
 *    `.nullable().optional()`, and the payload is built from the keys actually
 *    present rather than from a fixed field list.
 *
 * 2. LOST UPDATES.
 *    Read-modify-write over HTTP has no concurrency control by default: two
 *    people editing the same task means the second write silently discards the
 *    first. `ifUnmodifiedSince` provides opt-in optimistic locking.
 *
 * Unlike create and comment, this action IS idempotent — applying the same
 * patch twice leaves the task in the same state — so it may be safely retried.
 */

import { z } from 'zod';
import { TASK_OPT_FIELDS, rawTaskSchema, taskSchema, toTask } from '../schemas/asana.js';
import { clearable, dateOnlySchema, dateTimeSchema, gidSchema } from '../schemas/common.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';
import type { ActionContext, ConnectorAction } from './types.js';

/** Maps patch keys to Asana field names. The only place that mapping lives. */
const FIELD_MAP = {
  name: 'name',
  notes: 'notes',
  assignee: 'assignee',
  dueOn: 'due_on',
  dueAt: 'due_at',
  completed: 'completed',
} as const;

type PatchKey = keyof typeof FIELD_MAP;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(1024).optional().describe('New task title.'),
    notes: clearable(z.string().max(65_535)).describe('New description. Null clears it.'),
    assignee: clearable(z.string().trim().min(1)).describe(
      'User gid, email, or "me". Null unassigns the task.',
    ),
    dueOn: clearable(dateOnlySchema).describe('Due date (YYYY-MM-DD). Null clears it.'),
    dueAt: clearable(dateTimeSchema).describe('Due date-time (ISO 8601). Null clears it.'),
    completed: z.boolean().optional().describe('Completion state.'),
  })
  .describe(
    'Fields to change. Omitted fields are left untouched; an explicit null clears the field.',
  );

const inputSchema = z
  .object({
    taskId: gidSchema.describe('The Asana task gid to update.'),
    patch: patchSchema,
    ifUnmodifiedSince: z
      .string()
      .optional()
      .describe(
        'The task\'s modifiedAt value when it was loaded. When supplied, the update is rejected with ASANA_CONFLICT if the task changed since then, preventing a silent overwrite of a concurrent edit.',
      ),
  })
  /*
   * An empty patch would issue a pointless write and, worse, report success
   * for a change that never happened.
   */
  .refine((v) => Object.values(v.patch).some((value) => value !== undefined), {
    message: 'The patch must contain at least one field to update.',
    path: ['patch'],
  })
  .refine(
    (v) =>
      !(
        v.patch.dueOn !== null &&
        v.patch.dueOn !== undefined &&
        v.patch.dueAt !== null &&
        v.patch.dueAt !== undefined
      ),
    {
      message: 'Provide either dueOn or dueAt, not both.',
      path: ['patch', 'dueAt'],
    },
  );

const outputSchema = z.object({
  task: taskSchema,
  updatedFields: z
    .array(z.string())
    .describe('The patch keys that were actually sent to Asana.'),
});

export type UpdateTaskInput = z.infer<typeof inputSchema>;
export type UpdateTaskOutput = z.infer<typeof outputSchema>;

/**
 * Build the Asana payload from only the keys the caller actually supplied.
 *
 * `key in patch` distinguishes an explicit null from an absent key. A plain
 * `patch[key] !== undefined` check would be almost right, but would also drop
 * a key explicitly set to `undefined` — which is the correct behaviour, since
 * JSON cannot represent undefined and the intent is "leave it alone".
 */
export function buildUpdatePayload(patch: UpdateTaskInput['patch']): {
  body: Record<string, unknown>;
  updatedFields: string[];
} {
  const body: Record<string, unknown> = {};
  const updatedFields: string[] = [];

  for (const key of Object.keys(FIELD_MAP) as PatchKey[]) {
    if (!(key in patch)) continue;

    const value = patch[key];
    if (value === undefined) continue; // absent in intent, even if present as a key

    body[FIELD_MAP[key]] = value; // null passes through, meaning "clear this"
    updatedFields.push(key);
  }

  return { body, updatedFields };
}

/**
 * Optimistic concurrency check.
 *
 * Costs one extra read, which is why it is opt-in rather than automatic: a
 * scripted bulk update does not want to pay for it, but an interactive edit
 * form very much does.
 */
async function assertNotModified(
  input: UpdateTaskInput,
  expected: string,
  ctx: ActionContext,
): Promise<void> {
  const current = await ctx.client.request({
    method: 'GET',
    path: `/tasks/${encodeURIComponent(input.taskId)}`,
    schema: rawTaskSchema,
    query: { opt_fields: 'modified_at' },
    idempotent: true,
    actionId: 'asana.update_task',
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  ctx.recordUpstream(1, current.attempts);

  const actual = current.data.modified_at;
  if (actual === undefined || actual === expected) return;

  // Compare as instants: Asana may vary the string format even when the
  // moment is identical, and a false conflict is its own kind of bug.
  if (Date.parse(actual) === Date.parse(expected)) return;

  throw new ConnectorError(ERROR_CODES.CONFLICT, {
    message: 'The task was modified in Asana after it was loaded.',
    requestId: ctx.requestId,
    action: 'asana.update_task',
    details: [
      { field: 'ifUnmodifiedSince', message: `Expected ${expected}, but the task now reads ${actual}.` },
    ],
    guidance:
      'Refresh the task to see the newer values, then reapply your changes so the other edit is not lost.',
  });
}

export const updateTaskAction: ConnectorAction<UpdateTaskInput, UpdateTaskOutput> = {
  id: 'asana.update_task',
  name: 'Update Task',
  description:
    'Update selected fields on an Asana task. Omitted fields are left untouched; an explicit null clears a field.',
  category: 'tasks',
  supportsPagination: false,
  scopes: ['tasks:write', 'tasks:read'],
  endpoints: ['PUT /tasks/{task_gid}', 'GET /tasks/{task_gid}'],
  safety: {
    write: true,
    idempotent: true,
    risk: 'medium',
    requiresApproval: true,
    duplicateBehavior:
      'Applying the same patch twice is harmless: the task ends in the same state, and no new object is created.',
    retryBehavior:
      'Safe to retry, because the operation is idempotent. The client retries 429 and 5xx up to 2 further attempts, honouring Retry-After.',
    idempotencyBehavior:
      'Naturally idempotent, so an idempotency key is optional. Use ifUnmodifiedSince to avoid overwriting a concurrent edit.',
  },
  inputSchema,
  outputSchema,
  examples: [
    { title: 'Rename a task', input: { taskId: '1201234567890123', patch: { name: 'Updated title' } } },
    {
      title: 'Mark complete',
      input: { taskId: '1201234567890123', patch: { completed: true } },
    },
    {
      title: 'Clear the due date',
      description: 'An explicit null clears the field; omitting it would leave it unchanged.',
      input: { taskId: '1201234567890123', patch: { dueOn: null } },
    },
    {
      title: 'Safe edit with concurrency check',
      input: {
        taskId: '1201234567890123',
        patch: { notes: 'Revised description' },
        ifUnmodifiedSince: '2026-08-08T10:15:00.000Z',
      },
    },
  ],

  async run(input, ctx) {
    if (input.ifUnmodifiedSince !== undefined) {
      await assertNotModified(input, input.ifUnmodifiedSince, ctx);
    }

    const { body, updatedFields } = buildUpdatePayload(input.patch);

    const result = await ctx.client.request({
      method: 'PUT',
      path: `/tasks/${encodeURIComponent(input.taskId)}`,
      schema: rawTaskSchema,
      query: { opt_fields: TASK_OPT_FIELDS.join(',') },
      body,
      // Safe to retry: the same patch yields the same end state.
      idempotent: true,
      actionId: 'asana.update_task',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    ctx.logger.info('Updated Asana task', { taskId: input.taskId, fields: updatedFields });

    return { task: toTask(result.data), updatedFields };
  },
};
