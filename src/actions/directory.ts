/**
 * User, comment and tag actions (8).
 *
 * Users: get_current_user, get_user, list_users
 * Comments: list_comments
 * Tags: list_tags, create_tag, add_tag_to_task, remove_tag_from_task
 *
 * `list_comments` reads Asana "stories", which include system-generated
 * entries ("X assigned this to Y") alongside user comments. The action filters
 * to real comments by default, because a caller asking for comments almost
 * never wants the audit trail — but the filter is opt-out, not hard-coded.
 */

import { z } from 'zod';
import {
  STORY_OPT_FIELDS,
  USER_OPT_FIELDS,
  commentSchema,
  rawStorySchema,
  rawUserSchema,
  rawWorkspaceSchema,
  toComment,
  toUser,
  userSchema,
  workspaceSchema,
} from '../schemas/asana.js';
import {
  TAG_OPT_FIELDS,
  association,
  associationResultSchema,
  rawEmptySchema,
  rawTagSchema,
  tagSchema,
  toTag,
} from '../schemas/asana-extended.js';
import { gidSchema, paginationInputSchema, paginationOutputSchema } from '../schemas/common.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';
import { associateSafety, createSafety, readSafety } from './safety.js';
import type { ConnectorAction } from './types.js';

const USER_OPT = USER_OPT_FIELDS.join(',');
const TAG_OPT = TAG_OPT_FIELDS.join(',');

/* ========================================================================== */
/* Users                                                                       */
/* ========================================================================== */

const currentUserOutput = z.object({
  user: userSchema,
  workspaces: z.array(workspaceSchema),
});

export const getCurrentUserAction: ConnectorAction<
  Record<string, never>,
  z.infer<typeof currentUserOutput>
> = {
  id: 'asana.get_current_user',
  name: 'Get Current User',
  description:
    'Fetch the authenticated Asana user and the workspaces they can see. Read-only, with no side effects.',
  category: 'users',
  supportsPagination: false,
  scopes: ['users:read'],
  endpoints: ['GET /users/me'],
  safety: readSafety(),
  inputSchema: z.object({}).strict(),
  outputSchema: currentUserOutput,
  examples: [{ title: 'Who am I?', input: {} }],
  async run(_input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: '/users/me',
      schema: rawUserSchema.extend({ workspaces: z.array(rawWorkspaceSchema).optional() }),
      query: { opt_fields: USER_OPT },
      idempotent: true,
      actionId: 'asana.get_current_user',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const user = toUser(result.data);
    if (user === null) {
      throw new ConnectorError(ERROR_CODES.INVALID_RESPONSE, {
        message: 'Asana returned no user record for the authenticated account.',
        requestId: ctx.requestId,
        action: 'asana.get_current_user',
      });
    }

    return {
      user,
      workspaces: (result.data.workspaces ?? []).map((w) => ({
        id: w.gid,
        name: w.name ?? null,
        isOrganization: w.is_organization ?? null,
      })),
    };
  },
};

const getUserInput = z.object({
  userId: z
    .string()
    .trim()
    .min(1)
    .describe('A user gid, an email address, or the literal "me".'),
});

export const getUserAction: ConnectorAction<
  z.infer<typeof getUserInput>,
  { user: z.infer<typeof userSchema> }
> = {
  id: 'asana.get_user',
  name: 'Get User',
  description: 'Fetch a single Asana user by gid, email, or "me".',
  category: 'users',
  supportsPagination: false,
  scopes: ['users:read'],
  endpoints: ['GET /users/{user_gid}'],
  safety: readSafety(),
  inputSchema: getUserInput,
  outputSchema: z.object({ user: userSchema }),
  examples: [
    { title: 'By gid', input: { userId: '1201234567890101' } },
    { title: 'By email', input: { userId: 'teammate@example.com' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/users/${encodeURIComponent(input.userId)}`,
      schema: rawUserSchema,
      query: { opt_fields: USER_OPT },
      idempotent: true,
      actionId: 'asana.get_user',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const user = toUser(result.data);
    if (user === null) {
      throw new ConnectorError(ERROR_CODES.NOT_FOUND, {
        message: 'No Asana user matched that identifier.',
        requestId: ctx.requestId,
        action: 'asana.get_user',
      });
    }
    return { user };
  },
};

const listUsersInput = paginationInputSchema.extend({
  workspace: gidSchema
    .optional()
    .describe('Restrict to one workspace. Recommended — otherwise Asana returns users across all accessible workspaces.'),
  team: gidSchema.optional().describe('Restrict to one team.'),
});

const listUsersOutput = z.object({
  users: z.array(userSchema),
  pagination: paginationOutputSchema,
});

export const listUsersAction: ConnectorAction<
  z.infer<typeof listUsersInput>,
  z.infer<typeof listUsersOutput>
> = {
  id: 'asana.list_users',
  name: 'List Users',
  description: 'List Asana users, optionally filtered to a workspace or team.',
  category: 'users',
  supportsPagination: true,
  scopes: ['users:read'],
  endpoints: ['GET /users'],
  safety: readSafety(),
  inputSchema: listUsersInput,
  outputSchema: listUsersOutput,
  examples: [
    { title: 'Users in a workspace', input: { workspace: '1201234567890000', limit: 50 } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: '/users',
      schema: z.array(rawUserSchema),
      query: {
        workspace: input.workspace,
        team: input.team,
        limit: input.limit,
        offset: input.cursor,
        opt_fields: 'name,email',
      },
      idempotent: true,
      actionId: 'asana.list_users',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const users = result.data
      .map(toUser)
      .filter((u): u is NonNullable<typeof u> => u !== null);

    return {
      users,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: users.length,
      },
    };
  },
};

/* ========================================================================== */
/* Comments                                                                    */
/* ========================================================================== */

const listCommentsInput = paginationInputSchema.extend({
  taskId: gidSchema,
  includeSystemStories: z
    .boolean()
    .default(false)
    .describe(
      'Asana stores comments and system events ("X assigned this to Y") in the same collection. False returns only user-authored comments.',
    ),
});

const listCommentsOutput = z.object({
  comments: z.array(commentSchema),
  taskId: z.string(),
  pagination: paginationOutputSchema,
});

export const listCommentsAction: ConnectorAction<
  z.infer<typeof listCommentsInput>,
  z.infer<typeof listCommentsOutput>
> = {
  id: 'asana.list_comments',
  name: 'List Comments',
  description:
    'List the comments on an Asana task. System-generated activity entries are excluded by default.',
  category: 'comments',
  supportsPagination: true,
  scopes: ['stories:read'],
  endpoints: ['GET /tasks/{task_gid}/stories'],
  safety: readSafety(),
  inputSchema: listCommentsInput,
  outputSchema: listCommentsOutput,
  examples: [
    { title: 'Comments on a task', input: { taskId: '1201234567890123' } },
    {
      title: 'Include the activity trail',
      input: { taskId: '1201234567890123', includeSystemStories: true },
    },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(input.taskId)}/stories`,
      schema: z.array(rawStorySchema),
      query: { limit: input.limit, offset: input.cursor, opt_fields: STORY_OPT_FIELDS.join(',') },
      idempotent: true,
      actionId: 'asana.list_comments',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    /*
     * Filter client-side: Asana has no server-side "comments only" parameter,
     * so `returned` reflects what the caller actually receives rather than
     * what the page contained.
     */
    const comments = result.data
      .map(toComment)
      .filter((c) => input.includeSystemStories || c.type === 'comment');

    return {
      comments,
      taskId: input.taskId,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: comments.length,
      },
    };
  },
};

/* ========================================================================== */
/* Tags                                                                        */
/* ========================================================================== */

const listTagsInput = paginationInputSchema.extend({
  workspace: gidSchema.optional().describe('Restrict to one workspace.'),
});

const listTagsOutput = z.object({
  tags: z.array(tagSchema),
  pagination: paginationOutputSchema,
});

export const listTagsAction: ConnectorAction<
  z.infer<typeof listTagsInput>,
  z.infer<typeof listTagsOutput>
> = {
  id: 'asana.list_tags',
  name: 'List Tags',
  description: 'List Asana tags, optionally filtered to a workspace.',
  category: 'tags',
  supportsPagination: true,
  scopes: ['tags:read'],
  endpoints: ['GET /tags'],
  safety: readSafety(),
  inputSchema: listTagsInput,
  outputSchema: listTagsOutput,
  examples: [{ title: 'Tags in a workspace', input: { workspace: '1201234567890000' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: '/tags',
      schema: z.array(rawTagSchema),
      query: {
        workspace: input.workspace,
        limit: input.limit,
        offset: input.cursor,
        opt_fields: TAG_OPT,
      },
      idempotent: true,
      actionId: 'asana.list_tags',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const tags = result.data.map(toTag);
    return {
      tags,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: tags.length,
      },
    };
  },
};

const createTagInput = z.object({
  name: z.string().trim().min(1, 'A tag name is required.').max(1024),
  workspace: gidSchema.describe('Workspace to create the tag in. Required by Asana.'),
  color: z.string().trim().min(1).optional().describe('Asana colour name, e.g. "light-green".'),
  notes: z.string().max(65_535).optional(),
});

const createTagOutput = z.object({ tag: tagSchema, created: z.literal(true) });

export const createTagAction: ConnectorAction<
  z.infer<typeof createTagInput>,
  z.infer<typeof createTagOutput>
> = {
  id: 'asana.create_tag',
  name: 'Create Tag',
  description: 'Create a new Asana tag in a workspace.',
  category: 'tags',
  supportsPagination: false,
  scopes: ['tags:write'],
  endpoints: ['POST /tags'],
  safety: createSafety('tag'),
  inputSchema: createTagInput,
  outputSchema: createTagOutput,
  examples: [
    { title: 'Create a tag', input: { name: 'launch-blocker', workspace: '1201234567890000' } },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = { name: input.name, workspace: input.workspace };
    if (input.color !== undefined) body['color'] = input.color;
    if (input.notes !== undefined) body['notes'] = input.notes;

    const result = await ctx.client.request({
      method: 'POST',
      path: '/tags',
      schema: rawTagSchema,
      query: { opt_fields: TAG_OPT },
      body,
      idempotent: false,
      actionId: 'asana.create_tag',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return { tag: toTag(result.data), created: true as const };
  },
};

const tagChangeInput = z.object({ taskId: gidSchema, tagId: gidSchema });

export const addTagToTaskAction: ConnectorAction<
  z.infer<typeof tagChangeInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.add_tag_to_task',
  name: 'Add Tag to Task',
  description: 'Attach an existing tag to an Asana task.',
  category: 'tags',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks/{task_gid}/addTag'],
  safety: associateSafety('a tag is either on the task or it is not.'),
  inputSchema: tagChangeInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Tag a task', input: { taskId: '1201234567890123', tagId: '1201234567890888' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/addTag`,
      schema: rawEmptySchema,
      body: { tag: input.tagId },
      idempotent: true,
      actionId: 'asana.add_tag_to_task',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('task', input.taskId, 'tag', input.tagId);
  },
};

export const removeTagFromTaskAction: ConnectorAction<
  z.infer<typeof tagChangeInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.remove_tag_from_task',
  name: 'Remove Tag from Task',
  description:
    'Detach a tag from an Asana task. The tag itself is not deleted and remains available in the workspace.',
  category: 'tags',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /tasks/{task_gid}/removeTag'],
  safety: associateSafety('a tag is either on the task or it is not.'),
  inputSchema: tagChangeInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Untag a task', input: { taskId: '1201234567890123', tagId: '1201234567890888' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(input.taskId)}/removeTag`,
      schema: rawEmptySchema,
      body: { tag: input.tagId },
      idempotent: true,
      actionId: 'asana.remove_tag_from_task',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('task', input.taskId, 'tag', input.tagId);
  },
};
