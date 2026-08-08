/**
 * Credential types.
 *
 * A credential is a value, never a global. It is passed explicitly to whatever
 * needs it and is never read from the environment outside `src/config.ts`,
 * never written to disk unencrypted, and never included in any serialized
 * output — the safe-description types below have no field that could carry one.
 */

import { z } from 'zod';

/** Personal Access Token: long-lived, single-user, no refresh. */
export interface PatCredentials {
  readonly type: 'pat';
  readonly token: string;
}

/** OAuth 2.0 credentials, refreshable. */
export interface OAuthCredentials {
  readonly type: 'oauth';
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** Epoch milliseconds at which `accessToken` expires. */
  readonly expiresAt: number | undefined;
  readonly scopes: readonly string[];
}

export type AsanaCredentials = PatCredentials | OAuthCredentials;

/**
 * Credential metadata that is safe to serialize.
 *
 * Note the absence of any token field. That is deliberate: making the unsafe
 * thing unrepresentable is more reliable than remembering to strip it.
 */
export interface SafeCredentialInfo {
  readonly type: 'pat' | 'oauth' | 'none';
  /** Non-reversible identifier, so an operator can tell which credential is loaded. */
  readonly fingerprint: string | null;
  readonly scopes: readonly string[];
  /** ISO timestamp of access-token expiry; null for a PAT, which does not expire. */
  readonly expiresAt: string | null;
  readonly canRefresh: boolean;
}

/**
 * Resolves a bearer token for each request.
 *
 * Async and per-request rather than a stored string, so an OAuth access token
 * can be refreshed transparently mid-session without the client knowing.
 */
export interface CredentialProvider {
  getToken(): Promise<string>;
  describe(): Promise<SafeCredentialInfo>;
  readonly type: 'pat' | 'oauth' | 'none';
}

/* -------------------------------------------------------------------------- */
/* OAuth wire schemas                                                          */
/* -------------------------------------------------------------------------- */

/** Asana's token endpoint response. */
export const oauthTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  data: z
    .object({
      gid: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});

export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

/** Asana's OAuth error response (RFC 6749 shape). */
export const oauthErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Connection test                                                             */
/* -------------------------------------------------------------------------- */

export const connectionTestResultSchema = z.object({
  connected: z.boolean(),
  provider: z.literal('asana'),
  mode: z.enum(['live', 'demo']),
  account: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable()
    .describe('The authenticated Asana user. Null when not connected.'),
  workspaces: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        isOrganization: z.boolean().nullable(),
      }),
    )
    .describe('Workspaces visible to this credential, used to populate selectors.'),
  auth: z
    .object({
      type: z.enum(['pat', 'oauth', 'none']),
      fingerprint: z.string().nullable(),
      scopes: z.array(z.string()),
      expiresAt: z.string().nullable(),
      canRefresh: z.boolean(),
    })
    .describe('Credential metadata. Contains no secret values by construction.'),
  checkedAt: z.string(),
  latencyMs: z.number().int(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      guidance: z.string(),
    })
    .nullable()
    .describe('Why the connection failed. Null when connected.'),
});

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
