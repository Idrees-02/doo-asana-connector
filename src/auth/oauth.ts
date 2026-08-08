/**
 * Asana OAuth 2.0 (authorization code flow with PKCE).
 *
 * Endpoints (verified against Asana's current documentation):
 *   authorize  GET  https://app.asana.com/-/oauth_authorize
 *   token      POST https://app.asana.com/-/oauth_token
 *   revoke     POST https://app.asana.com/-/oauth_revoke
 *
 * Two protections are applied that Asana does not require but which are
 * cheap and close real attack paths:
 *
 *   PKCE   — Asana supports the confidential-client flow with a secret, but
 *            PKCE additionally binds the authorization code to this specific
 *            request, so an intercepted code is useless on its own.
 *   state  — single-use, short-TTL, cryptographically random. Without it the
 *            callback is vulnerable to CSRF: an attacker can complete the flow
 *            with their own code and silently connect the victim's session to
 *            the attacker's Asana account.
 */

import { z } from 'zod';
import type { OAuthConfig } from '../config.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';
import { normalizeThrown } from '../errors/normalize.js';
import {
  oauthErrorResponseSchema,
  oauthTokenResponseSchema,
  type OAuthCredentials,
  type OAuthTokenResponse,
} from './types.js';

export const ASANA_AUTHORIZE_URL = 'https://app.asana.com/-/oauth_authorize';
export const ASANA_TOKEN_URL = 'https://app.asana.com/-/oauth_token';
export const ASANA_REVOKE_URL = 'https://app.asana.com/-/oauth_revoke';

/** How long an unconsumed authorization attempt stays valid. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Refresh this far ahead of expiry, so a request never races the deadline. */
const REFRESH_LEEWAY_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* PKCE                                                                        */
/* -------------------------------------------------------------------------- */

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- */
/* Pending authorization state                                                 */
/* -------------------------------------------------------------------------- */

interface PendingAuthorization {
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
  readonly redirectUri: string;
}

/**
 * Tracks in-flight authorization attempts.
 *
 * In-memory and process-local: an OAuth flow completes in seconds, so
 * persistence would add a place for a code verifier to be stolen from without
 * buying anything. A server restart mid-flow simply means starting again.
 */
export class AuthorizationStateStore {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly now: () => number = Date.now) {}

  create(redirectUri: string, codeVerifier: string): string {
    this.prune();
    const state = randomUrlSafe(32);
    this.pending.set(state, {
      state,
      codeVerifier,
      createdAt: this.now(),
      redirectUri,
    });
    return state;
  }

  /**
   * Validate and atomically consume a state value.
   *
   * Single-use: the entry is deleted on first read, so a replayed callback
   * fails even within the TTL.
   */
  consume(state: string): PendingAuthorization {
    this.prune();

    const entry = this.pending.get(state);
    if (entry === undefined) {
      throw new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
        message: 'The OAuth state value is unrecognised, already used, or expired.',
        guidance: 'Start the connection flow again from Settings.',
      });
    }

    this.pending.delete(state);
    return entry;
  }

  private prune(): void {
    const cutoff = this.now() - STATE_TTL_MS;
    for (const [key, value] of this.pending) {
      if (value.createdAt < cutoff) this.pending.delete(key);
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Flow                                                                        */
/* -------------------------------------------------------------------------- */

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
}

/**
 * Build the URL the user is sent to in order to grant access.
 *
 * Returns the state so the caller can bind it to the user's session; the code
 * verifier never leaves the server.
 */
export async function buildAuthorizationUrl(
  config: OAuthConfig,
  store: AuthorizationStateStore,
): Promise<AuthorizationRequest> {
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = store.create(config.redirectUri, codeVerifier);

  const url = new URL(ASANA_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('scope', config.scopes.join(' '));

  return { url: url.toString(), state };
}

export interface OAuthExchangeDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  state: string,
  store: AuthorizationStateStore,
  deps: OAuthExchangeDeps = {},
): Promise<OAuthCredentials> {
  // Consume state first: an invalid callback must never reach the token
  // endpoint, and consuming eagerly also prevents replay.
  const pending = store.consume(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: pending.redirectUri,
    code,
    code_verifier: pending.codeVerifier,
  });

  const response = await postToken(body, deps);
  return toCredentials(response, config.scopes, deps.now?.() ?? Date.now());
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  deps: OAuthExchangeDeps = {},
): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await postToken(body, deps);

  // Asana does not always return a new refresh token; when it does not, the
  // existing one remains valid. Dropping it here would silently break the
  // next refresh and force the user to reconnect.
  return toCredentials(
    { ...response, refresh_token: response.refresh_token ?? refreshToken },
    config.scopes,
    deps.now?.() ?? Date.now(),
  );
}

/** Best-effort revocation. Used on disconnect. */
export async function revokeToken(
  config: OAuthConfig,
  token: string,
  deps: OAuthExchangeDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await fetchImpl(ASANA_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        token,
      }).toString(),
    });
    return response.ok;
  } catch {
    // A failed revocation must not block disconnect: the local credential is
    // discarded either way, and leaving the user "connected" in the UI because
    // Asana was unreachable would be worse.
    return false;
  }
}

async function postToken(
  body: URLSearchParams,
  deps: OAuthExchangeDeps,
): Promise<OAuthTokenResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await fetchImpl(ASANA_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (thrown) {
    throw normalizeThrown(thrown, { idempotent: true, action: 'oauth.token' });
  }

  const text = await response.text();
  const parsedBody = parseJsonOrText(text);

  if (!response.ok) {
    const oauthError = oauthErrorResponseSchema.safeParse(parsedBody);
    const description = oauthError.success
      ? (oauthError.data.error_description ?? oauthError.data.error)
      : undefined;

    throw new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
      message:
        description !== undefined
          ? `Asana rejected the OAuth token request: ${description}`
          : 'Asana rejected the OAuth token request.',
      httpStatus: response.status,
      action: 'oauth.token',
      guidance:
        'Check that the client id, client secret and redirect URI in .env exactly match the app configured at app.asana.com/0/my-apps.',
    });
  }

  const parsed = oauthTokenResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new ConnectorError(ERROR_CODES.INVALID_RESPONSE, {
      message: 'The Asana token endpoint returned an unexpected response shape.',
      action: 'oauth.token',
    });
  }

  return parsed.data;
}

/** Parse a body that is usually JSON but may be an HTML error page. */
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toCredentials(
  response: OAuthTokenResponse,
  requestedScopes: readonly string[],
  now: number,
): OAuthCredentials {
  return {
    type: 'oauth',
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: response.expires_in === undefined ? undefined : now + response.expires_in * 1000,
    // Asana echoes granted scopes; fall back to what we asked for if it does not.
    scopes:
      response.scope !== undefined && response.scope.trim().length > 0
        ? response.scope.split(/[\s,]+/).filter((s) => s.length > 0)
        : [...requestedScopes],
  };
}

/** Whether an access token is expired, or close enough that it should be refreshed. */
export function needsRefresh(credentials: OAuthCredentials, now = Date.now()): boolean {
  if (credentials.expiresAt === undefined) return false;
  return credentials.expiresAt - REFRESH_LEEWAY_MS <= now;
}

/** Parse the OAuth callback query, distinguishing user denial from failure. */
export const oauthCallbackSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .refine((v) => v.code !== undefined || v.error !== undefined, {
    message: 'The OAuth callback contained neither a code nor an error.',
  });
