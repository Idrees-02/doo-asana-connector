/**
 * Walk through the one OAuth step a machine cannot do: clicking "Allow".
 *
 *   npm run oauth:connect
 *
 * Starts the API, prints the URL to open, waits for Asana to redirect back,
 * then proves the resulting credential actually works by calling
 * `testConnection` with it.
 *
 * ============================================================================
 * WHY THIS EXISTS RATHER THAN "just open the start URL"
 * ============================================================================
 *
 * A Personal Access Token takes precedence over OAuth in
 * `AsanaConnector.buildCredentialProvider` — an explicitly-set
 * ASANA_ACCESS_TOKEN is an unambiguous instruction, whereas OAuth config may
 * be leftover with no live session. That is the right default, and it means
 * that if you connect via OAuth while a PAT is configured, the connector
 * carries on using the PAT and the flow proves nothing.
 *
 * So this script checks for that first and tells you, rather than letting you
 * complete a consent flow whose result is then ignored.
 */

import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { getConfig } from '../src/config.js';
import { bootstrap } from '../src/index.js';
import { createApp } from '../server/app.js';

const CALLBACK_PATH = '/api/auth/oauth/callback';

async function main(): Promise<void> {
  const config = getConfig();

  /* Preconditions --------------------------------------------------------- */

  if (config.oauth === undefined) {
    console.error(
      '\nOAuth is not configured.\n\n' +
        '  1. Open https://app.asana.com/0/my-apps and create an app\n' +
        '  2. Add this exact redirect URL:\n' +
        `       ${config.asana.baseUrl.replace(/\/api\/1\.0$/, '')}\n` +
        `       http://localhost:${config.server.port}${CALLBACK_PATH}\n` +
        '  3. Put the client id and secret in .env:\n' +
        '       ASANA_OAUTH_CLIENT_ID=...\n' +
        '       ASANA_OAUTH_CLIENT_SECRET=...\n',
    );
    process.exit(1);
  }

  if (config.accessToken !== undefined) {
    console.error(
      '\nASANA_ACCESS_TOKEN is set, and a PAT takes precedence over OAuth.\n\n' +
        'Connecting now would succeed and then be ignored — the connector would\n' +
        'keep using the PAT. To actually exercise the OAuth path:\n\n' +
        '  1. Comment out ASANA_ACCESS_TOKEN in .env\n' +
        '  2. Run this again\n\n' +
        'Put it back afterwards if you prefer the PAT for day-to-day use.\n',
    );
    process.exit(1);
  }

  if (config.credentialEncryptionKey === undefined) {
    console.warn(
      '\nNote: CREDENTIAL_ENCRYPTION_KEY is not set, so the token will live in\n' +
        'memory only and is lost when this process exits. That is fine for\n' +
        'verifying the flow. For a token that survives a restart, generate one:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n',
    );
  }

  /* Serve ----------------------------------------------------------------- */

  const runtime = bootstrap({ silent: true });
  const { app } = createApp(runtime);

  const startUrl = `http://localhost:${config.server.port}/api/auth/oauth/start`;

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(config.server.port, '127.0.0.1', () => resolve());
  });

  /**
   * Stop listening AND drop live connections.
   *
   * `server.close()` alone only stops accepting new connections; it leaves
   * established ones open. The browser that just completed the redirect holds
   * a keep-alive socket, so the process would sit there with nothing
   * listening and never exit — which looks exactly like a hang, right after
   * the step the user was waiting on.
   */
  const shutdown = (): void => {
    server.close();
    server.closeAllConnections();
  };

  console.log(
    [
      '',
      '  Asana OAuth — the one step that needs a human',
      '',
      '  1. Open this URL in your browser:',
      '',
      `       ${startUrl}`,
      '',
      '  2. Log in to Asana and click Allow.',
      '',
      `  Requesting: ${config.oauth.scopes.join(', ')}`,
      `  Redirecting to: http://localhost:${config.server.port}${CALLBACK_PATH}`,
      '',
      '  Waiting for the callback… (Ctrl+C to cancel)',
      '',
    ].join('\n'),
  );

  /* Poll the credential store until the callback has stored something ------ */

  const deadline = Date.now() + 5 * 60_000;

  for (;;) {
    if (Date.now() > deadline) {
      console.error('\n  Timed out after 5 minutes. Nothing was stored.\n');
      shutdown();
      process.exit(1);
    }

    const credentials = await runtime.connector.credentialStore.get();

    if (credentials?.type === 'oauth') {
      console.log('  Callback received. Verifying the token actually works…\n');

      // The proof. A stored token that cannot call Asana is not a connection.
      const connection = await runtime.connector.testConnection();

      if (!connection.connected) {
        console.error(`  FAILED  ${connection.error?.message ?? 'testConnection failed'}\n`);
        shutdown();
        process.exit(1);
      }

      console.log('  OAuth connection verified end to end:\n');
      console.log(`    account       ${connection.account?.name ?? 'unknown'}`);
      console.log(`    workspaces    ${connection.workspaces.length}`);
      console.log(`    credential    ${connection.auth.type}`);
      // A non-reversible identifier, never the token.
      console.log(`    fingerprint   ${connection.auth.fingerprint ?? 'n/a'}`);
      console.log(`    scopes        ${connection.auth.scopes.join(', ') || '(none echoed)'}`);
      console.log(`    refreshable   ${connection.auth.canRefresh}`);
      console.log(`    expires       ${connection.auth.expiresAt ?? 'no expiry reported'}`);
      console.log(`    latency       ${connection.latencyMs}ms`);
      console.log(`    requestId     ${connection.requestId}`);
      console.log(
        '\n  That is the OAuth consent step closed: authorization, consent,\n' +
          '  code exchange and an authenticated API call, all with a real login.\n',
      );

      shutdown();
      return;
    }

    await delay(1000);
  }
}

main().catch((error: unknown) => {
  console.error('\nFailed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
