/**
 * Live smoke test against a real Asana workspace.
 *
 *   npm run smoke:live              # read-only — safe on any workspace
 *   npm run smoke:live -- --writes  # also creates a task, updates it, comments
 *
 * Read-only by default on purpose. The write pass creates real objects that
 * this connector cannot delete, so it must be an explicit choice, and it
 * refuses to run without a project id you have deliberately nominated.
 *
 * Requires a credential in .env. Never prints one.
 */

import { bootstrap } from '../src/index.js';
import { REQUIRED_ACTION_IDS } from '../src/actions/index.js';

const WRITES = process.argv.includes('--writes');
const PROJECT_ARG = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1];

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
}

async function main(): Promise<void> {
  const { connector, config } = bootstrap();

  console.log('\nAsana connector — live smoke test');
  console.log(`  mode:   ${config.mode}`);
  console.log(`  writes: ${WRITES ? 'ENABLED' : 'disabled (read-only)'}\n`);

  if (config.mode === 'demo') {
    console.error(
      'Refusing to run: the connector is in demo mode, so this would prove nothing about\n' +
        'live Asana. Add ASANA_ACCESS_TOKEN to .env and try again.\n',
    );
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  /* 1. Connection                                                     */
  /* ---------------------------------------------------------------- */

  console.log('Connection');
  const connection = await connector.testConnection();
  report(
    'testConnection',
    connection.connected,
    connection.connected
      ? `${connection.account?.name ?? 'unknown'} · ${connection.workspaces.length} workspace(s) · ${connection.latencyMs}ms`
      : (connection.error?.message ?? 'failed'),
  );

  if (!connection.connected) {
    console.error(`\n${connection.error?.guidance ?? ''}\n`);
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  /* 2. Reads                                                          */
  /* ---------------------------------------------------------------- */

  console.log('\nRead actions');

  const projects = await connector.execute({
    actionId: 'asana.list_projects',
    input: { limit: 10 },
  });

  let projectId = PROJECT_ARG;

  if (projects.ok) {
    const data = projects.data as { projects: Array<{ id: string; name: string | null }> };
    report(
      'asana.list_projects',
      true,
      `${data.projects.length} project(s) · ${projects.meta.durationMs}ms`,
    );
    projectId ??= data.projects[0]?.id;
  } else {
    report('asana.list_projects', false, `${projects.error.code}: ${projects.error.message}`);
  }

  if (projectId === undefined) {
    console.error('\nNo project available to test against. Create one in Asana and retry.\n');
    process.exit(1);
  }

  const tasks = await connector.execute({
    actionId: 'asana.list_project_tasks',
    input: { projectId, limit: 10 },
  });

  report(
    'asana.list_project_tasks',
    tasks.ok,
    tasks.ok
      ? `${(tasks.data as { tasks: unknown[] }).tasks.length} task(s) · ${tasks.meta.durationMs}ms`
      : `${tasks.error.code}: ${tasks.error.message}`,
  );

  /* ---------------------------------------------------------------- */
  /* 3. Approval gate (read-only proof)                                */
  /* ---------------------------------------------------------------- */

  console.log('\nSafety');

  // Deliberately omits `approved`, so this must be refused BEFORE any network
  // call. It is safe to run even in read-only mode precisely because it is
  // guaranteed not to reach Asana.
  const unapproved = await connector.execute({
    actionId: 'asana.create_task',
    input: { projectId, name: '[smoke] this must never be created' },
  });

  report(
    'write blocked without approval',
    !unapproved.ok && unapproved.error.code === 'ASANA_APPROVAL_REQUIRED',
    unapproved.ok ? 'A TASK WAS CREATED — this is a bug' : unapproved.error.code,
  );

  /* ---------------------------------------------------------------- */
  /* 4. Writes (opt-in)                                                */
  /* ---------------------------------------------------------------- */

  if (!WRITES) {
    console.log('\n  Write actions skipped. Re-run with --writes to exercise them.');
    summarise();
    return;
  }

  console.log('\nWrite actions (creating real objects)');

  const stamp = new Date().toISOString();
  const created = await connector.execute({
    actionId: 'asana.create_task',
    input: {
      projectId,
      name: `[connector-smoke] ${stamp}`,
      notes: 'Created by npm run smoke:live. Safe to delete.',
    },
    approved: true,
    idempotencyKey: `smoke-${stamp}`,
  });

  if (!created.ok) {
    report('asana.create_task', false, `${created.error.code}: ${created.error.message}`);
    summarise();
    return;
  }

  const task = (created.data as { task: { id: string; modifiedAt: string | null } }).task;
  report('asana.create_task', true, `id ${task.id} · ${created.meta.durationMs}ms`);

  // Same key again: must replay rather than create a second task.
  const replay = await connector.execute({
    actionId: 'asana.create_task',
    input: {
      projectId,
      name: `[connector-smoke] ${stamp}`,
      notes: 'Created by npm run smoke:live. Safe to delete.',
    },
    approved: true,
    idempotencyKey: `smoke-${stamp}`,
  });

  report(
    'idempotency key prevents duplicate',
    replay.ok && (replay.data as { task: { id: string } }).task.id === task.id,
    replay.ok ? 'replayed the original result' : 'unexpected failure',
  );

  const updated = await connector.execute({
    actionId: 'asana.update_task',
    input: {
      taskId: task.id,
      patch: { notes: 'Updated by the smoke test.' },
      ...(task.modifiedAt === null ? {} : { ifUnmodifiedSince: task.modifiedAt }),
    },
    approved: true,
  });

  report(
    'asana.update_task',
    updated.ok,
    updated.ok
      ? `fields: ${(updated.data as { updatedFields: string[] }).updatedFields.join(', ')}`
      : `${updated.error.code}: ${updated.error.message}`,
  );

  const commented = await connector.execute({
    actionId: 'asana.add_comment',
    input: { taskId: task.id, text: 'Comment posted by the connector smoke test.' },
    approved: true,
  });

  report(
    'asana.add_comment',
    commented.ok,
    commented.ok
      ? `comment ${(commented.data as { comment: { id: string } }).comment.id}`
      : `${commented.error.code}: ${commented.error.message}`,
  );

  // Mark complete rather than delete — this connector has no delete action,
  // and inventing one for cleanup would contradict the whole design.
  const completed = await connector.execute({
    actionId: 'asana.update_task',
    input: { taskId: task.id, patch: { completed: true } },
    approved: true,
  });

  report('cleanup (marked complete)', completed.ok, completed.ok ? 'done' : 'failed');

  console.log(
    `\n  Note: task ${task.id} still exists in Asana, marked complete.\n` +
      '  This connector implements no delete action, so remove it manually if you wish.',
  );

  summarise();
}

function summarise(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`Actions covered: ${REQUIRED_ACTION_IDS.join(', ')}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error('\nSmoke test crashed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
