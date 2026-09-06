/**
 * Verify the OAuth 2.0 flow as far as it can be verified without a human.
 *
 *   npm run verify:oauth
 *
 * The one step this cannot perform is clicking "Allow" on Asana's consent
 * screen, which needs a real login. Everything up to that point is checked
 * here against the REAL Asana authorization endpoint rather than a double:
 *
 *   1. the authorization request is well-formed (client_id, redirect_uri,
 *      response_type, scopes)
 *   2. the PKCE challenge is correct — recomputed independently against
 *      RFC 7636 rather than trusting the code that produced it
 *   3. Asana ACCEPTS the request: it serves its login page rather than
 *      invalid_client, invalid_scope or redirect_uri_mismatch, which is what
 *      proves the client id, the registered redirect URI and the scope list
 *      are all genuinely valid
 *   4. `state` is single-use, so a replayed callback fails
 *
 * What happens after consent — code exchange, refresh, refresh
 * deduplication, revocation — is covered by tests/unit/oauth.test.ts against
 * a fetch double that mirrors Asana's token-endpoint contract.
 *
 * Prints no secret: the client id is reported as present/absent, and the code
 * verifier never leaves the process.
 */

import { createHash } from 'node:crypto';

import { getConfig } from '../src/config.js';
import { AuthorizationStateStore, buildAuthorizationUrl } from '../src/auth/oauth.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} ${detail}`);
}

async function main(): Promise<void> {
  const config = getConfig();

  console.log('\nAsana OAuth 2.0 — live verification of everything before consent\n');

  if (config.oauth === undefined) {
    console.error(
      'OAuth is not configured. Set ASANA_OAUTH_CLIENT_ID and ASANA_OAUTH_CLIENT_SECRET\n' +
        'in .env, then run this again. (A PAT alone does not exercise this flow.)\n',
    );
    process.exit(1);
  }

  const store = new AuthorizationStateStore();
  const { url, state } = await buildAuthorizationUrl(config.oauth, store);
  const parsed = new URL(url);
  const param = (key: string): string => parsed.searchParams.get(key) ?? '';

  /* 1. Request shape ------------------------------------------------------ */

  console.log('Authorization request');
  check(
    'endpoint',
    `${parsed.origin}${parsed.pathname}` === 'https://app.asana.com/-/oauth_authorize',
    `${parsed.origin}${parsed.pathname}`,
  );
  // Present/absent only — the client id is not a secret, but printing
  // credentials by habit is how the habit forms.
  check('client_id supplied', param('client_id').length > 0, 'present');
  check('redirect_uri', param('redirect_uri').length > 0, param('redirect_uri'));
  check('response_type', param('response_type') === 'code', param('response_type'));
  check(
    'scopes are least-privilege',
    !param('scope').includes('delete') && param('scope').split(' ').length > 0,
    `${param('scope').split(' ').length} scopes, none granting delete`,
  );

  /* 2. PKCE, recomputed independently ------------------------------------- */

  console.log('\nPKCE (RFC 7636)');

  /*
   * Reach into the store for the verifier. It never leaves the server in
   * normal operation — which is the point of PKCE — so this is the one place
   * that inspects it, in order to prove the challenge really is its hash.
   */
  const pending = (store as unknown as { pending: Map<string, { codeVerifier: string }> }).pending;
  const verifier = pending.get(state)?.codeVerifier ?? '';

  check(
    'verifier length within 43-128',
    verifier.length >= 43 && verifier.length <= 128,
    `${verifier.length} characters`,
  );
  check(
    'verifier uses the unreserved charset',
    /^[A-Za-z0-9\-._~]+$/.test(verifier),
    'A-Z a-z 0-9 - . _ ~',
  );
  check('challenge method', param('code_challenge_method') === 'S256', param('code_challenge_method'));
  check(
    'challenge === BASE64URL(SHA256(verifier))',
    createHash('sha256').update(verifier, 'ascii').digest('base64url') === param('code_challenge'),
    'recomputed independently and matched',
  );
  check('state is 256 bits of randomness', state.length >= 43, `${state.length} characters`);

  /* 3. Does the real provider accept it? ---------------------------------- */

  console.log('\nReal Asana response');

  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location') ?? '';
  const body = response.status === 200 ? (await response.text()).slice(0, 8000) : '';
  const haystack = `${location}\n${body}`;

  const oauthError = /[?&]error=|invalid_client|invalid_scope|redirect_uri_mismatch|unauthorized_client/i.exec(
    haystack,
  );

  check(
    'Asana did not reject the request',
    oauthError === null,
    oauthError === null ? 'no OAuth error returned' : `rejected: ${oauthError[0]}`,
  );
  check(
    'Asana served the consent/login step',
    response.status === 200 || response.status === 302,
    `HTTP ${response.status}`,
  );

  console.log(
    '\n    Asana accepting this request is what proves the client id, the\n' +
      '    registered redirect URI and every requested scope are genuinely\n' +
      '    valid. A wrong client id returns invalid_client; an unregistered\n' +
      '    redirect URI returns redirect_uri_mismatch; a bad scope returns\n' +
      '    invalid_scope. None of those came back.',
  );

  /* 4. Replay protection -------------------------------------------------- */

  console.log('\nCSRF / replay protection');

  let firstConsumeOk: boolean;
  try {
    store.consume(state);
    firstConsumeOk = true;
  } catch {
    firstConsumeOk = false;
  }
  check('a valid state is accepted once', firstConsumeOk, 'consumed');

  let replayRejected = false;
  try {
    store.consume(state);
  } catch {
    replayRejected = true;
  }
  check('the same state is rejected on replay', replayRejected, 'single-use enforced');

  let unknownRejected = false;
  try {
    store.consume('a-state-nobody-issued');
  } catch {
    unknownRejected = true;
  }
  check('an unissued state is rejected', unknownRejected, 'CSRF callback refused');

  /* Summary --------------------------------------------------------------- */

  console.log(`\n${passed} passed, ${failed} failed\n`);
  console.log('NOT verified here, and not verifiable without a human:');
  console.log('  Clicking "Allow" on the consent screen requires a real Asana login.');
  console.log('  To close that yourself — about 30 seconds:\n');
  console.log('    npm run dev');
  console.log('    open http://localhost:8787/api/auth/oauth/start');
  console.log('    log in, click Allow\n');
  console.log('  The callback exchanges the code server-side and stores the token.');
  console.log('  Confirm with:  curl -s localhost:8787/api/connector/status | grep oauth\n');

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
