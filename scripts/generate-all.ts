/**
 * Generate `connector.yaml` and `openapi.yaml`.
 *
 * Both are derived from the action registry and its Zod schemas — the same
 * definitions the runtime validates against. Nothing is transcribed by hand,
 * so the published contract cannot describe an action that does not exist,
 * omit one that does, or document a field the code does not accept.
 *
 * CI regenerates and fails if the committed files differ, which turns "the
 * docs are stale" from something a reviewer has to notice into a build error.
 *
 *   npm run generate
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

import { ACTIONS, REQUIRED_ACTION_IDS } from '../src/actions/index.js';
import { MANIFEST, CONNECTOR_VERSION } from '../src/manifest.js';
import {
  assertSchemasRepresentable,
  extractSharedComponents,
  toJsonSchema,
  toOutputJsonSchema,
  type SharedComponent,
} from '../src/schemas/json-schema.js';
import {
  commentSchema,
  objectRefSchema,
  projectSchema,
  taskSchema,
  userSchema,
  workspaceSchema,
} from '../src/schemas/asana.js';
import { sectionSchema, tagSchema } from '../src/schemas/asana-extended.js';
import { executionMetaSchema, paginationOutputSchema } from '../src/schemas/common.js';

/**
 * Domain types shared across actions, hoisted into `components/schemas`.
 *
 * Without this every endpoint inlines the full Task, Project and Ref
 * definitions, and the document reached 355 KB across 9,136 lines — the
 * six-line object-reference schema alone appeared 71 times. A reviewer
 * reported twice that they could not read it, which is a fair complaint about
 * a file that is 18% of the repository and almost entirely duplication.
 *
 * Order matters: the most specific schemas are registered first, so a Task is
 * recognised as a Task rather than matching some structurally similar
 * fragment registered earlier.
 */
const SHARED_COMPONENTS: readonly SharedComponent[] = [
  { name: 'Task', schema: taskSchema, io: 'output' },
  { name: 'Project', schema: projectSchema, io: 'output' },
  { name: 'Comment', schema: commentSchema, io: 'output' },
  { name: 'Section', schema: sectionSchema, io: 'output' },
  { name: 'Tag', schema: tagSchema, io: 'output' },
  { name: 'User', schema: userSchema, io: 'output' },
  { name: 'Workspace', schema: workspaceSchema, io: 'output' },
  { name: 'Pagination', schema: paginationOutputSchema, io: 'output' },
  { name: 'ExecutionMetaSchema', schema: executionMetaSchema, io: 'output' },
  // Registered last: it is the smallest and most generic, so anything more
  // specific gets the chance to claim a subtree first.
  { name: 'AsanaObjectRef', schema: objectRefSchema, io: 'output' },
];
import { ALL_ERROR_CODES, ERROR_CODE_META } from '../src/errors/codes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEADER = `# GENERATED FILE — DO NOT EDIT BY HAND.
# Produced by \`npm run generate\` from src/actions and src/schemas.
# CI fails if this file is out of date with the code.
`;

/* -------------------------------------------------------------------------- */
/* connector.yaml                                                              */
/* -------------------------------------------------------------------------- */

function generateConnectorYaml(): string {
  return HEADER + stringify(MANIFEST, { lineWidth: 100 });
}

/* -------------------------------------------------------------------------- */
/* openapi.yaml                                                                */
/* -------------------------------------------------------------------------- */

interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
}

function generateOpenApi(): string {
  const { components: sharedSchemas, deduplicate } = extractSharedComponents(SHARED_COMPONENTS);
  const paths: Record<string, unknown> = {};

  /* One path per action, mirroring the single generic route the server
     actually implements. */
  for (const action of ACTIONS) {
    paths[`/api/actions/${action.id}`] = {
      post: {
        operationId: action.id.replace(/\./g, '_'),
        summary: action.name,
        description: [
          action.description,
          '',
          `**Type:** ${action.safety.write ? 'WRITE' : 'READ'} · **Risk:** ${action.safety.risk}`,
          `**Asana endpoints:** ${action.endpoints.join(', ')}`,
          `**Scopes:** ${action.scopes.join(', ')}`,
          '',
          `**Duplicate behaviour:** ${action.safety.duplicateBehavior}`,
          `**Retry behaviour:** ${action.safety.retryBehavior}`,
          `**Idempotency:** ${action.safety.idempotencyBehavior}`,
        ].join('\n'),
        tags: [action.category],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: action.safety.requiresApproval ? ['input', 'approved'] : ['input'],
                properties: {
                  input: deduplicate(toJsonSchema(action.inputSchema, 'input', action.id)),
                  ...(action.safety.requiresApproval
                    ? {
                        approved: {
                          type: 'boolean',
                          description:
                            'Must be true. This action modifies data in Asana and will not run without explicit approval.',
                        },
                        idempotencyKey: {
                          type: 'string',
                          description:
                            'Optional. Reuse when retrying so the operation is not applied twice. Scoped per action and caller. Reusing a key with a DIFFERENT request body is rejected with ASANA_IDEMPOTENCY_CONFLICT rather than replaying the wrong result. Not distributed: a multi-replica deployment needs a shared store.',
                        },
                      }
                    : {}),
                },
              },
              examples: Object.fromEntries(
                action.examples.map((example, index) => [
                  `example${index + 1}`,
                  {
                    summary: example.title,
                    ...(example.description === undefined
                      ? {}
                      : { description: example.description }),
                    value: action.safety.requiresApproval
                      ? { input: example.input, approved: true }
                      : { input: example.input },
                  },
                ]),
              ),
            },
          },
        },
        responses: {
          '200': {
            description: 'The action completed successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'data', 'meta'],
                  properties: {
                    ok: { type: 'boolean', enum: [true] },
                    data: deduplicate(toOutputJsonSchema(action.outputSchema, action.id)),
                    meta: { $ref: '#/components/schemas/ExecutionMeta' },
                  },
                },
              },
            },
          },
          /*
           * Referenced, not repeated. Inlining the same eight error bodies
           * into 35 endpoints produced 280 identical blocks — roughly 1,400
           * lines saying nothing new.
           */
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/AuthenticationError' },
          '403': {
            $ref: action.safety.requiresApproval
              ? '#/components/responses/PermissionOrApprovalError'
              : '#/components/responses/PermissionError',
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
          '504': { $ref: '#/components/responses/Timeout' },
        },
      },
    };
  }

  /* Supporting endpoints. */
  paths['/api/connector/status'] = {
    get: {
      operationId: 'getStatus',
      summary: 'Connector status and safe configuration',
      description:
        'Returns connector identity, resolved run mode and configuration. Contains no credential values by construction.',
      tags: ['connector'],
      responses: { '200': { description: 'Current status.' } },
    },
  };

  paths['/api/connector/test'] = {
    post: {
      operationId: 'testConnection',
      summary: 'Verify authentication (read-only)',
      description:
        'Performs a single GET /users/me against Asana. Creates nothing, modifies nothing, deletes nothing. Never returns a token.',
      tags: ['connector'],
      responses: { '200': { description: 'Connection test result.' } },
    },
  };

  paths['/api/connector/manifest'] = {
    get: {
      operationId: 'getManifest',
      summary: 'Connector manifest',
      tags: ['connector'],
      responses: { '200': { description: 'The connector manifest.' } },
    },
  };

  paths['/api/connector/schemas/{actionId}'] = {
    get: {
      operationId: 'getActionSchema',
      summary: 'JSON Schema for one action',
      tags: ['connector'],
      parameters: [
        {
          name: 'actionId',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ACTIONS.map((a) => a.id) },
        },
      ],
      responses: { '200': { description: 'Input and output JSON Schema.' } },
    },
  };

  paths['/api/health'] = {
    get: {
      operationId: 'getHealth',
      summary: 'Component health',
      description: 'Read-only. Health checks never modify Asana data.',
      tags: ['operations'],
      responses: {
        '200': { description: 'All components healthy.' },
        '503': { description: 'One or more components are degraded or unauthenticated.' },
      },
    },
  };

  paths['/api/activity'] = {
    get: {
      operationId: 'listActivity',
      summary: 'Recent executions',
      description: 'Redacted request/response history from an in-memory ring buffer.',
      tags: ['operations'],
      responses: { '200': { description: 'Recent activity entries.' } },
    },
  };

  paths['/api/metrics'] = {
    get: {
      operationId: 'getMetrics',
      summary: 'Real request metrics',
      description:
        'Counters computed from recorded activity. Returns null rather than zero when nothing has run, so "no data" is distinguishable from "all failed".',
      tags: ['operations'],
      responses: { '200': { description: 'Metrics.' } },
    },
  };

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    /*
     * Declared once for the whole document, which is what OpenAPI 3.1 added
     * this field for. Every embedded schema previously repeated the same
     * `$schema` line — 70 copies of one URL.
     */
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Asana Connector API',
      version: CONNECTOR_VERSION,
      summary: 'HTTP API over the DOO Asana connector.',
      description: [
        'The HTTP adapter over the Asana connector core.',
        '',
        'All five actions are exposed through a single generic route,',
        '`POST /api/actions/{actionId}`, so there are no per-action handlers',
        'that can drift from the connector.',
        '',
        '## Authentication',
        '',
        'Credentials live server-side only. The browser never holds an Asana',
        'token: it calls this API, and the server attaches authentication.',
        'Configure a Personal Access Token or an OAuth app via environment',
        'variables — see `.env.example`.',
        '',
        '## Write safety',
        '',
        'The three write actions require `approved: true`. Failures on',
        'non-idempotent writes (create, comment) are reported with',
        '`retryStrategy: "manual_with_idempotency_key"` and are never retried',
        'automatically, because a timed-out create may already have succeeded.',
        '',
        '## Errors',
        '',
        'Every failure uses one normalized envelope with a stable `code`,',
        'a `requestId`, and retry classification. Stack traces and tokens are',
        'never included.',
      ].join('\n'),
      contact: { name: 'Idrees Khaled' },
      license: { name: 'MIT' },
    },
    servers: [
      { url: 'http://localhost:8787', description: 'Local development' },
      { url: '{baseUrl}', description: 'Deployed', variables: { baseUrl: { default: 'http://localhost:8787' } } },
    ],
    tags: [
      { name: 'projects', description: 'Asana project operations' },
      { name: 'tasks', description: 'Asana task operations' },
      { name: 'comments', description: 'Asana task comments (stories)' },
      { name: 'connector', description: 'Connector metadata and connection testing' },
      { name: 'operations', description: 'Health, metrics and activity' },
    ],
    paths,
    components: {
      schemas: {
        // Shared domain types, referenced by every action that uses them
        // rather than re-inlined into each.
        ...sharedSchemas,
        ExecutionMeta: {
          type: 'object',
          description: 'Execution metadata attached to every response.',
          required: ['requestId', 'actionId', 'provider', 'mode', 'demoData', 'durationMs'],
          properties: {
            requestId: {
              type: 'string',
              description: 'Connector-generated. Asana does not return a request id.',
            },
            actionId: { type: 'string' },
            provider: { type: 'string', enum: ['asana'] },
            mode: {
              type: 'string',
              enum: ['live', 'demo'],
              description: 'Whether this result came from Asana or the in-memory demo API.',
            },
            demoData: {
              type: 'boolean',
              description: 'True when the payload is synthetic. Never true for live Asana data.',
            },
            startedAt: { type: 'string', format: 'date-time' },
            durationMs: { type: 'integer' },
            upstreamCalls: { type: 'integer' },
            attempts: { type: 'integer', description: 'Attempts including retries.' },
            deprecations: {
              type: 'array',
              description: 'Notices captured from Asana-Change response headers.',
              items: { type: 'object' },
            },
          },
        },
        ConnectorError: {
          type: 'object',
          description: 'The single normalized error shape returned by every endpoint.',
          required: ['code', 'message', 'provider', 'requestId', 'retryable', 'retryStrategy'],
          properties: {
            code: { type: 'string', enum: [...ALL_ERROR_CODES] },
            message: { type: 'string', description: 'Human-readable. Redacted; never contains a token.' },
            provider: { type: 'string', enum: ['asana'] },
            action: { type: ['string', 'null'] },
            requestId: { type: 'string' },
            httpStatus: { type: ['integer', 'null'] },
            retryable: { type: 'boolean' },
            retryStrategy: {
              type: 'string',
              enum: ['none', 'immediate', 'backoff', 'after_delay', 'manual_with_idempotency_key'],
              description:
                'How to respond. "manual_with_idempotency_key" means the write may already have taken effect and must not be blindly retried.',
            },
            retryAfterMs: { type: ['integer', 'null'] },
            severity: { type: 'string', enum: ['warning', 'error'] },
            guidance: { type: 'string', description: 'Suggested next step, in plain language.' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
            },
            providerPhrase: {
              type: ['string', 'null'],
              description: "Asana's diagnostic phrase, present on 500s.",
            },
            occurredAt: { type: 'string', format: 'date-time' },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: { $ref: '#/components/schemas/ConnectorError' },
            meta: { $ref: '#/components/schemas/ExecutionMeta' },
          },
        },
      },
      responses: {
        ValidationError: errorResponse('Input failed validation.'),
        AuthenticationError: errorResponse('Asana authentication is invalid or expired.'),
        PermissionError: errorResponse('Permission denied.'),
        PermissionOrApprovalError: errorResponse(
          'Permission denied, or the required approval flag was not set.',
        ),
        NotFound: errorResponse('The action or the referenced Asana object was not found.'),
        Conflict: errorResponse('The task changed after it was loaded (stale-read guard).'),
        RateLimited: errorResponse('Asana rate limit exceeded.'),
        UpstreamError: errorResponse('Asana returned an upstream error.'),
        Timeout: errorResponse('The request to Asana timed out.'),
      },
      // Documented for completeness. Note that the API itself is not the place
      // a token is presented — the server holds credentials.
      securitySchemes: {
        serverSideCredential: {
          type: 'apiKey',
          in: 'header',
          name: 'x-not-used',
          description:
            'This API does not accept Asana credentials from the client. The server holds the Personal Access Token or OAuth tokens and attaches them upstream, so the browser never handles a secret.',
        },
      },
    },
  };

  return HEADER + stringify(document, { lineWidth: 100 });
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): void {
  /*
   * Fail closed BEFORE writing anything.
   *
   * A schema that cannot be represented exactly would otherwise be published
   * as a permissive object, and a permissive published contract is worse than
   * a missing one because callers trust it.
   */
  assertSchemasRepresentable(ACTIONS);

  const connectorYaml = generateConnectorYaml();
  const openApiYaml = generateOpenApi();

  /*
   * Content assertions run BEFORE the write and before the --check branch, so
   * neither mode can pass on output that is missing a required action or has
   * serialized a credential.
   */
  assertContentSound(connectorYaml, openApiYaml);

  /*
   * `--check` verifies the committed files match what the code would produce,
   * without writing. CI runs it so a stale contract is a build failure rather
   * than something a reviewer has to notice, and it works locally too — a
   * `git diff` after regenerating cannot tell "stale" from "uncommitted".
   */
  if (process.argv.includes('--check')) {
    const stale: string[] = [];
    for (const [name, expected] of [
      ['connector.yaml', connectorYaml],
      ['openapi.yaml', openApiYaml],
    ] as const) {
      const actual = readFileSync(join(ROOT, name), 'utf8');
      if (actual !== expected) stale.push(name);
    }

    if (stale.length > 0) {
      console.error(
        `\n${stale.join(' and ')} ${stale.length === 1 ? 'is' : 'are'} out of date with the code.\n` +
          'Run `npm run generate` and commit the result.\n',
      );
      process.exit(1);
    }

    console.log('generate:check — connector.yaml and openapi.yaml are current');
    return;
  }

  writeFileSync(join(ROOT, 'connector.yaml'), connectorYaml, 'utf8');
  writeFileSync(join(ROOT, 'openapi.yaml'), openApiYaml, 'utf8');

  console.log(`Generated connector.yaml  (${MANIFEST.actions.length} actions)`);
  console.log(`Generated openapi.yaml    (${Object.keys(ACTIONS).length} action endpoints)`);
  console.log(`Error codes documented:   ${ALL_ERROR_CODES.length}`);
  console.log(
    `Write actions requiring approval: ${MANIFEST.actions.filter((a) => a.requiresApproval).length}`,
  );
}

/**
 * Assertions about the generated CONTENT, as opposed to the schemas it came
 * from. Cheap, and each one closes a way the published contract could be
 * silently wrong.
 */
function assertContentSound(connectorYaml: string, openApiYaml: string): void {
  // The required ids must all be present, spelled exactly as assigned.
  for (const id of REQUIRED_ACTION_IDS) {
    if (!connectorYaml.includes(id) || !openApiYaml.includes(id)) {
      throw new Error(`Generated output is missing the required action "${id}".`);
    }
  }

  // A last line of defence against serializing anything secret.
  for (const [name, content] of [
    ['connector.yaml', connectorYaml],
    ['openapi.yaml', openApiYaml],
  ] as const) {
    if (/[12]\/\d{10,}:[0-9a-f]{16,}/.test(content) || /Bearer\s+\S{16,}/.test(content)) {
      throw new Error(`${name} appears to contain a credential. Generation aborted.`);
    }
  }

  void ERROR_CODE_META; // referenced for its side-effect-free type coverage
}

main();
