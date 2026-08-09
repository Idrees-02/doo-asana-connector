/**
 * Extended project and section actions (10).
 *
 * Projects: get_project, create_project, update_project,
 *           list_project_members, add_project_member, remove_project_member
 * Sections: list_project_sections, create_section, update_section,
 *           move_task_to_section
 *
 * Note on membership listing: Asana has deprecated
 * `GET /projects/{gid}/project_memberships` in favour of a generic
 * `GET /memberships?parent=…`. This connector still uses the project-scoped
 * endpoint deliberately — the replacement's documentation does not state which
 * granular OAuth scope it requires, and an endpoint that works under a
 * `default` scope but fails under least-privilege scopes would break exactly
 * the setup this connector recommends.
 */

import { z } from 'zod';
import { PROJECT_OPT_FIELDS, projectSchema, rawProjectSchema, toProject } from '../schemas/asana.js';
import {
  MEMBERSHIP_OPT_FIELDS,
  SECTION_OPT_FIELDS,
  association,
  associationResultSchema,
  projectMemberSchema,
  rawEmptySchema,
  rawMembershipSchema,
  rawSectionSchema,
  sectionSchema,
  toProjectMember,
  toSection,
} from '../schemas/asana-extended.js';
import {
  dateOnlySchema,
  gidSchema,
  paginationInputSchema,
  paginationOutputSchema,
} from '../schemas/common.js';
import { associateSafety, createSafety, mutateSafety, readSafety } from './safety.js';
import type { ConnectorAction } from './types.js';

const PROJECT_OPT = PROJECT_OPT_FIELDS.join(',');
const SECTION_OPT = SECTION_OPT_FIELDS.join(',');

const projectOutput = z.object({ project: projectSchema });

/* ========================================================================== */
/* asana.get_project                                                           */
/* ========================================================================== */

const getProjectInput = z.object({ projectId: gidSchema.describe('The Asana project gid.') });

export const getProjectAction: ConnectorAction<
  z.infer<typeof getProjectInput>,
  z.infer<typeof projectOutput>
> = {
  id: 'asana.get_project',
  name: 'Get Project',
  description: 'Fetch a single Asana project by id.',
  category: 'projects',
  supportsPagination: false,
  scopes: ['projects:read'],
  endpoints: ['GET /projects/{project_gid}'],
  safety: readSafety(),
  inputSchema: getProjectInput,
  outputSchema: projectOutput,
  examples: [{ title: 'Fetch a project', input: { projectId: '1201234567890123' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}`,
      schema: rawProjectSchema,
      query: { opt_fields: PROJECT_OPT },
      idempotent: true,
      actionId: 'asana.get_project',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);
    return { project: toProject(result.data) };
  },
};

/* ========================================================================== */
/* asana.create_project                                                        */
/* ========================================================================== */

const createProjectInput = z.object({
  name: z.string().trim().min(1, 'A project name is required.').max(1024),
  workspace: gidSchema.describe('Workspace to create the project in. Required by Asana.'),
  team: gidSchema
    .optional()
    .describe(
      'Team gid. REQUIRED when the workspace is an organization — Asana rejects the request without it.',
    ),
  notes: z.string().max(65_535).optional().describe('Project description.'),
  color: z.string().trim().min(1).optional().describe('Asana colour name, e.g. "light-green".'),
  privacySetting: z
    .enum(['public_to_workspace', 'private'])
    .optional()
    .describe('Access level. Asana deprecated the older "public" boolean.'),
  dueOn: dateOnlySchema.optional(),
  startOn: dateOnlySchema.optional(),
});

const createProjectOutput = z.object({ project: projectSchema, created: z.literal(true) });

export const createProjectAction: ConnectorAction<
  z.infer<typeof createProjectInput>,
  z.infer<typeof createProjectOutput>
> = {
  id: 'asana.create_project',
  name: 'Create Project',
  description:
    'Create a new Asana project in a workspace. A team gid is required when the workspace is an organization.',
  category: 'projects',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['POST /projects'],
  safety: createSafety('project', 'high'),
  inputSchema: createProjectInput,
  outputSchema: createProjectOutput,
  examples: [
    { title: 'Minimal project', input: { name: 'Q4 Launch', workspace: '1201234567890000' } },
    {
      title: 'Project in an organization',
      description: 'Organizations require a team.',
      input: { name: 'Q4 Launch', workspace: '1201234567890000', team: '1201234567890777', notes: 'Launch coordination.' },
    },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = { name: input.name, workspace: input.workspace };
    if (input.team !== undefined) body['team'] = input.team;
    if (input.notes !== undefined) body['notes'] = input.notes;
    if (input.color !== undefined) body['color'] = input.color;
    if (input.privacySetting !== undefined) body['privacy_setting'] = input.privacySetting;
    if (input.dueOn !== undefined) body['due_on'] = input.dueOn;
    if (input.startOn !== undefined) body['start_on'] = input.startOn;

    const result = await ctx.client.request({
      method: 'POST',
      path: '/projects',
      schema: rawProjectSchema,
      query: { opt_fields: PROJECT_OPT },
      body,
      idempotent: false,
      actionId: 'asana.create_project',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    ctx.logger.info('Created Asana project', { projectId: result.data.gid });
    return { project: toProject(result.data), created: true as const };
  },
};

/* ========================================================================== */
/* asana.update_project                                                        */
/* ========================================================================== */

const updateProjectInput = z
  .object({
    projectId: gidSchema,
    patch: z
      .object({
        name: z.string().trim().min(1).max(1024).optional(),
        notes: z.string().max(65_535).nullable().optional(),
        color: z.string().trim().min(1).nullable().optional(),
        archived: z.boolean().optional(),
        dueOn: dateOnlySchema.nullable().optional(),
        startOn: dateOnlySchema.nullable().optional(),
      })
      .describe('Fields to change. Omitted fields are untouched; null clears a field.'),
  })
  .refine((v) => Object.values(v.patch).some((value) => value !== undefined), {
    message: 'The patch must contain at least one field to update.',
    path: ['patch'],
  });

const updateProjectOutput = z.object({
  project: projectSchema,
  updatedFields: z.array(z.string()),
});

/** Same null-vs-absent discipline as update_task. */
const PROJECT_FIELD_MAP = {
  name: 'name',
  notes: 'notes',
  color: 'color',
  archived: 'archived',
  dueOn: 'due_on',
  startOn: 'start_on',
} as const;

export const updateProjectAction: ConnectorAction<
  z.infer<typeof updateProjectInput>,
  z.infer<typeof updateProjectOutput>
> = {
  id: 'asana.update_project',
  name: 'Update Project',
  description:
    'Update selected fields on an Asana project. Omitted fields are left untouched; an explicit null clears a field.',
  category: 'projects',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['PUT /projects/{project_gid}'],
  safety: mutateSafety('the project ends with the same field values'),
  inputSchema: updateProjectInput,
  outputSchema: updateProjectOutput,
  examples: [
    { title: 'Rename', input: { projectId: '1201234567890123', patch: { name: 'Q4 Launch (revised)' } } },
    { title: 'Archive', input: { projectId: '1201234567890123', patch: { archived: true } } },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    for (const key of Object.keys(PROJECT_FIELD_MAP) as Array<keyof typeof PROJECT_FIELD_MAP>) {
      if (!(key in input.patch)) continue;
      const value = input.patch[key];
      if (value === undefined) continue;
      body[PROJECT_FIELD_MAP[key]] = value;
      updatedFields.push(key);
    }

    const result = await ctx.client.request({
      method: 'PUT',
      path: `/projects/${encodeURIComponent(input.projectId)}`,
      schema: rawProjectSchema,
      query: { opt_fields: PROJECT_OPT },
      body,
      idempotent: true,
      actionId: 'asana.update_project',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return { project: toProject(result.data), updatedFields };
  },
};

/* ========================================================================== */
/* Project members                                                             */
/* ========================================================================== */

const listMembersInput = paginationInputSchema.extend({ projectId: gidSchema });

const listMembersOutput = z.object({
  members: z.array(projectMemberSchema),
  projectId: z.string(),
  pagination: paginationOutputSchema,
});

export const listProjectMembersAction: ConnectorAction<
  z.infer<typeof listMembersInput>,
  z.infer<typeof listMembersOutput>
> = {
  id: 'asana.list_project_members',
  name: 'List Project Members',
  description: 'List the users who are members of an Asana project, with their access level.',
  category: 'projects',
  supportsPagination: true,
  scopes: ['projects:read'],
  endpoints: ['GET /projects/{project_gid}/project_memberships'],
  safety: readSafety(),
  inputSchema: listMembersInput,
  outputSchema: listMembersOutput,
  examples: [{ title: 'Members of a project', input: { projectId: '1201234567890123' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/project_memberships`,
      schema: z.array(rawMembershipSchema),
      query: {
        limit: input.limit,
        offset: input.cursor,
        opt_fields: MEMBERSHIP_OPT_FIELDS.join(','),
      },
      idempotent: true,
      actionId: 'asana.list_project_members',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const members = result.data.map(toProjectMember);
    return {
      members,
      projectId: input.projectId,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: members.length,
      },
    };
  },
};

const memberChangeInput = z.object({
  projectId: gidSchema,
  member: z
    .string()
    .trim()
    .min(1)
    .describe('A user gid, an email address, or the literal "me".'),
});

export const addProjectMemberAction: ConnectorAction<
  z.infer<typeof memberChangeInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.add_project_member',
  name: 'Add Project Member',
  description: 'Add a user as a member of an Asana project.',
  category: 'projects',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['POST /projects/{project_gid}/addMembers'],
  safety: associateSafety('a user is either a member of the project or not.'),
  inputSchema: memberChangeInput,
  outputSchema: associationResultSchema,
  examples: [{ title: 'Add a member', input: { projectId: '1201234567890123', member: 'me' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/addMembers`,
      // Asana returns the updated project here rather than an empty body.
      schema: rawProjectSchema,
      body: { members: input.member },
      idempotent: true,
      actionId: 'asana.add_project_member',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('project', input.projectId, 'member', input.member);
  },
};

export const removeProjectMemberAction: ConnectorAction<
  z.infer<typeof memberChangeInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.remove_project_member',
  name: 'Remove Project Member',
  description:
    'Remove a user from an Asana project. The user account is not deleted — only their membership of this project ends.',
  category: 'projects',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['POST /projects/{project_gid}/removeMembers'],
  safety: associateSafety('a user is either a member of the project or not.'),
  inputSchema: memberChangeInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Remove a member', input: { projectId: '1201234567890123', member: '1201234567890101' } },
  ],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/removeMembers`,
      schema: rawProjectSchema,
      body: { members: input.member },
      idempotent: true,
      actionId: 'asana.remove_project_member',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('project', input.projectId, 'member', input.member);
  },
};

/* ========================================================================== */
/* Sections                                                                    */
/* ========================================================================== */

const listSectionsInput = paginationInputSchema.extend({ projectId: gidSchema });

const listSectionsOutput = z.object({
  sections: z.array(sectionSchema),
  projectId: z.string(),
  pagination: paginationOutputSchema,
});

export const listProjectSectionsAction: ConnectorAction<
  z.infer<typeof listSectionsInput>,
  z.infer<typeof listSectionsOutput>
> = {
  id: 'asana.list_project_sections',
  name: 'List Project Sections',
  description: 'List the sections (columns) of an Asana project.',
  category: 'sections',
  supportsPagination: true,
  scopes: ['projects:read'],
  endpoints: ['GET /projects/{project_gid}/sections'],
  safety: readSafety(),
  inputSchema: listSectionsInput,
  outputSchema: listSectionsOutput,
  examples: [{ title: 'Sections of a project', input: { projectId: '1201234567890123' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/sections`,
      schema: z.array(rawSectionSchema),
      query: { limit: input.limit, offset: input.cursor, opt_fields: SECTION_OPT },
      idempotent: true,
      actionId: 'asana.list_project_sections',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    const sections = result.data.map(toSection);
    return {
      sections,
      projectId: input.projectId,
      pagination: {
        nextCursor: result.nextOffset,
        hasMore: result.nextOffset !== null,
        pageSize: input.limit,
        returned: sections.length,
      },
    };
  },
};

const createSectionInput = z.object({
  projectId: gidSchema,
  name: z.string().trim().min(1, 'A section name is required and cannot be empty.').max(1024),
  insertBefore: gidSchema.optional().describe('Insert before this section gid.'),
  insertAfter: gidSchema.optional().describe('Insert after this section gid.'),
});

const sectionOutput = z.object({ section: sectionSchema, created: z.literal(true) });

export const createSectionAction: ConnectorAction<
  z.infer<typeof createSectionInput>,
  z.infer<typeof sectionOutput>
> = {
  id: 'asana.create_section',
  name: 'Create Section',
  description: 'Create a new section (column) in an Asana project.',
  category: 'sections',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['POST /projects/{project_gid}/sections'],
  safety: createSafety('section'),
  inputSchema: createSectionInput,
  outputSchema: sectionOutput,
  examples: [{ title: 'Add a section', input: { projectId: '1201234567890123', name: 'In Review' } }],
  async run(input, ctx) {
    const body: Record<string, unknown> = { name: input.name };
    // Asana rejects both together; the schema allows either, and sending only
    // what was supplied keeps that contract.
    if (input.insertBefore !== undefined) body['insert_before'] = input.insertBefore;
    else if (input.insertAfter !== undefined) body['insert_after'] = input.insertAfter;

    const result = await ctx.client.request({
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/sections`,
      schema: rawSectionSchema,
      query: { opt_fields: SECTION_OPT },
      body,
      idempotent: false,
      actionId: 'asana.create_section',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return { section: toSection(result.data), created: true as const };
  },
};

const updateSectionInput = z.object({
  sectionId: gidSchema,
  name: z.string().trim().min(1, 'A section name cannot be empty.').max(1024),
});

export const updateSectionAction: ConnectorAction<
  z.infer<typeof updateSectionInput>,
  z.infer<typeof sectionOutput>
> = {
  id: 'asana.update_section',
  name: 'Update Section',
  description: 'Rename an Asana section.',
  category: 'sections',
  supportsPagination: false,
  scopes: ['projects:write'],
  endpoints: ['PUT /sections/{section_gid}'],
  safety: mutateSafety('the section ends with the same name'),
  inputSchema: updateSectionInput,
  outputSchema: sectionOutput,
  examples: [{ title: 'Rename a section', input: { sectionId: '1201234567890555', name: 'Ready for QA' } }],
  async run(input, ctx) {
    const result = await ctx.client.request({
      method: 'PUT',
      path: `/sections/${encodeURIComponent(input.sectionId)}`,
      schema: rawSectionSchema,
      query: { opt_fields: SECTION_OPT },
      body: { name: input.name },
      idempotent: true,
      actionId: 'asana.update_section',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    // `created` is a literal in the shared output shape; this action reuses it
    // for symmetry, and it is accurate that the section exists afterwards.
    return { section: toSection(result.data), created: true as const };
  },
};

const moveToSectionInput = z.object({
  sectionId: gidSchema.describe('Destination section gid.'),
  taskId: gidSchema.describe('Task to move.'),
  insertBefore: gidSchema.optional().describe('Place before this task gid.'),
  insertAfter: gidSchema.optional().describe('Place after this task gid.'),
});

export const moveTaskToSectionAction: ConnectorAction<
  z.infer<typeof moveToSectionInput>,
  z.infer<typeof associationResultSchema>
> = {
  id: 'asana.move_task_to_section',
  name: 'Move Task to Section',
  description:
    'Move a task into a section. Asana removes the task from any other section of the same project automatically.',
  category: 'sections',
  supportsPagination: false,
  scopes: ['tasks:write'],
  endpoints: ['POST /sections/{section_gid}/addTask'],
  safety: associateSafety('a task sits in exactly one section of a project.'),
  inputSchema: moveToSectionInput,
  outputSchema: associationResultSchema,
  examples: [
    { title: 'Move a task', input: { sectionId: '1201234567890555', taskId: '1201234567890123' } },
  ],
  async run(input, ctx) {
    const body: Record<string, unknown> = { task: input.taskId };
    if (input.insertBefore !== undefined) body['insert_before'] = input.insertBefore;
    else if (input.insertAfter !== undefined) body['insert_after'] = input.insertAfter;

    const result = await ctx.client.request({
      method: 'POST',
      path: `/sections/${encodeURIComponent(input.sectionId)}/addTask`,
      schema: rawEmptySchema,
      body,
      idempotent: true,
      actionId: 'asana.move_task_to_section',
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    ctx.recordUpstream(1, result.attempts);

    return association('task', input.taskId, 'section', input.sectionId);
  },
};
