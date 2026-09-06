/**
 * Connector-side idempotency.
 *
 * Asana has NO server-side idempotency-key support: `POST /tasks` twice
 * creates two tasks, and `POST /tasks/{gid}/stories` twice posts two comments.
 * There is no provider mechanism to prevent that, so the connector provides
 * its own.
 *
 * WHAT THIS GIVES YOU
 *   - Replay. A caller that retries with the same key, action, principal and
 *     request body gets the ORIGINAL result back instead of a duplicate.
 *   - Conflict detection. The same key with a DIFFERENT request body is a
 *     deterministic ASANA_IDEMPOTENCY_CONFLICT, never a silent replay of an
 *     unrelated result.
 *   - Collapse. Concurrent requests sharing a key are joined, so exactly one
 *     consequential provider mutation happens.
 *   - Optional durability. With IDEMPOTENCY_STORE=file the record survives a
 *     process restart on a persistent volume.
 *
 * WHAT IT HONESTLY DOES NOT GIVE YOU — stated here rather than in a footnote:
 *   - It is NOT distributed. Neither backend coordinates across instances. Two
 *     replicas behind a load balancer each keep their own records, so the same
 *     key routed to different replicas will execute twice. Running more than
 *     one instance requires a shared backend, which is why the storage layer
 *     is an interface (see {@link IdempotencyStore}) rather than a hard-coded
 *     Map: a Redis or Postgres implementation is a drop-in, and none is
 *     claimed to exist today.
 *   - It cannot undo a duplicate created by a request Asana received but whose
 *     response never arrived. That is precisely why the client refuses to
 *     auto-retry non-idempotent writes in the first place.
 *
 * docs/WRITE-SAFETY.md and docs/LIMITATIONS.md repeat these limits verbatim
 * rather than rounding them up to "idempotent".
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

import { ERROR_CODES } from '../errors/codes.js';
import { ConnectorError } from '../errors/ConnectorError.js';

/* -------------------------------------------------------------------------- */
/* Record shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A recorded use of an idempotency key.
 *
 * `status` distinguishes "someone is mid-flight with this key" from "this key
 * produced a result". Only the durable backend can observe an `in_flight`
 * record left behind by a crashed process; that case is handled by treating an
 * expired in-flight record as absent, so a crash cannot wedge a key forever.
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly actionId: string;
  /** Who the key belongs to. Two principals may use the same key safely. */
  readonly principal: string;
  /** SHA-256 of the canonicalized request. Detects same-key-different-request. */
  readonly requestHash: string;
  readonly status: 'in_flight' | 'completed';
  /** The original result, present once `status` is `completed`. */
  readonly result?: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
}

const recordSchema = z.object({
  key: z.string(),
  actionId: z.string(),
  principal: z.string(),
  requestHash: z.string(),
  status: z.enum(['in_flight', 'completed']),
  result: z.unknown().optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The persistence seam.
 *
 * Deliberately tiny and free of any semantics: conflict detection, TTL policy
 * and in-flight collapse all live in {@link IdempotencyManager}, so a new
 * backend only has to store and fetch bytes. Adding Redis or Postgres means
 * implementing these four methods and nothing else.
 */
export interface IdempotencyStore {
  get(id: string): Promise<IdempotencyRecord | undefined>;
  put(id: string, record: IdempotencyRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** Drop everything expired at `now`. Called opportunistically, not scheduled. */
  prune(now: number): Promise<void>;
}

/** Process-local storage. The default, and the honest one about its limits. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  /** Bounds memory: a long-lived process must not grow a key per write forever. */
  constructor(private readonly maxEntries = 5_000) {}

  get(id: string): Promise<IdempotencyRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  put(id: string, record: IdempotencyRecord): Promise<void> {
    this.records.set(id, record);
    // Map preserves insertion order, so the first key is the oldest.
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }

  prune(now: number): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
    return Promise.resolve();
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * File-backed storage, so records survive a restart.
 *
 * Written whole rather than appended: the record set is bounded by the TTL and
 * measured in kilobytes, and rewriting it atomically (write a temp file, then
 * rename) is far simpler to reason about than a log that needs compaction.
 * `rename` is atomic within a filesystem, so a crash mid-write leaves the
 * previous complete file rather than a truncated one.
 *
 * Mode 0600 because a record can contain the result of a write — task names,
 * comment text — which is the user's data even though it is not a credential.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private records: Map<string, IdempotencyRecord> | undefined;

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Map<string, IdempotencyRecord>> {
    if (this.records !== undefined) return this.records;

    const records = new Map<string, IdempotencyRecord>();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = z.array(recordSchema).safeParse(JSON.parse(raw));
      if (parsed.success) {
        for (const record of parsed.data) {
          records.set(idOf(record.principal, record.actionId, record.key), record);
        }
      }
      // A corrupt or half-written file is treated as empty rather than fatal:
      // losing dedupe records degrades to "might duplicate on retry", whereas
      // refusing to start would take the whole service down for it.
    } catch {
      // Missing file is the normal first-run case.
    }

    this.records = records;
    return records;
  }

  private async flush(): Promise<void> {
    const records = await this.load();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify([...records.values()]), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async get(id: string): Promise<IdempotencyRecord | undefined> {
    return (await this.load()).get(id);
  }

  async put(id: string, record: IdempotencyRecord): Promise<void> {
    (await this.load()).set(id, record);
    await this.flush();
  }

  async delete(id: string): Promise<void> {
    (await this.load()).delete(id);
    await this.flush();
  }

  async prune(now: number): Promise<void> {
    const records = await this.load();
    let changed = false;
    for (const [id, record] of records) {
      if (record.expiresAt <= now) {
        records.delete(id);
        changed = true;
      }
    }
    if (changed) await this.flush();
  }
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

export interface IdempotencyManagerOptions {
  readonly store?: IdempotencyStore;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface IdempotentCall {
  readonly key: string | undefined;
  readonly actionId: string;
  /**
   * Who is calling.
   *
   * Folded into the record id so two callers cannot collide on a common key
   * like "retry-1", and so one caller can never replay another's result.
   */
  readonly principal: string;
  /** The validated input. Hashed, never stored in the clear as the identity. */
  readonly request: unknown;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Canonical JSON: object keys sorted at every level.
 *
 * Without this, `{a:1,b:2}` and `{b:2,a:1}` hash differently and an honest
 * retry — same intent, different key order after a round-trip through some
 * client — would be reported as a conflict.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not representable in JSON, so a key set to undefined must
    // hash the same as an absent key or the two spellings would conflict.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);

  return `{${entries.join(',')}}`;
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Record id. Scoped by principal and action so keys cannot collide across either. */
function idOf(principal: string, actionId: string, key: string): string {
  return `${principal} ${actionId} ${key}`;
}

export class IdempotencyManager {
  private readonly store: IdempotencyStore;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * In-process collapse for concurrent callers.
   *
   * The store alone cannot do this: two simultaneous requests would both read
   * "absent" before either wrote. This map is what guarantees exactly one
   * provider mutation, and it is intentionally process-local — collapsing
   * across instances is the distributed problem this connector does not claim
   * to solve.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: IdempotencyManagerOptions = {}) {
    this.store = options.store ?? new MemoryIdempotencyStore();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `operation` at most once per (principal, action, key).
   *
   * A completed record is replayed. An in-flight call is joined. A key reused
   * with a different request throws. Only a genuine first call reaches
   * `operation`.
   */
  async run<T>(call: IdempotentCall, operation: () => Promise<T>): Promise<T> {
    // No key: the caller has opted out of deduplication. Honour that.
    if (call.key === undefined || call.key.length === 0) return operation();

    const id = idOf(call.principal, call.actionId, call.key);
    const requestHash = hashRequest(call.request);
    const now = this.now();

    await this.store.prune(now);

    const existing = await this.store.get(id);
    if (existing !== undefined && existing.expiresAt > now) {
      // Same key, different request. Replaying would return a result for an
      // operation the caller did not ask for, so this must be an error and
      // never a silent success.
      if (existing.requestHash !== requestHash) {
        throw new ConnectorError(ERROR_CODES.IDEMPOTENCY_CONFLICT, {
          message: `Idempotency key "${call.key}" was already used for a different request.`,
          action: call.actionId,
          details: [
            {
              field: 'idempotencyKey',
              message:
                'This key is bound to the first request body it was used with. ' +
                'Reusing it with different values would make the outcome ambiguous.',
            },
          ],
          guidance:
            'Use a new idempotency key for a different request, or re-send the identical ' +
            'request body to replay the original result.',
        });
      }

      if (existing.status === 'completed') return existing.result as T;
      // `in_flight` from a previous process (this one would have found the
      // promise below). Fall through and re-run: a crashed request is far more
      // likely to have failed than to have silently succeeded, and blocking
      // forever on a record nobody will ever complete is worse.
    }

    const joined = this.inFlight.get(id);
    if (joined !== undefined) return joined as Promise<T>;

    const promise = (async (): Promise<T> => {
      await this.store.put(id, {
        key: call.key as string,
        actionId: call.actionId,
        principal: call.principal,
        requestHash,
        status: 'in_flight',
        createdAt: now,
        expiresAt: now + this.ttlMs,
      });

      try {
        const result = await operation();
        await this.store.put(id, {
          key: call.key as string,
          actionId: call.actionId,
          principal: call.principal,
          requestHash,
          status: 'completed',
          result,
          createdAt: now,
          expiresAt: this.now() + this.ttlMs,
        });
        return result;
      } catch (error) {
        // Failures are NOT recorded. Replaying a failure would deny the caller
        // a legitimate retry after they fix the cause.
        await this.store.delete(id);
        throw error;
      }
    })().finally(() => {
      this.inFlight.delete(id);
    });

    this.inFlight.set(id, promise);
    return promise;
  }

  /** Test/diagnostic helper: has this key produced a result? */
  async has(call: Pick<IdempotentCall, 'key' | 'actionId' | 'principal'>): Promise<boolean> {
    if (call.key === undefined || call.key.length === 0) return false;
    const record = await this.store.get(idOf(call.principal, call.actionId, call.key));
    return record !== undefined && record.expiresAt > this.now() && record.status === 'completed';
  }
}

/** Build the configured backend. Keeps the storage choice out of the connector. */
export function createIdempotencyStore(
  kind: 'memory' | 'file',
  filePath: string,
): IdempotencyStore {
  return kind === 'file' ? new FileIdempotencyStore(filePath) : new MemoryIdempotencyStore();
}
