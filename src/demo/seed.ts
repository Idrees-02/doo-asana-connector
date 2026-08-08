/**
 * Demo seed data.
 *
 * Entirely synthetic. Names, ids and emails are invented; nothing here comes
 * from a real Asana workspace, and no production or customer data is used.
 *
 * Uses the project and task names specified by the assignment brief, plus
 * enough extra tasks that cursor pagination is genuinely exercised rather than
 * always fitting in one page.
 *
 * Ids use a `9xxxxxxxxxxxxxxx` prefix so a demo id is visually distinguishable
 * from a real Asana gid at a glance during review.
 */

export interface SeedUser {
  readonly gid: string;
  readonly name: string;
  readonly email: string;
}

export interface SeedWorkspace {
  readonly gid: string;
  readonly name: string;
  readonly is_organization: boolean;
}

export interface SeedProject {
  readonly gid: string;
  readonly name: string;
  readonly archived: boolean;
  readonly color: string | null;
  readonly notes: string;
  readonly permalink_url: string;
  readonly created_at: string;
  readonly modified_at: string;
  readonly due_on: string | null;
  readonly resource_type: 'project';
  readonly workspace: { gid: string; name: string; resource_type: 'workspace' };
  readonly owner: { gid: string; name: string; resource_type: 'user' } | null;
  readonly team: { gid: string; name: string; resource_type: 'team' } | null;
}

export interface DemoSeed {
  readonly user: SeedUser;
  readonly users: readonly SeedUser[];
  readonly workspace: SeedWorkspace;
  readonly projects: readonly SeedProject[];
  readonly tasks: readonly DemoSeedTask[];
  readonly stories: readonly DemoSeedStory[];
  readonly nextId: number;
}

export interface DemoSeedTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  completed_at: string | null;
  due_on: string | null;
  due_at: string | null;
  start_on: string | null;
  created_at: string;
  modified_at: string;
  permalink_url: string;
  resource_subtype: string;
  resource_type: 'task';
  num_subtasks: number;
  assignee: { gid: string; name: string; email: string; resource_type: 'user' } | null;
  workspace: { gid: string; name: string; resource_type: 'workspace' };
  parent: null;
  projects: Array<{ gid: string; name: string; resource_type: 'project' }>;
  tags: Array<{ gid: string; name: string; resource_type: 'tag' }>;
}

export interface DemoSeedStory {
  gid: string;
  taskGid: string;
  text: string;
  created_at: string;
  created_by: { gid: string; name: string; resource_type: 'user' };
  type: 'comment';
  resource_subtype: 'comment_added';
  resource_type: 'story';
  is_pinned: boolean;
}

const WORKSPACE: SeedWorkspace = {
  gid: '900000000000001',
  name: 'Demo Workspace',
  is_organization: true,
};

const USERS: readonly SeedUser[] = [
  { gid: '900000000000101', name: 'Idrees Khaled', email: 'idrees@example.invalid' },
  { gid: '900000000000102', name: 'Layla Hassan', email: 'layla@example.invalid' },
  { gid: '900000000000103', name: 'Omar Nasser', email: 'omar@example.invalid' },
];

// Named rather than indexed, so strict index checking does not turn every
// reference into `SeedUser | undefined`.
const ME = USERS[0]!;
const LAYLA = USERS[1]!;
const OMAR = USERS[2]!;

const wsRef = { gid: WORKSPACE.gid, name: WORKSPACE.name, resource_type: 'workspace' as const };

function project(
  gid: string,
  name: string,
  color: string,
  notes: string,
  archived = false,
): SeedProject {
  return {
    gid,
    name,
    archived,
    color,
    notes,
    permalink_url: `https://app.asana.com/0/${gid}`,
    created_at: '2026-05-02T09:00:00.000Z',
    modified_at: '2026-08-01T14:30:00.000Z',
    due_on: null,
    resource_type: 'project',
    workspace: wsRef,
    owner: { gid: ME.gid, name: ME.name, resource_type: 'user' },
    team: { gid: '900000000000201', name: 'Core Team', resource_type: 'team' },
  };
}

/** The four projects named in the assignment brief. */
const PROJECTS: readonly SeedProject[] = [
  project('900000000001001', 'Product Launch', 'light-orange', 'Coordination for the v1.0 launch.'),
  project('900000000001002', 'Engineering', 'dark-teal', 'Platform and integration work.'),
  project('900000000001003', 'Marketing', 'light-purple', 'Launch campaign and content.'),
  project('900000000001004', 'Operations', 'dark-brown', 'Internal process and tooling.'),
  project('900000000001005', 'Archived Pilot', 'light-grey', 'Superseded pilot programme.', true),
];

let taskCounter = 900_000_000_002_000;

function task(
  name: string,
  projectGid: string,
  options: {
    notes?: string;
    completed?: boolean;
    dueOn?: string | null;
    assignee?: SeedUser | null;
  } = {},
): DemoSeedTask {
  taskCounter += 1;
  const gid = String(taskCounter);
  const proj = PROJECTS.find((p) => p.gid === projectGid)!;
  const completed = options.completed ?? false;
  const assignee = options.assignee === undefined ? ME : options.assignee;

  return {
    gid,
    name,
    notes: options.notes ?? '',
    completed,
    completed_at: completed ? '2026-08-05T11:20:00.000Z' : null,
    due_on: options.dueOn === undefined ? null : options.dueOn,
    due_at: null,
    start_on: null,
    created_at: '2026-07-15T08:00:00.000Z',
    modified_at: '2026-08-06T16:45:00.000Z',
    permalink_url: `https://app.asana.com/0/${projectGid}/${gid}`,
    resource_subtype: 'default_task',
    resource_type: 'task',
    num_subtasks: 0,
    assignee:
      assignee === null
        ? null
        : { gid: assignee.gid, name: assignee.name, email: assignee.email, resource_type: 'user' },
    workspace: wsRef,
    parent: null,
    projects: [{ gid: proj.gid, name: proj.name, resource_type: 'project' }],
    tags: [],
  };
}

const LAUNCH = '900000000001001';
const ENGINEERING = '900000000001002';
const MARKETING = '900000000001003';
const OPERATIONS = '900000000001004';

/** The five tasks named in the brief, plus enough others to page through. */
const TASKS: readonly DemoSeedTask[] = [
  task('Prepare launch documentation', LAUNCH, {
    notes: 'Write the README, authentication guide and known limitations.',
    dueOn: '2026-08-20',
  }),
  task('Test Asana connector', ENGINEERING, {
    notes: 'Run all five actions against a sandbox workspace.',
    dueOn: '2026-08-18',
    assignee: LAYLA,
  }),
  task('Validate MCP endpoint', ENGINEERING, {
    notes: 'Confirm the adapter exposes exactly the connector action list.',
    dueOn: '2026-08-19',
  }),
  task('Review API schemas', ENGINEERING, {
    notes: 'Check the generated JSON Schema matches runtime validation.',
    completed: true,
    assignee: OMAR,
  }),
  task('Prepare final demo', LAUNCH, {
    notes: 'Walk through the console end to end.',
    dueOn: '2026-08-22',
  }),

  task('Draft launch announcement', MARKETING, { dueOn: '2026-08-21', assignee: LAYLA }),
  task('Schedule social campaign', MARKETING, { assignee: LAYLA }),
  task('Update pricing page', MARKETING, { completed: true }),
  task('Brief the support team', OPERATIONS, { dueOn: '2026-08-25' }),
  task('Rotate API credentials', OPERATIONS, {
    notes: 'Quarterly rotation. Never commit the new values.',
    dueOn: '2026-09-01',
    assignee: OMAR,
  }),
  task('Audit rate-limit handling', ENGINEERING, { assignee: null }),
  task('Add pagination to the projects view', ENGINEERING, { completed: true }),
  task('Write error-normalization tests', ENGINEERING, { dueOn: '2026-08-17' }),
  task('Set up CI secret scanning', OPERATIONS, { completed: true }),
  task('Collect launch feedback', LAUNCH, { assignee: LAYLA }),
];

const STORIES: readonly DemoSeedStory[] = [
  {
    gid: '900000000003001',
    taskGid: TASKS[0]!.gid,
    text: 'Started on the authentication section — the PAT flow is documented.',
    created_at: '2026-08-06T09:15:00.000Z',
    created_by: { gid: ME.gid, name: ME.name, resource_type: 'user' },
    type: 'comment',
    resource_subtype: 'comment_added',
    resource_type: 'story',
    is_pinned: false,
  },
  {
    gid: '900000000003002',
    taskGid: TASKS[1]!.gid,
    text: 'All five actions pass against the sandbox. Rate-limit path still to verify.',
    created_at: '2026-08-07T13:40:00.000Z',
    created_by: { gid: LAYLA.gid, name: LAYLA.name, resource_type: 'user' },
    type: 'comment',
    resource_subtype: 'comment_added',
    resource_type: 'story',
    is_pinned: false,
  },
];

export const DEMO_SEED: DemoSeed = {
  user: ME,
  users: USERS,
  workspace: WORKSPACE,
  projects: PROJECTS,
  tasks: TASKS,
  stories: STORIES,
  nextId: 900_000_000_004_000,
};
