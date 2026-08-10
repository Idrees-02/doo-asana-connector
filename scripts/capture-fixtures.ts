/**
 * Recapture the Asana fixtures.
 *
 *   npm run fixtures:capture
 *
 * Read-only by construction: every request is a GET, so running this can never
 * modify a workspace no matter what is configured.
 *
 * Emails are redacted and photo URLs dropped; nothing else is touched, because
 * the point of a fixture is to be what the provider actually said. Fixtures are
 * committed, so review the diff — `tests/integration/fixtures.test.ts` fails if
 * a credential ever appears in one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../src/config.js';

const OUT_DIR = fileURLToPath(new URL('../fixtures/asana/', import.meta.url));

async function main(): Promise<void> {
  const config = getConfig();
  const token = config.accessToken;

  if (token === undefined) {
    console.error('Set ASANA_ACCESS_TOKEN in .env first. Nothing was written.');
    process.exit(1);
  }

  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${config.asana.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // A failed capture must not silently overwrite a good fixture with an
    // error body — except where the error body is the point.
    if (!response.ok && !path.includes('000000000000000')) {
      throw new Error(`${path} → ${response.status}`);
    }
    return response.json();
  };

  const me = (await get('/users/me?opt_fields=gid,name,email,workspaces.name')) as {
    data?: { workspaces?: Array<{ gid: string }> };
  };
  const workspace = me.data?.workspaces?.[0]?.gid;
  if (workspace === undefined) throw new Error('The credential can see no workspace.');

  const projects = (await get(
    `/projects?workspace=${workspace}&opt_fields=gid,name,archived,color,notes,permalink_url,created_at,modified_at,workspace.name,owner.name&limit=50`,
  )) as { data?: Array<{ gid: string }> };
  const project = projects.data?.[0]?.gid;
  if (project === undefined) throw new Error('The workspace has no project to capture.');

  const tasks = (await get(
    `/tasks?project=${project}&opt_fields=gid,name,completed,due_on,assignee.name,permalink_url,created_at,modified_at,notes&limit=50`,
  )) as { data?: Array<{ gid: string }> };
  const task = tasks.data?.[0]?.gid;

  const captured: Record<string, unknown> = {
    get_current_user: me,
    list_projects: projects,
    list_project_tasks: tasks,
    list_users: await get(`/users?workspace=${workspace}&opt_fields=gid,name,email`),
    list_project_sections: await get(`/projects/${project}/sections?opt_fields=gid,name,created_at`),
    error_not_found: await get('/tasks/000000000000000'),
  };

  if (task !== undefined) {
    captured['get_task'] = await get(
      `/tasks/${task}?opt_fields=gid,name,completed,due_on,notes,assignee.name,projects.name,permalink_url,created_at,modified_at`,
    );
    captured['list_comments'] = await get(
      `/tasks/${task}/stories?opt_fields=gid,text,created_at,created_by.name,type,resource_subtype&limit=20`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, payload] of Object.entries(captured)) {
    writeFileSync(`${OUT_DIR}${name}.json`, `${JSON.stringify(redact(payload), null, 2)}\n`);
  }

  console.log(`Captured ${Object.keys(captured).length} fixtures into fixtures/asana/.`);
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

function redact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(redact);

  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        if (key === 'email') return [key, 'builder@example.com'];
        if (key === 'photo') return [key, null];
        return [key, redact(value)];
      }),
    );
  }

  // Addresses also appear inside free text such as comment bodies.
  if (typeof node === 'string') return node.replace(EMAIL, 'builder@example.com');

  return node;
}

main().catch((error: unknown) => {
  console.error('Capture failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
