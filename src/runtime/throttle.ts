/**
 * Client-side rate limiting.
 *
 * Asana's limits are per-token: 150 requests/minute on free plans, 1500 on
 * paid, with a separate cap on concurrent in-flight requests (50 GET, 15
 * write) and a cost-based limiter on top. Crucially, Asana's documentation
 * states that *rejected* requests still count against the quota — so a client
 * that reacts only after receiving a 429 makes the problem worse.
 *
 * This module therefore paces requests *before* sending them. Staying under
 * the limit is cheaper than recovering from it.
 */

export type SleepFn = (ms: number) => Promise<void>;

/**
 * Safety bound on the token-bucket wait loop. Generous enough that no
 * legitimate throttle wait reaches it, small enough to fail fast on a stuck clock.
 */
const MAX_ACQUIRE_ITERATIONS = 10_000;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A token bucket smoothed to a per-millisecond refill.
 *
 * Chosen over a fixed window because a fixed window permits a burst of the
 * full quota at a boundary — send 140 requests at 59.9s and 140 more at 60.1s
 * and Asana sees 280 in a moving minute. A bucket spreads them out.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerMinute: number,
    private readonly sleep: SleepFn = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {
    this.capacity = Math.max(1, ratePerMinute);
    this.refillPerMs = ratePerMinute / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = current;
  }

  /** Approximate tokens available right now. Exposed as response metadata. */
  get remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  get limitRpm(): number {
    return this.ratePerMinute;
  }

  /**
   * Wait until a token is available, then consume it.
   *
   * @returns milliseconds spent waiting, reported to the caller so throttling
   *          is visible in the console rather than looking like network lag.
   */
  async acquire(): Promise<number> {
    const started = this.now();

    // Bounded rather than `for(;;)`. The loop only terminates when the clock
    // advances, so a clock that does not move (a mis-wired test double, a
    // suspended VM, a monotonic-time bug) would otherwise spin forever inside
    // an async function — the worst kind of hang, because it looks like a slow
    // network call. Failing loudly is far easier to diagnose.
    for (let iteration = 0; iteration < MAX_ACQUIRE_ITERATIONS; iteration++) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return this.now() - started;
      }

      // Sleep exactly long enough for one token, with a small floor so a
      // pathological rate cannot spin the event loop.
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(5, Math.ceil(deficit / this.refillPerMs));
      await this.sleep(waitMs);
    }

    throw new Error(
      `TokenBucket.acquire exceeded ${MAX_ACQUIRE_ITERATIONS} iterations without obtaining a token. ` +
        'This indicates the injected clock is not advancing.',
    );
  }
}

/**
 * Bounds simultaneous in-flight requests.
 *
 * Separate from the token bucket because the two limits are genuinely
 * different: the bucket governs requests per minute, this governs how many are
 * open at once. A slow endpoint can breach the concurrency cap without ever
 * approaching the rate cap.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.createRelease();
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      // Guard against double-release, which would corrupt the counter and
      // silently raise the effective concurrency limit.
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next !== undefined) next();
    };
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random between 0 and the computed ceiling) rather than fixed
 * backoff, because synchronised clients retrying in lockstep after a shared
 * 429 re-create the burst that caused it.
 */
export function backoffDelay(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 300;
  const max = options.maxMs ?? 8_000;
  const random = options.random ?? Math.random;

  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}
