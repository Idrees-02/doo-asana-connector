/**
 * End-to-end action tests against the in-memory Asana API.
 *
 * These run the real pipeline — validation, approval gating, idempotency, the
 * real client, the real actions, real error normalization — with only the
 * network replaced. So they exercise the code that actually ships.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config.js';
import { createConnector, type AsanaConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';
import { REQUIRED_ACTION_IDS } from '../../src/actions/index.js';
import { ERROR_CODES } from '../../src/errors/codes.js';
import type { ConnectorExecutionResult } from '../../src/runtime/execute.js';

const LAUNCH_PROJECT = '900000000001001';
const ENGINEERING_PROJECT = '900000000001002';

let store: DemoStore;
let connector: AsanaConnector;

beforeEach(() => {
  store = new DemoStore();
  connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    // No latency in tests; the console sets a realistic range at runtime.
    fetch: createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 }),
  });
});

/** Narrow a result to success, failing the test with the real error if not. */
function expectOk(result: ConnectorExecutionResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`Expected success but got ${result.error.code}: ${result.error.message}`);
  }
  return result.data as Record<string, unknown>;
}

function expectFail(result: ConnectorExecutionResult) {
  if (result.ok) throw new Error('Expected failure but the action succeeded.');
  return result.error;
}

/* ========================================================================== */
/* Registry                                                                    */
/* ========================================================================== */

describe('action registry', () => {
  it('exposes exactly the five assignment-required actions, correctly named', () => {
    // Guards against a rename or an accidental sixth action being added.
    expect(connector.listActions().map((a) => a.id)).toEqual([...REQUIRED_ACTION_IDS]);
  });

  it('never exposes a delete action', () => {
    // Delete is not one of the assigned actions and must not appear anywhere.
    const ids = connector.listActions().map((a) => a.id);
    expect(ids.some((id) => /delete|remove|destroy/i.test(id))).toBe(false);
  });

  it('requests no delete scope', () => {
    const scopes = connector.listActions().flatMap((a) => a.scopes);
    expect(scopes.some((s) => s.includes('delete'))).toBe(false);
  });

  it('marks exactly the three write actions as writes requiring approval', () => {
    const writes = connector.listActions().filter((a) => a.safety.write);

    expect(writes.map((a) => a.id)).toEqual([
      'asana.create_task',
      'asana.update_task',
      'asana.add_comment',
    ]);
    expect(writes.every((a) => a.safety.requiresApproval)).toBe(true);
  });

  it('marks create and comment as non-idempotent, and update as idempotent', () => {
    const byId = new Map(connector.listActions().map((a) => [a.id, a]));

    // This is what stops the transport layer retrying them.
    expect(byId.get('asana.create_task')?.safety.idempotent).toBe(false);
    expect(byId.get('asana.add_comment')?.safety.idempotent).toBe(false);
    expect(byId.get('asana.update_task')?.safety.idempotent).toBe(true);
  });
});

/* ========================================================================== */
/* testConnection                                                              */
/* ========================================================================== */

describe('testConnection', () => {
  it('reports the account and workspaces', async () => {
    const result = await connector.testConnection();

    expect(result.connected).toBe(true);
    expect(result.provider).toBe('asana');
    expect(result.account?.name).toBe('Idrees Khaled');
    expect(result.workspaces).toHaveLength(1);
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('performs NO write of any kind', async () => {
    // The assignment requires that the connection test has no side effects.
    // Asserting on the call log proves it rather than trusting a comment.
    const calls: Array<{ method: string; url: string }> = [];
    const demoFetch = createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 });

    const spyConnector = createConnector({
      config: buildConfig({ ASANA_MODE: 'demo' }),
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
        return demoFetch(input, init);
      },
    });

    await spyConnector.testConnection();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);

    // And nothing in the store changed.
    expect(store.listTasks(LAUNCH_PROJECT, null)).toHaveLength(
      new DemoStore().listTasks(LAUNCH_PROJECT, null).length,
    );
  });

  it('never returns a token, even masked', async () => {
    const result = await connector.testConnection();
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('demo-mode-no-credential-required');
    // A fingerprint identifies the credential without revealing it.
    expect(result.auth.fingerprint).toMatch(/^fp_[0-9a-f]{12}$/);
  });

  it('reports a clear failure when authentication is rejected', async () => {
    store.controls.fault = 'auth';

    const result = await connector.testConnection();

    expect(result.connected).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.AUTHENTICATION_ERROR);
    expect(result.error?.guidance).toMatch(/token|authenticate/i);
  });
});

/* ========================================================================== */
/* asana.list_projects                                                         */
/* ========================================================================== */

describe('asana.list_projects', () => {
  it('returns projects with the workspace resolved automatically', async () => {
    const data = expectOk(
      await connector.execute({ actionId: 'asana.list_projects', input: {} }),
    );

    const projects = data['projects'] as Array<{ name: string; url: string }>;
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.map((p) => p.name)).toContain('Product Launch');
    expect(projects[0]?.url).toMatch(/^https:\/\/app\.asana\.com\//);
  });

  it('filters by archived state', async () => {
    const active = expectOk(
      await connector.execute({ actionId: 'asana.list_projects', input: { archived: false } }),
    );
    const archived = expectOk(
      await connector.execute({ actionId: 'asana.list_projects', input: { archived: true } }),
    );

    const activeNames = (active['projects'] as Array<{ name: string }>).map((p) => p.name);
    const archivedNames = (archived['projects'] as Array<{ name: string }>).map((p) => p.name);

    expect(activeNames).toContain('Engineering');
    expect(activeNames).not.toContain('Archived Pilot');
    expect(archivedNames).toEqual(['Archived Pilot']);
  });

  it('paginates with an opaque cursor', async () => {
    const first = expectOk(
      await connector.execute({ actionId: 'asana.list_projects', input: { limit: 2 } }),
    );
    const pagination = first['pagination'] as { nextCursor: string; hasMore: boolean };

    expect(first['projects']).toHaveLength(2);
    expect(pagination.hasMore).toBe(true);
    expect(pagination.nextCursor).toBeTypeOf('string');

    const second = expectOk(
      await connector.execute({
        actionId: 'asana.list_projects',
        input: { limit: 2, cursor: pagination.nextCursor },
      }),
    );

    // A genuinely different page, not the same one repeated.
    const firstIds = (first['projects'] as Array<{ id: string }>).map((p) => p.id);
    const secondIds = (second['projects'] as Array<{ id: string }>).map((p) => p.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('reports an empty result without erroring', async () => {
    store.controls.fault = 'empty';

    const data = expectOk(await connector.execute({ actionId: 'asana.list_projects', input: {} }));

    expect(data['projects']).toEqual([]);
    expect((data['pagination'] as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('rejects an out-of-range page size before making a request', async () => {
    const error = expectFail(
      await connector.execute({ actionId: 'asana.list_projects', input: { limit: 500 } }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.details[0]?.field).toBe('limit');
  });
});

/* ========================================================================== */
/* asana.list_project_tasks                                                    */
/* ========================================================================== */

describe('asana.list_project_tasks', () => {
  it('returns tasks for a project', async () => {
    const data = expectOk(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: ENGINEERING_PROJECT },
      }),
    );

    const tasks = data['tasks'] as Array<{ name: string; assignee: unknown }>;
    expect(tasks.map((t) => t.name)).toContain('Test Asana connector');
  });

  it('excludes completed tasks when asked', async () => {
    const all = expectOk(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: ENGINEERING_PROJECT, includeCompleted: true },
      }),
    );
    const open = expectOk(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: ENGINEERING_PROJECT, includeCompleted: false },
      }),
    );

    const openTasks = open['tasks'] as Array<{ completed: boolean }>;
    expect(openTasks.every((t) => !t.completed)).toBe(true);
    expect(openTasks.length).toBeLessThan((all['tasks'] as unknown[]).length);
  });

  it('requires a valid project id', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: 'not-a-gid' },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.details[0]?.field).toBe('projectId');
  });

  it('surfaces a 404 for an unknown project', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: '111111111111111' },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(error.retryable).toBe(false);
  });
});

/* ========================================================================== */
/* asana.create_task                                                           */
/* ========================================================================== */

describe('asana.create_task', () => {
  const validInput = { projectId: LAUNCH_PROJECT, name: 'Prepare launch documentation v2' };

  it('refuses to run without explicit approval', async () => {
    const error = expectFail(
      await connector.execute({ actionId: 'asana.create_task', input: validInput }),
    );

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
    // Nothing was created.
    expect(store.listTasks(LAUNCH_PROJECT, null).map((t) => t.name)).not.toContain(validInput.name);
  });

  it('creates a task when approved', async () => {
    const data = expectOk(
      await connector.execute({ actionId: 'asana.create_task', input: validInput, approved: true }),
    );

    const task = data['task'] as { id: string; name: string; url: string };
    expect(data['created']).toBe(true);
    expect(task.name).toBe(validInput.name);
    expect(task.id).toBeTypeOf('string');
    expect(task.url).toMatch(/^https:\/\/app\.asana\.com\//);
  });

  it('requires either a project or a workspace', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { name: 'Orphan task' },
        approved: true,
      }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toMatch(/projectId or workspace/i);
  });

  it('rejects an empty name before any request is made', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: LAUNCH_PROJECT, name: '   ' },
        approved: true,
      }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.details[0]?.field).toBe('name');
  });

  it('rejects dueOn and dueAt together, as Asana would', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { ...validInput, dueOn: '2026-09-01', dueAt: '2026-09-01T12:00:00Z' },
        approved: true,
      }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toMatch(/either dueOn or dueAt/i);
  });

  it('deduplicates a retried create when an idempotency key is supplied', async () => {
    const before = store.listTasks(LAUNCH_PROJECT, null).length;

    const first = expectOk(
      await connector.execute({
        actionId: 'asana.create_task',
        input: validInput,
        approved: true,
        idempotencyKey: 'launch-doc-001',
      }),
    );
    const second = expectOk(
      await connector.execute({
        actionId: 'asana.create_task',
        input: validInput,
        approved: true,
        idempotencyKey: 'launch-doc-001',
      }),
    );

    // Same task returned, and only one actually created.
    expect((second['task'] as { id: string }).id).toBe((first['task'] as { id: string }).id);
    expect(store.listTasks(LAUNCH_PROJECT, null).length).toBe(before + 1);
  });

  it('creates two tasks without an idempotency key — matching Asana behaviour', async () => {
    // Documented honestly rather than pretended away: Asana has no server-side
    // deduplication, so two calls genuinely mean two tasks.
    const before = store.listTasks(LAUNCH_PROJECT, null).length;

    await connector.execute({ actionId: 'asana.create_task', input: validInput, approved: true });
    await connector.execute({ actionId: 'asana.create_task', input: validInput, approved: true });

    expect(store.listTasks(LAUNCH_PROJECT, null).length).toBe(before + 2);
  });

  it('does not retry on rate limit, and says why', async () => {
    store.controls.fault = 'rate_limit';

    const error = expectFail(
      await connector.execute({ actionId: 'asana.create_task', input: validInput, approved: true }),
    );

    expect(error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(error.retryable).toBe(false);
    expect(error.retryStrategy).toBe('manual_with_idempotency_key');
  });
});

/* ========================================================================== */
/* asana.update_task                                                           */
/* ========================================================================== */

describe('asana.update_task', () => {
  let taskId: string;

  beforeEach(() => {
    taskId = store.listTasks(LAUNCH_PROJECT, null)[0]!.gid;
  });

  it('requires approval', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: { name: 'Renamed' } },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('updates only the fields provided', async () => {
    const original = store.getTask(taskId)!;
    const originalNotes = original.notes;

    const data = expectOk(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: { name: 'Renamed task' } },
        approved: true,
      }),
    );

    expect((data['task'] as { name: string }).name).toBe('Renamed task');
    expect(data['updatedFields']).toEqual(['name']);
    // The untouched field is genuinely untouched.
    expect(store.getTask(taskId)?.notes).toBe(originalNotes);
  });

  it('clears a field when passed an explicit null', async () => {
    // The distinction that makes this action correct: null means "clear".
    expect(store.getTask(taskId)?.due_on).not.toBeNull();

    const data = expectOk(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: { dueOn: null } },
        approved: true,
      }),
    );

    expect((data['task'] as { dueOn: string | null }).dueOn).toBeNull();
    expect(store.getTask(taskId)?.due_on).toBeNull();
  });

  it('leaves a field alone when it is omitted', async () => {
    const before = store.getTask(taskId)!.due_on;

    await connector.execute({
      actionId: 'asana.update_task',
      input: { taskId, patch: { name: 'Still has a due date' } },
      approved: true,
    });

    expect(store.getTask(taskId)?.due_on).toBe(before);
  });

  it('rejects an empty patch rather than issuing a pointless write', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: {} },
        approved: true,
      }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toMatch(/at least one field/i);
  });

  it('marks a task complete', async () => {
    const data = expectOk(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: { completed: true } },
        approved: true,
      }),
    );

    expect((data['task'] as { completed: boolean }).completed).toBe(true);
  });

  describe('stale-write guard', () => {
    it('allows an update when the task has not changed', async () => {
      const modifiedAt = store.getTask(taskId)!.modified_at;

      const result = await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId, patch: { name: 'Safe edit' }, ifUnmodifiedSince: modifiedAt },
        approved: true,
      });

      expect(result.ok).toBe(true);
    });

    it('rejects an update that would silently overwrite a concurrent edit', async () => {
      const staleTimestamp = store.getTask(taskId)!.modified_at;

      // Someone else edits the task in the meantime.
      store.updateTask(taskId, { name: 'Edited by someone else' });

      const error = expectFail(
        await connector.execute({
          actionId: 'asana.update_task',
          input: { taskId, patch: { name: 'My edit' }, ifUnmodifiedSince: staleTimestamp },
          approved: true,
        }),
      );

      expect(error.code).toBe(ERROR_CODES.CONFLICT);
      expect(error.guidance).toMatch(/refresh/i);
      // The other person's edit survived.
      expect(store.getTask(taskId)?.name).toBe('Edited by someone else');
    });
  });
});

/* ========================================================================== */
/* asana.add_comment                                                           */
/* ========================================================================== */

describe('asana.add_comment', () => {
  let taskId: string;

  beforeEach(() => {
    taskId = store.listTasks(LAUNCH_PROJECT, null)[0]!.gid;
  });

  it('requires approval', async () => {
    const error = expectFail(
      await connector.execute({
        actionId: 'asana.add_comment',
        input: { taskId, text: 'Looks good' },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
    expect(store.listStories(taskId)).toHaveLength(1); // only the seeded one
  });

  it('adds a comment when approved', async () => {
    const data = expectOk(
      await connector.execute({
        actionId: 'asana.add_comment',
        input: { taskId, text: 'Verified against the sandbox workspace.' },
        approved: true,
      }),
    );

    const comment = data['comment'] as { text: string; createdAt: string; type: string };
    expect(comment.text).toBe('Verified against the sandbox workspace.');
    expect(comment.type).toBe('comment');
    expect(comment.createdAt).toBeTypeOf('string');
  });

  it('rejects an empty or whitespace-only comment', async () => {
    for (const text of ['', '   ', '\n\t ']) {
      const error = expectFail(
        await connector.execute({
          actionId: 'asana.add_comment',
          input: { taskId, text },
          approved: true,
        }),
      );
      expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('trims surrounding whitespace', async () => {
    const data = expectOk(
      await connector.execute({
        actionId: 'asana.add_comment',
        input: { taskId, text: '  needs review  ' },
        approved: true,
      }),
    );

    expect((data['comment'] as { text: string }).text).toBe('needs review');
  });

  it('deduplicates a retried comment when an idempotency key is supplied', async () => {
    const before = store.listStories(taskId).length;

    await connector.execute({
      actionId: 'asana.add_comment',
      input: { taskId, text: 'Only once please' },
      approved: true,
      idempotencyKey: 'comment-001',
    });
    await connector.execute({
      actionId: 'asana.add_comment',
      input: { taskId, text: 'Only once please' },
      approved: true,
      idempotencyKey: 'comment-001',
    });

    expect(store.listStories(taskId).length).toBe(before + 1);
  });

  it('never auto-retries, so a 500 cannot double-post', async () => {
    store.controls.fault = 'server_error';

    const error = expectFail(
      await connector.execute({
        actionId: 'asana.add_comment',
        input: { taskId, text: 'Might double post' },
        approved: true,
      }),
    );

    expect(error.retryable).toBe(false);
    expect(error.retryStrategy).toBe('manual_with_idempotency_key');
  });
});

/* ========================================================================== */
/* Envelope                                                                    */
/* ========================================================================== */

describe('execution envelope', () => {
  it('tags every demo response as demo data', async () => {
    const result = await connector.execute({ actionId: 'asana.list_projects', input: {} });

    expect(result.meta.mode).toBe('demo');
    // The flag the console uses to show its persistent banner. Synthetic data
    // must never be presentable as real Asana data.
    expect(result.meta.demoData).toBe(true);
  });

  it('carries a request id, timing and upstream call count', async () => {
    const result = await connector.execute({ actionId: 'asana.list_projects', input: {} });

    expect(result.meta.requestId).toMatch(/^req_/);
    expect(result.meta.actionId).toBe('asana.list_projects');
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.upstreamCalls).toBeGreaterThan(0);
  });

  it('returns a normalized error envelope for an unknown action', async () => {
    const error = expectFail(
      await connector.execute({ actionId: 'asana.delete_task', input: {} }),
    );

    expect(error.code).toBe(ERROR_CODES.UNKNOWN_ACTION);
    expect(error.retryable).toBe(false);
  });

  it('never leaks a stack trace to the caller', async () => {
    store.controls.fault = 'server_error';

    const result = await connector.execute({ actionId: 'asana.list_projects', input: {} });
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('at Object.');
    expect(serialised).not.toContain('/Users/');
    expect(serialised).not.toContain('node_modules');
  });
});
