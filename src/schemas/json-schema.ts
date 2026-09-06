/**
 * Zod -> JSON Schema conversion.
 *
 * Zod 4 emits JSON Schema natively, so there is no converter dependency and —
 * more importantly — no second definition of any schema. The Schema Inspector
 * in the console, the OpenAPI document and the MCP tool schemas all render the
 * output of this function, which means the published contract is mechanically
 * derived from the schema the runtime actually validates against.
 *
 * ============================================================================
 * PUBLISHED CONTRACTS FAIL CLOSED.
 * ============================================================================
 *
 * The previous implementation converted unrepresentable constructs to `any`
 * and, on outright failure, returned `{ type: 'object' }` with an apologetic
 * description. Both are dangerous in a published contract: a caller reads
 * "any object is acceptable" and writes code against a schema the runtime will
 * reject. A contract that quietly widens is worse than no contract, because it
 * is trusted.
 *
 * So there are two entry points, and the distinction between them is the whole
 * point of this module:
 *
 *   toJsonSchema        STRICT. Throws on anything it cannot represent
 *                       faithfully. Used by `npm run generate` for
 *                       connector.yaml and openapi.yaml, and asserted over
 *                       every action by tests. A failure here fails the build.
 *
 *   toJsonSchemaLenient EXPLICITLY DEGRADED. Never throws. Returns the
 *                       representable part plus an `x-schema-degraded` marker
 *                       naming what was lost. Used only by the console's
 *                       Schema Inspector, a live documentation surface that
 *                       must not go blank because one schema is exotic.
 *
 * Every emitted document carries the Draft 2020-12 `$schema` identifier, which
 * Zod's `draft-2020-12` target sets. `tests/unit/json-schema.test.ts` compiles
 * the results with Ajv's 2020-12 validator, so the dialect claim is checked by
 * a real validator rather than asserted in a comment.
 */

import { z } from 'zod';

/** The dialect every schema this module emits declares. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export interface JsonSchemaObject {
  readonly [key: string]: unknown;
}

export type SchemaIo = 'input' | 'output';

/**
 * Raised when a schema cannot be represented faithfully in JSON Schema.
 *
 * Carries the action id and direction because "conversion failed" is useless
 * on its own — the first question is always *which* contract broke.
 */
export class SchemaConversionError extends Error {
  override readonly name = 'SchemaConversionError';

  constructor(
    readonly subject: string,
    readonly io: SchemaIo,
    readonly reason: string,
  ) {
    super(
      `Cannot represent the ${io} schema of "${subject}" as JSON Schema: ${reason}\n` +
        'Published contracts must be exact. Rewrite the schema so it is representable, ' +
        'or the generated openapi.yaml / connector.yaml would describe something the ' +
        'runtime does not accept.',
    );
  }
}

const BASE_OPTIONS = {
  target: 'draft-2020-12',
  cycles: 'ref',
  reused: 'inline',
} as const;

/**
 * Convert a Zod schema to JSON Schema, or throw.
 *
 * `io: 'input'` describes what a caller may send (before defaults and
 * transforms are applied), which is the correct view for documentation and for
 * the Playground's editor. Using the output view would show callers fields
 * they are not allowed to supply.
 *
 * `unrepresentable: 'throw'` is the change that matters: a construct with no
 * JSON Schema equivalent stops the build instead of becoming `{}`.
 */
export function toJsonSchema(
  schema: z.ZodType,
  io: SchemaIo = 'input',
  subject = 'schema',
): JsonSchemaObject {
  try {
    return z.toJSONSchema(schema, { ...BASE_OPTIONS, io, unrepresentable: 'throw' });
  } catch (error) {
    throw new SchemaConversionError(
      subject,
      io,
      error instanceof Error ? error.message : 'unknown conversion failure',
    );
  }
}

/** Convert an action's output schema, which needs the output view. */
export function toOutputJsonSchema(schema: z.ZodType, subject = 'schema'): JsonSchemaObject {
  return toJsonSchema(schema, 'output', subject);
}

/**
 * Best-effort conversion for a live documentation surface.
 *
 * Never throws, and never pretends. When something is lost, the result carries
 * `x-schema-degraded` describing exactly what happened, so the console renders
 * a visible warning rather than a schema that looks authoritative. This is
 * deliberately NOT used to generate any published contract.
 */
export function toJsonSchemaLenient(
  schema: z.ZodType,
  io: SchemaIo = 'input',
  subject = 'schema',
): JsonSchemaObject {
  try {
    return toJsonSchema(schema, io, subject);
  } catch (strictError) {
    try {
      return {
        ...z.toJSONSchema(schema, { ...BASE_OPTIONS, io, unrepresentable: 'any' }),
        'x-schema-degraded': {
          reason:
            strictError instanceof SchemaConversionError
              ? strictError.reason
              : String(strictError),
          effect:
            'Parts of this schema have no JSON Schema equivalent and were widened. ' +
            'Runtime validation is unaffected and remains stricter than what is shown.',
        },
      };
    } catch (lenientError) {
      // Both views failed. Say so; do not emit a permissive object that a
      // reader would take for the real contract.
      return {
        $schema: JSON_SCHEMA_DIALECT,
        'x-schema-degraded': {
          reason: lenientError instanceof Error ? lenientError.message : 'unknown failure',
          effect:
            'This schema could not be rendered at all. Runtime validation is unaffected. ' +
            'No claim is made here about what this action accepts.',
        },
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Build-time assertion                                                        */
/* -------------------------------------------------------------------------- */

export interface SchemaSubject {
  readonly id: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
}

/**
 * Assert every action's input and output schema is exactly representable.
 *
 * Called by `npm run generate` before anything is written, and by a test, so
 * an unrepresentable schema fails the build at the point it is introduced
 * rather than being discovered by whoever reads openapi.yaml months later.
 *
 * Reports ALL offenders rather than the first: fixing them one build at a time
 * is a miserable way to find out there were four.
 */
export function assertSchemasRepresentable(subjects: readonly SchemaSubject[]): void {
  const failures: string[] = [];

  for (const subject of subjects) {
    for (const [io, schema] of [
      ['input', subject.inputSchema],
      ['output', subject.outputSchema],
    ] as const) {
      try {
        toJsonSchema(schema, io, subject.id);
      } catch (error) {
        failures.push(
          `  ${subject.id} (${io}): ${
            error instanceof SchemaConversionError ? error.reason : String(error)
          }`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} action schema(s) cannot be represented as JSON Schema:\n` +
        `${failures.join('\n')}\n\n` +
        'The generated contracts would misdescribe these actions, so generation is refused.',
    );
  }
}
