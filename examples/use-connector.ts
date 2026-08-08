/**
 * Using the connector as a library.
 *
 *   npx tsx examples/use-connector.ts
 *
 * Runs against the in-memory demo API when no credentials are configured, so
 * it works on a fresh clone. With a PAT in .env it runs against real Asana —
 * the code is identical either way, which is the point of the design.
 */

import { bootstrap } from '../src/index.js';

async function main(): Promise<void> {
  const { connector, config } = bootstrap({ silent: true });

  console.log(`Mode: ${config.mode} — ${config.modeReason}\n`);

  /* ------------------------------------------------------------------ */
  /* Connection test — read-only, no side effects                        */
  /* ------------------------------------------------------------------ */

  const connection = await connector.testConnection();
  console.log('testConnection');
  console.log(`  connected: ${connection.connected}`);
  console.log(`  account:   ${connection.account?.name ?? 'none'}`);
  console.log(`  auth:      ${connection.auth.type} (${connection.auth.fingerprint ?? 'none'})`);
  console.log(`  latency:   ${connection.latencyMs}ms\n`);

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  const projects = await connector.execute({
    actionId: 'asana.list_projects',
    input: { limit: 5 },
  });

  if (!projects.ok) {
    console.error(`Failed: ${projects.error.code} — ${projects.error.guidance}`);
    return;
  }

  const projectList = (projects.data as { projects: Array<{ id: string; name: string | null }> })
    .projects;

  console.log(`asana.list_projects — ${projectList.length} project(s)`);
  for (const project of projectList) {
    console.log(`  ${project.id}  ${project.name ?? 'untitled'}`);
  }

  const firstProject = projectList[0];
  if (firstProject === undefined) return;

  const tasks = await connector.execute({
    actionId: 'asana.list_project_tasks',
    input: { projectId: firstProject.id, limit: 5, includeCompleted: false },
  });

  if (tasks.ok) {
    const taskList = (tasks.data as { tasks: Array<{ id: string; name: string | null }> }).tasks;
    console.log(`\nasana.list_project_tasks — ${taskList.length} open task(s)`);
    for (const task of taskList) {
      console.log(`  ${task.id}  ${task.name ?? 'untitled'}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Writes — note the approval gate                                     */
  /* ------------------------------------------------------------------ */

  console.log('\nWrite safety');

  // Without `approved: true` this is refused before any network call.
  const refused = await connector.execute({
    actionId: 'asana.create_task',
    input: { projectId: firstProject.id, name: 'Never created' },
  });
  console.log(`  without approval: ${refused.ok ? 'created (BUG)' : refused.error.code}`);

  // With approval, and an idempotency key so a retry cannot duplicate.
  const created = await connector.execute({
    actionId: 'asana.create_task',
    input: {
      projectId: firstProject.id,
      name: 'Task created by the example script',
      notes: 'Demonstrates the approval gate and idempotency key.',
    },
    approved: true,
    idempotencyKey: 'example-script-001',
  });

  if (!created.ok) {
    console.log(`  with approval:    ${created.error.code} — ${created.error.guidance}`);
    return;
  }

  const task = (created.data as { task: { id: string; name: string | null } }).task;
  console.log(`  with approval:    created ${task.id}`);

  // Same key again — replays instead of creating a second task.
  const replay = await connector.execute({
    actionId: 'asana.create_task',
    input: {
      projectId: firstProject.id,
      name: 'Task created by the example script',
      notes: 'Demonstrates the approval gate and idempotency key.',
    },
    approved: true,
    idempotencyKey: 'example-script-001',
  });

  const replayedId = replay.ok ? (replay.data as { task: { id: string } }).task.id : 'error';
  console.log(`  same key again:   ${replayedId === task.id ? 'replayed (no duplicate)' : 'DUPLICATED (BUG)'}`);

  /* ------------------------------------------------------------------ */
  /* Partial update — null clears, absent leaves alone                   */
  /* ------------------------------------------------------------------ */

  const updated = await connector.execute({
    actionId: 'asana.update_task',
    input: { taskId: task.id, patch: { notes: 'Revised.', dueOn: null } },
    approved: true,
  });

  if (updated.ok) {
    const fields = (updated.data as { updatedFields: string[] }).updatedFields;
    console.log(`\nasana.update_task — sent only: ${fields.join(', ')}`);
    console.log('  (dueOn: null clears the field; unlisted fields are untouched)');
  }

  const commented = await connector.execute({
    actionId: 'asana.add_comment',
    input: { taskId: task.id, text: 'Comment from the example script.' },
    approved: true,
  });

  if (commented.ok) {
    const comment = (commented.data as { comment: { id: string } }).comment;
    console.log(`\nasana.add_comment — posted ${comment.id}`);
  }

  console.log('\nEvery response carried a requestId, timing and retry classification.');
  console.log(`Last request: ${commented.meta.requestId} (${commented.meta.durationMs}ms)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
