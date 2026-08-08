/**
 * A scripted fetch double.
 *
 * Tests queue responses and then assert on what was actually sent. This keeps
 * the whole suite offline and credential-free — no test ever needs a real
 * Asana token, which is what allows CI to run with no secrets configured.
 */

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface ScriptedResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a transport fault. */
  readonly throws?: Error;
}

export interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
  /** Calls that were not GETs — used to prove read-only operations stay read-only. */
  readonly writeCalls: RecordedCall[];
}

export function createFakeFetch(script: readonly ScriptedResponse[]): FakeFetch {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }

    calls.push({ url, method, headers, body });

    // Reuse the last scripted response once the script is exhausted, so a test
    // that retries N times does not need N identical entries.
    const scripted = script[Math.min(index, script.length - 1)];
    index += 1;

    if (scripted === undefined) {
      return Promise.reject(new Error(`fake fetch: no scripted response for call ${index}`));
    }

    if (scripted.throws !== undefined) {
      return Promise.reject(scripted.throws);
    }

    const status = scripted.status ?? 200;
    const payload = scripted.body === undefined ? null : JSON.stringify(scripted.body);

    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { 'content-type': 'application/json', ...(scripted.headers ?? {}) },
      }),
    );
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    calls,
    get writeCalls() {
      return calls.filter((c) => c.method !== 'GET');
    },
  };
}

/** An abort error shaped like the one fetch produces on timeout. */
export function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** A network failure shaped like Node's fetch wrapper produces. */
export function networkError(code = 'ECONNREFUSED'): Error {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = { code };
  return err;
}

/**
 * A virtual clock: `sleep` advances time instead of waiting.
 *
 * `now` must be wired up alongside `sleep`. Anything that waits for the clock
 * to advance — the token bucket especially — will spin forever if it sleeps
 * against a clock that never moves.
 */
export function createFakeClock(startAt = 1_700_000_000_000): {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  delays: number[];
} {
  const delays: number[] = [];
  let current = startAt;

  return {
    sleep: (ms: number) => {
      delays.push(ms);
      current += ms;
      return Promise.resolve();
    },
    now: () => current,
    delays,
  };
}
