/**
 * asana.add_comment — add a comment to an Asana task.
 *
 * Asana endpoint: POST /tasks/{task_gid}/stories
 *
 * Asana models comments as "stories". Only stories with type `comment` are
 * user-authored; the same collection also carries system stories ("X assigned
 * this to Y"), which is why the response reports `type`.
 *
 * WRITE ACTION, and duplicates here are especially visible — a comment posted
 * twice is immediately obvious to every follower of the task, and Asana
 * provides no way to merge them. So, as with create, this is never retried
 * automatically.
 */

import { z } from 'zod';
import { STORY_OPT_FIELDS, commentSchema, rawStorySchema, toComment } from '../schemas/asana.js';
import { gidSchema } from '../schemas/common.js';
import type { ConnectorAction } from './types.js';

const inputSchema = z.object({
  taskId: gidSchema.describe('The Asana task gid to comment on.'),
  text: z
    .string()
    /*
     * Trim before validating, so a body of only whitespace is rejected as
     * empty rather than posting a blank comment that cannot be deleted
     * through this connector.
     */
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'A comment cannot be empty.')
        .max(65_535, 'Comments are limited to 65535 characters.'),
    )
    .describe('The plain-text comment body. Leading and trailing whitespace is trimmed.'),
});

const outputSchema = z.object({
  comment: commentSchema,
  taskId: z.string(),
});

export type AddCommentInput = z.infer<typeof inputSchema>;
export type AddCommentOutput = z.infer<typeof outputSchema>;

export const addCommentAction: ConnectorAction<AddCommentInput, AddCommentOutput> = {
  id: 'asana.add_comment',
  name: 'Add Comment',
  description: 'Post a plain-text comment onto an Asana task.',
  category: 'comments',
  supportsPagination: false,
  scopes: ['stories:write'],
  endpoints: ['POST /tasks/{task_gid}/stories'],
  safety: {
    write: true,
    idempotent: false,
    risk: 'medium',
    requiresApproval: true,
    duplicateBehavior:
      'Calling this twice posts two separate comments. They are visible to every task follower, and this connector cannot delete them.',
    retryBehavior:
      'NEVER retried automatically. A failed request may already have posted the comment, so the connector reports retryStrategy=manual_with_idempotency_key rather than risking a double post.',
    idempotencyBehavior:
      'Supply idempotencyKey to make deliberate retries safe: a repeated key replays the original result instead of posting again. Process-local, 15-minute TTL. The console additionally warns before re-posting identical text within 60 seconds.',
  },
  inputSchema,
  outputSchema,
  examples: [
    {
      title: 'Add a comment',
      input: { taskId: '1201234567890123', text: 'Verified against the sandbox workspace.' },
    },
  ],

  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/stories`,
      schema: rawStorySchema,
      query: { opt_fields: STORY_OPT_FIELDS.join(',') },
      // `text` and `html_text` are mutually exclusive in Asana; we send only text.
      body: { text: input.text },
      // Never retried: a duplicate comment is immediately visible and permanent.
      idempotent: false,
      actionId: 'asana.add_comment',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    ctx.logger.info('Added Asana comment', { taskId: input.taskId, commentId: result.data.gid });

    return { comment: toComment(result.data), taskId: input.taskId };
  },
};
