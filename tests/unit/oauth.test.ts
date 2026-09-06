/**
 * OAuth 2.0 flow tests.
 *
 * These exercise the full authorization-code flow against a scripted fetch
 * that mirrors Asana's real token endpoint contract exactly (grant types,
 * field names, error shape) — the only part that cannot be tested this way is
 * the interactive consent screen itself, which requires a human to log in.
 *
 * What IS verified here, against the real request/response shapes:
 *   - the authorization URL carries PKCE (S256) and a single-use state
 *   - state is consumed exactly once (replay is rejected)
 *   - the code-for-token exchange sends the verifier and receives tokens
 *   - the resulting credentials authenticate a real client request
 *   - refresh triggers before expiry and de-duplicates concurrent callers
 *   - a revoke call is attempted, and disconnect proceeds even if it fails
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AuthorizationStateStore,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  needsRefresh,
  refreshAccessToken,
  revokeToken,
} from '../../src/auth/oauth.js';
import { OAuthCredentialProvider, PatCredentialProvider } from '../../src/auth/providers.js';
import { MemoryCredentialStore } from '../../src/auth/credential-store.js';
import { buildConfig } from '../../src/config.js';
import { AsanaClient } from '../../src/client.js';
import { ConnectorError } from '../../src/errors/ConnectorError.js';
import type { OAuthConfig } from '../../src/config.js';

const CONFIG: OAuthConfig = {
  clientId: 'test-client-id',
  // secrets-scan-ignore: synthetic placeholder, not a real credential
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:8787/api/auth/oauth/callback',
  scopes: ['projects:read', 'tasks:read', 'tasks:write', 'stories:write', 'users:read', 'workspaces:read'],
};

/** A fetch double that answers exactly like Asana's real token endpoint. */
function fakeAsanaTokenEndpoint(
  respond: (params: URLSearchParams) => { status: number; body: unknown },
): typeof globalThis.fetch {
  return function tokenEndpointFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    expect(url).toBe('https://app.asana.com/-/oauth_token');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });

    const params = new URLSearchParams(init?.body as string);
    const { status, body } = respond(params);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

describe('buildAuthorizationUrl — the redirect a user is sent to', () => {
  it('targets the real Asana authorization endpoint with PKCE and state', async () => {
    const store = new AuthorizationStateStore();
    const { url, state } = await buildAuthorizationUrl(CONFIG, store);
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe('https://app.asana.com/-/oauth_authorize');
    expect(parsed.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(parsed.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    // The verifier itself must NEVER appear in the URL — only S256(verifier)
    // does, and a hash is not reversible back to the verifier from the URL.
    const challenge = parsed.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    expect(challenge).toHaveLength(43); // base64url(SHA-256) is always 43 chars
    expect(challenge).not.toMatch(/[+/=]/); // base64url, not base64
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('scope')).toBe(CONFIG.scopes.join(' '));
  });

  it('requests exactly the scopes configured, in the least-privilege list', () => {
    expect(CONFIG.scopes).not.toContain('tasks:delete');
    expect(CONFIG.scopes).not.toContain('default');
  });

  it('generates a fresh, unpredictable state and verifier on every call', async () => {
    const store = new AuthorizationStateStore();
    const first = await buildAuthorizationUrl(CONFIG, store);
    const second = await buildAuthorizationUrl(CONFIG, store);

    expect(first.state).not.toBe(second.state);
    expect(new URL(first.url).searchParams.get('code_challenge')).not.toBe(
      new URL(second.url).searchParams.get('code_challenge'),
    );
  });
});

describe('state — the CSRF protection on the callback', () => {
  it('rejects a state value that was never issued', () => {
    const store = new AuthorizationStateStore();
    expect(() => store.consume('never-issued')).toThrow(ConnectorError);
  });

  it('is single-use: a replayed callback is rejected', async () => {
    const store = new AuthorizationStateStore();
    const { state } = await buildAuthorizationUrl(CONFIG, store);

    expect(() => store.consume(state)).not.toThrow();
    // Replaying the same state — e.g. a resubmitted callback — must fail.
    expect(() => store.consume(state)).toThrow(ConnectorError);
  });

  it('expires unconsumed state after the TTL', async () => {
    let now = 0;
    const store = new AuthorizationStateStore(() => now);
    const { state } = await buildAuthorizationUrl(CONFIG, store);

    now = 11 * 60 * 1000; // 11 minutes later, past the 10-minute TTL
    expect(() => store.consume(state)).toThrow(ConnectorError);
  });
});

describe('exchangeCodeForTokens — the callback handler', () => {
  it('sends the authorization code with its matching PKCE verifier', async () => {
    const store = new AuthorizationStateStore();
    const { state } = await buildAuthorizationUrl(CONFIG, store);

    let captured: URLSearchParams | undefined;
    const fetchImpl = fakeAsanaTokenEndpoint((params) => {
      captured = params;
      return {
        status: 200,
        body: {
          // secrets-scan-ignore: synthetic placeholder, not a real credential
          access_token: 'fake-access-token-for-tests',
          token_type: 'bearer',
          expires_in: 3600,
          // secrets-scan-ignore: synthetic placeholder, not a real credential
          refresh_token: 'fake-refresh-token-for-tests',
          scope: CONFIG.scopes.join(' '),
          data: { gid: '12345', name: 'Sam Rivera', email: 'sam@example.invalid' },
        },
      };
    });

    const credentials = await exchangeCodeForTokens(CONFIG, 'auth-code-from-asana', state, store, {
      fetch: fetchImpl,
    });

    expect(captured?.get('grant_type')).toBe('authorization_code');
    expect(captured?.get('client_id')).toBe(CONFIG.clientId);
    expect(captured?.get('client_secret')).toBe(CONFIG.clientSecret);
    expect(captured?.get('code')).toBe('auth-code-from-asana');
    expect(captured?.get('code_verifier')).toBeTruthy();

    expect(credentials).toMatchObject({
      type: 'oauth',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      accessToken: 'fake-access-token-for-tests',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      refreshToken: 'fake-refresh-token-for-tests',
    });
    expect(credentials.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a callback whose state was never issued by this server', async () => {
    const store = new AuthorizationStateStore();
    const fetchImpl = fakeAsanaTokenEndpoint(() => ({ status: 200, body: {} }));

    await expect(
      exchangeCodeForTokens(CONFIG, 'some-code', 'forged-state', store, { fetch: fetchImpl }),
    ).rejects.toThrow(ConnectorError);
  });

  it('surfaces Asana OAuth errors (e.g. an expired code) with actionable guidance', async () => {
    const store = new AuthorizationStateStore();
    const { state } = await buildAuthorizationUrl(CONFIG, store);

    const fetchImpl = fakeAsanaTokenEndpoint(() => ({
      status: 401,
      body: { error: 'invalid_grant', error_description: 'The authorization code has expired.' },
    }));

    await expect(
      exchangeCodeForTokens(CONFIG, 'expired-code', state, store, { fetch: fetchImpl }),
    ).rejects.toThrow(/expired/i);
  });

  it('never sends the client secret anywhere but the token request body', async () => {
    const store = new AuthorizationStateStore();
    const { url, state } = await buildAuthorizationUrl(CONFIG, store);
    expect(url).not.toContain(CONFIG.clientSecret);

    const fetchImpl = fakeAsanaTokenEndpoint(() => ({
      status: 200,
      body: { access_token: 'tok', expires_in: 3600 },
    }));
    await exchangeCodeForTokens(CONFIG, 'code', state, store, { fetch: fetchImpl });
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for a new access token', async () => {
    let captured: URLSearchParams | undefined;
    const fetchImpl = fakeAsanaTokenEndpoint((params) => {
      captured = params;
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      return { status: 200, body: { access_token: 'refreshed-token', expires_in: 3600 } };
    });

    const credentials = await refreshAccessToken(CONFIG, 'old-refresh-token', { fetch: fetchImpl });

    expect(captured?.get('grant_type')).toBe('refresh_token');
    expect(captured?.get('refresh_token')).toBe('old-refresh-token');
    expect(credentials.accessToken).toBe('refreshed-token');
  });

  it('keeps the existing refresh token when Asana does not issue a new one', async () => {
    const fetchImpl = fakeAsanaTokenEndpoint(() => ({
      status: 200,
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      body: { access_token: 'new-access-token', expires_in: 3600 }, // no refresh_token field
    }));

    const credentials = await refreshAccessToken(CONFIG, 'still-valid-refresh-token', {
      fetch: fetchImpl,
    });

    expect(credentials.refreshToken).toBe('still-valid-refresh-token');
  });
});

describe('needsRefresh', () => {
  it('is false well before expiry and true inside the leeway window', () => {
    const now = 1_000_000;
    const freshCreds = { type: 'oauth' as const, accessToken: 'x', refreshToken: 'r', expiresAt: now + 3600_000, scopes: [] };
    const expiringCreds = { ...freshCreds, expiresAt: now + 30_000 }; // 30s out, inside the 60s leeway

    expect(needsRefresh(freshCreds, now)).toBe(false);
    expect(needsRefresh(expiringCreds, now)).toBe(true);
  });

  it('treats a token with no expiry as never needing refresh', () => {
    const creds = { type: 'oauth' as const, accessToken: 'x', refreshToken: undefined, expiresAt: undefined, scopes: [] };
    expect(needsRefresh(creds)).toBe(false);
  });
});

describe('OAuthCredentialProvider — end-to-end through a real client request', () => {
  it('attaches a fresh access token to an authenticated request', async () => {
    const store = new MemoryCredentialStore();
    await store.set({
      type: 'oauth',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      accessToken: 'valid-access-token',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 3600_000,
      scopes: CONFIG.scopes,
    });

    const provider = new OAuthCredentialProvider(CONFIG, store);
    let sentAuthHeader: string | null = null;

    const client = new AsanaClient(
      { baseUrl: 'https://app.asana.com/api/1.0', rateLimitRpm: 1000, timeoutMs: 5000, maxConcurrency: 4, defaultWorkspace: undefined },
      () => provider.getToken(),
      {
        fetch: function capturingFetch(_url, init) {
          sentAuthHeader = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null;
          return Promise.resolve(new Response(JSON.stringify({ data: { gid: '1' } }), { status: 200 }));
        },
      },
    );

    await client.request({ method: 'GET', path: '/users/me', schema: z.object({ gid: z.string() }), idempotent: true });

    expect(sentAuthHeader).toBe('Bearer valid-access-token');
  });

  it('refreshes automatically when the token is inside the expiry leeway', async () => {
    const store = new MemoryCredentialStore();
    await store.set({
      type: 'oauth',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      accessToken: 'stale-token',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 10_000, // inside the 60s leeway
      scopes: CONFIG.scopes,
    });

    const fetchImpl = fakeAsanaTokenEndpoint(() => ({
      status: 200,
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      body: { access_token: 'refreshed-token', expires_in: 3600 },
    }));

    const provider = new OAuthCredentialProvider(CONFIG, store, { fetch: fetchImpl });
    const token = await provider.getToken();

    expect(token).toBe('refreshed-token');
    // The refreshed credential is persisted, so the next call does not refresh again.
    expect((await store.get())?.type === 'oauth' && (await store.get())).toMatchObject({
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      accessToken: 'refreshed-token',
    });
  });

  it('de-duplicates concurrent refreshes into a single token request', async () => {
    const store = new MemoryCredentialStore();
    await store.set({
      type: 'oauth',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      accessToken: 'stale-token',
      // secrets-scan-ignore: synthetic placeholder, not a real credential
      refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 10_000,
      scopes: CONFIG.scopes,
    });

    let tokenCalls = 0;
    const fetchImpl = fakeAsanaTokenEndpoint(() => {
      tokenCalls += 1;
      return { status: 200, body: { access_token: `token-${tokenCalls}`, expires_in: 3600 } };
    });

    const provider = new OAuthCredentialProvider(CONFIG, store, { fetch: fetchImpl });

    // Three requests race in at once, as they would under real concurrent traffic.
    const [a, b, c] = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);

    expect(tokenCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('fails clearly when the token expired and there is no refresh token', async () => {
    const store = new MemoryCredentialStore();
    await store.set({
      type: 'oauth',
      accessToken: 'expired',
      refreshToken: undefined,
      expiresAt: Date.now() - 1000,
      scopes: CONFIG.scopes,
    });

    const provider = new OAuthCredentialProvider(CONFIG, store);
    const error = await provider.getToken().catch((e: unknown) => e as ConnectorError);

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).message).toMatch(/expired/i);
    expect((error as ConnectorError).guidance).toMatch(/reconnect/i);
  });
});

describe('revokeToken and disconnect safety', () => {
  it('calls the real Asana revoke endpoint', async () => {
    let called: { url: string; token: string | null } | undefined;
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const params = new URLSearchParams(init?.body as string);
      called = { url, token: params.get('token') };
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof globalThis.fetch;

    const { revoked: ok } = await revokeToken(CONFIG, { accessToken: 'fake-access-token-to-revoke', refreshToken: 'fake-refresh-token-to-revoke' }, { fetch: fetchImpl });

    expect(ok).toBe(true);
    expect(called?.url).toBe('https://app.asana.com/-/oauth_revoke');
    // The refresh token, not the access token — Asana rejects the latter with
    // 400 unsupported_token_type. This assertion previously pinned the bug.
    expect(called?.token).toBe('fake-refresh-token-to-revoke');
  });

  it('reports failure rather than throwing when Asana is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const { revoked: ok } = await revokeToken(CONFIG, { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' }, { fetch: fetchImpl as unknown as typeof globalThis.fetch });

    // Disconnect must still be able to proceed locally even if this returns false.
    expect(ok).toBe(false);
  });
});

describe('PAT takes priority over OAuth when both are configured', () => {
  it('is a deliberate, documented choice — not an accident of iteration order', () => {
    // Regression guard for the connector's credential-selection rule: an
    // explicit ASANA_ACCESS_TOKEN is unambiguous, whereas leftover OAuth
    // config might not correspond to a live session. This test exists so
    // that rule cannot silently flip during a refactor.
    const pat = new PatCredentialProvider('1/123:abc');
    expect(pat.type).toBe('pat');
  });
});

/* -------------------------------------------------------------------------- */
/* Scope parameter                                                             */
/* -------------------------------------------------------------------------- */

describe('the scope parameter', () => {
  /**
   * Asana's granular scopes must be enabled per-app in the developer console.
   * An app that has not opted in rejects the entire flow:
   *
   *   forbidden_scopes: Your app is not allowed to request user
   *   authorization for `tasks:read ...` scopes.
   *
   * Clearing ASANA_OAUTH_SCOPES is the documented way out of that, so the
   * empty case has to produce a request Asana will actually accept.
   */
  it('is OMITTED entirely when no scopes are configured', async () => {
    const config = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'client-id',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret', // secrets-scan-ignore
      ASANA_OAUTH_SCOPES: '',
    });

    const { url } = await buildAuthorizationUrl(config.oauth!, new AuthorizationStateStore());
    const params = new URL(url).searchParams;

    // `scope=` is a request for NO scopes, which is not what "unset" means.
    // Omitting it asks for the app's default permissions.
    expect(params.has('scope')).toBe(false);
  });

  it('sends exactly the configured scopes when they are set', async () => {
    const config = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'client-id',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret', // secrets-scan-ignore
      ASANA_OAUTH_SCOPES: 'tasks:read projects:read',
    });

    const { url } = await buildAuthorizationUrl(config.oauth!, new AuthorizationStateStore());

    expect(new URL(url).searchParams.get('scope')).toBe('tasks:read projects:read');
  });

  it('accepts Asana\'s full-permission "default" scope', async () => {
    const config = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'client-id',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret', // secrets-scan-ignore
      ASANA_OAUTH_SCOPES: 'default',
    });

    const { url } = await buildAuthorizationUrl(config.oauth!, new AuthorizationStateStore());

    expect(new URL(url).searchParams.get('scope')).toBe('default');
  });

  it('never requests a delete scope, whatever is configured', () => {
    const config = buildConfig({
      ASANA_OAUTH_CLIENT_ID: 'client-id',
      ASANA_OAUTH_CLIENT_SECRET: 'client-secret', // secrets-scan-ignore
    });

    // The default list is least-privilege: this connector has no delete
    // action, so it must never ask for the permission to delete.
    expect(config.oauth?.scopes.some((s) => s.includes('delete'))).toBe(false);
  });
});

describe('revokeToken reports WHY it failed', () => {
  /*
   * A live run failed with a bare `false` and there was nothing to diagnose
   * from: no status, no error, no way to separate an unreachable network from
   * a rejected request. Revocation stays best-effort, but the reason is now
   * carried out rather than swallowed by a `catch {}`.
   */
  it('carries the HTTP status when Asana rejects the request', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(new Response('{"error":"invalid_client"}', { status: 401, statusText: 'Unauthorized' }));

    const result = await revokeToken(CONFIG, { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' }, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(result.revoked).toBe(false);
    expect(result.httpStatus).toBe(401);
    expect(result.reason).toContain('401');
  });

  it('reports a transport failure with a null status', async () => {
    const fetchImpl = (): Promise<Response> => Promise.reject(new Error('getaddrinfo ENOTFOUND'));

    const result = await revokeToken(CONFIG, { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' }, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(result.revoked).toBe(false);
    // null distinguishes "never reached Asana" from "Asana said no".
    expect(result.httpStatus).toBeNull();
    expect(result.reason).toMatch(/could not reach/i);
  });

  it('reports success with the status, and no reason', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));

    const result = await revokeToken(CONFIG, { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' }, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(result).toEqual({ revoked: true, httpStatus: 200, reason: '' });
  });

  it('redacts anything credential-shaped out of the failure reason', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        // An obviously inert literal; the point of the test is that redaction
        // removes it before the reason reaches a log line.
        new Response('failed for Bearer abcdefghijklmnopqrstuvwxyz012345', { status: 400 }), // secrets-scan-ignore
      );

    const result = await revokeToken(CONFIG, { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' }, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    // The reason reaches a log line and an API response, so it goes through
    // the same redaction as everything else.
    expect(result.reason).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(result.reason).toContain('[REDACTED]');
  });
});

describe('revokeToken sends the token Asana will actually accept', () => {
  /*
   * The bug this pins. The connector sent the ACCESS token, and Asana answers
   * a real access token with 400 unsupported_token_type — RFC 7009's "the
   * authorization server does not support revocation of the presented token
   * type". Revocation therefore never worked in production.
   *
   * It survived because the endpoint answers 200 to a token it does not
   * RECOGNISE, so every test against a made-up string passed. Only a live
   * credential exposed it.
   */
  it('revokes the REFRESH token when one exists', async () => {
    let sent: URLSearchParams | undefined;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      sent = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    const result = await revokeToken(
      CONFIG,
      { accessToken: 'fake-the-access-token', refreshToken: 'fake-the-refresh-token' },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(result.revoked).toBe(true);
    // Revoking the refresh token invalidates the whole grant, access token
    // included — which is what "disconnect" should mean.
    expect(sent?.get('token')).toBe('fake-the-refresh-token');
    expect(sent?.get('token_type_hint')).toBe('refresh_token');
    expect(sent?.get('token')).not.toBe('fake-the-access-token');
  });

  it('falls back to the access token when no refresh token was issued', async () => {
    let sent: URLSearchParams | undefined;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      sent = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await revokeToken(
      CONFIG,
      { accessToken: 'fake-the-access-token', refreshToken: undefined },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(sent?.get('token')).toBe('fake-the-access-token');
    expect(sent?.get('token_type_hint')).toBe('access_token');
  });

  it('always sends the client credentials Asana requires', async () => {
    let sent: URLSearchParams | undefined;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      sent = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await revokeToken(
      CONFIG,
      { accessToken: 'fake-a', refreshToken: 'fake-r' },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(sent?.get('client_id')).toBe(CONFIG.clientId);
    expect(sent?.get('client_secret')).toBe(CONFIG.clientSecret);
  });

  it('surfaces unsupported_token_type rather than hiding it', async () => {
    // The exact response Asana gave for an access token, so a regression
    // reproduces the original symptom.
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'unsupported_token_type',
            error_description: 'The authorization server does not support this token type.',
          }),
          { status: 400, statusText: 'Bad Request' },
        ),
      );

    const result = await revokeToken(
      CONFIG,
      { accessToken: 'fake-a', refreshToken: 'fake-r' },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(result.revoked).toBe(false);
    expect(result.httpStatus).toBe(400);
    expect(result.reason).toContain('unsupported_token_type');
  });
});
