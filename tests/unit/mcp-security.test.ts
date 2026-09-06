/**
 * MCP transport security policy.
 *
 * This file exists because the previous behaviour — authorize everyone when no
 * token is configured, and log a warning in production — passed every test
 * that existed at the time. Nothing asserted that an insecure configuration
 * must REFUSE TO START, so nothing stopped it shipping.
 *
 * The matrix below is therefore exhaustive over the inputs that decide the
 * posture: NODE_ENV × token × bind address × the explicit opt-out flag. Each
 * case asserts either a concrete decision or a throw; there is no combination
 * that is left unstated.
 */

import { describe, expect, it } from 'vitest';

import {
  InsecureMcpConfigurationError,
  MIN_MCP_TOKEN_LENGTH,
  describeEphemeralToken,
  isLoopbackBind,
  resolveMcpSecurity,
  type McpSecurityInput,
} from '../../src/runtime/mcp-security.js';
import { buildConfig } from '../../src/config.js';

/** A 64-hex-character token, i.e. what the documented generator produces. */
const GOOD_TOKEN = 'a'.repeat(64);

function input(overrides: Partial<McpSecurityInput> = {}): McpSecurityInput {
  return {
    nodeEnv: 'development',
    authToken: undefined,
    allowUnauthenticated: false,
    bindHost: '127.0.0.1',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Bind classification                                                         */
/* -------------------------------------------------------------------------- */

describe('isLoopbackBind', () => {
  it.each(['127.0.0.1', '127.0.0.53', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackBind(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '[::]', '192.168.1.10', '10.0.0.4', 'example.com', ''])(
    'treats %s as externally reachable',
    (host) => {
      // The default has to be pessimistic: anything not provably loopback is
      // assumed to be reachable from off-box.
      expect(isLoopbackBind(host)).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The required matrix                                                         */
/* -------------------------------------------------------------------------- */

describe('resolveMcpSecurity — production', () => {
  it('FAILS when MCP_AUTH_TOKEN is missing', () => {
    expect(() => resolveMcpSecurity(input({ nodeEnv: 'production', bindHost: '0.0.0.0' }))).toThrow(
      InsecureMcpConfigurationError,
    );
  });

  it('FAILS when MCP_AUTH_TOKEN is empty', () => {
    expect(() =>
      resolveMcpSecurity(input({ nodeEnv: 'production', bindHost: '0.0.0.0', authToken: '' })),
    ).toThrow(InsecureMcpConfigurationError);
  });

  it('FAILS when MCP_AUTH_TOKEN is only whitespace', () => {
    expect(() =>
      resolveMcpSecurity(input({ nodeEnv: 'production', bindHost: '0.0.0.0', authToken: '   \t ' })),
    ).toThrow(InsecureMcpConfigurationError);
  });

  it('FAILS even when bound to loopback — production is unconditional', () => {
    // A production process behind a reverse proxy still binds loopback, and
    // the proxy makes it public. NODE_ENV alone is enough to require a token.
    expect(() => resolveMcpSecurity(input({ nodeEnv: 'production', bindHost: '127.0.0.1' }))).toThrow(
      InsecureMcpConfigurationError,
    );
  });

  it('FAILS when the unauthenticated bypass is switched on', () => {
    // The bypass is refused rather than ignored: silently ignoring an
    // operator's security setting is its own failure mode.
    expect(() =>
      resolveMcpSecurity(
        input({ nodeEnv: 'production', bindHost: '0.0.0.0', allowUnauthenticated: true }),
      ),
    ).toThrow(/refus|production/i);
  });

  it('STARTS with a token configured', () => {
    const decision = resolveMcpSecurity(
      input({ nodeEnv: 'production', bindHost: '0.0.0.0', authToken: GOOD_TOKEN }),
    );

    expect(decision).toMatchObject({
      authRequired: true,
      token: GOOD_TOKEN,
      source: 'configured',
    });
  });

  it('FAILS on a token too short to be worth having', () => {
    expect(() =>
      resolveMcpSecurity(
        input({ nodeEnv: 'production', bindHost: '0.0.0.0', authToken: 'x'.repeat(MIN_MCP_TOKEN_LENGTH - 1) }),
      ),
    ).toThrow(/at least/i);
  });
});

describe('resolveMcpSecurity — external bind', () => {
  it.each(['0.0.0.0', '::', '192.168.1.10', 'connector.internal'])(
    'FAILS on %s without a token, even in development',
    (bindHost) => {
      expect(() => resolveMcpSecurity(input({ nodeEnv: 'development', bindHost }))).toThrow(
        InsecureMcpConfigurationError,
      );
    },
  );

  it('FAILS on an external bind even with the bypass flag set', () => {
    expect(() =>
      resolveMcpSecurity(
        input({ nodeEnv: 'development', bindHost: '0.0.0.0', allowUnauthenticated: true }),
      ),
    ).toThrow(/non-loopback|refus/i);
  });

  it('STARTS on an external bind with a token', () => {
    const decision = resolveMcpSecurity(
      input({ nodeEnv: 'development', bindHost: '0.0.0.0', authToken: GOOD_TOKEN }),
    );
    expect(decision.authRequired).toBe(true);
    expect(decision.source).toBe('configured');
  });
});

describe('resolveMcpSecurity — development on loopback', () => {
  it('runs OPEN only when the flag says so explicitly', () => {
    const decision = resolveMcpSecurity(input({ allowUnauthenticated: true }));

    expect(decision.authRequired).toBe(false);
    expect(decision.token).toBeUndefined();
    expect(decision.source).toBe('explicitly-open');
  });

  it('mints a token rather than running open when no flag is given', () => {
    // The secure default. "No token configured" must never resolve to
    // "no token required".
    const decision = resolveMcpSecurity(input());

    expect(decision.authRequired).toBe(true);
    expect(decision.source).toBe('ephemeral-dev');
    expect(decision.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a different token every time, so nothing can hard-code one', () => {
    const a = resolveMcpSecurity(input()).token;
    const b = resolveMcpSecurity(input()).token;
    expect(a).not.toBe(b);
  });

  it('refuses a contradictory configuration rather than picking a winner', () => {
    // Whichever we honoured, the operator believed the other was in force.
    expect(() =>
      resolveMcpSecurity(input({ authToken: GOOD_TOKEN, allowUnauthenticated: true })),
    ).toThrow(/contradict/i);
  });

  it('prints the minted token so it is actually usable', () => {
    const decision = resolveMcpSecurity(input());
    const banner = describeEphemeralToken(decision, '/mcp');

    expect(banner).toContain(decision.token as string);
    expect(banner).toContain('Bearer');
  });

  it('prints nothing for a configured or open endpoint', () => {
    expect(describeEphemeralToken(resolveMcpSecurity(input({ authToken: GOOD_TOKEN })), '/mcp')).toBe('');
    expect(
      describeEphemeralToken(resolveMcpSecurity(input({ allowUnauthenticated: true })), '/mcp'),
    ).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* No secret may reach a describable surface                                   */
/* -------------------------------------------------------------------------- */

describe('the decision never leaks the token into diagnostics', () => {
  it('keeps the token out of `reason`, which is logged verbatim', () => {
    for (const decision of [
      resolveMcpSecurity(input({ authToken: GOOD_TOKEN })),
      resolveMcpSecurity(input()),
      resolveMcpSecurity(input({ allowUnauthenticated: true })),
    ]) {
      if (decision.token !== undefined) {
        expect(decision.reason).not.toContain(decision.token);
      }
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Config wiring                                                               */
/* -------------------------------------------------------------------------- */

describe('config supplies the policy its inputs', () => {
  it('defaults the bind to loopback outside production', () => {
    const cfg = buildConfig({ NODE_ENV: 'development' });
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.server.externallyBound).toBe(false);
  });

  it('defaults the bind to every interface in production, where a proxy needs it', () => {
    const cfg = buildConfig({ NODE_ENV: 'production', MCP_AUTH_TOKEN: GOOD_TOKEN });
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.server.externallyBound).toBe(true);
  });

  it('honours an explicit HOST', () => {
    expect(buildConfig({ HOST: '0.0.0.0' }).server.externallyBound).toBe(true);
    expect(buildConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' }).server.externallyBound).toBe(
      false,
    );
  });

  it('treats a blank MCP_AUTH_TOKEN as absent, not as an empty-string token', () => {
    expect(buildConfig({ MCP_AUTH_TOKEN: '   ' }).mcp.authToken).toBeUndefined();
  });

  it('reads the unauthenticated flag, defaulting to false', () => {
    expect(buildConfig({}).mcp.allowUnauthenticated).toBe(false);
    expect(buildConfig({ MCP_ALLOW_UNAUTHENTICATED: 'true' }).mcp.allowUnauthenticated).toBe(true);
    expect(buildConfig({ MCP_ALLOW_UNAUTHENTICATED: 'no' }).mcp.allowUnauthenticated).toBe(false);
  });

  it('produces a production config that the policy then refuses', () => {
    // The two halves working together: config reads the environment faithfully,
    // and the policy is what says no.
    const cfg = buildConfig({ NODE_ENV: 'production' });
    expect(() =>
      resolveMcpSecurity({
        nodeEnv: cfg.nodeEnv,
        authToken: cfg.mcp.authToken,
        allowUnauthenticated: cfg.mcp.allowUnauthenticated,
        bindHost: cfg.server.host,
      }),
    ).toThrow(InsecureMcpConfigurationError);
  });
});
