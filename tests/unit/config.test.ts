import { describe, expect, it } from 'vitest';
import { buildConfig, describeConfig } from '../../src/config.js';

/**
 * These tests use a fake token that matches the *shape* of an Asana PAT but is
 * obviously synthetic, so the secret scanner and any human reviewer can tell at
 * a glance that it is not real.
 */
const FAKE_PAT = '1/0000000000000000:placeholder-not-a-real-token';

describe('buildConfig — mode resolution', () => {
  it('falls back to demo mode when no credentials are present', () => {
    const cfg = buildConfig({});

    expect(cfg.mode).toBe('demo');
    expect(cfg.modeReason).toMatch(/no asana credentials/i);
    expect(cfg.accessToken).toBeUndefined();
    expect(cfg.oauth).toBeUndefined();
  });

  it('selects live mode when a PAT is present under auto', () => {
    const cfg = buildConfig({ ASANA_ACCESS_TOKEN: FAKE_PAT });

    expect(cfg.mode).toBe('live');
    expect(cfg.modeReason).toMatch(/personal access token/i);
  });

  it('selects live mode when a complete OAuth app is configured', () => {
    const cfg = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'client-id-placeholder',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret-placeholder',
    });

    expect(cfg.mode).toBe('live');
    expect(cfg.oauth?.clientId).toBe('client-id-placeholder');
  });

  it('ignores a half-configured OAuth app rather than starting broken', () => {
    // Client id without a secret cannot complete a token exchange, so it must
    // not be treated as usable credentials.
    const cfg = buildConfig({ ASANA_OAUTH_CLIENT_ID: 'client-id-placeholder' });

    expect(cfg.oauth).toBeUndefined();
    expect(cfg.mode).toBe('demo');
  });

  it('honours an explicit demo mode even when credentials exist', () => {
    const cfg = buildConfig({ ASANA_MODE: 'demo', ASANA_ACCESS_TOKEN: FAKE_PAT });

    expect(cfg.mode).toBe('demo');
    expect(cfg.modeReason).toMatch(/explicitly/i);
  });

  it('fails loudly when live mode is demanded without credentials', () => {
    // Silently degrading to fake data here would be the worst outcome: the user
    // asked for real Asana data and would get synthetic data that looks real.
    expect(() => buildConfig({ ASANA_MODE: 'live' })).toThrow(/no credentials/i);
  });
});

describe('buildConfig — value handling', () => {
  it('treats a blank env var as unset rather than an empty string', () => {
    const cfg = buildConfig({ ASANA_ACCESS_TOKEN: '   ', ASANA_DEFAULT_WORKSPACE: '' });

    expect(cfg.accessToken).toBeUndefined();
    expect(cfg.asana.defaultWorkspace).toBeUndefined();
    expect(cfg.mode).toBe('demo');
  });

  it('applies documented defaults', () => {
    const cfg = buildConfig({});

    expect(cfg.asana.baseUrl).toBe('https://app.asana.com/api/1.0');
    expect(cfg.asana.rateLimitRpm).toBe(140); // just under the 150/min free tier
    expect(cfg.asana.timeoutMs).toBe(15_000);
    expect(cfg.asana.maxConcurrency).toBe(8);
    expect(cfg.server.port).toBe(8787);
    expect(cfg.mcp.transport).toBe('stdio');
  });

  it('parses numeric env vars and falls back on nonsense', () => {
    expect(buildConfig({ ASANA_RATE_LIMIT_RPM: '900' }).asana.rateLimitRpm).toBe(900);
    expect(buildConfig({ ASANA_RATE_LIMIT_RPM: 'banana' }).asana.rateLimitRpm).toBe(140);
    // Out of range values fall back rather than producing an unusable client.
    expect(buildConfig({ ASANA_RATE_LIMIT_RPM: '99999' }).asana.rateLimitRpm).toBe(140);
  });

  it('strips a trailing slash from the API base url', () => {
    const cfg = buildConfig({ ASANA_API_BASE_URL: 'https://app.asana.com/api/1.0/' });
    expect(cfg.asana.baseUrl).toBe('https://app.asana.com/api/1.0');
  });

  it('splits oauth scopes on whitespace and commas', () => {
    const cfg = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'id',
      ASANA_OAUTH_CLIENT_SECRET: 'secret-placeholder',
      ASANA_OAUTH_SCOPES: 'projects:read, tasks:read  tasks:write',
    });

    expect(cfg.oauth?.scopes).toEqual(['projects:read', 'tasks:read', 'tasks:write']);
  });

  it('never requests a delete scope by default', () => {
    // Delete is not one of the five assigned actions, so the connector must
    // never ask for the permission to do it.
    const cfg = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'id',
      ASANA_OAUTH_CLIENT_SECRET: 'secret-placeholder',
    });

    expect(cfg.oauth?.scopes.some((s) => s.includes('delete'))).toBe(false);
  });
});

describe('describeConfig — secret safety', () => {
  it('reports credential presence without exposing any value', () => {
    const cfg = buildConfig({
      ASANA_ACCESS_TOKEN: FAKE_PAT,
      ASANA_OAUTH_CLIENT_ID: 'client-id-placeholder',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret-placeholder',
      CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
    });

    const safe = describeConfig(cfg, 'fp_abc123');
    const serialised = JSON.stringify(safe);

    // The three things that must never appear, anywhere in the output.
    expect(serialised).not.toContain(FAKE_PAT);
    expect(serialised).not.toContain('client-secret-placeholder');
    expect(serialised).not.toContain('a'.repeat(64));

    // But the operator can still tell what is configured.
    expect(safe.auth.patConfigured).toBe(true);
    expect(safe.auth.oauthConfigured).toBe(true);
    expect(safe.credentialEncryptionEnabled).toBe(true);
    expect(safe.auth.credentialFingerprint).toBe('fp_abc123');
  });

  it('is honest when nothing is configured', () => {
    const safe = describeConfig(buildConfig({}));

    expect(safe.auth.patConfigured).toBe(false);
    expect(safe.auth.oauthConfigured).toBe(false);
    expect(safe.auth.credentialFingerprint).toBeNull();
    expect(safe.mode).toBe('demo');
  });
});
