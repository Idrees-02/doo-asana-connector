/**
 * Connector-side idempotency.
 *
 * Asana has NO server-side idempotency-key support: `POST /tasks` twice
 * creates two tasks, and `POST /tasks/{gid}/stories` twice posts two comments.
 * There is no provider mechanism to prevent that, so the connector provides
 * its own — and is explicit about the limits of doing so.
 *
 * What this gives you:
 *   - A caller that retries with the same key gets the original result back
 *     rather than creating a duplicate.
 *   - Concurrent requests with the same key are collapsed: the second waits
 *     for the first rather than racing it.
 *
 * What it honestly does NOT give you:
 *   - It is process-local. A restart, or a second instance behind a load
 *     balancer, will not see previously used keys.
 *   - It cannot protect against a duplicate created by a request that Asana
 *     received but whose response never arrived. That is precisely why the
 *     client refuses to auto-retry writes in the first place.
 *
 * Documented in docs/WRITE-SAFETY.md rather than quietly overstated.
 */

export interface IdempotencyEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly storedAt: number;
}

export interface IdempotencyOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export class IdempotencyCache<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `operation` at most once per key.
   *
   * A completed result is replayed. An in-flight call is joined. Only a genuine
   * first call reaches `operation`.
   */
  async run(key: string | undefined, operation: () => Promise<T>): Promise<T> {
    // No key supplied: the caller has opted out, so do not dedupe.
    if (key === undefined || key.length === 0) return operation();

    const cached = this.get(key);
    if (cached !== undefined) return cached.value;

    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;

    const promise = operation()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  get(key: string): IdempotencyEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, value: T): void {
    // Only successful results are cached. Replaying a failure would be wrong:
    // the caller should be free to retry after fixing the cause.
    this.entries.set(key, { key, value, storedAt: this.now() });
    this.evict();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drop expired entries, then the oldest, until within the size bound. */
  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.storedAt < cutoff) this.entries.delete(key);
    }

    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
