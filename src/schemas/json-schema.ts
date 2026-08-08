/**
 * Zod -> JSON Schema conversion.
 *
 * Zod 4 can emit JSON Schema natively, so there is no converter dependency and
 * — more importantly — no second definition of any schema. The Schema
 * Inspector in the console, the OpenAPI document and the MCP tool schemas all
 * render the output of this function, which means the published contract is
 * mechanically derived from the schema the runtime actually validates against.
 */

import { z } from 'zod';

export interface JsonSchemaObject {
  readonly [key: string]: unknown;
}

/**
 * Convert a Zod schema to JSON Schema.
 *
 * `io: 'input'` describes what a caller may send (before defaults and
 * transforms are applied), which is the correct view for documentation and for
 * the Playground's editor. Using the output view would show callers fields they
 * are not allowed to supply.
 */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchemaObject {
  try {
    const result = z.toJSONSchema(schema, {
      io,
      // Some schemas use transforms and refinements that have no JSON Schema
      // equivalent. Emitting the representable part is far more useful than
      // failing outright, so unrepresentable pieces become permissive.
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
    });
    return result;
  } catch (error) {
    // The Schema Inspector is a documentation surface, so a conversion failure
    // must never break it. Say so plainly rather than rendering nothing.
    return {
      type: 'object',
      description: `This schema could not be represented as JSON Schema: ${
        error instanceof Error ? error.message : 'unknown error'
      }. The runtime validation is unaffected.`,
    };
  }
}

/** Convert an action's output schema, which needs the output view. */
export function toOutputJsonSchema(schema: z.ZodType): JsonSchemaObject {
  return toJsonSchema(schema, 'output');
}
