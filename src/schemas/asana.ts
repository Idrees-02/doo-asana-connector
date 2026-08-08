/**
 * Asana domain schemas.
 *
 * Two layers, deliberately kept apart:
 *
 *   RAW  — what Asana actually returns (snake_case, `gid`, compact-by-default).
 *          Permissive by design: `opt_fields` decides which properties appear,
 *          and Asana adds new ones without notice, so a strict schema here
 *          would turn a harmless upstream addition into an outage.
 *
 *   DOMAIN — what this connector promises callers (camelCase, `id`, explicitly
 *          nullable). This is the published contract in OpenAPI and MCP.
 *
 * Mapping between them is explicit and one-way. The benefit is that Asana's
 * shape never leaks into our contract: when Asana renames something, one
 * mapper changes and every consumer is unaffected.
 */

import { z } from 'zod';

/* ========================================================================== */
/* RAW — Asana wire shapes                                                     */
/* ========================================================================== */

/** Any Asana object reference in its compact form. */
const rawCompactSchema = z.looseObject({
  gid: z.string(),
  resource_type: z.string().optional(),
  name: z.string().optional(),
});

export const rawUserSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  resource_type: z.string().optional(),
});

export const rawWorkspaceSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  is_organization: z.boolean().optional(),
  resource_type: z.string().optional(),
});

export const rawProjectSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  archived: z.boolean().optional(),
  color: z.string().nullable().optional(),
  notes: z.string().optional(),
  permalink_url: z.string().optional(),
  created_at: z.string().optional(),
  modified_at: z.string().optional(),
  due_on: z.string().nullable().optional(),
  workspace: rawCompactSchema.nullable().optional(),
  owner: rawUserSchema.nullable().optional(),
  team: rawCompactSchema.nullable().optional(),
  resource_type: z.string().optional(),
});

export const rawTaskSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  completed: z.boolean().optional(),
  completed_at: z.string().nullable().optional(),
  due_on: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  start_on: z.string().nullable().optional(),
  created_at: z.string().optional(),
  modified_at: z.string().optional(),
  permalink_url: z.string().optional(),
  resource_subtype: z.string().optional(),
  num_subtasks: z.number().optional(),
  assignee: rawUserSchema.nullable().optional(),
  workspace: rawCompactSchema.nullable().optional(),
  parent: rawCompactSchema.nullable().optional(),
  projects: z.array(rawCompactSchema).optional(),
  tags: z.array(rawCompactSchema).optional(),
  resource_type: z.string().optional(),
});

export const rawStorySchema = z.looseObject({
  gid: z.string(),
  text: z.string().optional(),
  html_text: z.string().optional(),
  created_at: z.string().optional(),
  created_by: rawUserSchema.nullable().optional(),
  type: z.string().optional(),
  resource_subtype: z.string().optional(),
  is_pinned: z.boolean().optional(),
  resource_type: z.string().optional(),
});

export type RawUser = z.infer<typeof rawUserSchema>;
export type RawWorkspace = z.infer<typeof rawWorkspaceSchema>;
export type RawProject = z.infer<typeof rawProjectSchema>;
export type RawTask = z.infer<typeof rawTaskSchema>;
export type RawStory = z.infer<typeof rawStorySchema>;

/* ========================================================================== */
/* opt_fields                                                                  */
/* ========================================================================== */

/**
 * Asana returns only `gid`, `name` and `resource_type` unless `opt_fields` asks
 * for more. These lists are deliberately tight: Asana's rate limiter is
 * cost-based, and every extra traversed field (followers, custom fields,
 * memberships) makes each request more expensive against the quota.
 */
export const PROJECT_OPT_FIELDS = [
  'name',
  'archived',
  'color',
  'notes',
  'permalink_url',
  'created_at',
  'modified_at',
  'due_on',
  'workspace.name',
  'owner.name',
  'team.name',
] as const;

export const TASK_OPT_FIELDS = [
  'name',
  'notes',
  'completed',
  'completed_at',
  'due_on',
  'due_at',
  'start_on',
  'created_at',
  'modified_at',
  'permalink_url',
  'resource_subtype',
  'num_subtasks',
  'assignee.name',
  'assignee.email',
  'workspace.name',
  'parent.name',
  'projects.name',
  'tags.name',
] as const;

export const STORY_OPT_FIELDS = [
  'text',
  'created_at',
  'created_by.name',
  'type',
  'resource_subtype',
  'is_pinned',
] as const;

export const USER_OPT_FIELDS = [
  'name',
  'email',
  'workspaces.name',
  'workspaces.is_organization',
] as const;

/* ========================================================================== */
/* DOMAIN — the connector's published contract                                 */
/* ========================================================================== */

export const objectRefSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
  })
  .describe('A reference to another Asana object.');

export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    isOrganization: z.boolean().nullable(),
  })
  .describe('An Asana workspace or organization.');

export const userSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  })
  .describe('An Asana user.');

export const projectSchema = z
  .object({
    id: z.string().describe('Asana project gid.'),
    name: z.string().nullable(),
    archived: z.boolean().nullable().describe('Null when Asana did not return the field.'),
    color: z.string().nullable(),
    notes: z.string().nullable(),
    url: z.string().nullable().describe('Permalink to the project in the Asana web app.'),
    workspace: objectRefSchema.nullable(),
    owner: objectRefSchema.nullable(),
    team: objectRefSchema.nullable(),
    dueOn: z.string().nullable(),
    createdAt: z.string().nullable(),
    modifiedAt: z.string().nullable(),
  })
  .describe('An Asana project.');

export const taskSchema = z
  .object({
    id: z.string().describe('Asana task gid.'),
    name: z.string().nullable(),
    notes: z.string().nullable().describe('Plain-text task description.'),
    completed: z.boolean().nullable(),
    completedAt: z.string().nullable(),
    dueOn: z.string().nullable().describe('Due date, YYYY-MM-DD.'),
    dueAt: z.string().nullable().describe('Due date-time, ISO 8601. Mutually exclusive with dueOn.'),
    startOn: z.string().nullable(),
    assignee: userSchema.nullable(),
    workspace: objectRefSchema.nullable(),
    parent: objectRefSchema.nullable(),
    projects: z.array(objectRefSchema),
    tags: z.array(objectRefSchema),
    subtaskCount: z.number().nullable(),
    resourceSubtype: z.string().nullable().describe('default_task | milestone | approval | custom.'),
    url: z.string().nullable().describe('Permalink to the task in the Asana web app.'),
    createdAt: z.string().nullable(),
    modifiedAt: z
      .string()
      .nullable()
      .describe(
        'Last modification time. Pass back as `ifUnmodifiedSince` on update to guard against overwriting a concurrent edit.',
      ),
  })
  .describe('An Asana task.');

export const commentSchema = z
  .object({
    id: z.string().describe('Asana story gid.'),
    text: z.string().nullable(),
    createdAt: z.string().nullable(),
    createdBy: objectRefSchema.nullable(),
    type: z.string().nullable().describe('"comment" or "system".'),
    resourceSubtype: z.string().nullable(),
    isPinned: z.boolean().nullable(),
  })
  .describe('A comment (Asana "story") on a task.');

export type ObjectRef = z.infer<typeof objectRefSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type User = z.infer<typeof userSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Comment = z.infer<typeof commentSchema>;

/* ========================================================================== */
/* Mappers — RAW -> DOMAIN                                                     */
/* ========================================================================== */

/**
 * Every mapper normalizes "absent" to `null` rather than leaving it undefined.
 *
 * That matters more than it looks: `undefined` disappears through
 * `JSON.stringify`, so a field Asana omitted would silently vanish from an API
 * response instead of being explicitly reported as unknown. Callers can then
 * tell "Asana says there is no assignee" from "we never asked for assignee".
 */

function refOf(raw: { gid: string; name?: string | undefined } | null | undefined): ObjectRef | null {
  if (raw === null || raw === undefined) return null;
  return { id: raw.gid, name: raw.name ?? null };
}

export function toWorkspace(raw: RawWorkspace): Workspace {
  return {
    id: raw.gid,
    name: raw.name ?? null,
    isOrganization: raw.is_organization ?? null,
  };
}

export function toUser(raw: RawUser | null | undefined): User | null {
  if (raw === null || raw === undefined) return null;
  return {
    id: raw.gid,
    name: raw.name ?? null,
    email: raw.email ?? null,
  };
}

export function toProject(raw: RawProject): Project {
  return {
    id: raw.gid,
    name: raw.name ?? null,
    archived: raw.archived ?? null,
    color: raw.color ?? null,
    notes: raw.notes ?? null,
    url: raw.permalink_url ?? null,
    workspace: refOf(raw.workspace),
    owner: refOf(raw.owner),
    team: refOf(raw.team),
    dueOn: raw.due_on ?? null,
    createdAt: raw.created_at ?? null,
    modifiedAt: raw.modified_at ?? null,
  };
}

export function toTask(raw: RawTask): Task {
  return {
    id: raw.gid,
    name: raw.name ?? null,
    notes: raw.notes ?? null,
    completed: raw.completed ?? null,
    completedAt: raw.completed_at ?? null,
    dueOn: raw.due_on ?? null,
    dueAt: raw.due_at ?? null,
    startOn: raw.start_on ?? null,
    assignee: toUser(raw.assignee),
    workspace: refOf(raw.workspace),
    parent: refOf(raw.parent),
    projects: (raw.projects ?? []).map((p) => ({ id: p.gid, name: p.name ?? null })),
    tags: (raw.tags ?? []).map((t) => ({ id: t.gid, name: t.name ?? null })),
    subtaskCount: raw.num_subtasks ?? null,
    resourceSubtype: raw.resource_subtype ?? null,
    url: raw.permalink_url ?? null,
    createdAt: raw.created_at ?? null,
    modifiedAt: raw.modified_at ?? null,
  };
}

export function toComment(raw: RawStory): Comment {
  return {
    id: raw.gid,
    text: raw.text ?? null,
    createdAt: raw.created_at ?? null,
    createdBy: refOf(raw.created_by),
    type: raw.type ?? null,
    resourceSubtype: raw.resource_subtype ?? null,
    isPinned: raw.is_pinned ?? null,
  };
}
