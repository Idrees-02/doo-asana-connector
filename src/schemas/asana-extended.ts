/**
 * Domain schemas for the extended action set.
 *
 * Kept in a separate module from `asana.ts` so the five original actions'
 * schemas stay byte-identical — they are verified against live Asana and
 * should not be disturbed by additive work.
 *
 * Same two-layer discipline as `asana.ts`: permissive RAW shapes matching
 * Asana's wire format, strict DOMAIN shapes forming this connector's published
 * contract, and explicit one-way mappers between them.
 */

import { z } from 'zod';
import { objectRefSchema, rawUserSchema, toUser, userSchema, type ObjectRef } from './asana.js';

/* ========================================================================== */
/* RAW — Asana wire shapes                                                     */
/* ========================================================================== */

const rawCompact = z.looseObject({
  gid: z.string(),
  resource_type: z.string().optional(),
  name: z.string().optional(),
});

export const rawSectionSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  created_at: z.string().optional(),
  project: rawCompact.nullable().optional(),
  resource_type: z.string().optional(),
});

export const rawTagSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  color: z.string().nullable().optional(),
  notes: z.string().optional(),
  created_at: z.string().optional(),
  permalink_url: z.string().optional(),
  workspace: rawCompact.nullable().optional(),
  resource_type: z.string().optional(),
});

export const rawMembershipSchema = z.looseObject({
  gid: z.string(),
  resource_type: z.string().optional(),
  resource_subtype: z.string().optional(),
  parent: rawCompact.nullable().optional(),
  member: rawCompact.nullable().optional(),
  user: rawUserSchema.nullable().optional(),
  access_level: z.string().nullable().optional(),
  write_access: z.string().nullable().optional(),
});

/**
 * Endpoints that mutate an association return `{"data": {}}`.
 *
 * Modelled explicitly rather than as `unknown`, so the response is still
 * validated and an unexpected body is still caught.
 */
export const rawEmptySchema = z.looseObject({});

export type RawSection = z.infer<typeof rawSectionSchema>;
export type RawTag = z.infer<typeof rawTagSchema>;
export type RawMembership = z.infer<typeof rawMembershipSchema>;

/* ========================================================================== */
/* opt_fields                                                                  */
/* ========================================================================== */

export const SECTION_OPT_FIELDS = ['name', 'created_at', 'project.name'] as const;

export const TAG_OPT_FIELDS = [
  'name',
  'color',
  'notes',
  'created_at',
  'permalink_url',
  'workspace.name',
] as const;

export const MEMBERSHIP_OPT_FIELDS = [
  'user.name',
  'user.email',
  'access_level',
  'parent.name',
] as const;

/* ========================================================================== */
/* DOMAIN                                                                      */
/* ========================================================================== */

export const sectionSchema = z
  .object({
    id: z.string().describe('Asana section gid.'),
    name: z.string().nullable(),
    project: objectRefSchema.nullable(),
    createdAt: z.string().nullable(),
  })
  .describe('A section (column) within an Asana project.');

export const tagSchema = z
  .object({
    id: z.string().describe('Asana tag gid.'),
    name: z.string().nullable(),
    color: z.string().nullable(),
    notes: z.string().nullable(),
    workspace: objectRefSchema.nullable(),
    url: z.string().nullable(),
    createdAt: z.string().nullable(),
  })
  .describe('An Asana tag.');

export const projectMemberSchema = z
  .object({
    id: z.string().describe('Membership gid, not the user gid.'),
    user: userSchema.nullable(),
    accessLevel: z
      .string()
      .nullable()
      .describe('admin | editor | commenter | viewer, where Asana reports it.'),
  })
  .describe('A user\'s membership of an Asana project.');

/**
 * Result of an association change (add/remove project, tag, member, section).
 *
 * Asana returns an empty body for these, so echoing back what was asked for is
 * the only way the caller can confirm which pairing was affected.
 */
export const associationResultSchema = z
  .object({
    changed: z.literal(true),
    subject: z.object({ type: z.string(), id: z.string() }),
    target: z.object({ type: z.string(), id: z.string() }),
  })
  .describe('Confirmation that an association was created or removed.');

export type Section = z.infer<typeof sectionSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type AssociationResult = z.infer<typeof associationResultSchema>;

/* ========================================================================== */
/* Mappers                                                                     */
/* ========================================================================== */

function refOf(raw: { gid: string; name?: string | undefined } | null | undefined): ObjectRef | null {
  if (raw === null || raw === undefined) return null;
  return { id: raw.gid, name: raw.name ?? null };
}

export function toSection(raw: RawSection): Section {
  return {
    id: raw.gid,
    name: raw.name ?? null,
    project: refOf(raw.project),
    createdAt: raw.created_at ?? null,
  };
}

export function toTag(raw: RawTag): Tag {
  return {
    id: raw.gid,
    name: raw.name ?? null,
    color: raw.color ?? null,
    notes: raw.notes ?? null,
    workspace: refOf(raw.workspace),
    url: raw.permalink_url ?? null,
    createdAt: raw.created_at ?? null,
  };
}

export function toProjectMember(raw: RawMembership): ProjectMember {
  /*
   * Asana returns the person under `user` on project_memberships, but under
   * the generic `member` on the newer /memberships endpoint. Accept either so
   * the mapper survives whichever the caller's plan exposes.
   */
  const user =
    raw.user !== null && raw.user !== undefined
      ? toUser(raw.user)
      : raw.member !== null && raw.member !== undefined
        ? { id: raw.member.gid, name: raw.member.name ?? null, email: null }
        : null;

  return {
    id: raw.gid,
    user,
    accessLevel: raw.access_level ?? null,
  };
}

/** Build the confirmation payload for an association change. */
export function association(
  subjectType: string,
  subjectId: string,
  targetType: string,
  targetId: string,
): AssociationResult {
  return {
    changed: true,
    subject: { type: subjectType, id: subjectId },
    target: { type: targetType, id: targetId },
  };
}
