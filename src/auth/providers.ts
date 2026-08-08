/**
 * Credential providers.
 *
 * Each provider knows how to produce a bearer token for a single request and
 * how to describe itself without revealing anything secret. The client depends
 * only on the `CredentialProvider` interface, so PAT and OAuth are
 * interchangeable and neither leaks into the transport layer.
 */

import type { OAuthConfig } from '../config.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';
import { fingerprintCredential } from '../runtime/redact.js';
import type { CredentialStore } from './credential-store.js';
import { needsRefresh, refreshAccessToken, type OAuthExchangeDeps } from './oauth.js';
import type { CredentialProvider, OAuthCredentials, SafeCredentialInfo } from './types.js';

/* -------------------------------------------------------------------------- */
/* Personal Access Token                                                       */
/* -------------------------------------------------------------------------- */

export class PatCredentialProvider implements CredentialProvider {
  readonly type = 'pat' as const;

  constructor(private readonly token: string) {}

  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }

  async describe(): Promise<SafeCredentialInfo> {
    return {
      type: 'pat',
      fingerprint: await fingerprintCredential(this.token),
      // A PAT carries the full permissions of the user who created it; Asana
      // does not scope them. Saying so is more honest than listing the scopes
      // the connector *would* request under OAuth.
      scopes: [],
      expiresAt: null,
      canRefresh: false,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

export class OAuthCredentialProvider implements CredentialProvider {
  readonly type = 'oauth' as const;

  /**
   * De-duplicates concurrent refreshes.
   *
   * Without this, a burst of parallel requests arriving just after expiry
   * would each start their own refresh. Asana may invalidate the previous
   * refresh token on use, so the extra flights can race and log the user out.
   */
  private refreshInFlight: Promise<OAuthCredentials> | undefined;

  constructor(
    private readonly config: OAuthConfig,
    private readonly store: CredentialStore,
    private readonly deps: OAuthExchangeDeps = {},
  ) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async getToken(): Promise<string> {
    const credentials = await this.load();

    if (!needsRefresh(credentials, this.now)) {
      return credentials.accessToken;
    }

    if (credentials.refreshToken === undefined) {
      throw new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
        message: 'The Asana access token has expired and no refresh token is available.',
        guidance: 'Reconnect from Settings to obtain a new token.',
      });
    }

    const refreshed = await this.refresh(credentials.refreshToken);
    return refreshed.accessToken;
  }

  private async refresh(refreshToken: string): Promise<OAuthCredentials> {
    // Join an in-flight refresh rather than starting a competing one.
    this.refreshInFlight ??= refreshAccessToken(this.config, refreshToken, this.deps)
      .then(async (credentials) => {
        await this.store.set(credentials);
        return credentials;
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });

    return this.refreshInFlight;
  }

  private async load(): Promise<OAuthCredentials> {
    const credentials = await this.store.get();

    if (credentials === undefined || credentials.type !== 'oauth') {
      throw new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
        message: 'Not connected to Asana.',
        guidance: 'Connect from Settings, or set ASANA_ACCESS_TOKEN in .env.',
      });
    }

    return credentials;
  }

  async describe(): Promise<SafeCredentialInfo> {
    const credentials = await this.store.get();

    if (credentials === undefined || credentials.type !== 'oauth') {
      return { type: 'none', fingerprint: null, scopes: [], expiresAt: null, canRefresh: false };
    }

    return {
      type: 'oauth',
      fingerprint: await fingerprintCredential(credentials.accessToken),
      scopes: credentials.scopes,
      expiresAt:
        credentials.expiresAt === undefined ? null : new Date(credentials.expiresAt).toISOString(),
      canRefresh: credentials.refreshToken !== undefined,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* None (demo mode)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Used in demo mode, where no Asana call is ever made.
 *
 * It throws rather than returning a placeholder token, so that a coding error
 * which routes a demo request to the real client fails immediately and
 * obviously instead of sending a bogus Authorization header to Asana.
 */
export class NoCredentialProvider implements CredentialProvider {
  readonly type = 'none' as const;

  getToken(): Promise<string> {
    return Promise.reject(
      new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
        message: 'No Asana credentials are configured.',
        guidance:
          'Add ASANA_ACCESS_TOKEN to .env (see README for how to create one), or connect via OAuth in Settings.',
      }),
    );
  }

  describe(): Promise<SafeCredentialInfo> {
    return Promise.resolve({
      type: 'none',
      fingerprint: null,
      scopes: [],
      expiresAt: null,
      canRefresh: false,
    });
  }
}
