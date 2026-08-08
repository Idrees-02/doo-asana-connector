/**
 * Request identifiers.
 *
 * Asana does not return a request id on either success or failure, so the
 * connector mints its own. Every execution, log line, activity entry and error
 * carries the same id, which is what makes "this failed — what happened?"
 * answerable after the fact.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a sortable, collision-resistant request id.
 *
 * Format: `req_<base36 timestamp><random>`. The timestamp prefix means ids
 * sort chronologically as plain strings, which keeps the activity log ordered
 * without a secondary sort key.
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = randomString(12);
  return `req_${timestamp}${random}`;
}

/** Idempotency keys are caller-facing, so they get their own prefix. */
export function generateIdempotencyKey(): string {
  return `idem_${Date.now().toString(36)}${randomString(16)}`;
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}
