# Known limitations

An honest account of what this connector does not do, what is unverified, and
where the boundaries are. A reviewer discovering an undocumented gap is worse
than reading about it here.

---

## Verified against live Asana

All five actions have been run against a real Asana workspace using a Personal
Access Token, via `npm run smoke:live -- --writes`:

| Check | Result |
| --- | --- |
| `testConnection` | Connected, 1 workspace, ~920ms |
| `asana.list_projects` | Live projects returned |
| `asana.list_project_tasks` | Live tasks returned |
| Unapproved write refused | `ASANA_APPROVAL_REQUIRED`, no network call |
| `asana.create_task` | Task created |
| Idempotency key replay | Original result replayed, **no duplicate** |
| `asana.update_task` | Only the named field sent |
| `asana.add_comment` | Comment posted |

9 passed, 0 failed.

What that does **not** cover: OAuth 2.0 has been implemented and type-checked
but the browser authorization flow has not been walked end-to-end against
Asana. The PAT path is the verified one.

Re-run at any time:

```bash
npm run smoke:live              # read-only
npm run smoke:live -- --writes  # full cycle
```

---

## Idempotency is process-local

The duplicate-suppression cache lives in memory with a 15-minute TTL.

- A restart clears it.
- A second instance behind a load balancer does not share it.
- It cannot help when the response to a successful write was lost, because
  nothing was recorded to replay.

This is a genuine limitation of building idempotency on the client side. Asana
provides no server-side mechanism, so the alternative would be a shared store
(Redis, a database) — deliberately out of scope for a local-first project.

See [WRITE-SAFETY.md](WRITE-SAFETY.md).

---

## No comment history

`asana.add_comment` posts a comment. There is **no action to list comments**,
because listing is not one of the five assigned actions.

The console shows comments added during the current session and links out to
Asana for the full history. Adding a sixth action would have been easy; it
would also have been scope the assignment did not ask for.

---

## Search filters the loaded page only

Asana's `GET /projects` and `GET /projects/{gid}/tasks` have no server-side name
filter. Searching across an entire workspace would mean fetching every page on
every keystroke, which spends rate-limit quota — and Asana's limiter is
cost-based — for a cosmetic feature.

The console states this in its empty state ("Filtering applies to loaded
projects only — try the next page") rather than letting the user assume the
search is global.

---

## `ASANA_CONFLICT` is connector-generated

Asana does not return HTTP 409 for tasks. The conflict comes from this
connector's opt-in stale-write guard (`ifUnmodifiedSince`), which re-reads the
task and compares `modified_at`.

It is a real protection against lost updates, but it is *ours*, not a
passthrough of a provider behaviour — worth knowing if you are comparing the
error table against Asana's documentation.

There is also a small race window: the guard reads, compares, then writes. A
change landing between the read and the write would not be caught. Closing that
properly needs provider-side conditional writes, which Asana does not offer.

---

## No webhooks

Asana supports webhooks for change notification. This connector does not
implement them; all data is fetched on demand. Nothing in the console is
real-time — the activity feed and metrics poll on an interval.

---

## Nothing is deployed

Local-first by design, so the project can be reviewed on a single machine with
`npm install && npm run dev`.

- The **stdio** MCP transport is implemented and verified against a real MCP
  session (5 tools, correct annotations, clean protocol stream).
- The **Streamable HTTP** MCP transport is implemented (`MCP_TRANSPORT=http`)
  but has **not been deployed or verified over HTTPS**. It compiles and the
  code path exists; that is all that can honestly be claimed.

No hosted URL exists, and none is implied anywhere in the documentation.

---

## Rate limiting assumes the free tier

The client-side throttle defaults to 140 requests/minute, just under Asana's
150/min free-tier limit. On a paid plan (1500/min) this is roughly 10× more
conservative than necessary — raise `ASANA_RATE_LIMIT_RPM`.

The throttle also cannot model Asana's **cost-based** limiter, which charges
more for requests that traverse many linked objects. The `opt_fields` lists are
kept deliberately tight to reduce that cost, but a workspace with very large
projects could still hit cost limits while well under the request-count limit.

---

## Personal Access Tokens are unscoped

Asana does not apply granular scopes to PATs. A PAT carries **the full
permissions of the user who created it**, so the least-privilege scope list the
connector publishes applies only to the OAuth path.

Mitigation, documented in [AUTHENTICATION.md](AUTHENTICATION.md): create the PAT
from a dedicated bot account with access only to the projects it needs.

---

## Output validation is lenient in production

Action outputs are validated against their declared schemas. In development and
tests a mismatch throws; in production it logs and returns the data anyway.

That is a deliberate trade-off: breaking a working user request because Asana
added a field would be a self-inflicted outage. The cost is that a genuine
upstream contract change is a log line rather than a hard failure in production.

---

## Single-user credential model

The connector holds one credential at a time. There is no per-user credential
storage, no multi-tenancy and no session isolation — appropriate for a local
console and a single-builder connector, but it would need to change before
serving multiple users.

---

## Test coverage boundaries

166 tests across the connector and console. Not covered:

- Real network conditions (partial responses, slow-loris, TLS failures)
- Asana API behaviour that differs from its documentation
- Load or concurrency beyond the semaphore's unit tests
- Browser compatibility beyond the jsdom environment
- Visual regression

The two structural tests are the ones worth trusting most: `testConnection`
issues no non-GET request, and the MCP tool list equals the connector's action
list. Both would fail loudly if the property they protect regressed.
