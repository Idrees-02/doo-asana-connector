/**
 * Execute the remaining OAuth lifecycle steps against REAL Asana.
 *
 *   npm run verify:oauth:lifecycle
 *
 * The assessment listed "OAuth consent, token exchange, refresh, revocation,
 * and encrypted persistence" as never executed. Consent and exchange are
 * covered by `npm run oauth:connect`. This closes the other three, in the only
 * order that works — revocation destroys the credential, so it goes last:
 *
 *   1. PERSISTENCE  decrypt a credential written by a previous process and
 *                   make a real API call with it (this IS a restart)
 *   2. REFRESH      rewrite the stored expiry into the past, then let the
 *                   provider exchange the real refresh token with Asana
 *   3. REVOCATION   hand the access token to Asana's revoke endpoint and
 *                   confirm it stops working
 *
 * Prints fingerprints, never tokens.
 */

import { getConfig } from '../src/config.js';
import { createConnector } from '../src/connector.js';
import { createCredentialStore } from '../src/auth/credential-store.js';
import { revokeToken } from '../src/auth/oauth.js';
import { fingerprintCredential } from '../src/runtime/redact.js';
import type { OAuthCredentials } from '../src/auth/types.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`);
}

async function main(): Promise<void> {
  const config = getConfig();

  if (config.credentialEncryptionKey === undefined) {
    console.error('\nCREDENTIAL_ENCRYPTION_KEY is not set — nothing was persisted to test.\n');
    process.exit(1);
  }
  if (config.oauth === undefined) {
    console.error('\nOAuth is not configured.\n');
    process.exit(1);
  }

  const store = createCredentialStore(config.credentialEncryptionKey);

  /* 1. Persistence -------------------------------------------------------- */

  console.log('\n1. Encrypted persistence — decrypting what a PREVIOUS process wrote\n');

  const stored = await store.get();
  if (stored === undefined || stored.type !== 'oauth') {
    console.error('  No OAuth credential on disk. Run `npm run oauth:connect` first.\n');
    process.exit(1);
  }

  const originalFp = await fingerprintCredential(stored.accessToken);
  check('decrypted an OAuth credential', true, originalFp);
  check('carries a refresh token', stored.refreshToken !== undefined, stored.refreshToken !== undefined ? 'present' : 'ABSENT');

  const connector = createConnector({ config, credentialStore: store });
  const before = await connector.testConnection();
  check(
    'the persisted token makes a REAL Asana call',
    before.connected,
    before.connected
      ? `${before.account?.name ?? '?'} · ${before.latencyMs}ms · ${before.requestId}`
      : (before.error?.message ?? 'failed'),
  );
  check('credential type in use', before.auth.type === 'oauth', before.auth.type);

  if (!before.connected || stored.refreshToken === undefined) {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  /* 2. Refresh ------------------------------------------------------------ */

  console.log('\n2. Refresh — forcing expiry, then exchanging the real refresh token\n');

  // Backdate the expiry so `needsRefresh` fires on the next getToken().
  const expired: OAuthCredentials = { ...stored, expiresAt: Date.now() - 60_000 };
  await store.set(expired);
  check('stored expiry moved into the past', true, new Date(expired.expiresAt as number).toISOString());

  // A fresh connector, so nothing is cached from before.
  const refreshing = createConnector({ config, credentialStore: store });
  const after = await refreshing.testConnection();

  check(
    'Asana accepted the refresh and the call succeeded',
    after.connected,
    after.connected ? `${after.latencyMs}ms · ${after.requestId}` : (after.error?.message ?? 'failed'),
  );

  const refreshed = await store.get();
  const newFp =
    refreshed !== undefined && refreshed.type === 'oauth'
      ? await fingerprintCredential(refreshed.accessToken)
      : 'n/a';

  check('a NEW access token was issued', newFp !== originalFp && newFp !== 'n/a', `${originalFp} -> ${newFp}`);
  check(
    'the refreshed credential was re-encrypted to disk',
    refreshed !== undefined && refreshed.type === 'oauth',
    'persisted',
  );

  /* 3. Revocation --------------------------------------------------------- */

  console.log('\n3. Revocation — handing the token to Asana and confirming it dies\n');

  const live = (await store.get()) as OAuthCredentials;
  const result = await revokeToken(config.oauth, live);
  check(
    'Asana accepted the revocation',
    result.revoked,
    result.revoked
      ? `HTTP ${result.httpStatus}`
      : `HTTP ${result.httpStatus ?? 'none'} — ${result.reason}`,
  );

  // The token should now be dead. Ask Asana directly rather than trusting the
  // revoke response.
  const dead = createConnector({ config, credentialStore: store });
  const afterRevoke = await dead.testConnection();
  check(
    'the revoked token no longer works',
    !afterRevoke.connected,
    afterRevoke.connected ? 'STILL WORKS — revocation did not take effect' : (afterRevoke.error?.code ?? 'rejected'),
  );

  await store.clear();
  check('local credential cleared', (await store.get()) === undefined, 'disconnected');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  console.log('The OAuth credential has been revoked and cleared. Reconnect with');
  console.log('`npm run oauth:connect` if you want an active OAuth session again.\n');

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error('\nFailed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
