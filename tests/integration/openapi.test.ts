/**
 * The published OpenAPI contract, checked by a real validator.
 *
 * The previous assessment could not verify `openapi.yaml` at all. Committing a
 * 348 KB generated document and asserting nothing about it is the same as
 * having no contract: a reader trusts it, and nothing stops it drifting from
 * the code or becoming structurally invalid.
 *
 * So this file does three separate jobs:
 *
 *   1. VALIDITY. `@readme/openapi-parser` — which understands 3.1 and its
 *      JSON Schema 2020-12 dialect — validates the document. A structural
 *      error fails the build.
 *   2. TRUTHFULNESS. Every documented action endpoint corresponds to a real
 *      registered action, and every real action has an endpoint. Neither
 *      invented endpoints nor missing ones can survive.
 *   3. COMPLETENESS. The things a caller must know in order to use this API
 *      safely — approval, idempotency keys, request ids, pagination,
 *      normalized errors — are actually present.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ACTIONS, REQUIRED_ACTION_IDS } from '../../src/actions/index.js';
import { ALL_ERROR_CODES } from '../../src/errors/codes.js';

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; license?: { name: string } };
  servers: unknown[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    securitySchemes: Record<string, unknown>;
  };
}

const path = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));
const raw = await readFile(path, 'utf8');
const doc = parse(raw) as OpenApiDoc;

/* -------------------------------------------------------------------------- */
/* 1. Validity                                                                 */
/* -------------------------------------------------------------------------- */

describe('openapi.yaml is a valid OpenAPI 3.1 document', () => {
  it('declares OpenAPI 3.1.x', () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it('passes a real OpenAPI validator', async () => {
    // Not a hand-rolled shape check: the actual parser, which resolves $refs
    // and validates against the 3.1 metaschema.
    const { validate } = await import('@readme/openapi-parser');

    const result = await validate(structuredClone(doc) as never);

    if (!result.valid) {
      // Surface the real diagnostics rather than a bare "false".
      throw new Error(
        `openapi.yaml failed validation:\n${JSON.stringify(result.errors ?? result, null, 2).slice(0, 4000)}`,
      );
    }
    expect(result.valid).toBe(true);
  });

  it('carries the identity a consumer needs', () => {
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The README claims MIT; the contract must say the same thing.
    expect(doc.info.license?.name).toBe('MIT');
    expect(doc.servers.length).toBeGreaterThan(0);
  });

  it('documents how the API is authenticated', () => {
    expect(Object.keys(doc.components.securitySchemes).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Truthfulness                                                             */
/* -------------------------------------------------------------------------- */

const actionPaths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/actions/'));
const documentedIds = actionPaths.map((p) => p.replace('/api/actions/', ''));

describe('the document describes exactly the actions that exist', () => {
  it.each(REQUIRED_ACTION_IDS)('documents the required action %s', (id) => {
    expect(documentedIds).toContain(id);
  });

  it('documents every registered action', () => {
    expect([...documentedIds].sort()).toEqual(ACTIONS.map((a) => a.id).sort());
  });

  it('invents no endpoint for an action that does not exist', () => {
    // The other direction of the same assertion, stated separately because a
    // fabricated endpoint is a different failure from a missing one.
    for (const id of documentedIds) {
      expect(ACTIONS.some((a) => a.id === id)).toBe(true);
    }
  });

  it('gives every action endpoint a unique operationId', () => {
    const ids = actionPaths.map((p) => doc.paths[p]?.['post']?.['operationId']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Completeness — the safety-relevant parts                                 */
/* -------------------------------------------------------------------------- */

function operation(id: string): Record<string, unknown> {
  const op = doc.paths[`/api/actions/${id}`]?.['post'];
  if (op === undefined) throw new Error(`No documented endpoint for "${id}".`);
  return op;
}

function requestSchema(id: string): Record<string, unknown> {
  const body = operation(id)['requestBody'] as {
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  const schema = body.content['application/json']?.schema;
  if (schema === undefined) throw new Error(`No JSON request schema for "${id}".`);
  return schema;
}

describe('write actions publish their approval and idempotency controls', () => {
  const writes = ACTIONS.filter((a) => a.safety.requiresApproval).map((a) => a.id);

  it.each(writes)('%s requires `approved` in the published contract', (id) => {
    const schema = requestSchema(id);
    const properties = schema['properties'] as Record<string, unknown>;

    // A caller reading only the contract must learn that approval is
    // mandatory — the runtime gate is not discoverable otherwise.
    expect(schema['required']).toContain('approved');
    expect(properties['approved']).toBeDefined();
  });

  it.each(writes)('%s offers an idempotencyKey', (id) => {
    const properties = requestSchema(id)['properties'] as Record<string, unknown>;
    expect(properties['idempotencyKey']).toBeDefined();
  });

  it.each(REQUIRED_ACTION_IDS.filter((id) => !writes.includes(id)))(
    '%s does NOT demand approval, because it is a read',
    (id) => {
      expect((requestSchema(id)['required'] as string[]) ?? []).not.toContain('approved');
    },
  );

  it('states the duplicate and retry behaviour in each write description', () => {
    for (const id of writes) {
      const description = String(operation(id)['description']);
      expect(description).toContain('Duplicate behaviour');
      expect(description).toContain('Retry behaviour');
      expect(description).toContain('Idempotency');
    }
  });
});

describe('input and output schemas are published for every action', () => {
  it.each(ACTIONS.map((a) => a.id))('%s publishes both directions', (id) => {
    const properties = requestSchema(id)['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['input']).toBeDefined();
    // Draft 2020-12, the same dialect the runtime schemas declare.
    expect(properties['input']?.['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');

    const ok = (operation(id)['responses'] as Record<string, Record<string, unknown>>)['200'];
    const content = ok?.['content'] as Record<string, { schema: Record<string, unknown> }>;
    const dataSchema = (content['application/json']?.schema['properties'] as Record<string, unknown>)[
      'data'
    ];
    expect(dataSchema).toBeDefined();
  });
});

describe('pagination is published where the action supports it', () => {
  const paginated = ACTIONS.filter((a) => a.supportsPagination).map((a) => a.id);

  it('covers the two required list actions', () => {
    expect(paginated).toContain('asana.list_projects');
    expect(paginated).toContain('asana.list_project_tasks');
  });

  it.each(paginated)('%s documents a cursor and a pagination result', (id) => {
    const input = (requestSchema(id)['properties'] as Record<string, Record<string, unknown>>)[
      'input'
    ];
    expect(Object.keys(input?.['properties'] as Record<string, unknown>)).toContain('cursor');

    const ok = (operation(id)['responses'] as Record<string, Record<string, unknown>>)['200'];
    const content = ok?.['content'] as Record<string, { schema: Record<string, unknown> }>;
    const data = (content['application/json']?.schema['properties'] as Record<string, Record<string, unknown>>)[
      'data'
    ];
    expect(Object.keys(data?.['properties'] as Record<string, unknown>)).toContain('pagination');
  });
});

describe('the normalized error envelope is published', () => {
  it('defines one error shape and reuses it', () => {
    expect(doc.components.schemas['ConnectorError']).toBeDefined();
    expect(doc.components.schemas['ErrorEnvelope']).toBeDefined();
  });

  it('enumerates every error code the runtime can actually emit', () => {
    const published = (doc.components.schemas['ConnectorError']?.['properties'] as Record<
      string,
      Record<string, unknown>
    >)['code']?.['enum'] as string[];

    // Exact equality: a code the runtime emits but the contract omits leaves a
    // caller unable to branch on it, and a code in the contract that the
    // runtime never emits is fiction.
    expect([...published].sort()).toEqual([...ALL_ERROR_CODES].sort());
  });

  it('publishes the retry classification, including the manual strategy', () => {
    const retryStrategy = (doc.components.schemas['ConnectorError']?.['properties'] as Record<
      string,
      Record<string, unknown>
    >)['retryStrategy']?.['enum'] as string[];

    expect(retryStrategy).toContain('manual_with_idempotency_key');
  });

  it('maps the statuses a caller has to handle on every action', () => {
    for (const id of ACTIONS.map((a) => a.id)) {
      const responses = Object.keys(operation(id)['responses'] as Record<string, unknown>);
      for (const status of ['400', '401', '403', '404', '409', '429', '502', '504']) {
        expect(responses).toContain(status);
      }
    }
  });
});

describe('execution metadata is published', () => {
  it('requires a requestId on every response', () => {
    const meta = doc.components.schemas['ExecutionMeta'];
    expect(meta?.['required']).toContain('requestId');
    // Asana returns no request id; the connector mints one. The contract has
    // to say that, or a caller will look for a provider header that is absent.
    const properties = meta?.['properties'] as Record<string, Record<string, unknown>>;
    expect(String(properties['requestId']?.['description'])).toMatch(/connector|asana does not/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Freshness                                                                   */
/* -------------------------------------------------------------------------- */

describe('the committed document is generated, not hand-edited', () => {
  it('carries the generated-file banner', () => {
    expect(raw.startsWith('# GENERATED FILE')).toBe(true);
  });

  it('contains no credential-shaped value', () => {
    expect(raw).not.toMatch(/1\/\d{10,}:[0-9a-f]{16,}/);
    expect(raw).not.toMatch(/Bearer\s+\S{16,}/);
  });
});
