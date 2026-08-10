/**
 * Fixture tests.
 *
 * The rest of the suite runs against an in-memory Asana that this repository
 * also wrote, which proves the connector is consistent with itself but not
 * that it is consistent with Asana. These fixtures are unmodified responses
 * captured from the real API (emails redacted, nothing else touched), replayed
 * through the connector.
 *
 * That makes them the one place a field Asana actually returns — `gid` rather
 * than `id`, `due_on` rather than `dueDate`, `next_page` rather than a cursor —
 * is checked against the parser. If Asana changes a shape, recapture the
 * fixtures and these tests fail before users do.
 *
 * Capture command (needs a credential; writes nothing):
 *   see fixtures/asana/README.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildConfig } from '../../src/config.js';
import { createConnector } from '../../src/connector.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../fixtures/asana/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** A connector wired to replay one captured response. */
function connectorFor(...bodies: unknown[]) {
  const fake = createFakeFetch(bodies.map((body) => ({ status: 200, body })));
  return {
    fake,
    connector: createConnector({
      config: buildConfig({ ASANA_MODE: 'live', ASANA_ACCESS_TOKEN: 'test-token' }),
      fetch: fake.fetch,
    }),
  };
}

describe('captured Asana responses', () => {
  it('parses a real project list', async () => {
    const { connector } = connectorFor(fixture('list_projects'));

    const result = await connector.execute({ actionId: 'asana.list_projects', input: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { projects, pagination } = result.data as {
      projects: Array<{ id: string; name: string; archived: boolean; url: string | null }>;
      pagination: { hasMore: boolean; nextCursor: string | null };
    };

    expect(projects.length).toBeGreaterThan(0);
    // Asana calls it `gid`; the connector normalizes it to `id`. This is the
    // assertion that would catch a rename on either side.
    expect(projects[0]?.id).toMatch(/^\d+$/);
    expect(typeof projects[0]?.name).toBe('string');
    expect(projects[0]?.archived).toBe(false);
    // `next_page: null` must become an explicit end-of-results, not undefined.
    expect(pagination).toEqual({ hasMore: false, nextCursor: null, pageSize: 50, returned: projects.length });
  });

  it('parses a real task list, including nulls Asana returns for empty fields', async () => {
    const { connector } = connectorFor(fixture('list_project_tasks'));

    const result = await connector.execute({
      actionId: 'asana.list_project_tasks',
      input: { projectId: '1217300991109390' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { tasks } = result.data as {
      tasks: Array<{ id: string; name: string; completed: boolean; dueOn: string | null }>;
    };

    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.id).toMatch(/^\d+$/);
      expect(typeof task.completed).toBe('boolean');
      // Absent due dates arrive as null, and must survive as null rather than
      // becoming undefined or the empty string.
      expect(task.dueOn === null || /^\d{4}-\d{2}-\d{2}$/.test(task.dueOn)).toBe(true);
    }
  });

  it('parses a real single task', async () => {
    const { connector } = connectorFor(fixture('get_task'));

    const result = await connector.execute({
      actionId: 'asana.get_task',
      input: { taskId: '1217301043120150' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { task } = result.data as { task: { id: string; name: string; url: string | null } };
    expect(task.id).toMatch(/^\d+$/);
    expect(task.name.length).toBeGreaterThan(0);
  });

  it('parses the real authenticated user and workspaces', async () => {
    const { connector } = connectorFor(fixture('get_current_user'));

    const result = await connector.execute({ actionId: 'asana.get_current_user', input: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { user, workspaces } = result.data as {
      user: { id: string; name: string; email: string | null };
      workspaces: Array<{ id: string; name: string }>;
    };

    expect(user.id).toMatch(/^\d+$/);
    expect(workspaces.length).toBeGreaterThan(0);
    // Proof the fixture itself carries no real address.
    expect(user.email).toBe('builder@example.com');
  });

  it('parses real comment stories', async () => {
    const { connector } = connectorFor(fixture('list_comments'));

    const result = await connector.execute({
      actionId: 'asana.list_comments',
      input: { taskId: '1217301043120150' },
    });

    expect(result.ok).toBe(true);
  });

  it('normalizes a real Asana error body', async () => {
    const fake = createFakeFetch([{ status: 404, body: fixture('error_not_found') }]);
    const connector = createConnector({
      config: buildConfig({ ASANA_MODE: 'live', ASANA_ACCESS_TOKEN: 'test-token' }),
      fetch: fake.fetch,
    });

    const result = await connector.execute({
      actionId: 'asana.get_task',
      input: { taskId: '000000000000000' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('ASANA_NOT_FOUND');
    // Asana's own wording is preserved for diagnosis, separately from the
    // connector's stable code and its own guidance.
    expect(result.error.message).toContain('Not a recognized ID');
    // "task: Not a recognized ID: 0" is split so a console can point at the
    // offending field rather than printing prose.
    expect(result.error.details[0]).toMatchObject({ field: 'task' });
    // This error carries no `phrase` — that field is optional in Asana's own
    // payloads, and the connector must leave it null rather than inventing one.
    expect(result.error.providerPhrase).toBeNull();
    expect(result.error.requestId).toMatch(/^req_/);
  });

  it('reads every fixture without a credential in it', () => {
    const names = [
      'list_projects',
      'list_project_tasks',
      'get_task',
      'get_current_user',
      'list_users',
      'list_project_sections',
      'list_comments',
      'error_not_found',
    ];

    for (const name of names) {
      const raw = JSON.stringify(fixture(name));
      // A PAT looks like `1/1234567890:hexhex…`, and no fixture may contain one.
      expect(raw).not.toMatch(/1\/\d{10,}:[0-9a-f]{8,}/);
      expect(raw.toLowerCase()).not.toContain('bearer ');
      expect(raw).not.toMatch(/gsk_[A-Za-z0-9]{20,}/);
    }
  });
});
