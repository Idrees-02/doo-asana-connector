/**
 * Credential storage at rest.
 *
 * This is the module that decides whether an OAuth refresh token — a
 * long-lived key to someone's Asana workspace — sits on disk readable, sits
 * there encrypted, or never touches disk at all. It had no tests. The
 * assessment noted that encrypted persistence was never executed, and it was
 * right: nothing here had ever been run.
 *
 * So these assert the properties that make the encryption worth having,
 * rather than merely that a round trip works:
 *
 *   - the ciphertext does not contain the plaintext
 *   - the file is owner-only (0600)
 *   - a fresh IV per write, because IV reuse breaks GCM catastrophically
 *   - tampering is DETECTED rather than silently decrypting to garbage,
 *     which is the whole reason for choosing GCM over CBC
 *   - a wrong key, a corrupt file and a missing file all degrade to
 *     "not connected" rather than crashing the server
 *   - a weak or malformed key is refused loudly rather than padded into shape
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EncryptedFileCredentialStore,
  MemoryCredentialStore,
  createCredentialStore,
  parseEncryptionKey,
} from '../../src/auth/credential-store.js';
import type { AsanaCredentials, OAuthCredentials } from '../../src/auth/types.js';
import { inert } from '../helpers/inert.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cred-'));
  dirs.push(dir);
  return join(dir, 'nested', 'asana.enc');
}

const KEY_HEX = randomBytes(32).toString('hex');

/**
 * Distinctive values, so a test that claims the ciphertext hides them is
 * actually searching for something that would be findable if it did not.
 */
const OAUTH: OAuthCredentials = {
  type: 'oauth',
  accessToken: inert('ACCESS-b7f3d1e9c4a2-MUST-NOT-APPEAR-IN-CIPHERTEXT'),
  refreshToken: inert('REFRESH-2a9c8e5f1d63-MUST-NOT-APPEAR-IN-CIPHERTEXT'),
  expiresAt: 1_800_000_000_000,
  scopes: ['default', 'identity'],
};

/* -------------------------------------------------------------------------- */
/* Key handling                                                                */
/* -------------------------------------------------------------------------- */

describe('parseEncryptionKey', () => {
  it('accepts a 32-byte hex key', () => {
    expect(parseEncryptionKey(KEY_HEX)).toHaveLength(32);
  });

  it('tolerates surrounding whitespace, which .env files attract', () => {
    expect(parseEncryptionKey(`  ${KEY_HEX}\n`)).toHaveLength(32);
  });

  it('accepts either hex case', () => {
    expect(parseEncryptionKey(KEY_HEX.toUpperCase())).toEqual(parseEncryptionKey(KEY_HEX));
  });

  it.each([
    ['too short', randomBytes(16).toString('hex')],
    ['too long', randomBytes(48).toString('hex')],
    ['one character short', KEY_HEX.slice(0, -1)],
  ])('refuses a key that is %s', (_name, key) => {
    // Padding or hashing a wrong-length key into shape would give the
    // appearance of encryption with none of the strength.
    expect(() => parseEncryptionKey(key)).toThrow(/32 bytes|64 hex/i);
  });

  it.each([
    ['non-hex characters', 'z'.repeat(64)],
    ['a passphrase', 'correct-horse-battery-staple-correct-horse-battery-staple-abcdef'],
    ['empty', ''],
  ])('refuses %s', (_name, key) => {
    expect(() => parseEncryptionKey(key)).toThrow();
  });

  it('names the generator command in the error, so the fix is obvious', () => {
    expect(() => parseEncryptionKey('abc')).toThrow(/randomBytes/);
  });
});

/* -------------------------------------------------------------------------- */
/* Encrypted persistence — the property that matters                           */
/* -------------------------------------------------------------------------- */

describe('EncryptedFileCredentialStore', () => {
  it('round-trips credentials through a NEW store, which is what a restart is', async () => {
    const path = await tempPath();

    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    // A second instance over the same file, holding no cached state.
    const reopened = await new EncryptedFileCredentialStore(
      path,
      parseEncryptionKey(KEY_HEX),
    ).get();

    expect(reopened).toEqual(OAUTH);
  });

  it('does NOT write the token in the clear', async () => {
    const path = await tempPath();
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    const onDisk = await readFile(path, 'utf8');

    // The point of the whole module, asserted directly.
    expect(onDisk).not.toContain(OAUTH.accessToken);
    expect(onDisk).not.toContain(OAUTH.refreshToken as string);
    expect(onDisk).not.toContain('ACCESS-');
    expect(onDisk).not.toContain('REFRESH-');
    // Nor the scopes, which leak what the token can do.
    expect(onDisk).not.toContain('identity');
  });

  it('writes an authenticated-encryption envelope, not just ciphertext', async () => {
    const path = await tempPath();
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;

    expect(Object.keys(envelope).sort()).toEqual(['data', 'iv', 'tag', 'v']);
    // 12 bytes is the IV length GCM is specified for.
    expect(Buffer.from(envelope['iv'] as string, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope['tag'] as string, 'base64')).toHaveLength(16);
  });

  it('uses a FRESH IV per write — reuse under one key breaks GCM badly', async () => {
    const path = await tempPath();
    const store = new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX));

    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await store.set(OAUTH);
      const envelope = JSON.parse(await readFile(path, 'utf8')) as { iv: string };
      ivs.add(envelope.iv);
    }

    expect(ivs.size).toBe(20);
  });

  it('produces different ciphertext each time for identical input', async () => {
    const path = await tempPath();
    const store = new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX));

    await store.set(OAUTH);
    const first = (JSON.parse(await readFile(path, 'utf8')) as { data: string }).data;
    await store.set(OAUTH);
    const second = (JSON.parse(await readFile(path, 'utf8')) as { data: string }).data;

    // Deterministic ciphertext would leak that the credential is unchanged.
    expect(first).not.toBe(second);
  });

  it('writes owner-only (0600) and creates the directory it needs', async () => {
    const path = await tempPath(); // deliberately inside a directory that does not exist
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    // Other users on the machine must not be able to read it.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('stores a PAT as well as OAuth credentials', async () => {
    const path = await tempPath();
    const pat: AsanaCredentials = { type: 'pat', token: inert('PAT-VALUE-NOT-REAL') };

    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(pat);

    expect(await readFile(path, 'utf8')).not.toContain(inert('PAT-VALUE-NOT-REAL'));
    expect(
      await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).toEqual(pat);
  });

  it('preserves an OAuth credential with no refresh token', async () => {
    const path = await tempPath();
    const noRefresh: OAuthCredentials = { ...OAUTH, refreshToken: undefined, expiresAt: undefined };

    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(noRefresh);
    const read = await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get();

    // `canRefresh` is derived from this, so undefined must not become a string.
    expect((read as OAuthCredentials).refreshToken).toBeUndefined();
    expect((read as OAuthCredentials).expiresAt).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Failure modes — every one degrades to "not connected"                       */
/* -------------------------------------------------------------------------- */

describe('EncryptedFileCredentialStore — hostile and broken inputs', () => {
  it('DETECTS a tampered ciphertext instead of decrypting garbage', async () => {
    const path = await tempPath();
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    const data = Buffer.from(envelope['data'] as string, 'base64');
    data[0] = (data[0] ?? 0) ^ 0xff; // flip a bit
    envelope['data'] = data.toString('base64');
    await writeFile(path, JSON.stringify(envelope), 'utf8');

    // This is why GCM was chosen over CBC: the auth tag fails, and the store
    // reports "not connected" rather than handing back corrupted values.
    expect(
      await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).toBeUndefined();
  });

  it('detects a tampered auth tag', async () => {
    const path = await tempPath();
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    const tag = Buffer.from(envelope['tag'] as string, 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    envelope['tag'] = tag.toString('base64');
    await writeFile(path, JSON.stringify(envelope), 'utf8');

    expect(
      await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).toBeUndefined();
  });

  it('returns undefined for the WRONG key rather than throwing', async () => {
    const path = await tempPath();
    await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).set(OAUTH);

    const wrongKey = parseEncryptionKey(randomBytes(32).toString('hex'));

    // A rotated key must mean "reconnect", not "the server will not boot".
    expect(await new EncryptedFileCredentialStore(path, wrongKey).get()).toBeUndefined();
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['JSON of the wrong shape', '{"hello":"world"}'],
    ['an empty object', '{}'],
    ['an envelope with garbage base64', '{"v":1,"iv":"!!","tag":"!!","data":"!!"}'],
    ['an empty file', ''],
  ])('treats %s as not connected', async (_name, contents) => {
    const path = await tempPath();
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');

    await expect(
      new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).resolves.toBeUndefined();
  });

  it('treats a missing file as the normal first-run case', async () => {
    const path = await tempPath();
    expect(
      await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).toBeUndefined();
  });

  it('clears the file, and clearing twice is not an error', async () => {
    const path = await tempPath();
    const store = new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX));

    await store.set(OAUTH);
    await store.clear();

    expect(await store.get()).toBeUndefined();
    // Disconnect must be idempotent — the UI may fire it twice.
    await expect(store.clear()).resolves.toBeUndefined();
    expect(
      await new EncryptedFileCredentialStore(path, parseEncryptionKey(KEY_HEX)).get(),
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Memory store and selection                                                  */
/* -------------------------------------------------------------------------- */

describe('MemoryCredentialStore', () => {
  it('holds and clears a credential without touching disk', async () => {
    const store = new MemoryCredentialStore();

    expect(await store.get()).toBeUndefined();
    await store.set(OAUTH);
    expect(await store.get()).toEqual(OAUTH);
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });
});

describe('createCredentialStore', () => {
  it('defaults to memory, so the SAFE choice needs no configuration', () => {
    // Plaintext-on-disk is deliberately not an option this function offers.
    expect(createCredentialStore(undefined)).toBeInstanceOf(MemoryCredentialStore);
  });

  it('uses encrypted storage when a key is configured', async () => {
    expect(createCredentialStore(KEY_HEX, await tempPath())).toBeInstanceOf(
      EncryptedFileCredentialStore,
    );
  });

  it('refuses to start with a malformed key rather than silently using memory', () => {
    // Falling back to memory here would mean an operator who asked for
    // durable encrypted storage silently gets neither.
    expect(() => createCredentialStore('not-a-valid-key')).toThrow();
  });
});
