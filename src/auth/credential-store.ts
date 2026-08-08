/**
 * Credential storage.
 *
 * OAuth tokens obtained at runtime have to live somewhere between requests.
 * The options and their honest trade-offs:
 *
 *   memory only (default)  — nothing touches disk; tokens die with the
 *                            process. The user reconnects after a restart.
 *   encrypted at rest      — AES-256-GCM under CREDENTIAL_ENCRYPTION_KEY,
 *                            opt-in. Survives restarts.
 *
 * Plaintext-on-disk is deliberately not an option. Defaulting to memory means
 * the safe choice requires no configuration, and the durable choice requires a
 * deliberate act (generating a key).
 *
 * GCM rather than CBC because it is authenticated: tampering with the
 * ciphertext is detected rather than silently decrypting to garbage.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AsanaCredentials } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the value GCM is specified for
const KEY_LENGTH = 32; // 256 bits

const storedCredentialsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pat'), token: z.string() }),
  z.object({
    type: z.literal('oauth'),
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scopes: z.array(z.string()),
  }),
]);

export interface CredentialStore {
  get(): Promise<AsanaCredentials | undefined>;
  set(credentials: AsanaCredentials): Promise<void>;
  clear(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* In-memory                                                                   */
/* -------------------------------------------------------------------------- */

export class MemoryCredentialStore implements CredentialStore {
  private credentials: AsanaCredentials | undefined;

  get(): Promise<AsanaCredentials | undefined> {
    return Promise.resolve(this.credentials);
  }

  set(credentials: AsanaCredentials): Promise<void> {
    this.credentials = credentials;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.credentials = undefined;
    return Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* Encrypted file                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse the hex key from configuration.
 *
 * Rejects a wrong-length key loudly rather than padding or hashing it into
 * shape: silently accepting a 4-character key would give the appearance of
 * encryption with none of the strength.
 */
export function parseEncryptionKey(hex: string): Buffer {
  const normalized = hex.trim();

  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be hexadecimal.');
  }
  if (normalized.length !== KEY_LENGTH * 2) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex characters). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  return Buffer.from(normalized, 'hex');
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private cache: AsanaCredentials | undefined;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {}

  async get(): Promise<AsanaCredentials | undefined> {
    if (this.loaded) return this.cache;

    try {
      const payload = await readFile(this.filePath, 'utf8');
      this.cache = this.decrypt(payload);
    } catch {
      // Missing file is the normal first-run case. A corrupt or
      // wrong-key file is treated the same way — as "not connected" —
      // because the only safe recovery is to re-authenticate.
      this.cache = undefined;
    }

    this.loaded = true;
    return this.cache;
  }

  async set(credentials: AsanaCredentials): Promise<void> {
    this.cache = credentials;
    this.loaded = true;

    await mkdir(dirname(this.filePath), { recursive: true });
    // 0600: owner read/write only. Other users on the machine cannot read it.
    await writeFile(this.filePath, this.encrypt(credentials), { encoding: 'utf8', mode: 0o600 });
  }

  async clear(): Promise<void> {
    this.cache = undefined;
    this.loaded = true;
    try {
      await unlink(this.filePath);
    } catch {
      // Already absent — nothing to do.
    }
  }

  private encrypt(credentials: AsanaCredentials): string {
    // A fresh IV per write: reusing an IV under the same key breaks GCM badly.
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const plaintext = JSON.stringify(credentials);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: ciphertext.toString('base64'),
    });
  }

  private decrypt(payload: string): AsanaCredentials | undefined {
    const envelope = z
      .object({
        v: z.number(),
        iv: z.string(),
        tag: z.string(),
        data: z.string(),
      })
      .safeParse(JSON.parse(payload));

    if (!envelope.success) return undefined;

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.data.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.data.tag, 'base64'));

    // Throws if the ciphertext was tampered with — caught by the caller and
    // treated as "not connected".
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    const parsed = storedCredentialsSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) return undefined;

    return parsed.data.type === 'pat'
      ? { type: 'pat', token: parsed.data.token }
      : {
          type: 'oauth',
          accessToken: parsed.data.accessToken,
          refreshToken: parsed.data.refreshToken,
          expiresAt: parsed.data.expiresAt,
          scopes: parsed.data.scopes,
        };
  }
}

/** Pick a store based on whether an encryption key was configured. */
export function createCredentialStore(
  encryptionKeyHex: string | undefined,
  filePath = '.credentials/asana.enc',
): CredentialStore {
  if (encryptionKeyHex === undefined) return new MemoryCredentialStore();
  return new EncryptedFileCredentialStore(filePath, parseEncryptionKey(encryptionKeyHex));
}
