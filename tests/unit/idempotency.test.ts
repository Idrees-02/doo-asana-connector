/**
 * Idempotency semantics.
 *
 * These cover the four behaviours the connector actually promises, and — just
 * as importantly — pin the boundary of what it does NOT promise, so nobody
 * later reads "idempotency" and assumes distributed protection:
 *
 *   replay      same key + same request  -> the ORIGINAL result
 *   conflict    same key + different req -> a deterministic error, never a
 *                                           silent replay of the wrong result
 *   collapse    concurrent same key      -> exactly ONE provider mutation
 *   expiry      after the TTL            -> the key is free again
 *
 * The durable backend is tested by writing with one store instance and reading
 * with a second built over the same file, which is what a restart looks like
 * from the store's point of view.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FileIdempotencyStore,
  IdempotencyManager,
  MemoryIdempotencyStore,
  canonicalize,
  createIdempotencyStore,
  hashRequest,
} from '../../src/runtime/idempotency.js';
import { ConnectorError } from '../../src/errors/ConnectorError.js';
import { ERROR_CODES } from '../../src/errors/codes.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idem-'));
  dirs.push(dir);
  return join(dir, 'records.json');
}

const call = (key: string | undefined, request: unknown = { name: 'A' }) => ({
  key,
  actionId: 'asana.create_task',
  principal: 'connector',
  request,
});

/* -------------------------------------------------------------------------- */
/* Request hashing                                                             */
/* -------------------------------------------------------------------------- */

describe('request canonicalization', () => {
  it('treats key order as insignificant', () => {
    // Otherwise an honest retry whose JSON round-tripped through a client with
    // different key ordering would be reported as a conflict.
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });

  it('treats an explicit undefined the same as an absent key', () => {
    // JSON cannot carry `undefined`, so the two spellings describe the same
    // wire request and must not disagree.
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });

  it('distinguishes genuinely different values', () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: null })).not.toBe(hashRequest({}));
  });

  it('sorts nested objects too, not just the top level', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });

  it('preserves array order, which IS significant', () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});

/* -------------------------------------------------------------------------- */
/* Core semantics                                                              */
/* -------------------------------------------------------------------------- */

describe('IdempotencyManager', () => {
  it('runs the operation when no key is supplied', async () => {
    const manager = new IdempotencyManager();
    let runs = 0;

    await manager.run(call(undefined), () => Promise.resolve(++runs));
    await manager.run(call(undefined), () => Promise.resolve(++runs));

    // Opting out of deduplication must actually opt out.
    expect(runs).toBe(2);
  });

  it('replays the original result for the same key and request', async () => {
    const manager = new IdempotencyManager();
    let runs = 0;

    const first = await manager.run(call('k1'), () => Promise.resolve({ id: `task-${++runs}` }));
    const second = await manager.run(call('k1'), () => Promise.resolve({ id: `task-${++runs}` }));

    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });

  it('raises a conflict for the same key with a different request', async () => {
    const manager = new IdempotencyManager();
    await manager.run(call('k1', { name: 'A' }), () => Promise.resolve('first'));

    const thrown = await manager
      .run(call('k1', { name: 'B' }), () => Promise.resolve('second'))
      .catch((e: unknown) => e);

    // Replaying "first" here would answer a question the caller did not ask.
    expect(ConnectorError.isConnectorError(thrown)).toBe(true);
    expect((thrown as ConnectorError).code).toBe(ERROR_CODES.IDEMPOTENCY_CONFLICT);
    expect((thrown as ConnectorError).details[0]?.field).toBe('idempotencyKey');
  });

  it('scopes keys by action, so one action cannot replay another"s result', async () => {
    const manager = new IdempotencyManager();

    const a = await manager.run(
      { key: 'shared', actionId: 'asana.create_task', principal: 'p', request: {} },
      () => Promise.resolve('task'),
    );
    const b = await manager.run(
      { key: 'shared', actionId: 'asana.add_comment', principal: 'p', request: {} },
      () => Promise.resolve('comment'),
    );

    expect(a).toBe('task');
    expect(b).toBe('comment');
  });

  it('scopes keys by principal, so callers cannot collide on a common key', async () => {
    const manager = new IdempotencyManager();

    const a = await manager.run(
      { key: 'retry-1', actionId: 'asana.create_task', principal: 'alice', request: {} },
      () => Promise.resolve('alice-task'),
    );
    const b = await manager.run(
      { key: 'retry-1', actionId: 'asana.create_task', principal: 'bob', request: {} },
      () => Promise.resolve('bob-task'),
    );

    expect(a).toBe('alice-task');
    expect(b).toBe('bob-task');
  });

  it('collapses concurrent duplicates into ONE provider mutation', async () => {
    const manager = new IdempotencyManager();
    let started = 0;
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    const operation = (): Promise<string> => {
      started += 1;
      return gate;
    };

    // Ten simultaneous callers, all with the same key.
    const all = Promise.all(Array.from({ length: 10 }, () => manager.run(call('same'), operation)));
    // Let the microtasks that register the in-flight entry run.
    await Promise.resolve();
    release('created-once');

    const results = await all;

    // The whole point: Asana is called once, and all ten get that one answer.
    expect(started).toBe(1);
    expect(results).toEqual(Array.from({ length: 10 }, () => 'created-once'));
  });

  it('does NOT record a failure, so the caller may retry after fixing the cause', async () => {
    const manager = new IdempotencyManager();
    let runs = 0;

    await manager
      .run(call('k1'), () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      })
      .catch(() => undefined);

    const second = await manager.run(call('k1'), () => {
      runs += 1;
      return Promise.resolve('recovered');
    });

    expect(runs).toBe(2);
    expect(second).toBe('recovered');
  });

  it('frees the key once the TTL has elapsed', async () => {
    let clock = 1_000;
    const manager = new IdempotencyManager({ ttlMs: 60_000, now: () => clock });
    let runs = 0;

    await manager.run(call('k1'), () => Promise.resolve(++runs));
    clock += 60_001;
    await manager.run(call('k1'), () => Promise.resolve(++runs));

    expect(runs).toBe(2);
  });

  it('still replays inside the TTL', async () => {
    let clock = 1_000;
    const manager = new IdempotencyManager({ ttlMs: 60_000, now: () => clock });
    let runs = 0;

    await manager.run(call('k1'), () => Promise.resolve(++runs));
    clock += 59_000;
    await manager.run(call('k1'), () => Promise.resolve(++runs));

    expect(runs).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Storage backends                                                            */
/* -------------------------------------------------------------------------- */

describe('MemoryIdempotencyStore', () => {
  it('bounds its own size, so a long-lived process does not grow forever', async () => {
    const store = new MemoryIdempotencyStore(3);

    for (let i = 0; i < 10; i++) {
      await store.put(`id-${i}`, {
        key: `k${i}`,
        actionId: 'a',
        principal: 'p',
        requestHash: 'h',
        status: 'completed',
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }

    expect(store.size).toBe(3);
    // Oldest evicted first.
    expect(await store.get('id-0')).toBeUndefined();
    expect(await store.get('id-9')).toBeDefined();
  });
});

describe('FileIdempotencyStore — durability across a restart', () => {
  it('replays a key recorded by a previous process', async () => {
    const path = await tempFile();
    let runs = 0;

    // Process 1.
    const first = new IdempotencyManager({ store: new FileIdempotencyStore(path) });
    const original = await first.run(call('restart-key'), () =>
      Promise.resolve({ id: `task-${++runs}` }),
    );

    // Process 2: a completely fresh manager and store over the same file.
    const second = new IdempotencyManager({ store: new FileIdempotencyStore(path) });
    const replayed = await second.run(call('restart-key'), () =>
      Promise.resolve({ id: `task-${++runs}` }),
    );

    expect(runs).toBe(1);
    expect(replayed).toEqual(original);
  });

  it('detects a conflicting reuse recorded by a previous process', async () => {
    const path = await tempFile();

    const first = new IdempotencyManager({ store: new FileIdempotencyStore(path) });
    await first.run(call('restart-key', { name: 'A' }), () => Promise.resolve('first'));

    const second = new IdempotencyManager({ store: new FileIdempotencyStore(path) });
    const thrown = await second
      .run(call('restart-key', { name: 'B' }), () => Promise.resolve('second'))
      .catch((e: unknown) => e);

    expect((thrown as ConnectorError).code).toBe(ERROR_CODES.IDEMPOTENCY_CONFLICT);
  });

  it('writes the record file owner-readable only', async () => {
    const path = await tempFile();
    const manager = new IdempotencyManager({ store: new FileIdempotencyStore(path) });

    await manager.run(call('k1'), () => Promise.resolve('done'));

    const fs = await import('node:fs/promises');
    // A record can contain a task name or comment text — the user's data, even
    // though it is not a credential.
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it('records the request HASH, never the request itself', async () => {
    const path = await tempFile();
    const manager = new IdempotencyManager({ store: new FileIdempotencyStore(path) });

    await manager.run(call('k1', { secretish: 'do-not-persist-verbatim' }), () =>
      Promise.resolve('ok'),
    );

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('do-not-persist-verbatim');
    expect(raw).toContain(hashRequest({ secretish: 'do-not-persist-verbatim' }));
  });

  it('treats a corrupt record file as empty rather than failing to start', async () => {
    const path = await tempFile();
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, 'this is not json', 'utf8');

    const manager = new IdempotencyManager({ store: new FileIdempotencyStore(path) });

    // Losing dedupe records degrades to "might duplicate on a retry"; refusing
    // to start would take the service down over it.
    await expect(manager.run(call('k1'), () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('createIdempotencyStore', () => {
  it('builds the backend named in configuration', async () => {
    expect(createIdempotencyStore('memory', 'ignored')).toBeInstanceOf(MemoryIdempotencyStore);
    expect(createIdempotencyStore('file', await tempFile())).toBeInstanceOf(FileIdempotencyStore);
  });
});

/* -------------------------------------------------------------------------- */
/* The limit, asserted rather than merely documented                           */
/* -------------------------------------------------------------------------- */

describe('the documented limit of this design', () => {
  it('does NOT deduplicate across two independent in-memory instances', async () => {
    // This is the multi-replica case, and it is asserted rather than glossed.
    // If a shared backend is ever added, this test is what should change —
    // and until it does, docs/LIMITATIONS.md is telling the truth.
    const a = new IdempotencyManager({ store: new MemoryIdempotencyStore() });
    const b = new IdempotencyManager({ store: new MemoryIdempotencyStore() });
    let runs = 0;

    await a.run(call('k1'), () => Promise.resolve(++runs));
    await b.run(call('k1'), () => Promise.resolve(++runs));

    expect(runs).toBe(2);
  });

  it('DOES deduplicate across two instances sharing one durable backend', async () => {
    // And this is why the storage layer is an interface: swapping in a Redis
    // or Postgres implementation is the whole of the work required to make
    // the multi-replica case safe.
    const path = await tempFile();
    const shared = new FileIdempotencyStore(path);
    const a = new IdempotencyManager({ store: shared });
    const b = new IdempotencyManager({ store: shared });
    let runs = 0;

    await a.run(call('k1'), () => Promise.resolve(++runs));
    await b.run(call('k1'), () => Promise.resolve(++runs));

    expect(runs).toBe(1);
  });
});
