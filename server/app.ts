/**
 * The HTTP API consumed by the console.
 *
 * This is an adapter over the connector, exactly like the MCP server. It owns
 * transport concerns — routing, CORS, rate limiting, the activity log — and
 * nothing else. There is no Asana knowledge here, and one generic route
 * handles all five actions, so there are no per-action handlers to drift.
 *
 * Its other job is to be the credential boundary. The browser never holds an
 * Asana token: it calls these endpoints, and the server attaches
 * authentication server-side.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { Bootstrapped } from '../src/index.js';
import { describeConfig } from '../src/config.js';
import { MANIFEST } from '../src/manifest.js';
import { getAction, ACTIONS } from '../src/actions/index.js';
import { ConnectorError } from '../src/errors/ConnectorError.js';
import { ERROR_CODES } from '../src/errors/codes.js';
import { generateRequestId } from '../src/runtime/request-id.js';
import { ActivityLog } from './activity.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMcpRoute } from './routes/mcp.js';
import { registerAiRoutes } from './routes/ai.js';
import { toJsonSchema } from '../src/schemas/json-schema.js';

export interface ApiServer {
  readonly app: Express;
  readonly activity: ActivityLog;
}

export function createApp(runtime: Bootstrapped): ApiServer {
  const { connector, config, logger, demoStore } = runtime;
  const app = express();
  const activity = new ActivityLog();

  /* ---------------------------------------------------------------- */
  /* Middleware                                                        */
  /* ---------------------------------------------------------------- */

  if (config.server.trustProxy) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(
    helmet({
      // The console is served separately by Vite in development, so a CSP
      // here would govern API responses only. It is set on the static host.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      // Locked to the console's origin rather than "*", so a hostile page
      // cannot drive this API using the user's session.
      origin: config.server.corsOrigin === '*' ? true : config.server.corsOrigin.split(','),
      credentials: true,
    }),
  );

  /*
   * MCP is mounted before the JSON body parser on purpose: the transport reads
   * the raw stream itself, and a parser that had already drained it would
   * leave the transport waiting on a body that never arrives.
   */
  registerMcpRoute(app, runtime);

  // Bounded body size: an unbounded JSON body is a trivial memory DoS.
  app.use(express.json({ limit: '1mb' }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests.' } },
    }),
  );

  // Attach a request id early so every log line and error can be correlated.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const requestId = generateRequestId();
    res.locals['requestId'] = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  /* ---------------------------------------------------------------- */
  /* Connector metadata                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/connector/status', (_req, res) => {
    res.json({
      connector: {
        name: MANIFEST.name,
        displayName: MANIFEST.displayName,
        version: MANIFEST.version,
        provider: MANIFEST.provider,
        builder: MANIFEST.builder,
      },
      // describeConfig cannot carry a secret — see src/config.ts.
      config: describeConfig(config),
      demoMode: config.mode === 'demo',
      demoControls:
        demoStore === undefined
          ? null
          : { fault: demoStore.controls.fault, latencyMs: demoStore.controls.latencyMs },
      client: connector.stats,
    });
  });

  app.get('/api/connector/manifest', (_req, res) => {
    res.json(MANIFEST);
  });

  app.get('/api/connector/actions', (_req, res) => {
    res.json({
      actions: ACTIONS.map((action) => ({
        id: action.id,
        name: action.name,
        description: action.description,
        category: action.category,
        type: action.safety.write ? 'write' : 'read',
        safety: action.safety,
        supportsPagination: action.supportsPagination,
        scopes: action.scopes,
        endpoints: action.endpoints,
        examples: action.examples,
      })),
    });
  });

  /** JSON Schema for one action — the console's Schema Inspector reads this. */
  app.get('/api/connector/schemas/:actionId', (req, res) => {
    const action = getAction(String(req.params['actionId'] ?? ''));

    if (action === undefined) {
      sendError(
        res,
        new ConnectorError(ERROR_CODES.UNKNOWN_ACTION, {
          message: `No connector action with id "${String(req.params['actionId'] ?? '')}".`,
          requestId: String(res.locals['requestId']),
        }),
      );
      return;
    }

    res.json({
      actionId: action.id,
      name: action.name,
      description: action.description,
      safety: action.safety,
      examples: action.examples,
      // Generated from the same Zod schemas the runtime validates against,
      // so the documented contract is the enforced contract.
      input: toJsonSchema(action.inputSchema),
      output: toJsonSchema(action.outputSchema),
    });
  });

  app.post('/api/connector/test', (_req, res) => {
    void connector
      .testConnection()
      .then((result) => res.json(result))
      .catch((error: unknown) => sendUnexpected(res, error));
  });

  /* ---------------------------------------------------------------- */
  /* Action execution — ONE route for all five actions                 */
  /* ---------------------------------------------------------------- */

  const executeBodySchema = z.object({
    input: z.unknown().optional(),
    approved: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  });

  app.post('/api/actions/:actionId', (req: Request, res: Response) => {
    const requestId = String(res.locals['requestId']);
    const parsed = executeBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      sendError(
        res,
        new ConnectorError(ERROR_CODES.VALIDATION_ERROR, {
          message: 'The request body must be an object with an "input" property.',
          requestId,
        }),
      );
      return;
    }

    const input = parsed.data.input ?? {};

    void connector
      .execute({
        actionId: String(req.params['actionId'] ?? ''),
        input,
        approved: parsed.data.approved,
        idempotencyKey: parsed.data.idempotencyKey,
        requestId,
      })
      .then((result) => {
        activity.record(input, result);
        // A failed action is a successful HTTP exchange that reports a
        // domain failure; the status reflects the domain outcome so clients
        // can branch without parsing the body.
        res.status(result.ok ? 200 : statusForError(result.error.code)).json(result);
      })
      .catch((error: unknown) => sendUnexpected(res, error));
  });

  /* ---------------------------------------------------------------- */
  /* Activity, metrics, health                                         */
  /* ---------------------------------------------------------------- */

  app.get('/api/activity', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 50) || 50, 200);
    res.json({
      entries: activity.list({
        limit,
        ...(typeof req.query['actionId'] === 'string' ? { actionId: req.query['actionId'] } : {}),
        ...(typeof req.query['status'] === 'string' ? { status: req.query['status'] } : {}),
      }),
    });
  });

  app.get('/api/activity/:requestId', (req, res) => {
    const entry = activity.get(String(req.params['requestId'] ?? ''));
    if (entry === undefined) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such request id.' } });
      return;
    }
    res.json(entry);
  });

  app.get('/api/metrics', (_req, res) => {
    res.json({ ...activity.metrics(), client: connector.stats });
  });

  app.get('/api/health', (_req, res) => {
    void buildHealth(runtime, activity)
      .then((health) => res.status(health.status === 'healthy' ? 200 : 503).json(health))
      .catch((error: unknown) => sendUnexpected(res, error));
  });

  /* ---------------------------------------------------------------- */
  /* Demo controls                                                     */
  /* ---------------------------------------------------------------- */

  /*
   * Only mounted in demo mode. In live mode the routes do not exist at all,
   * so a stray UI control cannot inject a fault into, or reset, real data.
   */
  if (demoStore !== undefined) {
    const faultSchema = z.object({
      fault: z.enum(['none', 'auth', 'permission', 'not_found', 'rate_limit', 'server_error', 'timeout', 'empty']),
    });

    app.post('/api/demo/fault', (req, res) => {
      const parsed = faultSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown fault.' } });
        return;
      }
      demoStore.controls.fault = parsed.data.fault;
      res.json({ fault: demoStore.controls.fault });
    });

    app.post('/api/demo/reset', (_req, res) => {
      demoStore.reset();
      activity.clear();
      res.json({ reset: true });
    });
  }

  registerAuthRoutes(app, runtime);
  registerAiRoutes(app, runtime);

  /* ---------------------------------------------------------------- */
  /* Console (single-origin deploys)                                   */
  /* ---------------------------------------------------------------- */

  /*
   * In development Vite serves the console and proxies /api here. In a
   * deployment there is no Vite, so if a built console is present we serve it
   * from this same origin — which also makes CORS a non-issue there.
   */
  const webDist = resolveWebDist(config.server.webDist);

  if (webDist !== undefined) {
    logger.info('Serving console', { dir: webDist });
    app.use(express.static(webDist, { index: false }));

    // SPA fallback: any non-/api GET is a client-side route.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  /* ---------------------------------------------------------------- */
  /* Fallbacks                                                         */
  /* ---------------------------------------------------------------- */

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.path}` },
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled API error', { error });
    sendUnexpected(res, error);
  });

  return { app, activity };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Locate a built console, if there is one.
 *
 * Returns undefined during local development, where Vite owns the console and
 * `frontend/dist` is usually absent or stale.
 */
function resolveWebDist(configured: string | undefined): string | undefined {
  const candidates = [configured, path.resolve(process.cwd(), 'frontend/dist')].filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0,
  );

  return candidates.find((dir) => existsSync(path.join(dir, 'index.html')));
}

/** Map a connector error code to the HTTP status the API should report. */
function statusForError(code: string): number {
  switch (code) {
    case ERROR_CODES.VALIDATION_ERROR:
    case ERROR_CODES.BAD_REQUEST:
      return 400;
    case ERROR_CODES.AUTHENTICATION_ERROR:
      return 401;
    case ERROR_CODES.PAYMENT_REQUIRED:
      return 402;
    case ERROR_CODES.PERMISSION_DENIED:
    case ERROR_CODES.APPROVAL_REQUIRED:
      return 403;
    case ERROR_CODES.NOT_FOUND:
    case ERROR_CODES.UNKNOWN_ACTION:
      return 404;
    case ERROR_CODES.CONFLICT:
      return 409;
    case ERROR_CODES.RATE_LIMITED:
      return 429;
    case ERROR_CODES.TIMEOUT:
      return 504;
    default:
      return 502; // an upstream failure, not a fault in this server
  }
}

function sendError(res: Response, error: ConnectorError): void {
  res.status(statusForError(error.code)).json({ ok: false, error: error.toJSON() });
}

/**
 * Last-resort handler.
 *
 * Normalizes into the same envelope so a caller never has to parse two error
 * shapes, and never exposes a stack trace.
 */
function sendUnexpected(res: Response, error: unknown): void {
  if (ConnectorError.isConnectorError(error)) {
    sendError(res, error);
    return;
  }

  const wrapped = new ConnectorError(ERROR_CODES.UNKNOWN_ERROR, {
    message: 'An unexpected server error occurred.',
    requestId: String(res.locals['requestId'] ?? 'req_unassigned'),
    cause: error,
  });

  res.status(500).json({ ok: false, error: wrapped.toJSON() });
}

export interface HealthReport {
  readonly status: 'healthy' | 'degraded' | 'unauthenticated';
  readonly checkedAt: string;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly status: 'healthy' | 'warning' | 'offline' | 'auth_required';
    readonly detail: string;
    readonly latencyMs: number | null;
  }>;
}

/**
 * Health check.
 *
 * Read-only by construction: the only upstream call it makes is
 * `testConnection`, which is a single GET. A health check that modified Asana
 * data would be a serious bug, so it reuses the one operation already proven
 * side-effect-free by test.
 */
async function buildHealth(runtime: Bootstrapped, activity: ActivityLog): Promise<HealthReport> {
  const { connector, config } = runtime;
  const started = Date.now();
  const connection = await connector.testConnection();
  const latencyMs = Date.now() - started;

  const metrics = activity.metrics();

  const components: HealthReport['components'] = [
    {
      name: 'Connector Core',
      status: 'healthy',
      detail: `${MANIFEST.actions.length} actions registered, v${MANIFEST.version}`,
      latencyMs: null,
    },
    {
      name: 'Asana API',
      status: connection.connected ? 'healthy' : connection.error?.code === 'ASANA_AUTHENTICATION_ERROR' ? 'auth_required' : 'offline',
      detail: connection.connected
        ? `Reachable in ${latencyMs}ms${config.mode === 'demo' ? ' (in-memory demo API)' : ''}`
        : (connection.error?.message ?? 'Unreachable'),
      latencyMs,
    },
    {
      name: 'Authentication',
      status: connection.connected ? 'healthy' : 'auth_required',
      detail: connection.connected
        ? `${connection.auth.type.toUpperCase()} credential accepted`
        : 'No valid credential',
      latencyMs: null,
    },
    {
      name: 'MCP Adapter',
      status: 'healthy',
      detail: `${MANIFEST.actions.length} tools exposed over ${config.mcp.transport}`,
      latencyMs: null,
    },
    {
      name: 'Frontend API',
      status: metrics.failedRequests > metrics.successfulRequests && metrics.totalRequests > 0 ? 'warning' : 'healthy',
      detail:
        metrics.totalRequests === 0
          ? 'No requests recorded yet'
          : `${metrics.successfulRequests}/${metrics.totalRequests} succeeded`,
      latencyMs: metrics.averageLatencyMs,
    },
  ];

  const status: HealthReport['status'] = connection.connected
    ? components.some((c) => c.status === 'warning')
      ? 'degraded'
      : 'healthy'
    : 'unauthenticated';

  return { status, checkedAt: new Date().toISOString(), components };
}
