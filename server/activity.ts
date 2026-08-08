/**
 * The activity log.
 *
 * A bounded in-memory ring buffer of recent executions, powering the console's
 * Activity page, Request Inspector and Overview metrics.
 *
 * Two deliberate constraints:
 *
 *   REDACTED ON WRITE. Inputs and outputs pass through `redactValue` as they
 *   are recorded, not as they are read. Redacting on read would leave a
 *   plaintext credential sitting in memory and would fail open if any future
 *   code path forgot to call the redactor.
 *
 *   BOUNDED. A ring buffer, not an array that grows. An unbounded log in a
 *   long-running process is a memory leak with a friendly name.
 *
 * Metrics are computed from these entries rather than fabricated, so an empty
 * log honestly reports "no requests yet" instead of inventing plausible
 * numbers.
 */

import { redactValue } from '../src/runtime/redact.js';
import type { ConnectorExecutionResult } from '../src/runtime/execute.js';

export interface ActivityEntry {
  readonly requestId: string;
  readonly actionId: string;
  readonly status: 'success' | 'error';
  readonly timestamp: string;
  readonly durationMs: number;
  readonly mode: 'live' | 'demo';
  readonly demoData: boolean;
  /** One-line human summary, e.g. "Fetched 12 projects". */
  readonly summary: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly httpStatus: number | null;
    readonly retryable: boolean;
    readonly retryStrategy: string;
    readonly guidance: string;
  } | null;
  readonly upstreamCalls: number;
  readonly attempts: number;
}

const DEFAULT_CAPACITY = 500;

export class ActivityLog {
  private entries: ActivityEntry[] = [];

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  record(input: unknown, result: ConnectorExecutionResult): ActivityEntry {
    const entry: ActivityEntry = {
      requestId: result.meta.requestId,
      actionId: result.meta.actionId,
      status: result.ok ? 'success' : 'error',
      timestamp: result.meta.startedAt,
      durationMs: result.meta.durationMs,
      mode: result.meta.mode,
      demoData: result.meta.demoData,
      summary: summarize(result),
      // Redacted here, at the point of capture.
      input: redactValue(input),
      output: result.ok ? redactValue(result.data) : null,
      error: result.ok
        ? null
        : {
            code: result.error.code,
            message: result.error.message,
            httpStatus: result.error.httpStatus,
            retryable: result.error.retryable,
            retryStrategy: result.error.retryStrategy,
            guidance: result.error.guidance,
          },
      upstreamCalls: result.meta.upstreamCalls,
      attempts: result.meta.attempts,
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.capacity) {
      this.entries.length = this.capacity;
    }

    return entry;
  }

  list(options: { limit?: number; actionId?: string; status?: string } = {}): ActivityEntry[] {
    let result = this.entries;

    if (options.actionId !== undefined) {
      result = result.filter((e) => e.actionId === options.actionId);
    }
    if (options.status !== undefined) {
      result = result.filter((e) => e.status === options.status);
    }

    return result.slice(0, options.limit ?? 100);
  }

  get(requestId: string): ActivityEntry | undefined {
    return this.entries.find((e) => e.requestId === requestId);
  }

  clear(): void {
    this.entries = [];
  }

  /** Real counters derived from recorded entries. Nothing here is invented. */
  metrics(): ActivityMetrics {
    const total = this.entries.length;
    const successful = this.entries.filter((e) => e.status === 'success').length;
    const failed = total - successful;

    const durations = this.entries.map((e) => e.durationMs).sort((a, b) => a - b);
    const byAction: Record<string, number> = {};
    for (const entry of this.entries) {
      byAction[entry.actionId] = (byAction[entry.actionId] ?? 0) + 1;
    }

    return {
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: failed,
      // Null rather than 0 when there is no data: a success rate of 0% and
      // "nothing has run yet" are very different things to show a user.
      successRate: total === 0 ? null : Math.round((successful / total) * 1000) / 10,
      averageLatencyMs:
        total === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / total),
      p95LatencyMs: percentile(durations, 0.95),
      requestsByAction: byAction,
      rateLimitHits: this.entries.filter((e) => e.error?.code === 'ASANA_RATE_LIMITED').length,
    };
  }
}

export interface ActivityMetrics {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly successRate: number | null;
  readonly averageLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly requestsByAction: Record<string, number>;
  readonly rateLimitHits: number;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? null;
}

/** Build the one-line summary shown in the activity feed. */
function summarize(result: ConnectorExecutionResult): string {
  if (!result.ok) {
    return result.error.message;
  }

  const data = result.data as Record<string, unknown>;

  switch (result.meta.actionId) {
    case 'asana.list_projects': {
      const count = Array.isArray(data['projects']) ? data['projects'].length : 0;
      return `Fetched ${count} project${count === 1 ? '' : 's'}`;
    }
    case 'asana.list_project_tasks': {
      const count = Array.isArray(data['tasks']) ? data['tasks'].length : 0;
      return `Fetched ${count} task${count === 1 ? '' : 's'}`;
    }
    case 'asana.create_task': {
      const task = data['task'] as { name?: string } | undefined;
      return `Created "${task?.name ?? 'task'}"`;
    }
    case 'asana.update_task': {
      const fields = Array.isArray(data['updatedFields']) ? data['updatedFields'] : [];
      return `Updated ${fields.length} field${fields.length === 1 ? '' : 's'} (${fields.join(', ')})`;
    }
    case 'asana.add_comment':
      return 'Added a comment';
    default:
      return 'Completed';
  }
}
