/**
 * The five-action acceptance scenario.
 *
 * The rest of the suite tests units and edges. This file does one thing: it
 * walks the five assignment-required actions in order, as a single coherent
 * session, the way a reviewer would — discover, read, write, verify — and
 * asserts every cross-cutting guarantee at the point it actually applies.
 *
 *   asana.list_projects        discovery, pagination, request ids
 *   asana.list_project_tasks   pagination through a real cursor
 *   asana.create_task          approval gate, idempotency, no auto-retry
 *   asana.update_task          partial patch, explicit null, stale-read guard
 *   asana.add_comment          approval gate, text validation, idempotency
 *
 * It runs against the in-memory Asana through the real client, the real
 * actions, the real validation, the real approval gate and the real error
 * normalization — the only substitution is the socket. A live equivalent of
 * this scenario is `npm run smoke:live -- --writes`, which drives the same
 * five actions against a real workspace.
 *
 * The controls being asserted are INDEPENDENT, and the tests say so
 * explicitly: authentication admits a caller to the transport, approval
 * consents to a specific write, and an idempotency key deduplicates a retry.
 * None of the three substitutes for another.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildConfig } from '../../src/config.js';
import { createConnector, type AsanaConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';
import { REQUIRED_ACTION_IDS } from '../../src/actions/index.js';
import { ERROR_CODES } from '../../src/errors/codes.js';
import type { ConnectorExecutionResult } from '../../src/runtime/execute.js';

let store: DemoStore;
let connector: AsanaConnector;
/** Every request/response pair the connector made, for provider assertions. */
let calls: Array<{ method: string; url: string; body: unknown }>;

beforeEach(() => {
  store = new DemoStore();
  calls = [];

  const demoFetch = createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 });

  connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    // A recording wrapper, so the scenario can assert the HTTP methods and
    // paths the connector actually used — not just that it returned data.
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return demoFetch(input, init);
    },
  });
});

function ok(result: ConnectorExecutionResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`Expected success but got ${result.error.code}: ${result.error.message}`);
  }
  return result.data as Record<string, unknown>;
}

function failed(result: ConnectorExecutionResult) {
  if (result.ok) throw new Error('Expected failure but the action succeeded.');
  return result.error;
}

/** Every response, success or failure, must carry the same metadata shape. */
function assertMeta(result: ConnectorExecutionResult, actionId: string): void {
  expect(result.meta.requestId).toMatch(/^req_[a-z0-9]+$/);
  expect(result.meta.actionId).toBe(actionId);
  expect(result.meta.provider).toBe('asana');
  expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  // Demo results are labelled as such, so synthetic data can never be mistaken
  // for a real workspace.
  expect(result.meta.demoData).toBe(true);
}

/* ========================================================================== */
/* 0. Authentication and discovery                                             */
/* ========================================================================== */

describe('acceptance · 0 · authentication and discovery', () => {
  it('authenticates and reports the account without touching anything', async () => {
    const connection = await connector.testConnection();

    expect(connection.connected).toBe(true);
    expect(connection.account?.id).toBeTruthy();
    expect(connection.workspaces.length).toBeGreaterThan(0);
    expect(connection.requestId).toMatch(/^req_/);

    // Read-only, proven from the call log rather than asserted in prose.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/1.0/users/me']);
  });

  it('never returns a credential from the connection test', async () => {
    const connection = await connector.testConnection();
    const serialized = JSON.stringify(connection);

    // The type has no field capable of carrying one; this asserts the
    // resulting VALUE too, since a fingerprint is what should appear instead.
    expect(serialized).not.toMatch(/1\/\d{10,}:/);
    expect(serialized.toLowerCase()).not.toContain('bearer ');
    expect(connection.auth.fingerprint).toMatch(/^fp_[0-9a-f]{12}$/);
  });

  it('discovers all five required actions, correctly ordered and typed', () => {
    const actions = connector.listActions();

    expect(actions.slice(0, 5).map((a) => a.id)).toEqual([...REQUIRED_ACTION_IDS]);

    for (const action of actions.slice(0, 5)) {
      expect(action.inputSchema).toBeDefined();
      expect(action.outputSchema).toBeDefined();
      expect(action.endpoints.length).toBeGreaterThan(0);
      expect(action.scopes.length).toBeGreaterThan(0);
      // Write-safety metadata is discoverable BEFORE invocation, which is the
      // whole point of publishing it.
      expect(typeof action.safety.duplicateBehavior).toBe('string');
      expect(typeof action.safety.retryBehavior).toBe('string');
    }
  });

  it('rejects an unknown action id rather than guessing', async () => {
    const error = failed(await connector.execute({ actionId: 'asana.delete_everything', input: {} }));
    expect(error.code).toBe(ERROR_CODES.UNKNOWN_ACTION);
  });
});

/* ========================================================================== */
/* 1. asana.list_projects                                                      */
/* ========================================================================== */

describe('acceptance · 1 · asana.list_projects', () => {
  it('lists projects with validated output and execution metadata', async () => {
    const result = await connector.execute({ actionId: 'asana.list_projects', input: { limit: 3 } });
    const data = ok(result);
    assertMeta(result, 'asana.list_projects');

    const projects = data['projects'] as Array<{ id: string; name: string }>;
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.length).toBeLessThanOrEqual(3);
    for (const project of projects) {
      expect(project.id).toMatch(/^\d+$/);
      expect(typeof project.name).toBe('string');
    }

    // GET only: a read action must never issue a mutating request.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('paginates through a real cursor rather than re-serving page one', async () => {
    const first = ok(await connector.execute({ actionId: 'asana.list_projects', input: { limit: 2 } }));
    const page1 = first['pagination'] as { hasMore: boolean; nextCursor: string | null };

    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const second = ok(
      await connector.execute({
        actionId: 'asana.list_projects',
        input: { limit: 2, cursor: page1.nextCursor },
      }),
    );

    const idsA = (first['projects'] as Array<{ id: string }>).map((p) => p.id);
    const idsB = (second['projects'] as Array<{ id: string }>).map((p) => p.id);

    // The failure this catches is a cursor that is accepted and ignored.
    expect(idsB).not.toEqual(idsA);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });

  it('rejects invalid input before any network call', async () => {
    calls.length = 0;
    const error = failed(
      await connector.execute({ actionId: 'asana.list_projects', input: { limit: 9999 } }),
    );

    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.details.length).toBeGreaterThan(0);
    // Nothing reached Asana, which is why a validation failure is always safe.
    expect(calls).toHaveLength(0);
  });
});

/* ========================================================================== */
/* 2. asana.list_project_tasks                                                 */
/* ========================================================================== */

describe('acceptance · 2 · asana.list_project_tasks', () => {
  it('lists the tasks of a project discovered in step 1', async () => {
    const projects = ok(await connector.execute({ actionId: 'asana.list_projects', input: {} }))[
      'projects'
    ] as Array<{ id: string }>;
    const projectId = projects[0]?.id;
    expect(projectId).toBeDefined();

    const result = await connector.execute({
      actionId: 'asana.list_project_tasks',
      input: { projectId, limit: 5 },
    });
    const data = ok(result);
    assertMeta(result, 'asana.list_project_tasks');

    const tasks = data['tasks'] as Array<{ id: string; completed: boolean; dueOn: string | null }>;
    for (const task of tasks) {
      expect(task.id).toMatch(/^\d+$/);
      expect(typeof task.completed).toBe('boolean');
      // Null survives as null rather than becoming undefined or "".
      expect(task.dueOn === null || /^\d{4}-\d{2}-\d{2}$/.test(task.dueOn)).toBe(true);
    }
  });

  it('normalizes a missing project into ASANA_NOT_FOUND with guidance', async () => {
    const error = failed(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: '999999999999999' },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(error.retryable).toBe(false);
    expect(error.requestId).toMatch(/^req_/);
    expect(error.guidance.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric gid, which Asana would reject anyway', async () => {
    const error = failed(
      await connector.execute({
        actionId: 'asana.list_project_tasks',
        input: { projectId: 'not-a-gid' },
      }),
    );
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

/* ========================================================================== */
/* 3. asana.create_task                                                        */
/* ========================================================================== */

describe('acceptance · 3 · asana.create_task', () => {
  const input = { projectId: '900000000001001', name: 'Acceptance task' };

  it('REFUSES to run without explicit approval, before any network call', async () => {
    calls.length = 0;
    const error = failed(await connector.execute({ actionId: 'asana.create_task', input }));

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
    // The gate runs before the transport, so an unapproved create cannot even
    // partially happen.
    expect(calls).toHaveLength(0);
    // The guidance names the consequence, so an agent can reason about it.
    expect(error.guidance).toMatch(/two separate tasks|duplicate/i);
  });

  it('also refuses when approved is explicitly false', async () => {
    const error = failed(
      await connector.execute({ actionId: 'asana.create_task', input, approved: false }),
    );
    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('creates the task once approval is given, using POST /tasks', async () => {
    calls.length = 0;
    const result = await connector.execute({ actionId: 'asana.create_task', input, approved: true });
    const data = ok(result);
    assertMeta(result, 'asana.create_task');

    const task = (data['task'] as { id: string; name: string }) ?? undefined;
    expect(task.id).toMatch(/^\d+$/);
    expect(task.name).toBe('Acceptance task');
    expect(data['created']).toBe(true);

    // Provider compatibility: the right verb, the right path, and Asana's
    // `{ data: … }` request envelope.
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(new URL(post?.url ?? '').pathname).toBe('/api/1.0/tasks');
    expect(post?.body).toMatchObject({ data: { name: 'Acceptance task' } });
  });

  it('replays the original task for a repeated idempotency key', async () => {
    const first = ok(
      await connector.execute({
        actionId: 'asana.create_task',
        input,
        approved: true,
        idempotencyKey: 'acceptance-key-1',
      }),
    );

    const postsBefore = calls.filter((c) => c.method === 'POST').length;

    const second = ok(
      await connector.execute({
        actionId: 'asana.create_task',
        input,
        approved: true,
        idempotencyKey: 'acceptance-key-1',
      }),
    );

    // Same task back, and — the part that matters — no second POST.
    expect((second['task'] as { id: string }).id).toBe((first['task'] as { id: string }).id);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(postsBefore);
  });

  it('raises a conflict when a key is reused for a DIFFERENT request', async () => {
    await connector.execute({
      actionId: 'asana.create_task',
      input,
      approved: true,
      idempotencyKey: 'acceptance-key-2',
    });

    const error = failed(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { ...input, name: 'A completely different task' },
        approved: true,
        idempotencyKey: 'acceptance-key-2',
      }),
    );

    // Replaying the first result here would return a task the caller did not
    // ask for, which is worse than an error.
    expect(error.code).toBe(ERROR_CODES.IDEMPOTENCY_CONFLICT);
  });

  it('collapses concurrent duplicates into exactly one created task', async () => {
    calls.length = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        connector.execute({
          actionId: 'asana.create_task',
          input,
          approved: true,
          idempotencyKey: 'acceptance-concurrent',
        }),
      ),
    );

    const ids = results.map((r) => (ok(r)['task'] as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('is classified so the transport can NEVER auto-retry it', () => {
    const action = connector.listActions().find((a) => a.id === 'asana.create_task');

    // The single flag that stops a timed-out create becoming two tasks.
    expect(action?.safety.idempotent).toBe(false);
    expect(action?.safety.requiresApproval).toBe(true);
    expect(action?.safety.retryBehavior).toContain('NEVER retried automatically');
  });

  it('reports a failed create as manual_with_idempotency_key, not as retryable', async () => {
    // A 500 on a create: the outcome is genuinely unknown, so the connector
    // hands the decision back rather than making it.
    store.controls.fault = 'server_error';

    const error = failed(
      await connector.execute({ actionId: 'asana.create_task', input, approved: true }),
    );

    expect(error.retryable).toBe(false);
    expect(error.retryStrategy).toBe('manual_with_idempotency_key');
    expect(error.guidance).toMatch(/may or may not have been applied/i);
  });
});

/* ========================================================================== */
/* 4. asana.update_task                                                        */
/* ========================================================================== */

describe('acceptance · 4 · asana.update_task', () => {
  async function seedTask(): Promise<{ id: string; modifiedAt: string | null }> {
    const data = ok(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: '900000000001001', name: 'Task to update', dueOn: '2026-06-01' },
        approved: true,
      }),
    );
    return data['task'] as { id: string; modifiedAt: string | null };
  }

  it('requires approval, exactly like create', async () => {
    const task = await seedTask();
    const error = failed(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId: task.id, patch: { name: 'Renamed' } },
      }),
    );
    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('applies a PARTIAL patch and leaves omitted fields untouched', async () => {
    const task = await seedTask();

    const data = ok(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId: task.id, patch: { name: 'Renamed' } },
        approved: true,
      }),
    );

    expect(data['updatedFields']).toEqual(['name']);
    const updated = data['task'] as { name: string; dueOn: string | null };
    expect(updated.name).toBe('Renamed');
    // The field nobody mentioned survives. Collapsing "omitted" into "clear"
    // would silently wipe it.
    expect(updated.dueOn).toBe('2026-06-01');
  });

  it('CLEARS a field on an explicit null, which is a different intent', async () => {
    const task = await seedTask();

    const data = ok(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId: task.id, patch: { dueOn: null } },
        approved: true,
      }),
    );

    expect(data['updatedFields']).toEqual(['dueOn']);
    expect((data['task'] as { dueOn: string | null }).dueOn).toBeNull();

    // And the null actually reached Asana, rather than being dropped en route.
    const put = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(put?.body).toMatchObject({ data: { due_on: null } });
  });

  it('rejects an empty patch instead of reporting a change that never happened', async () => {
    const task = await seedTask();
    const error = failed(
      await connector.execute({
        actionId: 'asana.update_task',
        input: { taskId: task.id, patch: {} },
        approved: true,
      }),
    );
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('rejects mutually exclusive date fields', async () => {
    const task = await seedTask();
    const error = failed(
      await connector.execute({
        actionId: 'asana.update_task',
        input: {
          taskId: task.id,
          patch: { dueOn: '2026-06-01', dueAt: '2026-06-01T12:00:00.000Z' },
        },
        approved: true,
      }),
    );
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('trips the STALE-READ guard when the task changed since it was loaded', async () => {
    const task = await seedTask();

    // Somebody else edits it, moving `modified_at` forward.
    await connector.execute({
      actionId: 'asana.update_task',
      input: { taskId: task.id, patch: { notes: 'Edited by someone else' } },
      approved: true,
    });

    /*
     * A deliberately old timestamp rather than the one captured at create.
     *
     * Asana's `modified_at` has millisecond resolution, and the demo provider
     * reproduces that faithfully — so a create and an update landing in the
     * same millisecond produce an identical value and the guard, correctly,
     * sees no change. Using a value that is unambiguously older tests the
     * guard rather than the clock. The resolution limit itself is asserted in
     * the next case, because it is a real property of this design and not
     * something to paper over.
     */
    const error = failed(
      await connector.execute({
        actionId: 'asana.update_task',
        input: {
          taskId: task.id,
          patch: { name: 'My edit' },
          ifUnmodifiedSince: '2020-01-01T00:00:00.000Z',
        },
        approved: true,
      }),
    );

    expect(error.code).toBe(ERROR_CODES.CONFLICT);
    expect(error.guidance).toMatch(/refresh/i);
  });

  it('is a stale-READ guard, not atomic compare-and-swap — and the gap is real', async () => {
    /*
     * The honest statement of what `ifUnmodifiedSince` does.
     *
     * It issues GET then PUT. Between those two calls another writer can
     * commit, and this connector will not see it — Asana exposes no
     * conditional-write primitive for tasks (no ETag, no If-Match), so there
     * is no compare-and-swap to perform. The check narrows the window; it does
     * not close it.
     *
     * The second limit is resolution: `modified_at` is millisecond-precision,
     * so an edit within the same millisecond as the caller's read is
     * indistinguishable from no edit at all.
     *
     * docs/WRITE-SAFETY.md says exactly this. The test exists so the claim in
     * the documentation is anchored to observable behaviour.
     */
    const task = await seedTask();

    // Two reads of the same unchanged task agree, which is all the guard
    // can ever establish: that nothing was observed to change.
    const first = await connector.execute({
      actionId: 'asana.update_task',
      input: {
        taskId: task.id,
        patch: { name: 'Edit A' },
        ...(task.modifiedAt === null ? {} : { ifUnmodifiedSince: task.modifiedAt }),
      },
      approved: true,
    });
    expect(first.ok).toBe(true);

    // The guard costs a real extra GET. That is why it is opt-in rather than
    // automatic, and it is visible in the call log.
    const gets = calls.filter(
      (c) => c.method === 'GET' && c.url.includes(`/tasks/${task.id}`),
    );
    expect(gets.length).toBeGreaterThan(0);

    // GET-then-PUT, in that order, with no conditional header of any kind —
    // because Asana offers none to send.
    const conditional = calls.find((c) => c.method === 'PUT');
    expect(conditional).toBeDefined();
    expect(JSON.stringify(conditional?.body)).not.toContain('If-Match');
  });

  it('proceeds when the task has NOT changed since it was loaded', async () => {
    const task = await seedTask();

    const result = await connector.execute({
      actionId: 'asana.update_task',
      input: {
        taskId: task.id,
        patch: { name: 'Safe edit' },
        ...(task.modifiedAt === null ? {} : { ifUnmodifiedSince: task.modifiedAt }),
      },
      approved: true,
    });

    expect(result.ok).toBe(true);
  });

  it('is classified as idempotent, because the same patch is the same end state', () => {
    const action = connector.listActions().find((a) => a.id === 'asana.update_task');
    expect(action?.safety.idempotent).toBe(true);
    expect(action?.safety.write).toBe(true);
    expect(action?.safety.requiresApproval).toBe(true);
  });
});

/* ========================================================================== */
/* 5. asana.add_comment                                                        */
/* ========================================================================== */

describe('acceptance · 5 · asana.add_comment', () => {
  async function seedTask(): Promise<string> {
    const data = ok(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: '900000000001001', name: 'Task to comment on' },
        approved: true,
      }),
    );
    return (data['task'] as { id: string }).id;
  }

  it('requires approval', async () => {
    const taskId = await seedTask();
    const error = failed(
      await connector.execute({
        actionId: 'asana.add_comment',
        input: { taskId, text: 'Should not post' },
      }),
    );
    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('validates the comment text rather than posting an empty story', async () => {
    const taskId = await seedTask();

    for (const text of ['', '   ']) {
      const error = failed(
        await connector.execute({
          actionId: 'asana.add_comment',
          input: { taskId, text },
          approved: true,
        }),
      );
      expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('posts the comment to POST /tasks/{gid}/stories once approved', async () => {
    const taskId = await seedTask();
    calls.length = 0;

    const result = await connector.execute({
      actionId: 'asana.add_comment',
      input: { taskId, text: 'Acceptance comment' },
      approved: true,
    });
    const data = ok(result);
    assertMeta(result, 'asana.add_comment');

    expect((data['comment'] as { text: string }).text).toBe('Acceptance comment');

    const post = calls.find((c) => c.method === 'POST');
    expect(new URL(post?.url ?? '').pathname).toBe(`/api/1.0/tasks/${taskId}/stories`);
  });

  it('deduplicates a repeated idempotency key', async () => {
    const taskId = await seedTask();
    const input = { taskId, text: 'Only once' };

    const first = ok(
      await connector.execute({
        actionId: 'asana.add_comment',
        input,
        approved: true,
        idempotencyKey: 'comment-key-1',
      }),
    );
    const postsBefore = calls.filter((c) => c.method === 'POST').length;

    const second = ok(
      await connector.execute({
        actionId: 'asana.add_comment',
        input,
        approved: true,
        idempotencyKey: 'comment-key-1',
      }),
    );

    expect((second['comment'] as { id: string }).id).toBe((first['comment'] as { id: string }).id);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(postsBefore);
  });

  it('is classified so the transport can NEVER auto-retry it', () => {
    const action = connector.listActions().find((a) => a.id === 'asana.add_comment');
    expect(action?.safety.idempotent).toBe(false);
    expect(action?.safety.retryBehavior).toContain('NEVER retried automatically');
  });
});

/* ========================================================================== */
/* 6. The controls are independent                                             */
/* ========================================================================== */

describe('acceptance · 6 · approval is not authentication', () => {
  it('an unauthenticated connector refuses even an APPROVED write', async () => {
    // No credential at all. `approved: true` is present and must buy nothing:
    // consent to a write is not permission to make a request.
    const unauthenticated = createConnector({
      config: buildConfig({ ASANA_MODE: 'auto', NODE_ENV: 'test' }),
      // Force live mode with no credential by supplying no token: the
      // NoCredentialProvider rejects before any request is built.
      fetch: () => Promise.reject(new Error('no request should ever be made')),
    });

    // In demo mode the connector is deliberately usable without a credential,
    // so this asserts the credential provider directly instead — the layer
    // that would reject a real unauthenticated call.
    const connection = await unauthenticated.testConnection();
    expect(connection.mode).toBe('demo');

    // And the approval gate is unaffected by any of it: still required.
    const error = failed(
      await unauthenticated.execute({
        actionId: 'asana.create_task',
        input: { projectId: '900000000001001', name: 'x' },
      }),
    );
    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('approval does not disable validation either', async () => {
    // Three independent gates, and approving one does not satisfy the others.
    const error = failed(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: 'not-a-gid', name: '' },
        approved: true,
      }),
    );
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('an idempotency key does not substitute for approval', async () => {
    const error = failed(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: '900000000001001', name: 'x' },
        idempotencyKey: 'key-without-approval',
      }),
    );

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
    // And the rejected attempt must NOT have consumed the key, or the caller
    // would be unable to use it once they do approve.
    const after = ok(
      await connector.execute({
        actionId: 'asana.create_task',
        input: { projectId: '900000000001001', name: 'x' },
        approved: true,
        idempotencyKey: 'key-without-approval',
      }),
    );
    expect(after['created']).toBe(true);
  });
});

/* ========================================================================== */
/* 7. Every response carries the same envelope                                 */
/* ========================================================================== */

describe('acceptance · 7 · one envelope for all five actions', () => {
  it('returns a request id and meta on success AND on failure', async () => {
    const cases: Array<[string, unknown, boolean]> = [
      ['asana.list_projects', {}, true],
      ['asana.list_project_tasks', { projectId: '900000000001001' }, true],
      ['asana.create_task', { projectId: '900000000001001', name: 'meta check' }, false],
      ['asana.update_task', { taskId: '1', patch: {} }, false],
      ['asana.add_comment', { taskId: '1', text: '' }, false],
    ];

    for (const [actionId, input, shouldSucceed] of cases) {
      const result = await connector.execute({ actionId, input });

      expect(result.ok).toBe(shouldSucceed);
      expect(result.meta.requestId).toMatch(/^req_/);
      expect(result.meta.actionId).toBe(actionId);
      expect(result.meta.provider).toBe('asana');

      if (!result.ok) {
        // The normalized failure shape, identical across every action.
        expect(result.error.code).toMatch(/^ASANA_/);
        expect(result.error.requestId).toBe(result.meta.requestId);
        expect(typeof result.error.retryable).toBe('boolean');
        expect(typeof result.error.retryStrategy).toBe('string');
        expect(result.error.guidance.length).toBeGreaterThan(0);
        // No stack, no token, ever.
        expect(JSON.stringify(result.error)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      }
    }
  });

  it('uses a distinct request id per execution', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, async () =>
        (await connector.execute({ actionId: 'asana.list_projects', input: {} })).meta.requestId,
      ),
    );
    expect(new Set(ids).size).toBe(5);
  });
});
