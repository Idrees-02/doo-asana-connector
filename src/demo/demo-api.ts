/**
 * An in-memory Asana API for demo mode.
 *
 * This is a `fetch` implementation, not a parallel connector. Demo requests go
 * through the real client, the real actions, the real Zod validation and the
 * real error normalization — only the network hop is replaced. Two things
 * follow from that, both of which matter for review:
 *
 *   - Demo behaviour cannot drift from live behaviour, because there is only
 *     one implementation of the behaviour.
 *   - Exercising the console in demo mode genuinely exercises the connector,
 *     rather than a mock that happens to return similar-looking JSON.
 *
 * The store is stateful: creating a task, updating it and commenting all
 * persist for the lifetime of the process, so the console behaves like a real
 * application instead of replaying canned responses.
 *
 * Everything here is synthetic. The connector tags every demo response with
 * `mode: "demo"` and `demoData: true`, and the console shows a persistent
 * banner, so this data is never mistakable for real Asana data.
 */

import { DEMO_SEED, type DemoSeed } from './seed.js';

/* -------------------------------------------------------------------------- */
/* Fault injection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Forces the next matching request to fail.
 *
 * This is how the console's error, rate-limit and empty states get exercised
 * and tested without hammering the real Asana API — and without pretending
 * those states are unreachable.
 */
export type DemoFault =
  | 'none'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'empty';

export interface DemoControls {
  /** Fault applied to subsequent requests until reset to 'none'. */
  fault: DemoFault;
  /** Simulated network latency range, so loading states are actually visible. */
  latencyMs: [number, number];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Coerce an untrusted JSON value to a string.
 *
 * Request bodies arrive as `unknown`, so a blind `String(value)` would turn an
 * object into the useless literal "[object Object]" and store it as if it were
 * real data. Anything that is not a primitive is rejected as absent instead.
 */
function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

interface StoredTask {
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

interface StoredStory {
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

export class DemoStore {
  readonly seed: DemoSeed;
  private tasks: StoredTask[];
  private stories: StoredStory[];
  private nextId: number;

  readonly controls: DemoControls = {
    fault: 'none',
    latencyMs: [60, 220],
  };

  constructor(seed: DemoSeed = DEMO_SEED) {
    this.seed = seed;
    this.tasks = seed.tasks.map((t) => ({ ...t }));
    this.stories = seed.stories.map((s) => ({ ...s }));
    this.nextId = seed.nextId;
  }

  /** Restore the seeded state. Used by the console's "Reset demo data" control. */
  reset(): void {
    this.tasks = this.seed.tasks.map((t) => ({ ...t }));
    this.stories = this.seed.stories.map((s) => ({ ...s }));
    this.nextId = this.seed.nextId;
    this.controls.fault = 'none';
  }

  allocateId(): string {
    this.nextId += 1;
    return String(this.nextId);
  }

  listProjects(workspace: string | null, archived: boolean | null) {
    return this.seed.projects.filter((p) => {
      if (workspace !== null && p.workspace.gid !== workspace) return false;
      if (archived !== null && p.archived !== archived) return false;
      return true;
    });
  }

  listTasks(projectGid: string, completedSince: string | null): StoredTask[] {
    return this.tasks.filter((task) => {
      if (!task.projects.some((p) => p.gid === projectGid)) return false;
      if (completedSince === null) return true;
      // Matches Asana: incomplete tasks, plus those completed since the cutoff.
      if (!task.completed) return true;
      if (completedSince === 'now') return false;
      return task.completed_at !== null && Date.parse(task.completed_at) >= Date.parse(completedSince);
    });
  }

  getTask(gid: string): StoredTask | undefined {
    return this.tasks.find((t) => t.gid === gid);
  }

  createTask(fields: Record<string, unknown>): StoredTask {
    const now = new Date().toISOString();
    const gid = this.allocateId();

    const projectGids = Array.isArray(fields['projects']) ? (fields['projects'] as string[]) : [];
    const projects = projectGids
      .map((pg) => this.seed.projects.find((p) => p.gid === pg))
      .filter((p): p is DemoSeed['projects'][number] => p !== undefined)
      .map((p) => ({ gid: p.gid, name: p.name, resource_type: 'project' as const }));

    const workspace = projects[0]?.gid !== undefined
      ? (this.seed.projects.find((p) => p.gid === projects[0]?.gid)?.workspace ?? this.seed.workspace)
      : this.seed.workspace;

    const task: StoredTask = {
      gid,
      name: asString(fields['name']) ?? 'Untitled task',
      notes: typeof fields['notes'] === 'string' ? fields['notes'] : '',
      completed: false,
      completed_at: null,
      due_on: typeof fields['due_on'] === 'string' ? fields['due_on'] : null,
      due_at: typeof fields['due_at'] === 'string' ? fields['due_at'] : null,
      start_on: null,
      created_at: now,
      modified_at: now,
      permalink_url: `https://app.asana.com/0/${projects[0]?.gid ?? '0'}/${gid}`,
      resource_subtype: 'default_task',
      resource_type: 'task',
      num_subtasks: 0,
      assignee: this.resolveAssignee(fields['assignee']),
      workspace: { gid: workspace.gid, name: workspace.name, resource_type: 'workspace' },
      parent: null,
      projects,
      tags: [],
    };

    this.tasks = [task, ...this.tasks];
    return task;
  }

  updateTask(gid: string, fields: Record<string, unknown>): StoredTask | undefined {
    const task = this.getTask(gid);
    if (task === undefined) return undefined;

    // Mirrors Asana's partial-update semantics precisely: only keys present in
    // the body change, and an explicit null clears the field.
    if ('name' in fields && typeof fields['name'] === 'string') task.name = fields['name'];
    if ('notes' in fields) task.notes = asString(fields['notes']) ?? '';
    if ('due_on' in fields) task.due_on = asString(fields['due_on']);
    if ('due_at' in fields) task.due_at = asString(fields['due_at']);
    if ('assignee' in fields) task.assignee = this.resolveAssignee(fields['assignee']);
    if ('completed' in fields && typeof fields['completed'] === 'boolean') {
      task.completed = fields['completed'];
      task.completed_at = fields['completed'] ? new Date().toISOString() : null;
    }

    task.modified_at = new Date().toISOString();
    return task;
  }

  addStory(taskGid: string, text: string): StoredStory {
    const story: StoredStory = {
      gid: this.allocateId(),
      taskGid,
      text,
      created_at: new Date().toISOString(),
      created_by: { ...this.seed.user, resource_type: 'user' },
      type: 'comment',
      resource_subtype: 'comment_added',
      resource_type: 'story',
      is_pinned: false,
    };
    this.stories = [...this.stories, story];
    return story;
  }

  listStories(taskGid: string): StoredStory[] {
    return this.stories.filter((s) => s.taskGid === taskGid);
  }

  private resolveAssignee(value: unknown): StoredTask['assignee'] {
    const key = asString(value);
    if (key === null) return null;
    if (key === 'me') return { ...this.seed.user, resource_type: 'user' };

    const match = this.seed.users.find((u) => u.gid === key || u.email === key);
    return match === undefined ? null : { ...match, resource_type: 'user' };
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch implementation                                                        */
/* -------------------------------------------------------------------------- */

interface DemoFetchDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/**
 * Build a `fetch` that answers Asana API calls from the in-memory store.
 *
 * Faithfully reproduces the parts of Asana's contract the connector depends
 * on — the `{data}` envelope, `next_page` cursor pagination, the `{errors:[]}`
 * error shape and the `Retry-After` header — because those are exactly the
 * behaviours the connector's pagination and retry code is written against.
 */
export function createDemoFetch(store: DemoStore, deps: DemoFetchDeps = {}): typeof globalThis.fetch {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/1\.0/, '');

    // Simulated latency, so loading skeletons are actually observable.
    const [min, max] = store.controls.latencyMs;
    await sleep(Math.round(min + random() * (max - min)));

    const fault = injectedFault(store.controls.fault, path);
    if (fault !== undefined) return fault;

    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { data?: Record<string, unknown> };
        body = parsed.data ?? {};
      } catch {
        body = {};
      }
    }

    return route(store, method, path, url, body);
  };
}

function route(
  store: DemoStore,
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown>,
): Response {
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const offset = url.searchParams.get('offset');

  // GET /users/me
  if (method === 'GET' && path === '/users/me') {
    return json({
      data: {
        ...store.seed.user,
        resource_type: 'user',
        workspaces: [{ ...store.seed.workspace, resource_type: 'workspace' }],
      },
    });
  }

  // GET /workspaces
  if (method === 'GET' && path === '/workspaces') {
    return json({
      data: [{ ...store.seed.workspace, resource_type: 'workspace' }],
      next_page: null,
    });
  }

  // GET /projects
  if (method === 'GET' && path === '/projects') {
    const archivedParam = url.searchParams.get('archived');
    const projects = store.listProjects(
      url.searchParams.get('workspace'),
      archivedParam === null ? null : archivedParam === 'true',
    );
    return paginated(projects, limit, offset);
  }

  // GET /projects/{gid}/tasks
  const projectTasks = /^\/projects\/(\d+)\/tasks$/.exec(path);
  if (method === 'GET' && projectTasks?.[1] !== undefined) {
    const projectGid = projectTasks[1];

    // Asana returns 404 for a project that does not exist or is not visible.
    // Returning an empty list instead would hide a real caller error behind a
    // plausible-looking empty state.
    if (!store.seed.projects.some((p) => p.gid === projectGid)) {
      return asanaError(404, 'project: Not a recognized ID');
    }

    const tasks = store.listTasks(projectGid, url.searchParams.get('completed_since'));
    return paginated(tasks, limit, offset);
  }

  // POST /tasks
  if (method === 'POST' && path === '/tasks') {
    if (typeof body['name'] !== 'string' || body['name'].trim().length === 0) {
      return asanaError(400, 'name: Missing input');
    }
    return json({ data: store.createTask(body) }, 201);
  }

  // GET|PUT /tasks/{gid}
  const taskPath = /^\/tasks\/(\d+)$/.exec(path);
  if (taskPath?.[1] !== undefined) {
    const gid = taskPath[1];

    if (method === 'GET') {
      const task = store.getTask(gid);
      return task === undefined ? asanaError(404, 'Not a recognized ID') : json({ data: task });
    }

    if (method === 'PUT') {
      const updated = store.updateTask(gid, body);
      return updated === undefined ? asanaError(404, 'Not a recognized ID') : json({ data: updated });
    }
  }

  // POST /tasks/{gid}/stories
  const stories = /^\/tasks\/(\d+)\/stories$/.exec(path);
  if (stories?.[1] !== undefined) {
    const gid = stories[1];
    if (store.getTask(gid) === undefined) return asanaError(404, 'Not a recognized ID');

    if (method === 'POST') {
      const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
      if (text.length === 0) return asanaError(400, 'text: Missing input');
      return json({ data: store.addStory(gid, text) }, 201);
    }

    if (method === 'GET') {
      return paginated(store.listStories(gid), 100, null);
    }
  }

  return asanaError(404, `Unknown demo endpoint: ${method} ${path}`);
}

/* -------------------------------------------------------------------------- */
/* Response helpers                                                            */
/* -------------------------------------------------------------------------- */

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function asanaError(status: number, message: string, headers: Record<string, string> = {}): Response {
  // Matches Asana's documented error envelope, including the `phrase` that
  // only appears on 500s.
  const payload =
    status >= 500
      ? { errors: [{ message, phrase: '6 sad squid snuggle softly' }] }
      : { errors: [{ message }] };
  return json(payload, status, headers);
}

/**
 * Cursor pagination matching Asana's contract.
 *
 * The cursor is opaque to callers (base64), exactly as Asana's is, so the
 * connector's pagination code is genuinely exercised rather than being handed
 * a plain integer it would never see in production.
 */
function paginated<T>(items: readonly T[], limit: number, offset: string | null): Response {
  const start = decodeOffset(offset);
  const size = Math.min(Math.max(limit, 1), 100);
  const page = items.slice(start, start + size);
  const nextIndex = start + size;

  return json({
    data: page,
    next_page:
      nextIndex < items.length
        ? {
            offset: encodeOffset(nextIndex),
            path: '/demo',
            uri: 'https://app.asana.com/api/1.0/demo',
          }
        : null,
  });
}

function encodeOffset(index: number): string {
  return Buffer.from(JSON.stringify({ o: index })).toString('base64url');
}

function decodeOffset(offset: string | null): number {
  if (offset === null) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(offset, 'base64url').toString('utf8')) as { o?: number };
    return typeof parsed.o === 'number' && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/** Endpoints that return a collection, and so can meaningfully be "empty". */
function isCollectionPath(path: string): boolean {
  return path === '/projects' || /^\/projects\/\d+\/tasks$/.test(path) || /\/stories$/.test(path);
}

function injectedFault(fault: DemoFault, path: string): Response | undefined {
  /*
   * The "empty" fault is scoped to collection endpoints only. Applying it to
   * every request would also empty the workspace lookup that `list_projects`
   * uses to resolve its workspace, producing a misleading "not a member of any
   * workspace" error instead of the empty-state the tester asked to see.
   */
  if (fault === 'empty' && !isCollectionPath(path)) return undefined;

  switch (fault) {
    case 'none':
      return undefined;
    case 'auth':
      return asanaError(401, 'Not Authorized');
    case 'permission':
      return asanaError(403, 'Forbidden: You do not have access to this object');
    case 'not_found':
      return asanaError(404, 'Not a recognized ID');
    case 'rate_limit':
      return asanaError(429, 'Rate Limit Enforced', { 'retry-after': '5' });
    case 'server_error':
      return asanaError(500, 'Server Error');
    case 'timeout': {
      // A never-settling response, so the client's own AbortController fires —
      // exercising the real timeout path rather than faking its symptom.
      return new Response(null, { status: 200 });
    }
    case 'empty':
      return json({ data: [], next_page: null });
    default:
      return undefined;
  }
}
