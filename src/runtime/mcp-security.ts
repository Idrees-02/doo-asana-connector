/**
 * MCP HTTP transport security policy.
 *
 * ============================================================================
 * THE ENDPOINT THIS GUARDS EXECUTES REAL WRITES AGAINST A REAL ASANA WORKSPACE
 * USING THE SERVER'S OWN CREDENTIAL. AN OPEN /mcp IS AN OPEN DOOR.
 * ============================================================================
 *
 * The previous implementation authorized every request when no token was
 * configured and merely logged a warning in production. A warning does not
 * stop anyone. This module replaces that with a decision that FAILS CLOSED:
 * an insecure combination throws, the process never reaches `listen`, and the
 * endpoint is never exposed.
 *
 * The policy, in the order it is evaluated:
 *
 *   1. A usable token is configured           -> AUTHENTICATED. Always allowed.
 *   2. No token, and NODE_ENV=production      -> THROW.
 *   3. No token, and the bind address is
 *      reachable from off-box                 -> THROW.
 *   4. No token, loopback, non-production,
 *      MCP_ALLOW_UNAUTHENTICATED=true         -> OPEN. Explicit, local only.
 *   5. No token, loopback, non-production,
 *      no flag                                -> EPHEMERAL. A random token is
 *                                                minted for this process and
 *                                                printed to stderr.
 *
 * Rule 5 is the secure default: out of the box, with zero configuration, the
 * endpoint is authenticated. Rule 4 exists because a reviewer running locally
 * may reasonably want the door open, and making that an explicit, named,
 * loudly-logged choice is better than making "no token" mean "no auth".
 *
 * Rules 2 and 3 are what make rule 4 safe to offer at all: the bypass cannot
 * be switched on in production or on an externally-bound socket. Setting the
 * flag there is not ignored — it is a startup error, because silently
 * ignoring an operator's security setting is its own failure mode.
 *
 * SEPARATION OF CONCERNS, STATED EXPLICITLY: nothing here consults, or can be
 * satisfied by, `approved: true`. Approval is a *write-consent* control
 * carried inside an already-authenticated request body. Authentication is a
 * *transport-admission* control. An unauthenticated caller is rejected before
 * a request body is ever read, so `approved` never gets the chance to matter.
 * `tests/unit/mcp-security.test.ts` asserts this directly.
 */

import { randomBytes } from 'node:crypto';

/** How the endpoint ended up in the state it is in. Surfaced in logs and /health. */
export type McpAuthSource =
  /** MCP_AUTH_TOKEN was supplied. */
  | 'configured'
  /** Minted for this process because none was supplied. Never persisted. */
  | 'ephemeral-dev'
  /** Deliberately unauthenticated. Only reachable on loopback, non-production. */
  | 'explicitly-open';

export interface McpSecurityDecision {
  /** True unless the operator explicitly opted out on a loopback dev socket. */
  readonly authRequired: boolean;
  /** The bearer token the endpoint will accept, or undefined when open. */
  readonly token: string | undefined;
  readonly source: McpAuthSource;
  /** Human-readable justification, logged at startup so the state is never a mystery. */
  readonly reason: string;
}

export interface McpSecurityInput {
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** Raw MCP_AUTH_TOKEN. Blank/whitespace is treated as absent by config. */
  readonly authToken: string | undefined;
  /** MCP_ALLOW_UNAUTHENTICATED. */
  readonly allowUnauthenticated: boolean;
  /** The interface the HTTP server binds to, e.g. `127.0.0.1` or `0.0.0.0`. */
  readonly bindHost: string;
}

/**
 * Shortest token accepted in a configured deployment.
 *
 * A four-character "token" is theatre. 32 hex characters (128 bits) is what
 * the documented generator produces; 16 is the floor, low enough not to
 * obstruct a reasonable secrets manager and high enough to be unguessable.
 */
export const MIN_MCP_TOKEN_LENGTH = 16;

/**
 * Addresses from which the socket is NOT reachable off-box.
 *
 * `0.0.0.0` and `::` are the dangerous ones: they mean "every interface",
 * which is exactly the deployed case. Anything that is not demonstrably
 * loopback is treated as external — the default has to be the pessimistic one.
 */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Thrown when the configuration would expose an unauthenticated MCP endpoint.
 *
 * A distinct class so the entry points can print the remediation without
 * catching unrelated startup failures, and so tests assert on the type rather
 * than on message text.
 */
export class InsecureMcpConfigurationError extends Error {
  override readonly name = 'InsecureMcpConfigurationError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve the transport's security posture, or refuse to start.
 *
 * Pure and total: every input combination either returns a decision or throws.
 * That is what makes the full matrix testable without booting a server.
 */
export function resolveMcpSecurity(input: McpSecurityInput): McpSecurityDecision {
  const isProduction = input.nodeEnv === 'production';
  const loopback = isLoopbackBind(input.bindHost);
  const token = input.authToken?.trim();
  const hasToken = token !== undefined && token.length > 0;

  /* 1. A configured token. The only posture allowed when exposed. ---------- */
  if (hasToken) {
    if (token.length < MIN_MCP_TOKEN_LENGTH) {
      throw new InsecureMcpConfigurationError(
        `MCP_AUTH_TOKEN is only ${token.length} characters. It must be at least ` +
          `${MIN_MCP_TOKEN_LENGTH}. Generate one with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }

    // Setting both is contradictory. Refusing is safer than picking a winner:
    // whichever we chose, the operator believed the other.
    if (input.allowUnauthenticated) {
      throw new InsecureMcpConfigurationError(
        'MCP_AUTH_TOKEN and MCP_ALLOW_UNAUTHENTICATED=true were both set. ' +
          'These contradict each other. Remove one.',
      );
    }

    return {
      authRequired: true,
      token,
      source: 'configured',
      reason: 'MCP_AUTH_TOKEN is configured; every request must present it as a bearer token.',
    };
  }

  /* 2. Production without a token. Non-negotiable. ------------------------- */
  if (isProduction) {
    throw new InsecureMcpConfigurationError(
      'Refusing to start: NODE_ENV=production and MCP_AUTH_TOKEN is not set.\n' +
        'The /mcp endpoint executes real writes against Asana with this server\'s own\n' +
        'credential, so an unauthenticated production endpoint is an open door.\n' +
        'Set MCP_AUTH_TOKEN. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'MCP_ALLOW_UNAUTHENTICATED is refused in production and cannot be used here.',
    );
  }

  /* 3. Externally reachable without a token. Equally non-negotiable. ------- */
  if (!loopback) {
    throw new InsecureMcpConfigurationError(
      `Refusing to start: the HTTP server binds to "${input.bindHost}", which is reachable\n` +
        'from outside this machine, and MCP_AUTH_TOKEN is not set.\n' +
        'Either set MCP_AUTH_TOKEN, or bind to loopback with HOST=127.0.0.1.\n' +
        'MCP_ALLOW_UNAUTHENTICATED is refused on a non-loopback bind.',
    );
  }

  /* 4. Explicit, local, non-production opt-out. ---------------------------- */
  if (input.allowUnauthenticated) {
    return {
      authRequired: false,
      token: undefined,
      source: 'explicitly-open',
      reason:
        `MCP_ALLOW_UNAUTHENTICATED=true on a loopback bind (${input.bindHost}) in ` +
        `${input.nodeEnv}. The endpoint is UNAUTHENTICATED and reachable only from this machine.`,
    };
  }

  /* 5. Secure default: mint a token rather than leave the door open. ------- */
  return {
    authRequired: true,
    token: randomBytes(32).toString('hex'),
    source: 'ephemeral-dev',
    reason:
      'No MCP_AUTH_TOKEN was set, so a random one was generated for this process and ' +
      'printed to stderr. It changes on every restart and is never written to disk. ' +
      'Set MCP_AUTH_TOKEN for a stable token, or MCP_ALLOW_UNAUTHENTICATED=true to ' +
      'run the local endpoint open.',
  };
}

/**
 * The startup banner for an ephemeral token.
 *
 * Printed to stderr rather than stdout because the stdio MCP transport owns
 * stdout, and returned as a string rather than printed here so the caller
 * decides where it goes (and so it is testable).
 */
export function describeEphemeralToken(decision: McpSecurityDecision, path: string): string {
  if (decision.source !== 'ephemeral-dev' || decision.token === undefined) return '';
  return [
    '',
    '  MCP endpoint authentication (development)',
    `  No MCP_AUTH_TOKEN was set, so this process generated one:`,
    '',
    `    Authorization: Bearer ${decision.token}`,
    '',
    `  It is valid only for this process and only at ${path}.`,
    '  Set MCP_AUTH_TOKEN in .env for a stable token.',
    '',
  ].join('\n');
}
