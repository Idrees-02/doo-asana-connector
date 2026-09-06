# Known limitations

An honest account of what this connector does not do, what is unverified, and
where the boundaries are. A reviewer discovering an undocumented gap is worse
than reading about it here.

Every claim below is dated and attributed to the command that produced it.
Nothing is described as "verified" that was not actually executed.

---

## Verification status, as of 6 September 2026

### Verified live against real Asana

Run: `npm run smoke:live -- --writes` — **9 passed, 0 failed**.

| Check | Result |
| --- | --- |
| `testConnection` | Connected · 1 workspace · 964 ms |
| `asana.list_projects` | 1 project returned · 1268 ms |
| `asana.list_project_tasks` | 4 tasks returned · 452 ms |
| Unapproved write refused | `ASANA_APPROVAL_REQUIRED`, no network call made |
| `asana.create_task` | Task created · 1021 ms |
| Idempotency key replay | Original result replayed · **no duplicate created** |
| `asana.update_task` | Only the named field (`notes`) sent |
| `asana.add_comment` | Comment posted |
| Cleanup | Task marked complete (this connector has no delete action) |

**All five assignment-required actions were executed against a real workspace
using a Personal Access Token.** The task the run created still exists there,
marked complete — the connector implements no delete, and inventing one for
test cleanup would contradict the design.

### Verified live: the MCP endpoint driving real Asana

Also on 6 September 2026, the built server was started with
`NODE_ENV=production ASANA_MODE=live MCP_AUTH_TOKEN=<generated>` and driven
over HTTP:

| Check | Result |
| --- | --- |
| Unauthenticated `initialize` | **401**, `WWW-Authenticate: Bearer` |
| Authenticated `initialize` | 200, session id issued |
| `tools/list` | 35 tools; all five required ids present |
| Tool annotations | `readOnlyHint` / `idempotentHint` correct per action; `approved` and `idempotencyKey` present on every write tool |
| `tools/call asana_list_projects` | Returned **live Asana data** through the full MCP → adapter → connector → Asana chain |
| `tools/call asana_create_task` with `approved: false` | `ASANA_APPROVAL_REQUIRED` — refused after authentication |
| Server log inspection | 0 occurrences of any credential pattern or the MCP token |

### Verified locally against the built server

`npm run build:core` followed by running `dist/server/index.js` directly:

| Configuration | Result |
| --- | --- |
| `NODE_ENV=production`, no `MCP_AUTH_TOKEN` | **Refused to start**, exit 1 |
| `NODE_ENV=production`, `MCP_ALLOW_UNAUTHENTICATED=true` | **Refused to start** |
| `HOST=0.0.0.0`, no token | **Refused to start** |
| `NODE_ENV=production` with a token | Started; anonymous `/mcp` → 401, authenticated → 200; `/api/ready` disclosed no token |

### Verified live: what Asana's response headers actually contain

`GET /users/me` on 6 September 2026, headers inspected directly:

| Header | Observed |
| --- | --- |
| `X-RateLimit-*` / `RateLimit-*` | **Absent.** Asana sends no remaining-quota header at all |
| `Retry-After` | Sent only on a 429, i.e. only after a request has already been rejected |
| `Asana-Change` | **Five** deprecation notices, one carrying `affected=true` |
| `X-Asana-Api-Version` | `1.1` |

The first row is the interesting one, and it validates a design decision: the
client paces requests with its own token bucket *before sending* rather than
reading a budget header, because **there is no budget header to read**. A
client that waited to be told would learn its budget only by exhausting it —
and Asana's rejected requests still count against the quota.

The real five-notice `Asana-Change` value is replayed through the parser in
`tests/unit/reliability-matrix.test.ts`, so the deprecation handling is tested
against what Asana actually sends rather than an invented example.

### Verified live: the public deployment

`https://doo-asana-connectorfrontend-production-80e4.up.railway.app` on 6 September 2026:

| Check | Result |
| --- | --- |
| `GET /overview` | 200, console served over HTTPS |
| `GET /api/connector/status` | 200 · `mode: live` · `nodeEnv: production` · PAT configured |
| `GET /mcp/health` | 200 · `authRequired: true` |
| `POST /mcp` with no token | **401** |
| `POST /mcp` with a wrong token | **401** |

**The deployment is running a build that predates this remediation pass.** It
was verified as it stands, and it stands secure — `MCP_AUTH_TOKEN` is set, so
the endpoint rejects anonymous callers. But `/api/ready` returns 404 there and
`/api/connector/status` carries no `authSource` field, which are this pass's
additions. **Redeploy from the current `main` to pick up the fail-closed
startup policy**, without which "secure" depends on the environment variable
staying set rather than on the process refusing to start.

### NOT independently verified
- **OAuth interactive consent.** The authorization redirect was verified
  against Asana's real authorization endpoint during development — a live
  request produced a correctly-formed URL (real `client_id`, matching
  `redirect_uri`, PKCE `S256` challenge, single-use `state`, exact
  least-privilege scopes) which Asana accepted, serving its login page rather
  than an error. Clicking through the consent screen requires a human login and
  was not performed. Token exchange, refresh, deduplication and revocation are
  covered by `tests/unit/oauth.test.ts` against a fetch double that mirrors
  Asana's token-endpoint contract. **The PAT path is verified end to end;
  OAuth is verified up to, but not including, interactive consent.**

  Everything before the click is now checked against the real provider by
  `npm run verify:oauth` (15/15 on 2026-09-06): the request shape, the PKCE
  challenge recomputed independently against RFC 7636, that Asana *accepts*
  the client id / redirect URI / scope list rather than returning
  `invalid_client`, `redirect_uri_mismatch` or `invalid_scope`, and that
  `state` is single-use.

  To close the remaining step yourself, `npm run oauth:connect` runs the
  guided flow and then calls `testConnection` with the resulting token —
  because a stored token that cannot call Asana is not a connection. Note
  that a PAT takes precedence over OAuth, so `ASANA_ACCESS_TOKEN` must be
  unset for the OAuth credential to actually be used; the script refuses to
  proceed otherwise rather than letting you complete a flow whose result is
  ignored.
- **The 30 extended actions were not re-run live in this pass.** They are
  exercised end to end through the same real client, validation and
  error-handling path against the in-memory Asana API.

Reproduce any of the above:

```bash
npm run smoke:live              # read-only, safe on any workspace
npm run smoke:live -- --writes  # creates real objects — read the script first
npm run verify                  # typecheck, lint, secrets, licences, all tests
```

---

## Idempotency is not distributed

Duplicate suppression is real, and its reach is exactly this:

| `IDEMPOTENCY_STORE` | Survives a restart | Shared across instances |
| --- | --- | --- |
| `memory` (default) | No | No |
| `file` | Yes, on a persistent volume | **No** |

Two replicas behind a load balancer each keep their own records, so the same
key routed to different replicas will execute twice. Making that safe requires
a shared backend. The storage layer is a four-method interface
(`IdempotencyStore`) so Redis or Postgres is a drop-in — **and no such backend
is implemented today.**

`tests/unit/idempotency.test.ts` asserts both directions of this: two
independent in-memory managers do *not* deduplicate, and two managers sharing
one durable store *do*. The limitation is therefore pinned by a test rather
than merely described here.

Asana provides no server-side idempotency mechanism at all, so client-side is
the only option available. See [WRITE-SAFETY.md](WRITE-SAFETY.md).

---

## `ifUnmodifiedSince` is a stale-read guard, not compare-and-swap

The implementation is GET, compare `modified_at`, then PUT. Asana exposes no
conditional-write primitive for tasks — no ETag, no `If-Match`, no version
field — so there is no atomic compare-and-swap to perform.

- A writer that commits between the read and the write is **not detected**.
  The guard narrows the race window from "as long as the form was open" to
  "one network round trip"; it does not close it.
- `modified_at` is millisecond-resolution, so an edit within the same
  millisecond as the caller's read is indistinguishable from no edit.

`ASANA_CONFLICT` is connector-generated. Asana does not return 409 for tasks.

---

## Deployment

Runs locally with `npm install && npm run dev`, and is deployed at
`https://doo-asana-connectorfrontend-production-80e4.up.railway.app`.

- The **stdio** MCP transport is implemented and verified against a real MCP
  session.
- The **Streamable HTTP** MCP transport is deployed at `/mcp` over HTTPS and
  verified to return 401 without a bearer token.
- The full MCP → adapter → connector → Asana chain was driven against live
  Asana locally (see above); the deployed endpoint was verified for
  reachability and authentication, not driven through a full tool call.

The production security configuration is enforced rather than merely
documented: a deployment without `MCP_AUTH_TOKEN` fails at startup, and CI
asserts that. **That enforcement is in the current `main` and not yet in the
running deployment** — redeploy to pick it up.

---

## Fixtures are anonymized captures

`fixtures/asana/*.json` were captured from a real Asana workspace and
anonymized **by the capture script itself**, not by a manual pass — every gid,
person, workspace, project, task, comment and timestamp is rewritten before
anything is written to disk, so a recapture cannot reintroduce real data. Every
wire *shape* is exactly what Asana returned; every *value* is synthetic. See
`fixtures/asana/README.md` for the substitution table and gid namespaces.

Eleven fixtures now cover all five required actions, including the three
**write** responses (`POST /tasks`, `PUT /tasks/{gid}`,
`POST /tasks/{gid}/stories`). Before this pass the write actions had no
captured provider response behind them at all, and rested entirely on the
in-memory provider this repository also wrote — which proves self-consistency
and nothing about what Asana really returns.

They prove the connector agrees with Asana's response *format*. They do not
prove anything about a specific real workspace's contents, and are not intended
to. `tests/integration/privacy.test.ts` fails the build if real identifiers
reappear anywhere in the repository.

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

## No webhooks

Asana supports webhooks for change notification. This connector does not
implement them; all data is fetched on demand. Nothing in the console is
real-time — the activity feed and metrics poll on an interval.

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

## Published JSON Schema is wider than the runtime, in one specific way

Schema generation is fail-closed: an action schema that cannot be represented
exactly stops the build rather than being published as a permissive object.
Every published schema declares the Draft 2020-12 dialect and compiles under
Ajv's 2020-12 validator (`tests/unit/json-schema.test.ts`).

What JSON Schema genuinely cannot express is Zod's **cross-field refinements**.
Three exist:

| Action | Runtime-only rule |
| --- | --- |
| `asana.create_task` | Either `projectId` or `workspace` must be present |
| `asana.create_task` | `dueOn` and `dueAt` are mutually exclusive |
| `asana.update_task` | The patch must contain at least one field; `dueOn`/`dueAt` mutually exclusive |

So the published schema accepts a few inputs the runtime rejects. The gap runs
in the safe direction — the runtime is the stricter of the two — and each case
is asserted explicitly in `tests/unit/json-schema.test.ts` so it is a stated
property rather than an unnoticed surprise.

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

Idempotency records are already scoped by principal, so the mechanism is ready
for that change even though the credential model is not.

---

## Comment history

`asana.list_comments` (`GET /tasks/{task_gid}/stories`) exists, so the console's
task drawer shows real comment history rather than only what was posted in the
current session.

There is no action to edit or delete a comment, since neither is part of the
assignment or the extended set, and this connector implements no delete
capability anywhere.

---

## Test coverage boundaries

786 tests: 757 in the connector suite, 29 in the console suite. Not covered:

- Real network conditions (partial responses, slow-loris, TLS failures)
- Asana API behaviour that differs from its documentation
- A real 429 from Asana (the quota was never exhausted; the `Retry-After`
  path is covered against a double)
- Load or concurrency beyond the semaphore's unit tests
- Browser compatibility beyond the jsdom environment
- Visual regression
- A multi-instance deployment (there is nothing to test — see above)

The structural tests are the ones worth trusting most, because each protects a
property rather than an example:

- `testConnection` issues no non-GET request.
- The MCP tool list equals the connector's action list.
- The OpenAPI document's action endpoints equal the registry, in both
  directions.
- The published error-code enum equals the runtime's, exactly.
- An insecure production configuration cannot start.
- No real account identifier exists anywhere in the repository.

Each would fail loudly if the property it protects regressed.
