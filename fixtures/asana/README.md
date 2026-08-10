# Asana fixtures

Unmodified responses captured from the real Asana API. Only emails are
redacted (`builder@example.com`) and photo URLs nulled; every other field is
exactly what Asana returned, including the shapes that are easy to get wrong —
`gid` rather than `id`, `due_on` rather than a date object, `next_page: null`
rather than an absent key.

`tests/integration/fixtures.test.ts` replays them through the connector. The
rest of the suite runs against this repository's own in-memory Asana, which
proves the connector is self-consistent; these prove it agrees with the
provider.

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
| `error_not_found.json` | A real 404 body |

## Recapturing

Every request is a GET, so recapturing cannot modify a workspace.

```bash
npm run fixtures:capture
```

Needs `ASANA_ACCESS_TOKEN` in `.env`. Review the diff before committing: a
fixture must never contain a credential, and the test suite fails if one does.
