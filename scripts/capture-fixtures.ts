/**
 * Recapture the Asana fixtures.
 *
 *   npm run fixtures:capture             # reads only — safe on any workspace
 *   npm run fixtures:capture -- --writes # ALSO captures create/update/comment
 *
 * ============================================================================
 * ANONYMIZATION IS MECHANICAL, NOT A MANUAL PASS.
 * ============================================================================
 *
 * An earlier revision redacted only email addresses and left real names, gids,
 * workspace and project names, task text and permalink URLs in the committed
 * fixtures. That is exactly what a reviewer flagged, and the reason it happened
 * is that anonymization was a thing someone had to remember to do.
 *
 * It is now part of capture. Every gid, person, workspace, project, task,
 * comment and timestamp is rewritten to a deterministic synthetic equivalent
 * before anything is written to disk, so a recapture CANNOT reintroduce real
 * data. `tests/integration/privacy.test.ts` is the second line of defence.
 *
 * What is preserved is everything that makes a fixture worth having: the exact
 * key names, the null-vs-absent distinctions, the envelope shape, the
 * permalink URL structure, the story `type`/`resource_subtype` pair. Only the
 * values change.
 *
 * The `--writes` mode exists because read fixtures alone cannot prove the
 * connector parses what Asana returns from `POST /tasks`, `PUT /tasks/{gid}`
 * and `POST /tasks/{gid}/stories` — the three responses the required write
 * actions actually depend on. It creates ONE real task, updates it, comments
 * on it, and marks it complete. It is opt-in for that reason.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../src/config.js';

const OUT_DIR = fileURLToPath(new URL('../fixtures/asana/', import.meta.url));

const WRITES = process.argv.includes('--writes');

/* -------------------------------------------------------------------------- */
/* Deterministic anonymization                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which digit follows the `77` prefix, per resource kind.
 *
 * Namespacing matters for more than readability. Allocation is by first
 * appearance, so two capture runs that encounter objects in a slightly
 * different order can assign the same number to different things — and a
 * fixture set where one gid means "a story" in one file and "a task" in
 * another is worse than no fixtures, because it silently teaches the reader
 * something false. Separating the ranges makes that class of collision
 * impossible rather than unlikely.
 */
const GID_NAMESPACE: Readonly<Record<Kind, string>> = {
  user: '1',
  workspace: '2',
  project: '3',
  task: '4',
  section: '5',
  story: '6',
  tag: '7',
};

/**
 * Synthetic gid allocator.
 *
 * `77` + a kind digit + 12 more: a valid Asana gid *shape* that is
 * unmistakably not a real object, and deliberately distinct from the `9…`
 * range the in-memory demo provider uses — so a gid in a log or a test
 * failure is always attributable to one source or the other.
 */
class Anonymizer {
  /** Real gid -> synthetic gid, shared across every fixture in one run. */
  private readonly gids = new Map<string, string>();
  private readonly people = new Map<string, string>();
  private readonly projects = new Map<string, string>();
  private readonly tasks = new Map<string, string>();
  private readonly workspaces = new Map<string, string>();
  private readonly tags = new Map<string, string>();
  private readonly sections = new Map<string, string>();
  private nextComment = 1;
  /** Fixed epoch so timestamps are stable across recaptures. */
  private nextInstant = Date.UTC(2026, 0, 5, 9, 0, 0);

  private readonly perKind = new Map<Kind, number>();

  gid(real: string, kind: Kind): string {
    let synthetic = this.gids.get(real);
    if (synthetic === undefined) {
      const next = (this.perKind.get(kind) ?? 0) + 1;
      this.perKind.set(kind, next);
      synthetic = `77${GID_NAMESPACE[kind]}${String(next).padStart(12, '0')}`;
      this.gids.set(real, synthetic);
    }
    return synthetic;
  }

  person(real: string): string {
    let synthetic = this.people.get(real);
    if (synthetic === undefined) {
      // The first person encountered is `GET /users/me` — the account itself.
      synthetic = this.people.size === 0 ? 'Synthetic Builder' : `Synthetic Member ${this.people.size + 1}`;
      this.people.set(real, synthetic);
    }
    return synthetic;
  }

  workspace(real: string): string {
    let synthetic = this.workspaces.get(real);
    if (synthetic === undefined) {
      synthetic =
        this.workspaces.size === 0
          ? 'DOO Synthetic Workspace'
          : `DOO Synthetic Workspace ${this.workspaces.size + 1}`;
      this.workspaces.set(real, synthetic);
    }
    return synthetic;
  }

  project(real: string): string {
    let synthetic = this.projects.get(real);
    if (synthetic === undefined) {
      const letters = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
      synthetic = `Synthetic Project ${letters[this.projects.size] ?? String(this.projects.size + 1)}`;
      this.projects.set(real, synthetic);
    }
    return synthetic;
  }

  task(real: string): string {
    let synthetic = this.tasks.get(real);
    if (synthetic === undefined) {
      synthetic = `Synthetic Task ${String(this.tasks.size + 1).padStart(3, '0')}`;
      this.tasks.set(real, synthetic);
    }
    return synthetic;
  }

  comment(): string {
    return `Synthetic comment ${this.nextComment++}.`;
  }

  tag(real: string): string {
    let synthetic = this.tags.get(real);
    if (synthetic === undefined) {
      synthetic = `Synthetic Tag ${this.tags.size + 1}`;
      this.tags.set(real, synthetic);
    }
    return synthetic;
  }

  section(real: string): string {
    let synthetic = this.sections.get(real);
    if (synthetic === undefined) {
      synthetic = `Synthetic Section ${this.sections.size + 1}`;
      this.sections.set(real, synthetic);
    }
    return synthetic;
  }

  /** A stable synthetic instant, advancing 10 seconds per call. */
  instant(): string {
    const iso = new Date(this.nextInstant).toISOString();
    this.nextInstant += 10_000;
    return iso;
  }

  /** Rewrite free text that mentions a real person, project or workspace. */
  text(value: string): string {
    let out = value;
    for (const [real, synthetic] of this.people) out = out.split(real).join(synthetic);
    for (const [real, synthetic] of this.projects) out = out.split(real).join(synthetic);
    for (const [real, synthetic] of this.workspaces) out = out.split(real).join(synthetic);
    return out;
  }

  /**
   * Remap every gid inside a permalink so the URL structure survives intact.
   *
   * Only ids already seen elsewhere are rewritten. An unseen id in a URL has
   * no known kind, so it is replaced with an inert marker rather than guessed
   * at — leaving a real id in place would defeat the whole exercise.
   */
  url(value: string): string {
    return value.replace(/\d{8,}/g, (real) => this.gids.get(real) ?? '770000000000000');
  }
}

/**
 * The resource kind a `name` field belongs to.
 *
 * Asana returns `{ gid, name }` for people, projects, workspaces, sections and
 * tasks alike, so the parent key is the only signal available. Anything
 * unrecognised falls through to task-style naming, which is the safe default:
 * it replaces the value rather than keeping it.
 */
type Kind = 'user' | 'project' | 'workspace' | 'section' | 'task' | 'tag' | 'story';

/**
 * The kind of the object a given key holds.
 *
 * Returns undefined when the key says nothing — in which case the caller keeps
 * the kind it already had. That is what carries the ROOT kind down through
 * Asana's `{ "data": … }` envelope and through array elements: without it,
 * `GET /users/me` would fall back to the default and rename the account
 * itself as if it were a task.
 */
function kindFor(parentKey: string): Kind | undefined {
  switch (parentKey) {
    case 'assignee':
    case 'owner':
    case 'created_by':
    case 'followers':
    case 'users':
      return 'user';
    case 'workspace':
    case 'workspaces':
      return 'workspace';
    case 'project':
    case 'projects':
    case 'memberships':
      return 'project';
    case 'sections':
      return 'section';
    case 'tags':
      return 'tag';
    case 'stories':
      return 'story';
    case 'subtasks':
    case 'tasks':
    case 'parent':
      return 'task';
    default:
      // 'data', array indices, and anything unrecognised inherit.
      return undefined;
  }
}

/** Section names are generic workflow labels and carry no identity. */
const SAFE_SECTION_NAMES = new Set(['to do', 'doing', 'done', 'in progress', 'backlog', 'untitled section']);

function anonymize(node: unknown, anon: Anonymizer, kind: Kind): unknown {
  // Array elements are the same kind as the array itself.
  if (Array.isArray(node)) return node.map((item) => anonymize(item, anon, kind));

  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      switch (key) {
        case 'gid':
          out[key] = typeof value === 'string' ? anon.gid(value, kind) : value;
          break;

        case 'email':
          // A reserved domain (RFC 2606) that can never resolve.
          out[key] = 'builder@example.com';
          break;

        case 'photo':
          out[key] = null;
          break;

        case 'name': {
          if (typeof value !== 'string') {
            out[key] = value;
            break;
          }
          if (SAFE_SECTION_NAMES.has(value.trim().toLowerCase())) {
            out[key] = value;
            break;
          }
          out[key] =
            kind === 'user'
              ? anon.person(value)
              : kind === 'workspace'
                ? anon.workspace(value)
                : kind === 'project'
                  ? anon.project(value)
                  : kind === 'tag'
                    ? anon.tag(value)
                    : kind === 'section'
                      ? anon.section(value)
                      : anon.task(value);
          break;
        }

        case 'text':
        case 'html_text':
          // System stories name people and projects; plain comments are
          // replaced outright rather than scrubbed, since arbitrary user prose
          // cannot be reliably de-identified.
          out[key] =
            typeof value === 'string'
              ? /\b(added|marked|assigned|changed|attached|removed|created)\b/i.test(value)
                ? anon.text(value)
                : anon.comment()
              : value;
          break;

        case 'notes':
          out[key] = typeof value === 'string' && value.length > 0 ? 'Synthetic notes.' : value;
          break;

        case 'permalink_url':
        case 'uri':
        case 'url':
          out[key] = typeof value === 'string' ? anon.url(value) : value;
          break;

        case 'created_at':
        case 'modified_at':
        case 'completed_at':
        case 'due_at':
          out[key] = typeof value === 'string' ? anon.instant() : value;
          break;

        default:
          // The key decides the child's kind; when it says nothing, the
          // current kind is carried down (envelopes, arrays, unknown fields).
          out[key] = anonymize(value, anon, kindFor(key) ?? kind);
      }
    }
    return out;
  }

  return node;
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const config = getConfig();
  const token = config.accessToken;

  if (token === undefined) {
    console.error('Set ASANA_ACCESS_TOKEN in .env first. Nothing was written.');
    process.exit(1);
  }

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await fetch(`${config.asana.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify({ data: body }) }),
    });
    // A failed capture must not silently overwrite a good fixture with an
    // error body — except where the error body is the point.
    if (!response.ok && !path.includes('000000000000000')) {
      throw new Error(`${method} ${path} → ${response.status}`);
    }
    return response.json();
  };

  const get = (path: string): Promise<unknown> => call('GET', path);

  /* Reads ---------------------------------------------------------------- */

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

  /* Writes (opt-in) ------------------------------------------------------- */

  if (WRITES) {
    console.log('Capturing WRITE responses. This creates one real task in Asana.');

    const TASK_FIELDS =
      'gid,name,completed,due_on,notes,assignee.name,projects.name,permalink_url,created_at,modified_at';

    const created = (await call('POST', `/tasks?opt_fields=${TASK_FIELDS}`, {
      projects: [project],
      name: `[fixture-capture] ${new Date().toISOString()}`,
      notes: 'Created by npm run fixtures:capture -- --writes. Safe to delete.',
    })) as { data?: { gid?: string } };

    const createdGid = created.data?.gid;
    if (createdGid === undefined) throw new Error('The create response carried no gid.');

    captured['create_task'] = created;

    captured['update_task'] = await call('PUT', `/tasks/${createdGid}?opt_fields=${TASK_FIELDS}`, {
      notes: 'Updated by the fixture capture.',
    });

    captured['add_comment'] = await call(
      'POST',
      `/tasks/${createdGid}/stories?opt_fields=gid,text,created_at,created_by.name,type,resource_subtype`,
      { text: 'Comment posted by the fixture capture.' },
    );

    // Mark complete rather than delete: this connector implements no delete
    // action, and inventing one for cleanup would contradict the design.
    await call('PUT', `/tasks/${createdGid}`, { completed: true });

    console.log(`  Created task ${createdGid}, now marked complete. Remove it manually if you wish.`);
  }

  /* Anonymize and write --------------------------------------------------- */

  /*
   * ONE anonymizer across every fixture, so the same real object maps to the
   * same synthetic id everywhere. Per-file anonymizers would give the same
   * task two different gids in `get_task` and `list_project_tasks`, which
   * would make the fixtures mutually inconsistent — and a fixture set that
   * contradicts itself is worse than none.
   *
   * `get_current_user` is processed first so the account's own name becomes
   * "Synthetic Builder" rather than an arbitrary member number.
   */
  const anon = new Anonymizer();

  /*
   * The root resource kind per fixture.
   *
   * Asana wraps everything in `{ "data": … }`, and a `{ gid, name }` pair is
   * shaped identically for a user, a project and a task — so the envelope
   * carries no type information and the kind has to be supplied here.
   * `get_current_user` is first so the account's own name becomes
   * "Synthetic Builder" rather than an arbitrary member number.
   */
  const ROOT_KIND: ReadonlyArray<readonly [string, Kind]> = [
    ['get_current_user', 'user'],
    ['list_projects', 'project'],
    ['list_project_tasks', 'task'],
    ['get_task', 'task'],
    ['create_task', 'task'],
    ['update_task', 'task'],
    ['list_users', 'user'],
    ['list_project_sections', 'section'],
    ['list_comments', 'story'],
    ['add_comment', 'story'],
    ['error_not_found', 'task'],
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  const names: string[] = [];
  for (const [name, rootKind] of ROOT_KIND) {
    if (!(name in captured)) continue;
    const clean = anonymize(captured[name], anon, rootKind);
    writeFileSync(`${OUT_DIR}${name}.json`, `${JSON.stringify(clean, null, 2)}\n`);
    names.push(name);
  }

  console.log(`Captured ${names.length} fixtures into fixtures/asana/ (fully anonymized).`);
  console.log('Review the diff, then run: npx vitest run tests/integration/privacy.test.ts');
}

main().catch((error: unknown) => {
  console.error('Capture failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
