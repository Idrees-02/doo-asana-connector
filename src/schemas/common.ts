/**
 * Shared schema primitives.
 *
 * These Zod schemas are the single source of truth. The same definitions
 * produce: runtime validation in the execution pipeline, the JSON Schema shown
 * in the console's Schema Inspector, the MCP tool input schemas, and the
 * OpenAPI document. Nothing is hand-duplicated, so the published contract
 * cannot drift from what the code actually enforces.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An Asana global id.
 *
 * Asana gids are numeric strings and must stay strings — several exceed 2^53,
 * so parsing one as a JavaScript number silently corrupts it. Validation
 * rejects anything non-numeric early, which turns a confusing 404 from Asana
 * into a clear client-side validation error.
 */
export const gidSchema = z
  .string()
  .trim()
  .min(1, 'Required.')
  .regex(/^\d+$/, 'Must be an Asana global id (a numeric string, e.g. "1201234567890123").')
  .describe('Asana global id (gid) — a numeric string.');

/** A calendar date with no time component, as Asana's `due_on` expects. */
export const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Must be a real calendar date.')
  .describe('Date in YYYY-MM-DD format.');

/** An ISO 8601 instant, as Asana's `due_at` expects. */
export const dateTimeSchema = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO 8601 date-time.')
  .describe('ISO 8601 date-time, e.g. "2026-03-01T17:00:00Z".');

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Asana's page size limit is 1–100. We default to 50 rather than 100 because
 * these actions request wide `opt_fields`, and Asana's cost-based rate limiter
 * charges more for large, richly-populated pages.
 */
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;

export const paginationInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    .describe(`Results per page (1–${PAGE_SIZE_MAX}). Defaults to ${PAGE_SIZE_DEFAULT}.`),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Opaque pagination cursor from a previous response. Asana only accepts cursors it issued — a hand-constructed value will be rejected.',
    ),
});

export const paginationOutputSchema = z
  .object({
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` to fetch the next page. Null when there are no more results.'),
    hasMore: z.boolean().describe('Whether another page is available.'),
    pageSize: z.number().int().describe('The page size that was applied.'),
    returned: z.number().int().describe('Number of items in this page.'),
  })
  .describe('Cursor pagination metadata.');

export type PaginationInput = z.infer<typeof paginationInputSchema>;
export type PaginationOutput = z.infer<typeof paginationOutputSchema>;

/* -------------------------------------------------------------------------- */
/* Execution envelope                                                          */
/* -------------------------------------------------------------------------- */

export const runModeSchema = z.enum(['live', 'demo']);

/** Rate-limit state, surfaced so callers can pace themselves deliberately. */
export const rateLimitMetaSchema = z.object({
  limitRpm: z.number().int().describe('Configured client-side request-per-minute ceiling.'),
  remaining: z.number().int().describe('Approximate requests left in the current window.'),
  throttledMs: z
    .number()
    .int()
    .describe('Milliseconds this request spent waiting on the client-side throttle.'),
});

/** An Asana deprecation notice, captured from the `Asana-Change` header. */
export const deprecationSchema = z.object({
  name: z.string(),
  info: z.string().nullable(),
  affected: z.boolean(),
});

export const executionMetaSchema = z.object({
  requestId: z.string().describe('Connector-generated id. Asana does not return one.'),
  actionId: z.string(),
  provider: z.literal('asana'),
  mode: runModeSchema.describe('Whether this result came from live Asana or the demo provider.'),
  demoData: z
    .boolean()
    .describe('True when the payload is synthetic. Never true for live Asana data.'),
  startedAt: z.string(),
  durationMs: z.number().int(),
  /** Upstream HTTP calls made. >1 means a retry or a paginated internal fetch. */
  upstreamCalls: z.number().int(),
  attempts: z.number().int().describe('Attempts for the final upstream call, including retries.'),
  rateLimit: rateLimitMetaSchema.optional(),
  deprecations: z.array(deprecationSchema).default([]),
});

export type ExecutionMeta = z.infer<typeof executionMetaSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type Deprecation = z.infer<typeof deprecationSchema>;
export type RateLimitMeta = z.infer<typeof rateLimitMetaSchema>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a `field?: T | null` schema.
 *
 * The distinction is load-bearing for `asana.update_task`:
 *   - absent  => leave the field alone
 *   - null    => clear the field in Asana
 * Collapsing the two would make it impossible to clear a due date, or would
 * silently wipe fields the caller never mentioned.
 */
export function clearable<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullable().optional();
}
