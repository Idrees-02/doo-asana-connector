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

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

import { ACTIONS } from '../src/actions/index.js';
import { MANIFEST, CONNECTOR_VERSION } from '../src/manifest.js';
import { toJsonSchema, toOutputJsonSchema } from '../src/schemas/json-schema.js';
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
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
}

function generateOpenApi(): string {
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
                  input: toJsonSchema(action.inputSchema),
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
                            'Optional. Reuse when retrying so the operation is not applied twice. Process-local, 15-minute TTL.',
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
                    data: toOutputJsonSchema(action.outputSchema),
                    meta: { $ref: '#/components/schemas/ExecutionMeta' },
                  },
                },
              },
            },
          },
          '400': errorResponse('Input failed validation.'),
          '401': errorResponse('Asana authentication is invalid or expired.'),
          '403': errorResponse(
            action.safety.requiresApproval
              ? 'Permission denied, or the required approval flag was not set.'
              : 'Permission denied.',
          ),
          '404': errorResponse('The action or the referenced Asana object was not found.'),
          '409': errorResponse('The task changed after it was loaded (stale-write guard).'),
          '429': errorResponse('Asana rate limit exceeded.'),
          '502': errorResponse('Asana returned an upstream error.'),
          '504': errorResponse('The request to Asana timed out.'),
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
  const connectorYaml = generateConnectorYaml();
  const openApiYaml = generateOpenApi();

  writeFileSync(join(ROOT, 'connector.yaml'), connectorYaml, 'utf8');
  writeFileSync(join(ROOT, 'openapi.yaml'), openApiYaml, 'utf8');

  console.log(`Generated connector.yaml  (${MANIFEST.actions.length} actions)`);
  console.log(`Generated openapi.yaml    (${Object.keys(ACTIONS).length} action endpoints)`);
  console.log(`Error codes documented:   ${ALL_ERROR_CODES.length}`);
  console.log(
    `Write actions requiring approval: ${MANIFEST.actions.filter((a) => a.requiresApproval).length}`,
  );

  // A sanity check on the generated content itself: the required ids must all
  // be present, spelled exactly as assigned.
  for (const id of ['asana.list_projects', 'asana.list_project_tasks', 'asana.create_task', 'asana.update_task', 'asana.add_comment']) {
    if (!connectorYaml.includes(id) || !openApiYaml.includes(id)) {
      throw new Error(`Generated output is missing the required action "${id}".`);
    }
  }

  // And a last-line-of-defence check that nothing secret was serialized.
  for (const [name, content] of [
    ['connector.yaml', connectorYaml],
    ['openapi.yaml', openApiYaml],
  ] as const) {
    if (/1\/\d{10,}:[0-9a-f]{16,}/.test(content) || /Bearer\s+\S{16,}/.test(content)) {
      throw new Error(`${name} appears to contain a credential. Generation aborted.`);
    }
  }

  void ERROR_CODE_META; // referenced for its side-effect-free type coverage
}

main();
