/**
 * Redaction.
 *
 * Everything that could reach a log line, an API response, the activity feed,
 * or a screenshot passes through here first. The rule the brief sets is
 * absolute — no token, header, or secret ever leaves the process — so this
 * module errs heavily toward over-redacting. A redacted field that turns out
 * to be harmless costs a moment of debugging; a leaked token costs an account.
 *
 * Two independent layers, because either alone is insufficient:
 *   1. Key-based  — any property whose *name* looks sensitive is masked,
 *                   regardless of its value.
 *   2. Pattern-based — any *value* that looks like a credential is masked,
 *                   regardless of where it appeared.
 */

/** Property names whose values are always masked. Matched case-insensitively. */
const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|auth|cookie|set-cookie|x-api-key|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|pwd|credential|credentials|private[_-]?key|session|bearer|code[_-]?verifier|pat)$/i;

/** Value shapes that are masked wherever they appear. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // Asana Personal Access Token: 1/<numeric user gid>:<hex secret>
  new RegExp(String.raw`\b1\/\d{10,}:[0-9a-zA-Z]{16,}\b`, 'g'),
  // Authorization header values
  new RegExp(String.raw`\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-\/+=]{16,}`, 'gi'),
  // JWTs
  new RegExp(String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`, 'g'),
  // OAuth authorization codes / tokens in query strings
  new RegExp(
    String.raw`\b(access_token|refresh_token|client_secret|code|code_verifier)=([^&\s"']{6,})`,
    'gi',
  ),
];

export const REDACTED = '[REDACTED]';

/** Mask credential-shaped substrings inside a free-text string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match, ...groups: unknown[]) => {
      // For `key=value` patterns keep the key so the log stays readable.
      const first = groups[0];
      if (typeof first === 'string' && match.includes('=')) {
        return `${first}=${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/** True if a property name indicates its value must never be shown. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim());
}

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4_000;

/**
 * Deep-redact an arbitrary value so it is safe to log or return.
 *
 * Also bounds size: unbounded structures in the activity log are a memory and
 * readability problem, and truncation is stated explicitly rather than silently.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth > MAX_DEPTH) return '[TRUNCATED: max depth]';

  if (typeof value === 'string') {
    const redacted = redactString(value);
    return redacted.length > MAX_STRING_LENGTH
      ? `${redacted.slice(0, MAX_STRING_LENGTH)}… [TRUNCATED: ${redacted.length} chars]`
      : redacted;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[TRUNCATED: ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, depth + 1);
    }
    return out;
  }

  // Functions, symbols — never useful in a log, and can close over secrets.
  return `[${typeof value}]`;
}

/** Redact HTTP headers. Header names are case-insensitive, hence the lowercasing. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key.toLowerCase()) ? REDACTED : redactString(value);
  }
  return out;
}

/** Strip credential-bearing query parameters from a URL before logging it. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    // Not a well-formed absolute URL — fall back to pattern redaction.
    return redactString(url);
  }
}

/**
 * A stable, non-reversible identifier for a credential.
 *
 * Lets an operator answer "which token is loaded?" and "did the token change?"
 * without any part of the secret being recoverable. Deliberately *not* a
 * masked prefix of the token itself — even four real characters is four
 * characters more than necessary.
 */
export async function fingerprintCredential(secret: string): Promise<string> {
  const data = new TextEncoder().encode(`asana-connector:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  return `fp_${hex}`;
}
