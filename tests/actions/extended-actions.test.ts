/**
 * Coverage for the 30 extended actions.
 *
 * Every action is invoked through the real pipeline against the in-memory
 * Asana API, so this exercises validation, the approval gate, the client, the
 * mappers and error normalization — not a mock of them.
 *
 * The final block is the one that matters most: it asserts that EVERY
 * registered action can actually execute, so a new action cannot be added to
 * the registry without a working demo path behind it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config.js';
import { createConnector, type AsanaConnector } from '../../src/connector.js';
import { createDemoFetch, DemoStore } from '../../src/demo/demo-api.js';
import { ACTIONS } from '../../src/actions/index.js';
import { ERROR_CODES } from '../../src/errors/codes.js';
import type { ConnectorExecutionResult } from '../../src/runtime/execute.js';

const LAUNCH = '900000000001001';
const ENGINEERING = '900000000001002';
const WORKSPACE = '900000000000001';
const SECTION_TODO = '900000000005001';
const TAG_BLOCKER = '900000000006001';

let store: DemoStore;
let connector: AsanaConnector;

beforeEach(() => {
  store = new DemoStore();
  connector = createConnector({
    config: buildConfig({ ASANA_MODE: 'demo' }),
    fetch: createDemoFetch(store, { sleep: () => Promise.resolve(), random: () => 0 }),
  });
});

function ok(result: ConnectorExecutionResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`Expected success but got ${result.error.code}: ${result.error.message}`);
  }
  return result.data as Record<string, unknown>;
}

function fail(result: ConnectorExecutionResult) {
  if (result.ok) throw new Error('Expected failure but the action succeeded.');
  return result.error;
}

/** Run an action with approval, since every write requires it. */
function run(actionId: string, input: unknown) {
  return connector.execute({ actionId, input, approved: true });
}

function firstTaskId(): string {
  return store.listTasks(LAUNCH, null)[0]!.gid;
}

/* ========================================================================== */
/* Tasks — reads                                                               */
/* ========================================================================== */

describe('extended task reads', () => {
  it('asana.get_task returns a single task', async () => {
    const data = ok(await run('asana.get_task', { taskId: firstTaskId() }));
    expect((data['task'] as { name: string }).name).toBe('Prepare launch documentation');
  });

  it('asana.get_task reports a clean 404 for an unknown id', async () => {
    const error = fail(await run('asana.get_task', { taskId: '111111111111111' }));
    expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(error.retryable).toBe(false);
  });

  it('asana.list_tasks requires a filter, matching Asana', async () => {
    // Asana rejects an unfiltered /tasks call; we reject it before the network.
    const error = fail(await run('asana.list_tasks', {}));
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toMatch(/project, section, tag, or assignee/i);
  });

  it('asana.list_tasks filters by project', async () => {
    const data = ok(await run('asana.list_tasks', { project: LAUNCH }));
    expect((data['tasks'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('asana.list_tasks accepts assignee combined with workspace', async () => {
    const data = ok(await run('asana.list_tasks', { assignee: 'me', workspace: WORKSPACE }));
    expect(Array.isArray(data['tasks'])).toBe(true);
  });

  it('asana.search_tasks finds tasks by text and reports it is not paginated', async () => {
    const data = ok(await run('asana.search_tasks', { workspace: WORKSPACE, text: 'launch' }));

    expect((data['tasks'] as Array<{ name: string }>).some((t) => /launch/i.test(t.name))).toBe(true);
    // Honest about Asana's unstable search ordering rather than offering a
    // cursor that cannot be relied on.
    expect(data['paginated']).toBe(false);
  });

  it('asana.list_subtasks returns an empty list before any subtask exists', async () => {
    const data = ok(await run('asana.list_subtasks', { taskId: firstTaskId() }));
    expect(data['subtasks']).toEqual([]);
  });
});

/* ========================================================================== */
/* Tasks — mutations                                                           */
/* ========================================================================== */

describe('extended task mutations', () => {
  it('asana.complete_task and asana.reopen_task round-trip', async () => {
    const taskId = firstTaskId();

    const completed = ok(await run('asana.complete_task', { taskId }));
    expect((completed['task'] as { completed: boolean }).completed).toBe(true);

    const reopened = ok(await run('asana.reopen_task', { taskId }));
    expect((reopened['task'] as { completed: boolean }).completed).toBe(false);
  });

  it('asana.assign_task assigns and unassigns', async () => {
    const taskId = firstTaskId();

    const assigned = ok(await run('asana.assign_task', { taskId, assignee: 'me' }));
    expect((assigned['task'] as { assignee: unknown }).assignee).not.toBeNull();

    // null is the documented way to clear the assignee.
    const cleared = ok(await run('asana.assign_task', { taskId, assignee: null }));
    expect((cleared['task'] as { assignee: unknown }).assignee).toBeNull();
  });

  it('asana.set_task_due_date sets and clears the due date', async () => {
    const taskId = firstTaskId();

    const set = ok(await run('asana.set_task_due_date', { taskId, dueOn: '2026-12-01' }));
    expect((set['task'] as { dueOn: string }).dueOn).toBe('2026-12-01');

    const cleared = ok(await run('asana.set_task_due_date', { taskId, dueOn: null }));
    expect((cleared['task'] as { dueOn: string | null }).dueOn).toBeNull();
  });

  it('asana.set_task_due_date rejects dueOn and dueAt together', async () => {
    const error = fail(
      await run('asana.set_task_due_date', {
        taskId: firstTaskId(),
        dueOn: '2026-12-01',
        dueAt: '2026-12-01T10:00:00Z',
      }),
    );
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('asana.set_task_description replaces the notes', async () => {
    const data = ok(
      await run('asana.set_task_description', { taskId: firstTaskId(), notes: 'Rewritten.' }),
    );
    expect((data['task'] as { notes: string }).notes).toBe('Rewritten.');
  });

  it('the mutations do not disturb unrelated fields', async () => {
    // The whole point of sending only the named field.
    const taskId = firstTaskId();
    const before = store.getTask(taskId)!.name;

    await run('asana.complete_task', { taskId });

    expect(store.getTask(taskId)?.name).toBe(before);
  });
});

/* ========================================================================== */
/* Tasks — creates and associations                                            */
/* ========================================================================== */

describe('subtasks and associations', () => {
  it('asana.create_subtask creates a child task', async () => {
    const taskId = firstTaskId();
    const data = ok(await run('asana.create_subtask', { taskId, name: 'Draft the outline' }));

    expect((data['subtask'] as { name: string }).name).toBe('Draft the outline');
    expect(data['parentTaskId']).toBe(taskId);
    expect(store.listSubtasks(taskId)).toHaveLength(1);
  });

  it('asana.create_subtask requires approval', async () => {
    const taskId = firstTaskId();
    const error = fail(
      await connector.execute({
        actionId: 'asana.create_subtask',
        input: { taskId, name: 'Should not exist' },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
    expect(store.listSubtasks(taskId)).toHaveLength(0);
  });

  it('asana.add_task_to_project and remove are reversible and idempotent', async () => {
    const taskId = firstTaskId();

    ok(await run('asana.add_task_to_project', { taskId, projectId: ENGINEERING }));
    expect(store.getTask(taskId)?.projects.some((p) => p.gid === ENGINEERING)).toBe(true);

    // Repeating is a no-op, not a duplicate.
    ok(await run('asana.add_task_to_project', { taskId, projectId: ENGINEERING }));
    expect(store.getTask(taskId)?.projects.filter((p) => p.gid === ENGINEERING)).toHaveLength(1);

    ok(await run('asana.remove_task_from_project', { taskId, projectId: ENGINEERING }));
    expect(store.getTask(taskId)?.projects.some((p) => p.gid === ENGINEERING)).toBe(false);
  });

  it('removing a task from a project does NOT delete the task', async () => {
    // The distinction that justifies having no delete action at all.
    const taskId = firstTaskId();

    ok(await run('asana.remove_task_from_project', { taskId, projectId: LAUNCH }));

    expect(store.getTask(taskId)).toBeDefined();
  });
});

/* ========================================================================== */
/* Projects and sections                                                       */
/* ========================================================================== */

describe('projects', () => {
  it('asana.get_project returns a project', async () => {
    const data = ok(await run('asana.get_project', { projectId: LAUNCH }));
    expect((data['project'] as { name: string }).name).toBe('Product Launch');
  });

  it('asana.create_project creates one and requires approval', async () => {
    const input = { name: 'Q4 Launch', workspace: WORKSPACE };

    expect(fail(await connector.execute({ actionId: 'asana.create_project', input })).code).toBe(
      ERROR_CODES.APPROVAL_REQUIRED,
    );

    const data = ok(await run('asana.create_project', input));
    expect((data['project'] as { name: string }).name).toBe('Q4 Launch');
    expect(data['created']).toBe(true);
  });

  it('asana.update_project sends only the named fields', async () => {
    const data = ok(await run('asana.update_project', { projectId: LAUNCH, patch: { name: 'Renamed' } }));
    expect(data['updatedFields']).toEqual(['name']);
  });

  it('asana.update_project rejects an empty patch', async () => {
    const error = fail(await run('asana.update_project', { projectId: LAUNCH, patch: {} }));
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('asana.list_project_members returns members with access levels', async () => {
    const data = ok(await run('asana.list_project_members', { projectId: LAUNCH }));
    const members = data['members'] as Array<{ user: { name: string } | null; accessLevel: string }>;

    expect(members.length).toBeGreaterThan(0);
    expect(members[0]?.accessLevel).toBeTypeOf('string');
  });

  it('asana.add_project_member and remove are reversible', async () => {
    const before = store.listMemberships(ENGINEERING).length;

    ok(await run('asana.add_project_member', { projectId: ENGINEERING, member: 'me' }));
    expect(store.listMemberships(ENGINEERING).length).toBe(before + 1);

    ok(await run('asana.remove_project_member', { projectId: ENGINEERING, member: 'me' }));
    expect(store.listMemberships(ENGINEERING).length).toBe(before);
  });
});

describe('sections', () => {
  it('asana.list_project_sections returns the project columns', async () => {
    const data = ok(await run('asana.list_project_sections', { projectId: LAUNCH }));
    const sections = data['sections'] as Array<{ name: string }>;

    expect(sections.map((s) => s.name)).toContain('In Progress');
  });

  it('asana.create_section adds a column', async () => {
    const data = ok(await run('asana.create_section', { projectId: LAUNCH, name: 'In Review' }));
    expect((data['section'] as { name: string }).name).toBe('In Review');
  });

  it('asana.create_section rejects an empty name, as Asana does', async () => {
    const error = fail(await run('asana.create_section', { projectId: LAUNCH, name: '   ' }));
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('asana.update_section renames it', async () => {
    const data = ok(await run('asana.update_section', { sectionId: SECTION_TODO, name: 'Queued' }));
    expect((data['section'] as { name: string }).name).toBe('Queued');
  });

  it('asana.move_task_to_section moves a task', async () => {
    const taskId = firstTaskId();
    ok(await run('asana.move_task_to_section', { sectionId: SECTION_TODO, taskId }));

    expect(store.tasksInSection(SECTION_TODO).map((t) => t.gid)).toContain(taskId);
  });
});

/* ========================================================================== */
/* Users, comments, tags                                                       */
/* ========================================================================== */

describe('users', () => {
  it('asana.get_current_user returns the account and its workspaces', async () => {
    const data = ok(await run('asana.get_current_user', {}));

    expect((data['user'] as { name: string }).name).toBe('Idrees Khaled');
    expect((data['workspaces'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('asana.get_user resolves by gid and by email', async () => {
    const byGid = ok(await run('asana.get_user', { userId: '900000000000102' }));
    expect((byGid['user'] as { name: string }).name).toBe('Layla Hassan');

    const byEmail = ok(await run('asana.get_user', { userId: 'omar@example.invalid' }));
    expect((byEmail['user'] as { name: string }).name).toBe('Omar Nasser');
  });

  it('asana.list_users lists the directory', async () => {
    const data = ok(await run('asana.list_users', { workspace: WORKSPACE }));
    expect((data['users'] as unknown[]).length).toBe(3);
  });
});

describe('comments', () => {
  it('asana.list_comments excludes system stories by default', async () => {
    const taskId = firstTaskId();
    const data = ok(await run('asana.list_comments', { taskId }));
    const comments = data['comments'] as Array<{ type: string }>;

    expect(comments.length).toBeGreaterThan(0);
    expect(comments.every((c) => c.type === 'comment')).toBe(true);
  });

  it('asana.list_comments sees a comment added through asana.add_comment', async () => {
    const taskId = firstTaskId();
    await run('asana.add_comment', { taskId, text: 'Round-trip check.' });

    const data = ok(await run('asana.list_comments', { taskId }));
    const texts = (data['comments'] as Array<{ text: string }>).map((c) => c.text);

    expect(texts).toContain('Round-trip check.');
  });
});

describe('tags', () => {
  it('asana.list_tags returns workspace tags', async () => {
    const data = ok(await run('asana.list_tags', { workspace: WORKSPACE }));
    expect((data['tags'] as Array<{ name: string }>).map((t) => t.name)).toContain('launch-blocker');
  });

  it('asana.create_tag creates one and requires approval', async () => {
    const input = { name: 'new-tag', workspace: WORKSPACE };

    expect(fail(await connector.execute({ actionId: 'asana.create_tag', input })).code).toBe(
      ERROR_CODES.APPROVAL_REQUIRED,
    );

    const data = ok(await run('asana.create_tag', input));
    expect((data['tag'] as { name: string }).name).toBe('new-tag');
  });

  it('asana.add_tag_to_task and remove are reversible and idempotent', async () => {
    const taskId = firstTaskId();

    ok(await run('asana.add_tag_to_task', { taskId, tagId: TAG_BLOCKER }));
    expect(store.getTask(taskId)?.tags.some((t) => t.gid === TAG_BLOCKER)).toBe(true);

    // Repeating adds no duplicate.
    ok(await run('asana.add_tag_to_task', { taskId, tagId: TAG_BLOCKER }));
    expect(store.getTask(taskId)?.tags.filter((t) => t.gid === TAG_BLOCKER)).toHaveLength(1);

    ok(await run('asana.remove_tag_from_task', { taskId, tagId: TAG_BLOCKER }));
    expect(store.getTask(taskId)?.tags.some((t) => t.gid === TAG_BLOCKER)).toBe(false);
  });

  it('removing a tag from a task does NOT delete the tag', async () => {
    const taskId = firstTaskId();
    await run('asana.add_tag_to_task', { taskId, tagId: TAG_BLOCKER });
    await run('asana.remove_tag_from_task', { taskId, tagId: TAG_BLOCKER });

    expect(store.getTag(TAG_BLOCKER)).toBeDefined();
  });
});

/* ========================================================================== */
/* Registry-wide guarantees                                                    */
/* ========================================================================== */

describe('every registered action is executable', () => {
  /**
   * Minimal valid input per action.
   *
   * Building this by hand is deliberate: it forces someone adding an action to
   * think about what a caller must supply, and it means a new action cannot be
   * registered without a working end-to-end path.
   */
  const INPUTS: Record<string, unknown> = {
    'asana.list_projects': {},
    'asana.list_project_tasks': { projectId: LAUNCH },
    'asana.create_task': { projectId: LAUNCH, name: 'Coverage task' },
    'asana.update_task': { taskId: '__TASK__', patch: { name: 'Coverage rename' } },
    'asana.add_comment': { taskId: '__TASK__', text: 'Coverage comment' },
    'asana.get_task': { taskId: '__TASK__' },
    'asana.list_tasks': { project: LAUNCH },
    'asana.search_tasks': { workspace: WORKSPACE, text: 'launch' },
    'asana.complete_task': { taskId: '__TASK__' },
    'asana.reopen_task': { taskId: '__TASK__' },
    'asana.assign_task': { taskId: '__TASK__', assignee: 'me' },
    'asana.set_task_due_date': { taskId: '__TASK__', dueOn: '2026-12-01' },
    'asana.set_task_description': { taskId: '__TASK__', notes: 'Coverage notes' },
    'asana.create_subtask': { taskId: '__TASK__', name: 'Coverage subtask' },
    'asana.list_subtasks': { taskId: '__TASK__' },
    'asana.add_task_to_project': { taskId: '__TASK__', projectId: ENGINEERING },
    'asana.remove_task_from_project': { taskId: '__TASK__', projectId: ENGINEERING },
    'asana.get_project': { projectId: LAUNCH },
    'asana.create_project': { name: 'Coverage project', workspace: WORKSPACE },
    'asana.update_project': { projectId: LAUNCH, patch: { name: 'Coverage project rename' } },
    'asana.list_project_members': { projectId: LAUNCH },
    'asana.add_project_member': { projectId: LAUNCH, member: 'me' },
    'asana.remove_project_member': { projectId: LAUNCH, member: 'me' },
    'asana.list_project_sections': { projectId: LAUNCH },
    'asana.create_section': { projectId: LAUNCH, name: 'Coverage section' },
    'asana.update_section': { sectionId: SECTION_TODO, name: 'Coverage rename' },
    'asana.move_task_to_section': { sectionId: SECTION_TODO, taskId: '__TASK__' },
    'asana.get_current_user': {},
    'asana.get_user': { userId: '900000000000102' },
    'asana.list_users': { workspace: WORKSPACE },
    'asana.list_comments': { taskId: '__TASK__' },
    'asana.list_tags': { workspace: WORKSPACE },
    'asana.create_tag': { name: 'coverage-tag', workspace: WORKSPACE },
    'asana.add_tag_to_task': { taskId: '__TASK__', tagId: TAG_BLOCKER },
    'asana.remove_tag_from_task': { taskId: '__TASK__', tagId: TAG_BLOCKER },
  };

  it('has a sample input for all 35 actions', () => {
    // Fails loudly when an action is added without one, rather than skipping it.
    expect(Object.keys(INPUTS).sort()).toEqual(ACTIONS.map((a) => a.id).sort());
  });

  it.each(ACTIONS.map((a) => [a.id] as const))('%s executes successfully', async (actionId) => {
    const template = INPUTS[actionId];
    const input = JSON.parse(JSON.stringify(template).replace(/__TASK__/g, firstTaskId())) as unknown;

    const result = await connector.execute({ actionId, input, approved: true });

    if (!result.ok) {
      throw new Error(`${actionId} failed: ${result.error.code} — ${result.error.message}`);
    }
    expect(result.meta.actionId).toBe(actionId);
    expect(result.meta.requestId).toMatch(/^req_/);
  });

  it('refuses every write action without approval', async () => {
    const writes = ACTIONS.filter((a) => a.safety.write);

    for (const action of writes) {
      const template = INPUTS[action.id];
      const input = JSON.parse(
        JSON.stringify(template).replace(/__TASK__/g, firstTaskId()),
      ) as unknown;

      const result = await connector.execute({ actionId: action.id, input });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ERROR_CODES.APPROVAL_REQUIRED);
      }
    }
  });
});
