import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AsanaClient, parseDeprecations } from '../../src/client.js';
import type { AsanaApiConfig } from '../../src/config.js';
import { ERROR_CODES } from '../../src/errors/codes.js';
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
  rateLimitRpm: 10_000, // effectively disable pacing in tests
  timeoutMs: 15_000,
  maxConcurrency: 8,
  defaultWorkspace: undefined,
};

const FAKE_TOKEN = 'test-token-not-real';
const listSchema = z.array(z.object({ gid: z.string(), name: z.string().optional() }));

function makeClient(script: readonly ScriptedResponse[], config: Partial<AsanaApiConfig> = {}) {
  const fake = createFakeFetch(script);
  const { sleep, now, delays } = createFakeClock();
  const client = new AsanaClient({ ...API_CONFIG, ...config }, () => Promise.resolve(FAKE_TOKEN), {
    fetch: fake.fetch,
    sleep,
    now,
    random: () => 0.5, // deterministic jitter
  });
  return { client, fake, delays };
}

describe('AsanaClient — request construction', () => {
  it('builds the URL, query string and auth header', async () => {
    const { client, fake } = makeClient([{ body: { data: [] } }]);

    await client.request({
      method: 'GET',
      path: '/projects',
      schema: listSchema,
      query: { workspace: '123', limit: 50, archived: false, omitted: undefined },
      idempotent: true,
    });

    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('https://app.asana.com/api/1.0/projects');
    expect(call.url).toContain('workspace=123');
    expect(call.url).toContain('limit=50');
    expect(call.url).toContain('archived=false');
    expect(call.url).not.toContain('omitted');
    expect(call.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('wraps request bodies in the data envelope Asana requires', async () => {
    const { client, fake } = makeClient([{ status: 201, body: { data: { gid: '1' } } }]);

    await client.request({
      method: 'POST',
      path: '/tasks',
      schema: z.object({ gid: z.string() }),
      body: { name: 'Prepare launch documentation' },
      idempotent: false,
    });

    expect(fake.calls[0]!.body).toEqual({ data: { name: 'Prepare launch documentation' } });
    expect(fake.calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('unwraps the data envelope and reports the next-page cursor', async () => {
    const { client } = makeClient([
      { body: { data: [{ gid: '1', name: 'Product Launch' }], next_page: { offset: 'eyJ0eXAiOiJ' } } },
    ]);

    const result = await client.request({
      method: 'GET',
      path: '/projects',
      schema: listSchema,
      idempotent: true,
    });

    expect(result.data).toEqual([{ gid: '1', name: 'Product Launch' }]);
    expect(result.nextOffset).toBe('eyJ0eXAiOiJ');
    expect(result.attempts).toBe(1);
  });

  it('reports a null cursor on the final page', async () => {
    const { client } = makeClient([{ body: { data: [], next_page: null } }]);

    const result = await client.request({
      method: 'GET',
      path: '/projects',
      schema: listSchema,
      idempotent: true,
    });

    expect(result.nextOffset).toBeNull();
  });
});

describe('AsanaClient — retry policy for idempotent reads', () => {
  it('retries a 429 and honours Retry-After instead of guessing', async () => {
    const { client, fake, delays } = makeClient([
      { status: 429, headers: { 'retry-after': '3' }, body: { errors: [{ message: 'Rate limited' }] } },
      { body: { data: [{ gid: '1' }] } },
    ]);

    const result = await client.request({
      method: 'GET',
      path: '/projects',
      schema: listSchema,
      idempotent: true,
    });

    expect(result.attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);
    // Asana told us 3 seconds; we must wait exactly that, not a computed backoff.
    expect(delays).toContain(3_000);
  });

  it('retries 5xx with exponential backoff', async () => {
    const { client, delays } = makeClient([
      { status: 500, body: { errors: [{ message: 'Server Error', phrase: 'sad squid' }] } },
      { status: 502, body: {} },
      { body: { data: [{ gid: '1' }] } },
    ]);

    const result = await client.request({
      method: 'GET',
      path: '/projects',
      schema: listSchema,
      idempotent: true,
    });

    expect(result.attempts).toBe(3);
    // Deterministic jitter of 0.5: 300*0.5 then 600*0.5.
    expect(delays).toEqual([150, 300]);
  });

  it('gives up after the attempt budget and surfaces the last error', async () => {
    const { client, fake } = makeClient([{ status: 503, body: {} }]);

    await expect(
      client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SERVICE_UNAVAILABLE });

    // Bounded: three attempts, never unlimited.
    expect(fake.calls).toHaveLength(3);
  });

  it('retries timeouts and network failures', async () => {
    for (const fault of [abortError(), networkError('ENOTFOUND')]) {
      const { client, fake } = makeClient([{ throws: fault }, { body: { data: [] } }]);

      const result = await client.request({
        method: 'GET',
        path: '/projects',
        schema: listSchema,
        idempotent: true,
      });

      expect(result.attempts).toBe(2);
      expect(fake.calls).toHaveLength(2);
    }
  });

  it('never retries client errors, which would only fail again', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { client, fake } = makeClient([{ status, body: {} }]);

      await expect(
        client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
      ).rejects.toBeInstanceOf(ConnectorError);

      expect(fake.calls).toHaveLength(1);
    }
  });
});

describe('AsanaClient — write safety (the duplicate-prevention rule)', () => {
  const writeRequest = {
    method: 'POST' as const,
    path: '/tasks',
    schema: z.object({ gid: z.string() }),
    body: { name: 'Test Asana connector' },
    idempotent: false,
  };

  it('does NOT retry a rate-limited create, which would duplicate the task', async () => {
    const { client, fake } = makeClient([
      { status: 429, headers: { 'retry-after': '2' }, body: {} },
      { status: 201, body: { data: { gid: '999' } } }, // must never be reached
    ]);

    await expect(client.request(writeRequest)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMITED,
      retryable: false,
      retryStrategy: 'manual_with_idempotency_key',
    });

    expect(fake.calls).toHaveLength(1);
  });

  it('does NOT retry a 500 on a create — the task may already exist', async () => {
    const { client, fake } = makeClient([{ status: 500, body: {} }, { status: 201, body: { data: { gid: '2' } } }]);

    await expect(client.request(writeRequest)).rejects.toMatchObject({
      retryable: false,
      retryStrategy: 'manual_with_idempotency_key',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('does NOT retry a timed-out create', async () => {
    // The most dangerous case: the request very likely reached Asana.
    const { client, fake } = makeClient([{ throws: abortError() }, { status: 201, body: { data: { gid: '3' } } }]);

    await expect(client.request(writeRequest)).rejects.toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      retryable: false,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('does NOT retry a comment, which would post twice', async () => {
    const { client, fake } = makeClient([{ status: 500, body: {} }]);

    await expect(
      client.request({
        method: 'POST',
        path: '/tasks/1/stories',
        schema: z.object({ gid: z.string() }),
        body: { text: 'Looks good' },
        idempotent: false,
      }),
    ).rejects.toMatchObject({ retryable: false });

    expect(fake.calls).toHaveLength(1);
  });

  it('DOES retry an idempotent PUT, where the end state is identical', async () => {
    // Updating to a fixed set of values twice leaves the same result, so this
    // is genuinely safe — unlike a create.
    const { client, fake } = makeClient([{ status: 500, body: {} }, { body: { data: { gid: '5' } } }]);

    const result = await client.request({
      method: 'PUT',
      path: '/tasks/5',
      schema: z.object({ gid: z.string() }),
      body: { completed: true },
      idempotent: true,
    });

    expect(result.attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('AsanaClient — response validation', () => {
  it('rejects a response missing the data envelope', async () => {
    const { client } = makeClient([{ body: { unexpected: true } }]);

    await expect(
      client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_RESPONSE });
  });

  it('rejects data that does not match the expected shape', async () => {
    const { client } = makeClient([{ body: { data: [{ wrong: 'shape' }] } }]);

    await expect(
      client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_RESPONSE });
  });

  it('classifies a non-JSON gateway error by status rather than failing to parse', async () => {
    const fake = createFakeFetch([]);
    void fake;
    const { client } = makeClient([{ status: 502, body: undefined, headers: { 'content-type': 'text/html' } }]);

    await expect(
      client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.BAD_GATEWAY });
  });
});

describe('AsanaClient — rate limiting', () => {
  it('paces requests when the configured limit is low', async () => {
    // Budget of 1 rpm: the second request must wait for a refill.
    const { client, delays } = makeClient([{ body: { data: [] } }], { rateLimitRpm: 1 });

    await client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true });
    await client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true });

    expect(delays.length).toBeGreaterThan(0);
  });

  it('counts rate-limit hits for the health page', async () => {
    const { client } = makeClient([{ status: 429, body: {} }]);

    await expect(
      client.request({ method: 'GET', path: '/projects', schema: listSchema, idempotent: true }),
    ).rejects.toBeInstanceOf(ConnectorError);

    expect(client.stats.rateLimitHits).toBeGreaterThan(0);
    expect(client.stats.totalRetries).toBeGreaterThan(0);
  });
});

describe('parseDeprecations', () => {
  it('parses a single Asana-Change notice', () => {
    const headers = new Headers({
      'asana-change': 'name=new_task_lists;info=https://asa.na/api-changes;affected=true',
    });

    expect(parseDeprecations(headers)).toEqual([
      { name: 'new_task_lists', info: 'https://asa.na/api-changes', affected: true },
    ]);
  });

  it('parses several notices and defaults affected to false', () => {
    const headers = new Headers({
      'asana-change': 'name=a;info=https://x/1;affected=false, name=b;info=https://x/2',
    });

    const result = parseDeprecations(headers);
    expect(result).toHaveLength(2);
    expect(result[0]?.affected).toBe(false);
    expect(result[1]?.name).toBe('b');
  });

  it('returns nothing when the header is absent', () => {
    expect(parseDeprecations(new Headers())).toEqual([]);
  });
});
