/**
 * OAuth routes.
 *
 * The browser never sees a token. It is redirected to Asana, Asana redirects
 * back here, and the code-for-token exchange happens server-side using the
 * client secret. The access token is stored in the server-side credential
 * store; the browser learns only whether it worked.
 */

import type { Express, Request, Response } from 'express';
import type { Bootstrapped } from '../../src/index.js';
import {
  AuthorizationStateStore,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  oauthCallbackSchema,
  revokeToken,
} from '../../src/auth/oauth.js';
import { ConnectorError } from '../../src/errors/ConnectorError.js';
import { ERROR_CODES } from '../../src/errors/codes.js';

export function registerAuthRoutes(app: Express, runtime: Bootstrapped): void {
  const { config, logger } = runtime;
  const stateStore = new AuthorizationStateStore();

  /** Begin the flow: redirect the user to Asana's consent screen. */
  app.get('/api/auth/oauth/start', (_req: Request, res: Response) => {
    if (config.oauth === undefined) {
      res.status(400).json({
        ok: false,
        error: {
          code: ERROR_CODES.AUTHENTICATION_ERROR,
          message: 'OAuth is not configured.',
          guidance:
            'Set ASANA_OAUTH_CLIENT_ID and ASANA_OAUTH_CLIENT_SECRET in .env, or use a Personal Access Token instead.',
        },
      });
      return;
    }

    void buildAuthorizationUrl(config.oauth, stateStore)
      .then(({ url }) => {
        // A redirect rather than returning the URL: it keeps the state and
        // PKCE challenge out of any client-side code that might log them.
        res.redirect(url);
      })
      .catch((error: unknown) => {
        logger.error('Failed to build the authorization URL', { error });
        res.status(500).json({ ok: false, error: { code: 'OAUTH_START_FAILED' } });
      });
  });

  /** Asana redirects here with a code (or an error). */
  app.get('/api/auth/oauth/callback', (req: Request, res: Response) => {
    const parsed = oauthCallbackSchema.safeParse(req.query);

    if (!parsed.success) {
      res.status(400).send(renderResult(false, 'The OAuth callback was malformed.'));
      return;
    }

    const { code, state, error, error_description } = parsed.data;

    // The user declining is a normal outcome, not a failure to debug.
    if (error !== undefined) {
      const detail = error === 'access_denied' ? 'Access was declined.' : (error_description ?? error);
      res.status(200).send(renderResult(false, detail));
      return;
    }

    if (code === undefined || state === undefined || config.oauth === undefined) {
      res.status(400).send(renderResult(false, 'The OAuth callback was incomplete.'));
      return;
    }

    void exchangeCodeForTokens(config.oauth, code, state, stateStore)
      .then(async (credentials) => {
        await runtime.connector.credentialStore.set(credentials);
        logger.info('Asana OAuth connection established');
        res.status(200).send(renderResult(true, 'Connected to Asana. You can close this window.'));
      })
      .catch((thrown: unknown) => {
        const err = ConnectorError.isConnectorError(thrown)
          ? thrown
          : new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, { cause: thrown });

        logger.warn('OAuth token exchange failed', { code: err.code });
        // The message is already redacted by ConnectorError.
        res.status(400).send(renderResult(false, err.message));
      });
  });

  /** Disconnect: revoke upstream where possible, and always clear locally. */
  app.post('/api/auth/disconnect', (_req: Request, res: Response) => {
    void (async () => {
      const credentials = await runtime.connector.credentialStore.get();
      let revoked = false;

      if (credentials?.type === 'oauth' && config.oauth !== undefined) {
        revoked = await revokeToken(config.oauth, credentials.accessToken);
      }

      // Cleared regardless of whether revocation succeeded: leaving the user
      // "connected" locally because Asana was unreachable would be worse.
      await runtime.connector.credentialStore.clear();

      res.json({
        disconnected: true,
        revokedUpstream: revoked,
        note: revoked
          ? 'Token revoked with Asana and cleared locally.'
          : 'Cleared locally. The token was not revoked upstream — revoke it manually at app.asana.com/0/my-apps if needed.',
      });
    })().catch((error: unknown) => {
      logger.error('Disconnect failed', { error });
      res.status(500).json({ disconnected: false });
    });
  });
}

/**
 * Minimal self-contained result page.
 *
 * Deliberately plain HTML with no script and no external resources: this page
 * renders immediately after an OAuth redirect, and it must not be capable of
 * exfiltrating anything from the URL it was loaded with.
 */
function renderResult(success: boolean, message: string): string {
  const escaped = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const accent = success ? '#34D399' : '#F87171';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Asana Connector</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{background:#0A0A0B;color:#F2F2F3;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#121214;border:1px solid #26262B;border-radius:6px;padding:32px;max-width:420px}
  .dot{width:8px;height:8px;border-radius:50%;background:${accent};display:inline-block;margin-right:8px}
  h1{font-size:16px;margin:0 0 12px;font-weight:600}
  p{color:#8A8A93;margin:0}
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>${success ? 'Connected' : 'Connection failed'}</h1>
  <p>${escaped}</p>
</div></body></html>`;
}
