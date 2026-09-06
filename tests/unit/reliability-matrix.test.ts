/**
 * The reliability matrix, stated as one table.
 *
 * `client.test.ts` and `errors.test.ts` cover these behaviours case by case,
 * which is right for reading a single failure but wrong for answering "is
 * every status classified, and does the write-safety rule hold across all of
 * them?" — a question you can only answer by looking at the whole grid.
 *
 * So this file sweeps EVERY status the connector claims to classify through
 * both an idempotent read and a non-idempotent write, and asserts:
 *
 *   1. the normalized code                      (the caller branches on this)
 *   2. the retry classification                 (what the caller should do)
 *   3. that a non-idempotent write is NEVER reported as auto-retryable,
 *      whatever the status says in isolation
 *   4. that the transport actually behaved that way — the attempt count
 *
 * Point 3 is the safety-critical one. A 429 on a read is "wait and retry"; the
 * identical 429 on a `POST /tasks` must become
 * `manual_with_idempotency_key`, because the task may already exist.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AsanaClient } from '../../src/client.js';
import type { AsanaApiConfig } from '../../src/config.js';
import { ERROR_CODES, type ErrorCode, type RetryStrategy } from '../../src/errors/codes.js';
import { ConnectorError } from '../../src/errors/ConnectorError.js';
import {
  abortError,
  createFakeClock,
  createFakeFetch,
  networkError,
  type ScriptedResponse,
} from '../helpers/fake-fetch.js';

const API_CONFIG: AsanaApiConfig = {
  baseUrl: 'https://app.asana.com/api/1.0',
  rateLimitRpm: 10_000, // effectively disable pacing
  timeoutMs: 15_000,
  maxConcurrency: 8,
  defaultWorkspace: undefined,
};

const schema = z.array(z.object({ gid: z.string() }));

function makeClient(script: readonly ScriptedResponse[]) {
  const fake = createFakeFetch(script);
  const { sleep, now, delays } = createFakeClock();
  const client = new AsanaClient(API_CONFIG, () => Promise.resolve('test-token-not-real'), {
    fetch: fake.fetch,
    sleep,
    now,
    random: () => 0.5,
  });
  return { client, fake, delays };
}

/** Run one request and return the normalized failure. */
async function failWith(
  script: readonly ScriptedResponse[],
  idempotent: boolean,
): Promise<{ error: ConnectorError; attempts: number }> {
  const { client, fake } = makeClient(script);

  try {
    await client.request({
      method: idempotent ? 'GET' : 'POST',
      path: '/tasks',
      schema,
      idempotent,
      actionId: idempotent ? 'asana.list_projects' : 'asana.create_task',
      requestId: 'req_matrix',
      ...(idempotent ? {} : { body: { name: 'x' } }),
    });
    throw new Error('Expected the request to fail.');
  } catch (thrown) {
    if (!ConnectorError.isConnectorError(thrown)) throw thrown;
    return { error: thrown, attempts: fake.calls.length };
  }
}

/** Enough copies of a response that a retry loop can never run out of script. */
function repeat(response: ScriptedResponse): ScriptedResponse[] {
  return Array.from({ length: 5 }, () => response);
}

/* -------------------------------------------------------------------------- */
/* HTTP status matrix                                                          */
/* -------------------------------------------------------------------------- */

interface Row {
  readonly status: number;
  readonly code: ErrorCode;
  /** What a READ should be told to do. */
  readonly readStrategy: RetryStrategy;
  /** Whether the transport should actually re-send a READ. */
  readonly readRetries: boolean;
}

const MATRIX: readonly Row[] = [
  { status: 400, code: ERROR_CODES.BAD_REQUEST, readStrategy: 'none', readRetries: false },
  { status: 401, code: ERROR_CODES.AUTHENTICATION_ERROR, readStrategy: 'none', readRetries: false },
  { status: 402, code: ERROR_CODES.PAYMENT_REQUIRED, readStrategy: 'none', readRetries: false },
  { status: 403, code: ERROR_CODES.PERMISSION_DENIED, readStrategy: 'none', readRetries: false },
  { status: 404, code: ERROR_CODES.NOT_FOUND, readStrategy: 'none', readRetries: false },
  { status: 409, code: ERROR_CODES.CONFLICT, readStrategy: 'none', readRetries: false },
  { status: 451, code: ERROR_CODES.UNAVAILABLE_LEGAL, readStrategy: 'none', readRetries: false },
  { status: 429, code: ERROR_CODES.RATE_LIMITED, readStrategy: 'after_delay', readRetries: true },
  { status: 500, code: ERROR_CODES.SERVER_ERROR, readStrategy: 'backoff', readRetries: true },
  { status: 502, code: ERROR_CODES.BAD_GATEWAY, readStrategy: 'backoff', readRetries: true },
  { status: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, readStrategy: 'backoff', readRetries: true },
  { status: 504, code: ERROR_CODES.SERVICE_UNAVAILABLE, readStrategy: 'backoff', readRetries: true },
];

describe('every HTTP status is classified, on a READ', () => {
  it.each(MATRIX.map((r) => [r.status, r] as const))('%s', async (_status, row) => {
    const { error, attempts } = await failWith(repeat({ status: row.status, body: {} }), true);

    expect(error.code).toBe(row.code);
    expect(error.retryStrategy).toBe(row.readStrategy);
    expect(error.requestId).toBe('req_matrix');
    expect(error.guidance.length).toBeGreaterThan(0);

    // A retryable read is actually re-sent, up to the 3-attempt budget; a
    // non-retryable one is sent exactly once.
    expect(attempts).toBe(row.readRetries ? 3 : 1);
  });
});

describe('every HTTP status is DOWNGRADED on a non-idempotent WRITE', () => {
  it.each(MATRIX.map((r) => [r.status, r] as const))('%s', async (_status, row) => {
    const { error, attempts } = await failWith(repeat({ status: row.status, body: {} }), false);

    // The code is unchanged — the caller still learns what went wrong.
    expect(error.code).toBe(row.code);

    // But nothing is ever reported as automatically retryable, and the
    // transport sends exactly one request whatever the status.
    expect(error.retryable).toBe(false);
    expect(attempts).toBe(1);

    if (row.readRetries) {
      // The statuses that WOULD be retryable on a read become the explicit
      // "a human must decide" strategy on a write.
      expect(error.retryStrategy).toBe('manual_with_idempotency_key');
      expect(error.guidance).toMatch(/may or may not have been applied/i);
    } else {
      // The rest were never retryable, so there is nothing to downgrade.
      expect(error.retryStrategy).toBe('none');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Transport faults                                                            */
/* -------------------------------------------------------------------------- */

describe('transport faults are classified and obey the same write rule', () => {
  it.each([
    ['timeout', abortError(), ERROR_CODES.TIMEOUT],
    ['network failure', networkError('ECONNREFUSED'), ERROR_CODES.NETWORK_ERROR],
    ['DNS failure', networkError('ENOTFOUND'), ERROR_CODES.NETWORK_ERROR],
  ] as const)('a %s on a READ is retried', async (_name, thrown, code) => {
    const { error, attempts } = await failWith(repeat({ throws: thrown }), true);

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(true);
    expect(attempts).toBe(3);
  });

  it.each([
    ['timeout', abortError(), ERROR_CODES.TIMEOUT],
    ['network failure', networkError('ECONNREFUSED'), ERROR_CODES.NETWORK_ERROR],
  ] as const)('a %s on a WRITE is never retried', async (_name, thrown, code) => {
    const { error, attempts } = await failWith(repeat({ throws: thrown }), false);

    // The dangerous case: a timed-out POST may already have created the task.
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.retryStrategy).toBe('manual_with_idempotency_key');
    expect(attempts).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Malformed responses                                                         */
/* -------------------------------------------------------------------------- */

describe('malformed responses fail loudly rather than being guessed at', () => {
  it('rejects a 200 with no data envelope', async () => {
    const { error } = await failWith([{ status: 200, body: { unexpected: true } }], true);
    expect(error.code).toBe(ERROR_CODES.INVALID_RESPONSE);
  });

  it('rejects a 200 whose data does not match the schema', async () => {
    const { error } = await failWith([{ status: 200, body: { data: [{ wrong: 1 }] } }], true);
    expect(error.code).toBe(ERROR_CODES.INVALID_RESPONSE);
    expect(error.details.length).toBeGreaterThan(0);
  });

  it('classifies a non-JSON gateway body by status instead of failing to parse', async () => {
    // Load balancers return HTML for 502. Parsing must not replace the real
    // error with a parse error.
    const { error } = await failWith(repeat({ status: 502, body: '<html>Bad Gateway</html>' }), true);
    expect(error.code).toBe(ERROR_CODES.BAD_GATEWAY);
  });
});

/* -------------------------------------------------------------------------- */
/* Retry pacing                                                                */
/* -------------------------------------------------------------------------- */

describe('retry pacing', () => {
  it('honours Retry-After in preference to its own backoff', async () => {
    const { client, fake, delays } = makeClient([
      { status: 429, headers: { 'retry-after': '7' }, body: {} },
      { status: 200, body: { data: [] } },
    ]);

    await client.request({
      method: 'GET',
      path: '/projects',
      schema,
      idempotent: true,
    });

    expect(fake.calls).toHaveLength(2);
    // Asana's own number, not a guess. Retrying early makes a rate limit
    // worse, because rejected requests still consume quota.
    expect(delays).toEqual([7000]);
  });

  it('backs off with increasing delays when no Retry-After is given', async () => {
    const { client, delays } = makeClient([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { data: [] } },
    ]);

    await client.request({ method: 'GET', path: '/projects', schema, idempotent: true });

    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
  });

  it('stops at the attempt budget rather than retrying indefinitely', async () => {
    const { error, attempts } = await failWith(repeat({ status: 503, body: {} }), true);

    // Bounded: 3 attempts total, then the last error is surfaced.
    expect(attempts).toBe(3);
    expect(error.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing leaks                                                               */
/* -------------------------------------------------------------------------- */

describe('no failure in the matrix leaks a credential or a stack', () => {
  it.each(MATRIX.map((r) => [r.status, r] as const))('%s', async (_status, row) => {
    const { error } = await failWith(repeat({ status: row.status, body: {} }), true);
    const wire = JSON.stringify(error.toJSON());

    expect(wire).not.toContain('test-token-not-real');
    expect(wire.toLowerCase()).not.toContain('bearer ');
    // A stack frame in a wire error tells an attacker about the filesystem
    // and tells the caller nothing useful.
    expect(wire).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* Headers Asana actually returns                                              */
/* -------------------------------------------------------------------------- */

/**
 * Captured from `GET https://app.asana.com/api/1.0/users/me` on 2026-09-06.
 *
 * The assessment noted that "actual provider rate-limit headers were not
 * independently observed". They now have been, and the observation is worth
 * recording because of what it does NOT contain.
 */
describe('the response headers Asana really sends', () => {
  /**
   * The verbatim `Asana-Change` value from that live response — five notices,
   * comma-separated, one of them carrying `affected=true`.
   */
  const LIVE_ASANA_CHANGE =
    'name=new_user_task_lists;info=https://forum.asana.com/t/update-on-our-planned-api-changes-to-user-task-lists-a-k-a-my-tasks/103828, ' +
    'name=cross_workspace_deprecation;info=https://forum.asana.com/t/change-get-projects-get-users-and-get-tags-will-require-a-workspace-or-team/1031581, ' +
    'name=new_goal_memberships;info=https://forum.asana.com/t/launched-team-sharing-for-goals/378601;affected=true, ' +
    'name=teamless_projects;info=https://forum.asana.com/t/change-teamless-projects/929205, ' +
    'name=goal_sals_api;info=https://forum.asana.com/t/new-change-goal-access-levels-admin-editor-and-viewer/1089758';

  it('parses the real multi-notice Asana-Change header', async () => {
    const { parseDeprecations } = await import('../../src/client.js');

    const notices = parseDeprecations(new Headers({ 'asana-change': LIVE_ASANA_CHANGE }));

    // Five notices, not one blob — the comma split has to survive URLs that
    // themselves contain hyphens, slashes and equals signs.
    expect(notices).toHaveLength(5);
    expect(notices.map((n) => n.name)).toEqual([
      'new_user_task_lists',
      'cross_workspace_deprecation',
      'new_goal_memberships',
      'teamless_projects',
      'goal_sals_api',
    ]);

    // Exactly one notice applies to this request, and the `info` URL survives
    // intact despite containing `=` inside the value.
    const affected = notices.filter((n) => n.affected);
    expect(affected).toHaveLength(1);
    expect(affected[0]?.name).toBe('new_goal_memberships');
    expect(affected[0]?.info).toContain('https://forum.asana.com/');
  });

  it('surfaces those notices on a successful request rather than discarding them', async () => {
    const { client } = makeClient([
      { status: 200, body: { data: [] }, headers: { 'asana-change': LIVE_ASANA_CHANGE } },
    ]);

    const result = await client.request({
      method: 'GET',
      path: '/projects',
      schema,
      idempotent: true,
    });

    // Finding out about a deprecation now, rather than when it breaks.
    expect(result.deprecations).toHaveLength(5);
  });

  it('does not depend on a rate-limit budget header, because Asana sends none', async () => {
    /*
     * THE OBSERVATION THAT MATTERS.
     *
     * The live response carried NO `X-RateLimit-Remaining`, no `RateLimit-*`,
     * no budget header of any kind — only `Retry-After`, and only once you
     * have already been rejected with a 429.
     *
     * That is precisely why this client paces requests with its own token
     * bucket BEFORE sending rather than reading a remaining-quota header:
     * there is no header to read. A design that waited to be told would only
     * learn its budget by exhausting it, and Asana's rejected requests still
     * count against the quota.
     */
    const { client } = makeClient([{ status: 200, body: { data: [] } }]);

    await client.request({ method: 'GET', path: '/projects', schema, idempotent: true });

    // The reported limit comes from configuration and the local bucket, not
    // from the provider.
    expect(client.rateLimit.limitRpm).toBe(API_CONFIG.rateLimitRpm);
    expect(typeof client.rateLimit.remaining).toBe('number');
  });

  it('still honours Retry-After, which IS the one thing Asana sends on a 429', async () => {
    const { client, delays } = makeClient([
      { status: 429, headers: { 'retry-after': '3' }, body: {} },
      { status: 200, body: { data: [] } },
    ]);

    await client.request({ method: 'GET', path: '/projects', schema, idempotent: true });

    expect(delays).toEqual([3000]);
  });
});
