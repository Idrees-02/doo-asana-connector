/**
 * Generated JSON Schema, checked by a real Draft 2020-12 validator.
 *
 * The previous implementation widened anything it could not represent to
 * `any`, and on failure returned `{ type: 'object' }`. Both produce a document
 * that LOOKS like a contract and is not one — and no test noticed, because
 * nothing ever asked "is this schema faithful?" or "is it even valid?".
 *
 * So this file asks both, with Ajv rather than by inspection:
 *
 *   1. Every action's input and output schema compiles under Ajv's 2020-12
 *      validator. A schema that will not compile is not a contract.
 *   2. Every schema declares the Draft 2020-12 dialect explicitly.
 *   3. Conversion is FAIL-CLOSED: an unrepresentable schema throws, naming the
 *      offending action and direction.
 *   4. The generated schema actually agrees with the runtime — a value Zod
 *      accepts validates, and a value Zod rejects does not.
 */

/*
 * Ajv and ajv-formats are CommonJS with `export =`, so under NodeNext the
 * callable/constructable value is on `.default`. Named here rather than
 * inline so the reason is stated once.
 */
import ajv2020Module from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';

const Ajv2020 = ajv2020Module.default;
const addFormats = ajvFormatsModule.default;
type Ajv2020Instance = InstanceType<typeof Ajv2020>;
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ACTIONS, REQUIRED_ACTION_IDS, getAction } from '../../src/actions/index.js';
import {
  JSON_SCHEMA_DIALECT,
  SchemaConversionError,
  assertSchemasRepresentable,
  toJsonSchema,
  toJsonSchemaLenient,
  toOutputJsonSchema,
} from '../../src/schemas/json-schema.js';

/**
 * A fresh Ajv per call.
 *
 * Ajv caches by `$id` and by schema identity; sharing one instance across
 * dozens of structurally similar schemas produces confusing duplicate-id
 * errors that have nothing to do with the schema under test.
 */
function validator(): Ajv2020Instance {
  const ajv = new Ajv2020({
    strict: false,
    // Draft 2020-12 leaves `format` annotative. The connector's own Zod
    // schemas do the real enforcement; compiling formats here just proves the
    // emitted keywords are ones a validator understands.
    validateFormats: true,
    allErrors: true,
  });
  addFormats(ajv);
  return ajv;
}

const required = REQUIRED_ACTION_IDS.map((id) => {
  const action = getAction(id);
  if (action === undefined) throw new Error(`Required action "${id}" is missing from the registry.`);
  return action;
});

/* -------------------------------------------------------------------------- */
/* Dialect                                                                     */
/* -------------------------------------------------------------------------- */

describe('Draft 2020-12 declaration', () => {
  it.each(required.map((a) => [a.id, a] as const))(
    '%s declares the 2020-12 dialect on both directions',
    (_id, action) => {
      expect(toJsonSchema(action.inputSchema, 'input', action.id)['$schema']).toBe(
        JSON_SCHEMA_DIALECT,
      );
      expect(toOutputJsonSchema(action.outputSchema, action.id)['$schema']).toBe(
        JSON_SCHEMA_DIALECT,
      );
    },
  );

  it('declares the dialect for every action, not only the required five', () => {
    for (const action of ACTIONS) {
      expect(toJsonSchema(action.inputSchema, 'input', action.id)['$schema']).toBe(
        JSON_SCHEMA_DIALECT,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Compiles under a real validator                                             */
/* -------------------------------------------------------------------------- */

describe('every generated schema compiles under Ajv 2020-12', () => {
  it.each(ACTIONS.map((a) => [a.id, a] as const))('%s input', (_id, action) => {
    expect(() => validator().compile(toJsonSchema(action.inputSchema, 'input', action.id))).not.toThrow();
  });

  it.each(ACTIONS.map((a) => [a.id, a] as const))('%s output', (_id, action) => {
    expect(() => validator().compile(toOutputJsonSchema(action.outputSchema, action.id))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed                                                                 */
/* -------------------------------------------------------------------------- */

describe('conversion fails closed', () => {
  it('throws rather than emitting a permissive object for an unrepresentable schema', () => {
    // `z.custom` has no JSON Schema equivalent. Previously this produced
    // `{}` — "anything is acceptable" — inside a published contract.
    const schema = z.object({ weird: z.custom<() => void>((v) => typeof v === 'function') });

    expect(() => toJsonSchema(schema, 'input', 'demo.action')).toThrow(SchemaConversionError);
  });

  it('names the offending subject and direction in the error', () => {
    const schema = z.object({ weird: z.custom<() => void>(() => true) });

    const thrown = (() => {
      try {
        toOutputJsonSchema(schema, 'asana.example');
        return undefined;
      } catch (e) {
        return e as SchemaConversionError;
      }
    })();

    // "conversion failed" is useless on its own; the first question is always
    // WHICH contract broke.
    expect(thrown?.subject).toBe('asana.example');
    expect(thrown?.io).toBe('output');
    expect(thrown?.message).toContain('asana.example');
  });

  it('accepts every action currently in the registry', () => {
    // The build-time gate `npm run generate` runs before writing anything.
    expect(() => assertSchemasRepresentable(ACTIONS)).not.toThrow();
  });

  it('reports ALL offenders at once rather than one per build', () => {
    const bad = z.object({ f: z.custom<() => void>(() => true) });
    const subjects = [
      { id: 'a.one', inputSchema: bad, outputSchema: z.object({}) },
      { id: 'a.two', inputSchema: bad, outputSchema: z.object({}) },
    ];

    const thrown = (() => {
      try {
        assertSchemasRepresentable(subjects);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(thrown?.message).toContain('a.one');
    expect(thrown?.message).toContain('a.two');
  });
});

describe('the lenient path is explicitly degraded, never silently permissive', () => {
  it('marks what it had to widen', () => {
    const schema = z.object({ weird: z.custom<() => void>(() => true) });

    const result = toJsonSchemaLenient(schema, 'input', 'demo.action');

    // The console renders a visible warning off this key. Without it, a
    // widened schema looks exactly like an authoritative one.
    expect(result['x-schema-degraded']).toBeDefined();
  });

  it('does not mark a schema it represented exactly', () => {
    const result = toJsonSchemaLenient(z.object({ a: z.string() }), 'input', 'demo.action');
    expect(result['x-schema-degraded']).toBeUndefined();
  });

  it('is not used to build any published contract', async () => {
    // A structural assertion: the generator imports only the strict entry
    // points. If someone switches it to the lenient one, this fails.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../scripts/generate-all.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('toJsonSchemaLenient');
    expect(source).toContain('assertSchemasRepresentable');
  });
});

/* -------------------------------------------------------------------------- */
/* The generated schema agrees with the runtime                                */
/* -------------------------------------------------------------------------- */

describe('generated schemas agree with runtime validation', () => {
  /** Every action's own declared examples must satisfy its published schema. */
  it.each(
    ACTIONS.flatMap((action) =>
      action.examples.map((example, i) => [`${action.id} example ${i + 1}`, action, example] as const),
    ),
  )('%s validates against the published input schema', (_name, action, example) => {
    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));

    expect(action.inputSchema.safeParse(example.input).success).toBe(true);
    expect(validate(example.input)).toBe(true);
  });

  it('rejects a missing required field in both Zod and JSON Schema', () => {
    const action = getAction('asana.create_task');
    if (action === undefined) throw new Error('asana.create_task is missing.');

    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));
    // `name` is genuinely required, so both layers reject its absence.
    // (`projectId` is only conditionally required — that rule is a refinement,
    // which JSON Schema cannot express and which the next case covers.)
    const bad = { projectId: '1201234567890123' };

    expect(action.inputSchema.safeParse(bad).success).toBe(false);
    expect(validate(bad)).toBe(false);
  });

  it('documents create_task"s either/or rule as a runtime-only refinement', () => {
    const action = getAction('asana.create_task');
    if (action === undefined) throw new Error('asana.create_task is missing.');

    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));
    const neither = { name: 'No project and no workspace' };

    // "either projectId or workspace" has no JSON Schema equivalent, so the
    // published schema is wider than the runtime. The gap runs in the safe
    // direction — the runtime is the stricter of the two — and saying so here
    // stops it being an unnoticed surprise for a caller reading the contract.
    expect(validate(neither)).toBe(true);
    expect(action.inputSchema.safeParse(neither).success).toBe(false);
  });

  it('rejects a non-numeric gid in both Zod and JSON Schema', () => {
    const action = getAction('asana.list_project_tasks');
    if (action === undefined) throw new Error('asana.list_project_tasks is missing.');

    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));
    const bad = { projectId: 'not-a-gid' };

    expect(action.inputSchema.safeParse(bad).success).toBe(false);
    expect(validate(bad)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* update_task's three-state patch, in the published schema                    */
/* -------------------------------------------------------------------------- */

describe('asana.update_task publishes its nullable-vs-omitted semantics', () => {
  const action = getAction('asana.update_task');

  it('accepts an explicit null (clear) as well as a value (set)', () => {
    if (action === undefined) throw new Error('asana.update_task is missing.');
    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));

    expect(validate({ taskId: '1201234567890123', patch: { dueOn: null } })).toBe(true);
    expect(validate({ taskId: '1201234567890123', patch: { dueOn: '2026-03-01' } })).toBe(true);
    // Omitted entirely — the "leave alone" case — is also valid at the schema
    // level; the empty-patch rejection is a refinement, covered below.
    expect(validate({ taskId: '1201234567890123', patch: { name: 'x' } })).toBe(true);
  });

  it('documents the empty-patch rejection as a runtime-only refinement', () => {
    if (action === undefined) throw new Error('asana.update_task is missing.');
    const validate = validator().compile(toJsonSchema(action.inputSchema, 'input', action.id));
    const emptyPatch = { taskId: '1201234567890123', patch: {} };

    // Cross-field refinements have no JSON Schema equivalent, so the published
    // schema is necessarily WIDER than the runtime here. Stating that in a
    // test is what stops it being an unnoticed surprise: the runtime is the
    // stricter of the two, which is the safe direction for the gap to run.
    expect(validate(emptyPatch)).toBe(true);
    expect(action.inputSchema.safeParse(emptyPatch).success).toBe(false);
  });

  it('rejects dueOn and dueAt together at runtime, also a refinement', () => {
    if (action === undefined) throw new Error('asana.update_task is missing.');

    expect(
      action.inputSchema.safeParse({
        taskId: '1201234567890123',
        patch: { dueOn: '2026-03-01', dueAt: '2026-03-01T10:00:00.000Z' },
      }).success,
    ).toBe(false);
  });
});
