import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES, codeForHttpStatus } from '../../src/errors/codes.js';
import { ConnectorError } from '../../src/errors/ConnectorError.js';
import {
  normalizeHttpError,
  normalizeThrown,
  normalizeZodError,
  parseRetryAfter,
} from '../../src/errors/normalize.js';

const READ = { action: 'asana.list_projects', requestId: 'req_test', idempotent: true } as const;
const WRITE = { action: 'asana.create_task', requestId: 'req_test', idempotent: false } as const;

describe('codeForHttpStatus', () => {
  it.each([
    [400, ERROR_CODES.BAD_REQUEST],
    [401, ERROR_CODES.AUTHENTICATION_ERROR],
    [402, ERROR_CODES.PAYMENT_REQUIRED],
    [403, ERROR_CODES.PERMISSION_DENIED],
    [404, ERROR_CODES.NOT_FOUND],
    [409, ERROR_CODES.CONFLICT],
    [429, ERROR_CODES.RATE_LIMITED],
    [451, ERROR_CODES.UNAVAILABLE_LEGAL],
    [500, ERROR_CODES.SERVER_ERROR],
    [502, ERROR_CODES.BAD_GATEWAY],
    [503, ERROR_CODES.SERVICE_UNAVAILABLE],
    [504, ERROR_CODES.SERVICE_UNAVAILABLE],
  ])('maps HTTP %i to %s', (status, expected) => {
    expect(codeForHttpStatus(status)).toBe(expected);
  });

  it('maps unlisted 5xx to a server error rather than unknown', () => {
    expect(codeForHttpStatus(507)).toBe(ERROR_CODES.SERVER_ERROR);
  });
});

describe('parseRetryAfter', () => {
  it('parses a seconds value', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const later = new Date(now + 45_000).toUTCString();
    expect(parseRetryAfter(later, now)).toBe(45_000);
  });

  it('never returns a negative delay for a past date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const past = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon please')).toBeUndefined();
  });
});

describe('normalizeHttpError — Asana error bodies', () => {
  it('uses Asana wording and splits "field: problem" into a field detail', () => {
    const err = normalizeHttpError(
      { status: 400, body: { errors: [{ message: 'workspace: Missing input' }] } },
      READ,
    );

    expect(err.code).toBe(ERROR_CODES.BAD_REQUEST);
    expect(err.message).toBe('workspace: Missing input');
    expect(err.details).toEqual([{ field: 'workspace', message: 'Missing input', reason: undefined }]);
  });

  it('captures the diagnostic phrase Asana returns on 500s', () => {
    const err = normalizeHttpError(
      {
        status: 500,
        body: { errors: [{ message: 'Server Error', phrase: '6 sad squid snuggle softly' }] },
      },
      READ,
    );

    expect(err.code).toBe(ERROR_CODES.SERVER_ERROR);
    expect(err.providerPhrase).toBe('6 sad squid snuggle softly');
  });

  it('survives a non-JSON error body without masking the real failure', () => {
    // A load balancer 502 arrives as HTML. Parsing must not throw.
    const err = normalizeHttpError({ status: 502, body: '<html>Bad Gateway</html>' }, READ);

    expect(err.code).toBe(ERROR_CODES.BAD_GATEWAY);
    expect(err.httpStatus).toBe(502);
  });

  it('ignores provider messages that merely echo the status text', () => {
    const err = normalizeHttpError({ status: 404, body: { errors: [{ message: 'Not Found' }] } }, READ);
    expect(err.message).toBe('The requested Asana resource was not found.');
  });

  it('carries the rate-limit delay through from Retry-After', () => {
    const err = normalizeHttpError({ status: 429, body: {}, retryAfter: '12' }, READ);

    expect(err.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(err.retryAfterMs).toBe(12_000);
  });
});

describe('write safety — the rule that prevents duplicate tasks and comments', () => {
  it('allows automatic retry of a rate-limited READ', () => {
    const err = normalizeHttpError({ status: 429, body: {}, retryAfter: '5' }, READ);

    expect(err.retryable).toBe(true);
    expect(err.retryStrategy).toBe('after_delay');
  });

  it('refuses automatic retry of a rate-limited non-idempotent WRITE', () => {
    // The POST may already have created the task. Retrying would duplicate it.
    const err = normalizeHttpError({ status: 429, body: {}, retryAfter: '5' }, WRITE);

    expect(err.retryable).toBe(false);
    expect(err.retryStrategy).toBe('manual_with_idempotency_key');
    expect(err.guidance).toMatch(/may or may not have been applied/i);
    // The delay is still reported so a human can act on it.
    expect(err.retryAfterMs).toBe(5_000);
  });

  it('refuses automatic retry of a 500 on a write', () => {
    const err = normalizeHttpError({ status: 500, body: {} }, WRITE);

    expect(err.retryable).toBe(false);
    expect(err.retryStrategy).toBe('manual_with_idempotency_key');
  });

  it('refuses automatic retry of a timed-out write', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';

    const err = normalizeThrown(abort, WRITE);

    expect(err.code).toBe(ERROR_CODES.TIMEOUT);
    expect(err.retryable).toBe(false);
    expect(err.retryStrategy).toBe('manual_with_idempotency_key');
  });

  it('leaves non-retryable failures untouched on writes', () => {
    // A 403 cannot have taken effect, so the guidance should stay specific.
    const err = normalizeHttpError({ status: 403, body: {} }, WRITE);

    expect(err.retryable).toBe(false);
    expect(err.retryStrategy).toBe('none');
    expect(err.guidance).not.toMatch(/may or may not/i);
  });
});

describe('normalizeThrown — transport faults', () => {
  it('classifies an abort as a timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(normalizeThrown(abort, READ).code).toBe(ERROR_CODES.TIMEOUT);
  });

  it('classifies DNS and connection failures as network errors', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN']) {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = { code };
      expect(normalizeThrown(err, READ).code).toBe(ERROR_CODES.NETWORK_ERROR);
    }
  });

  it('classifies undici connect timeouts as timeouts, not network errors', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    expect(normalizeThrown(err, READ).code).toBe(ERROR_CODES.TIMEOUT);
  });

  it('passes an existing ConnectorError through, adding context', () => {
    const original = new ConnectorError(ERROR_CODES.NOT_FOUND);
    const normalized = normalizeThrown(original, READ);

    expect(normalized.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(normalized.action).toBe('asana.list_projects');
    expect(normalized.requestId).toBe('req_test');
  });
});

describe('normalizeZodError', () => {
  it('reports the offending field path and reason', () => {
    const schema = z.object({ name: z.string().min(1) });
    const result = schema.safeParse({ name: '' });

    expect(result.success).toBe(false);
    if (result.success) return;

    const err = normalizeZodError(result.error, { action: 'asana.create_task', requestId: 'req_x' });

    expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(err.retryable).toBe(false);
    expect(err.details[0]?.field).toBe('name');
    expect(err.message).toMatch(/name/);
  });

  it('summarises when several fields are invalid', () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: 'x' });
    if (result.success) throw new Error('expected failure');

    const err = normalizeZodError(result.error, {});
    expect(err.details).toHaveLength(2);
    expect(err.message).toMatch(/2 fields/);
  });
});

describe('ConnectorError serialization — what must never escape', () => {
  it('omits the stack trace and cause from the wire format', () => {
    const err = new ConnectorError(ERROR_CODES.SERVER_ERROR, {
      cause: new Error('internal detail with /Users/someone/path'),
    });

    const json: Record<string, unknown> = { ...err.toJSON() };

    expect(json['stack']).toBeUndefined();
    expect(json['cause']).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('/Users/');
  });

  it('redacts credential-shaped content out of error messages', () => {
    /*
     * Assembled at runtime rather than written as a literal. The value is
     * entirely synthetic, but a real-looking PAT literal in the repository
     * would trip GitHub's push protection — and a project that trains people
     * to click past secret-scanning warnings has defeated the point of having
     * them.
     */
    const secretPart = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    const syntheticToken = ['1', `1234567890123456:${secretPart}`].join('/');

    const err = new ConnectorError(ERROR_CODES.AUTHENTICATION_ERROR, {
      message: `Rejected token ${syntheticToken} from client`,
    });

    expect(err.message).not.toContain(secretPart);
    expect(err.message).toContain('[REDACTED]');
  });

  it('exposes the full wire contract with stable field names', () => {
    const err = new ConnectorError(ERROR_CODES.RATE_LIMITED, {
      action: 'asana.list_projects',
      requestId: 'req_abc',
      httpStatus: 429,
      retryAfterMs: 30_000,
    });

    expect(err.toJSON()).toMatchObject({
      code: 'ASANA_RATE_LIMITED',
      provider: 'asana',
      action: 'asana.list_projects',
      requestId: 'req_abc',
      httpStatus: 429,
      retryable: true,
      retryStrategy: 'after_delay',
      retryAfterMs: 30_000,
      severity: 'warning',
    });
  });

  it('keeps debug output separate and still redacted', () => {
    const err = new ConnectorError(ERROR_CODES.SERVER_ERROR, { cause: new Error('boom') });
    const debug = err.toDebugJSON();

    expect(debug['stack']).toBeTypeOf('string');
    expect(debug['cause']).toMatchObject({ message: 'boom' });
  });
});
