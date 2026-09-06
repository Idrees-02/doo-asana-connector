# Asana fixtures

**Real response *shapes*, fully synthetic *content*.**

These files were captured from the real Asana API and then anonymized. What is
preserved is everything that makes them useful as a compatibility check —
`gid` rather than `id`, `due_on` rather than a date object, `next_page: null`
rather than an absent key, `assignee: null` for an unassigned task, the exact
`permalink_url` path structure, the `type` / `resource_subtype` pair on
stories. What is replaced is everything that identified a real account:

| Field | Value used |
| --- | --- |
| User | `Synthetic Builder` · `builder@example.com` |
| Workspace | `DOO Synthetic Workspace` |
| Project | `Synthetic Project Alpha` |
| Sections | Generic labels (`To do`, `Doing`, `Done`) are kept — they carry no identity |
| Tasks | `Synthetic Task 001`… |
| Comments | `Synthetic comment 1.`… ; system stories keep their wording with names remapped |
| `notes` | `Synthetic notes.` |
| Timestamps | Fixed synthetic instants from 2026-01-05T09:00:00Z, advancing 10 s |

### Gid namespaces

Every gid is `77` + a **kind digit** + 12 more — a valid Asana gid *shape*
that is not a real object:

| Prefix | Kind |
| --- | --- |
| `771…` | Users |
| `772…` | Workspaces |
| `773…` | Projects |
| `774…` | Tasks |
| `775…` | Sections |
| `776…` | Stories / comments |
| `777…` | Tags |

The kind digit is not decoration. Allocation is by first appearance, so two
capture runs that meet objects in a slightly different order could otherwise
assign the same number to a task in one file and a story in another — and a
fixture set that contradicts itself is worse than none, because a reader
trusts it. Separating the ranges makes that collision impossible.

The `77` prefix is also deliberately distinct from the `9…` prefix used by the
in-memory demo provider (`src/demo/seed.ts`), so a gid seen in a test failure
or a log is unambiguously attributable to one source or the other.

The substitution stays obvious at a glance while keeping the parser under
genuine test: the connector still has to handle a numeric-string id, and a
test asserts the format.

`tests/integration/privacy.test.ts` enforces this. It scans the whole
repository — fixtures, tests, docs, examples, README — for the specific names,
gids and workspace strings that used to be here, and fails if any of them
reappear. Re-introducing real data is therefore a build failure, not something
a reviewer has to spot.

`tests/integration/fixtures.test.ts` replays these through the connector. The
rest of the suite runs against this repository's own in-memory Asana, which
proves the connector is self-consistent; these prove it agrees with the
provider's wire format.

## Contents

| File | Endpoint |
|---|---|
| `list_projects.json` | `GET /projects?workspace=…` |
| `list_project_tasks.json` | `GET /tasks?project=…` |
| `get_task.json` | `GET /tasks/{gid}` |
| `get_current_user.json` | `GET /users/me` |
| `list_users.json` | `GET /users?workspace=…` |
| `list_project_sections.json` | `GET /projects/{gid}/sections` |
| `list_comments.json` | `GET /tasks/{gid}/stories` |
| `error_not_found.json` | A real 404 body (contains no account data) |
| `create_task.json` | `POST /tasks` |
| `update_task.json` | `PUT /tasks/{gid}` |
| `add_comment.json` | `POST /tasks/{gid}/stories` |

The last three are **write** responses. Read fixtures alone left the three
required write actions resting entirely on the in-memory provider this
repository also wrote — which proves self-consistency and nothing about what
Asana actually returns from a POST or a PUT. They are captured by the opt-in
`--writes` mode below.

## Recapturing

**Anonymization is part of capture, not a manual step afterwards.**
`scripts/capture-fixtures.ts` rewrites every gid, person, workspace, project,
task, comment and timestamp before anything is written to disk, so a recapture
*cannot* reintroduce real data. That is deliberate: the previous revision
redacted only email addresses and left everything else, and the reason it
happened is that anonymization was something a human had to remember.

```bash
npm run fixtures:capture              # reads only — safe on any workspace
npm run fixtures:capture -- --writes  # ALSO captures create / update / comment
```

Needs `ASANA_ACCESS_TOKEN` in `.env`.

`--writes` **creates one real task** in the workspace, updates it, comments on
it, and marks it complete. This connector implements no delete action, so the
task remains — remove it by hand afterwards. It is opt-in for exactly that
reason.

Capture everything in **one run**. Running the read-only and write captures
separately gives each its own allocator, and the two sets can then disagree
about what a given gid refers to.

Then verify:

```bash
npx vitest run tests/integration/privacy.test.ts
npm run secrets:scan
```

The privacy test enforces the gid namespaces, the permitted name set, and the
absence of carried-over free text; `secrets:scan` covers credential shapes.
Review the diff either way.
