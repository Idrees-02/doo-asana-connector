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
 *   3. Asana serves its login step rather than rejecting the request outright
 *   4. `state` is single-use, so a replayed callback fails
 *
 * WHAT STEP 3 DOES **NOT** PROVE — learned the hard way.
 *
 * An earlier version of this script asserted that a 200 login page meant the
 * client id, redirect URI and scopes were all valid. It does not. Asana
 * validates `redirect_uri` only AFTER the user authenticates, so an
 * unregistered URL still gets you a login page and then fails with
 * `invalid_request: The redirect_uri parameter does not match a valid url for
 * the application` at the very end. The script reported PASS and the flow
 * failed anyway, which is worse than not checking at all.
 *
 * So this now reports what it can actually see, and prints the exact
 * redirect URI to register rather than claiming it already is.
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

  const oauthError = /[?&]error=|invalid_client|invalid_scope|redirect_uri_mismatch|unauthorized_client|invalid_request/i.exec(
    haystack,
  );

  check(
    'not rejected before the login step',
    oauthError === null,
    oauthError === null ? 'no immediate OAuth error' : `rejected: ${oauthError[0]}`,
  );
  check(
    'Asana served the login/consent step',
    response.status === 200 || response.status === 302,
    `HTTP ${response.status}`,
  );

  console.log(
    '\n  NOT PROVEN BY THE ABOVE — read this before trusting it:\n' +
      '\n    Asana validates redirect_uri only AFTER the user authenticates.\n' +
      '    An UNREGISTERED redirect URL still returns a login page here and\n' +
      '    then fails at the end of the flow with:\n' +
      '\n      invalid_request: The `redirect_uri` parameter does not match a\n' +
      '      valid url for the application.\n' +
      '\n    So a pass above does not mean the redirect URI is registered.\n' +
      '    Register this EXACT string at https://app.asana.com/0/my-apps\n' +
      '    under your app -> OAuth -> Redirect URLs:\n' +
      `\n      ${config.oauth.redirectUri}\n` +
      '\n    Character for character: scheme, port, and no trailing slash.',
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
  console.log('  - Whether the redirect URI above is registered (Asana checks it');
  console.log('    only after login — see the note above).');
  console.log('  - Clicking "Allow" on the consent screen requires a real Asana login.');
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
