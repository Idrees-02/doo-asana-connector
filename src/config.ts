/**
 * The single source of environment configuration.
 *
 * ============================================================================
 * THIS IS THE ONLY MODULE IN THE PROJECT PERMITTED TO READ `process.env`.
 * ============================================================================
 *
 * Everything else — client, actions, server, MCP adapter — receives typed
 * config as an argument. That is enforced mechanically by the
 * `no-restricted-properties` ESLint rule (see eslint.config.js), not by
 * convention, so a stray `process.env.ASANA_ACCESS_TOKEN` elsewhere fails lint.
 *
 * Consequences worth stating plainly:
 *   - No credential ever appears as a literal in source, fixtures or tests.
 *   - Config is 12-factor, so the same build runs locally and deployed with
 *     nothing changed but the environment.
 *   - `describeConfig()` is the only sanctioned way to display config, and it
 *     structurally cannot emit a secret value.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Env schema                                                                  */
/* -------------------------------------------------------------------------- */

/** Accepts "1"/"true"/"yes"/"on" (case-insensitive) as true. */
const booleanish = z
  .string()
  .trim()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

/** An env var that is absent when blank — `FOO=` must mean "unset", not "". */
const optionalString = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const intFromString = (min: number, max: number, fallback: number) =>
  z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max))
    .catch(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).catch('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).catch('info'),

  // Mode ------------------------------------------------------------------
  ASANA_MODE: z.enum(['auto', 'live', 'demo']).catch('auto'),

  // Credentials — always optional. Their absence is a supported state that
  // puts the connector in demo mode; it is never a startup crash.
  ASANA_ACCESS_TOKEN: optionalString,
  ASANA_OAUTH_CLIENT_ID: optionalString,
  ASANA_OAUTH_CLIENT_SECRET: optionalString,
  ASANA_OAUTH_REDIRECT_URI: z
    .string()
    .trim()
    .catch('http://localhost:8787/api/auth/oauth/callback'),
  ASANA_OAUTH_SCOPES: z
    .string()
    .trim()
    .catch('projects:read tasks:read tasks:write stories:write users:read workspaces:read'),

  ASANA_DEFAULT_WORKSPACE: optionalString,

  // Asana API -------------------------------------------------------------
  ASANA_API_BASE_URL: z.string().trim().url().catch('https://app.asana.com/api/1.0'),
  ASANA_RATE_LIMIT_RPM: intFromString(1, 1500, 140),
  ASANA_TIMEOUT_MS: intFromString(1000, 120_000, 15_000),
  ASANA_MAX_CONCURRENCY: intFromString(1, 50, 8),

  // Server ----------------------------------------------------------------
  PORT: intFromString(1, 65_535, 8787),
  CORS_ORIGIN: z.string().trim().catch('http://localhost:5173'),
  TRUST_PROXY: booleanish.catch(false),
  // Directory of a built console to serve from this origin. Blank => look for
  // frontend/dist, which is how a single-service deploy (e.g. Railway) works.
  WEB_DIST: optionalString,
  // The origin this deployment is reachable on, e.g.
  // https://doo-asana-connector.up.railway.app. Blank => the console falls back
  // to whatever origin it was loaded from, which is right locally and right on
  // the deployment itself; setting it is what lets the console print the real
  // public MCP URL when it is being read anywhere else.
  PUBLIC_BASE_URL: optionalString,

  // MCP -------------------------------------------------------------------
  // stdio is the local default (what the mentor and Claude Desktop use);
  // http exposes the Streamable HTTP transport for a deployed endpoint.
  MCP_TRANSPORT: z.enum(['stdio', 'http']).catch('stdio'),
  MCP_HTTP_PORT: intFromString(1, 65_535, 8788),
  // Bearer token guarding the public /mcp endpoint. Blank => open, which is
  // fine locally and unacceptable once deployed: the endpoint drives a real
  // Asana workspace with the server's own credential.
  MCP_AUTH_TOKEN: optionalString,
  // Extra hosts the /mcp endpoint will answer to, comma-separated. Normally
  // unnecessary: the host list is derived from CORS_ORIGIN. Needed when the
  // endpoint is reached on a name the console is not served from.
  MCP_ALLOWED_HOSTS: optionalString,

  // AI assistant ----------------------------------------------------------
  // Groq inference. Blank => the assistant is disabled and the console hides
  // it, so the app still runs with no AI provider configured.
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().trim().catch('llama-3.3-70b-versatile'),

  // At-rest encryption for OAuth tokens. Blank => memory only.
  CREDENTIAL_ENCRYPTION_KEY: optionalString,
});

type Env = z.infer<typeof envSchema>;

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export type RunMode = 'live' | 'demo';

export interface AsanaApiConfig {
  readonly baseUrl: string;
  readonly rateLimitRpm: number;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly defaultWorkspace: string | undefined;
}

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface ServerConfig {
  readonly port: number;
  readonly corsOrigin: string;
  readonly trustProxy: boolean;
  /** Explicit console build directory, when one was configured. */
  readonly webDist: string | undefined;
  /** Public origin of this deployment, when it has been configured. */
  readonly publicBaseUrl: string | undefined;
}

export interface McpConfig {
  readonly transport: 'stdio' | 'http';
  readonly httpPort: number;
  /** Bearer token required by the HTTP endpoint, when one is configured. */
  readonly authToken: string | undefined;
  /** Additional hosts accepted by the HTTP endpoint, beyond the console's own. */
  readonly allowedHosts: readonly string[];
}

export interface AiConfig {
  readonly apiKey: string | undefined;
  readonly model: string;
  /** Convenience flag: the console asks this rather than probing for a key. */
  readonly enabled: boolean;
}

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly logLevel: Env['LOG_LEVEL'];
  /** Resolved run mode: `auto` collapses to live/demo based on credentials. */
  readonly mode: RunMode;
  /** Why we ended up in that mode — surfaced in the UI so it is never a mystery. */
  readonly modeReason: string;
  readonly asana: AsanaApiConfig;
  /** Present only when a PAT was supplied. */
  readonly accessToken: string | undefined;
  /** Present only when a complete OAuth app was configured. */
  readonly oauth: OAuthConfig | undefined;
  readonly server: ServerConfig;
  readonly mcp: McpConfig;
  readonly ai: AiConfig;
  readonly credentialEncryptionKey: string | undefined;
  readonly isProduction: boolean;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

let cached: AppConfig | undefined;

/**
 * Build config from a raw environment record.
 *
 * Exported separately from {@link getConfig} so tests can construct config
 * without mutating `process.env` — which keeps test runs isolated and means
 * no test ever needs a real credential.
 */
export function buildConfig(raw: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    // Report only the offending variable NAMES. Values are never echoed,
    // because a malformed value may still be a real secret.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(
      `Invalid environment configuration for: ${names.join(', ')}. ` +
        `See .env.example for the expected format. (Values are intentionally not shown.)`,
    );
  }

  const env = parsed.data;

  const oauth: OAuthConfig | undefined =
    env.ASANA_OAUTH_CLIENT_ID !== undefined && env.ASANA_OAUTH_CLIENT_SECRET !== undefined
      ? {
          clientId: env.ASANA_OAUTH_CLIENT_ID,
          clientSecret: env.ASANA_OAUTH_CLIENT_SECRET,
          redirectUri: env.ASANA_OAUTH_REDIRECT_URI,
          scopes: env.ASANA_OAUTH_SCOPES.split(/[\s,]+/).filter((s) => s.length > 0),
        }
      : undefined;

  const hasCredentials = env.ASANA_ACCESS_TOKEN !== undefined || oauth !== undefined;
  const { mode, modeReason } = resolveMode(env.ASANA_MODE, hasCredentials, env.ASANA_ACCESS_TOKEN);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    mode,
    modeReason,
    asana: {
      baseUrl: env.ASANA_API_BASE_URL.replace(/\/+$/, ''),
      rateLimitRpm: env.ASANA_RATE_LIMIT_RPM,
      timeoutMs: env.ASANA_TIMEOUT_MS,
      maxConcurrency: env.ASANA_MAX_CONCURRENCY,
      defaultWorkspace: env.ASANA_DEFAULT_WORKSPACE,
    },
    accessToken: env.ASANA_ACCESS_TOKEN,
    oauth,
    server: {
      port: env.PORT,
      corsOrigin: env.CORS_ORIGIN,
      trustProxy: env.TRUST_PROXY,
      webDist: env.WEB_DIST,
      // Trailing slashes would double up when a path is appended to this.
      publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    },
    mcp: {
      transport: env.MCP_TRANSPORT,
      httpPort: env.MCP_HTTP_PORT,
      authToken: env.MCP_AUTH_TOKEN,
      allowedHosts:
        env.MCP_ALLOWED_HOSTS === undefined
          ? []
          : env.MCP_ALLOWED_HOSTS.split(',')
              .map((host) => host.trim())
              .filter((host) => host.length > 0),
    },
    ai: {
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL,
      enabled: env.GROQ_API_KEY !== undefined,
    },
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
    isProduction: env.NODE_ENV === 'production',
  };
}

function resolveMode(
  requested: Env['ASANA_MODE'],
  hasCredentials: boolean,
  token: string | undefined,
): { mode: RunMode; modeReason: string } {
  if (requested === 'demo') {
    return { mode: 'demo', modeReason: 'ASANA_MODE=demo was set explicitly.' };
  }

  if (requested === 'live') {
    if (!hasCredentials) {
      // Explicitly asking for live without credentials is a real mistake,
      // so fail loudly rather than silently degrading to fake data.
      throw new Error(
        'ASANA_MODE=live but no credentials were provided. Set ASANA_ACCESS_TOKEN ' +
          '(or a full OAuth app) in .env, or use ASANA_MODE=auto to fall back to demo mode.',
      );
    }
    return { mode: 'live', modeReason: 'ASANA_MODE=live with credentials present.' };
  }

  // auto
  if (!hasCredentials) {
    return {
      mode: 'demo',
      modeReason: 'No Asana credentials found, so the connector started in demo mode.',
    };
  }
  return {
    mode: 'live',
    modeReason: token !== undefined ? 'Personal Access Token found.' : 'OAuth app configured.',
  };
}

/** Load `.env` (if present) and return validated, cached config. */
export function getConfig(): AppConfig {
  if (cached === undefined) {
    // `.env` is optional by design — a missing file is normal, not an error.
    loadDotenv({ quiet: true });
    // The one sanctioned read of process.env in the entire project.
    // (Permitted here by the src/config.ts override in eslint.config.js.)
    cached = buildConfig(process.env);
  }
  return cached;
}

/** Test-only: drop the cache so a fresh environment can be loaded. */
export function resetConfigCache(): void {
  cached = undefined;
}

/* -------------------------------------------------------------------------- */
/* Safe description                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A representation of config that is safe to log, render in the UI, or return
 * over HTTP. Secrets are reduced to booleans and opaque fingerprints — there is
 * no field here that can carry a credential value, by construction.
 */
export interface SafeConfigDescription {
  readonly mode: RunMode;
  readonly modeReason: string;
  readonly nodeEnv: string;
  readonly asana: {
    readonly baseUrl: string;
    readonly rateLimitRpm: number;
    readonly timeoutMs: number;
    readonly maxConcurrency: number;
    readonly defaultWorkspace: string | null;
  };
  readonly auth: {
    readonly patConfigured: boolean;
    readonly oauthConfigured: boolean;
    readonly oauthRedirectUri: string | null;
    readonly oauthScopes: readonly string[];
    /** Non-reversible identifier so you can tell *which* credential is loaded. */
    readonly credentialFingerprint: string | null;
  };
  readonly server: {
    readonly port: number;
    readonly corsOrigin: string;
    /** Null when unset, in which case the console uses its own origin. */
    readonly publicBaseUrl: string | null;
  };
  readonly mcp: {
    readonly transport: string;
    readonly httpPort: number;
    /** Whether the public endpoint is guarded. Never the token itself. */
    readonly authRequired: boolean;
    /** The endpoint's public URL, when a public origin is configured. */
    readonly publicUrl: string | null;
  };
  /** Whether an assistant provider is configured. Never the key itself. */
  readonly aiEnabled: boolean;
  readonly aiModel: string | null;
  readonly credentialEncryptionEnabled: boolean;
}

export function describeConfig(cfg: AppConfig, fingerprint: string | null = null): SafeConfigDescription {
  return {
    mode: cfg.mode,
    modeReason: cfg.modeReason,
    nodeEnv: cfg.nodeEnv,
    asana: {
      baseUrl: cfg.asana.baseUrl,
      rateLimitRpm: cfg.asana.rateLimitRpm,
      timeoutMs: cfg.asana.timeoutMs,
      maxConcurrency: cfg.asana.maxConcurrency,
      defaultWorkspace: cfg.asana.defaultWorkspace ?? null,
    },
    auth: {
      patConfigured: cfg.accessToken !== undefined,
      oauthConfigured: cfg.oauth !== undefined,
      oauthRedirectUri: cfg.oauth?.redirectUri ?? null,
      oauthScopes: cfg.oauth?.scopes ?? [],
      credentialFingerprint: fingerprint,
    },
    server: {
      port: cfg.server.port,
      corsOrigin: cfg.server.corsOrigin,
      publicBaseUrl: cfg.server.publicBaseUrl ?? null,
    },
    mcp: {
      transport: cfg.mcp.transport,
      httpPort: cfg.mcp.httpPort,
      authRequired: cfg.mcp.authToken !== undefined,
      // Derived rather than separately configured: the endpoint is always
      // /mcp on this origin, so one variable cannot drift from the other.
      publicUrl:
        cfg.server.publicBaseUrl === undefined ? null : `${cfg.server.publicBaseUrl}/mcp`,
    },
    aiEnabled: cfg.ai.enabled,
    aiModel: cfg.ai.enabled ? cfg.ai.model : null,
    credentialEncryptionEnabled: cfg.credentialEncryptionKey !== undefined,
  };
}
