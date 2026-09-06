# Verification log

The assessment's remaining demonstration gap was:

> No demonstration recording or independently observed live walkthrough was
> supplied.

This is that walkthrough. It is a **reproducible** one rather than a video:
every command below can be re-run, and each is followed by output actually
captured on **6 September 2026**, not a transcription of what it should say.

Nothing here is claimed that was not executed. Where something remains
unverified it is stated as such, here and in
[`LIMITATIONS.md`](LIMITATIONS.md).

**Deployment:** `https://doo-asana-connectorfrontend-production-80e4.up.railway.app`

---

## 1. The deployed console and endpoint

```
GET /overview -> 200  (0.865s, TLS verified)

GET /api/ready
{"status":"ready","version":"1.0.0","mode":"live","actions":35,
 "mcp":{"authRequired":true,"authSource":"configured"},"uptimeSeconds":206}
```

`mode: live` — the deployment talks to real Asana, not the demo provider.
`authSource: configured` — the fail-closed security policy ran at startup and
found a token. `server.externallyBound` is `true` there, so had the token been
absent the process would have refused to boot rather than serving an open
endpoint.

## 2. The MCP endpoint refuses anonymous callers

```
POST /mcp  (no Authorization)
HTTP/2 401
www-authenticate: Bearer

POST /mcp  (Authorization: Bearer wrong-token-…)
401
```

## 3. An authenticated MCP session, against the deployment

```
initialize -> 200, session established (eca872aa…)

tools/list -> 35 tools

  asana_list_projects        readOnly=true  idempotent=true  approved=false
  asana_list_project_tasks   readOnly=true  idempotent=true  approved=false
  asana_create_task          readOnly=false idempotent=false approved=true
  asana_update_task          readOnly=false idempotent=true  approved=true
  asana_add_comment          readOnly=false idempotent=false approved=true
```

The annotations are derived from each action's own safety metadata, so
`create` and `comment` advertise `idempotent=false` — which is what stops a
client retrying them — and every write requires `approved`.

## 4. A tool call reaching real Asana through the deployment

```
tools/call asana_list_projects {limit: 2}

isError: false
projects from live Asana: 1
pagination: {"nextCursor":null,"hasMore":false,"pageSize":2,"returned":1}
no credential in response: true
```

That is the full chain — HTTPS → MCP transport → adapter →
`connector.execute` → shared client → `app.asana.com` — exercised end to end
on the deployed instance.

## 5. Authentication and approval are independent

```
tools/call asana_create_task {approved: false}   (authenticated)

isError: true
code   : ASANA_APPROVAL_REQUIRED
```

An authenticated caller is still refused without consent. The converse holds
too: an *approved* write from an unauthenticated caller returns 401, rejected
at the transport before the body is parsed. `approved: true` is write consent,
never a credential.

---

## 6. The five required actions, against a real workspace

`npm run smoke:live -- --writes` — **9 passed, 0 failed**

| Check | Result |
| --- | --- |
| `testConnection` | Connected · 1 workspace · 964 ms |
| `asana.list_projects` | 1 project · 1268 ms |
| `asana.list_project_tasks` | 4 tasks · 452 ms |
| Unapproved write refused | `ASANA_APPROVAL_REQUIRED`, **no network call made** |
| `asana.create_task` | Task created · 1021 ms |
| Idempotency key replay | Original result replayed, **no duplicate** |
| `asana.update_task` | Only the named field sent |
| `asana.add_comment` | Comment posted |
| Cleanup | Marked complete (this connector has no delete action) |

Read-only re-run afterwards, on the restored PAT: **4 passed, 0 failed**
(`testConnection` 910 ms, 1 project, 7 tasks, approval gate held).

## 7. OAuth 2.0, every step against the live provider

`npm run verify:oauth:lifecycle` — **11 passed, 0 failed**

```
1. Encrypted persistence
   PASS  decrypted a credential a PREVIOUS process wrote   fp_123990d39c58
   PASS  carries a refresh token                           present
   PASS  the persisted token makes a REAL Asana call       1014ms · req_0mtpyrdvfgpg2jt7zkd12
   PASS  credential type in use                            oauth

2. Refresh
   PASS  stored expiry moved into the past
   PASS  Asana accepted the refresh                        949ms · req_0mtpyrenq3e0cwx8ueb3j
   PASS  a NEW access token was issued    fp_123990d39c58 -> fp_cc17c76bf7a3
   PASS  the refreshed credential was re-encrypted to disk

3. Revocation
   PASS  Asana accepted the revocation                     HTTP 200
   PASS  the revoked token no longer works                 ASANA_AUTHENTICATION_ERROR
   PASS  local credential cleared                          disconnected
```

Consent itself was granted by a human at Asana's screen
(`npm run oauth:connect`), producing `credential: oauth`, `refreshable: true`.

The last line of section 3 matters more than the 200 above it: the token was
confirmed dead by **asking Asana**, not by trusting the revoke response.

**This found a real bug.** The connector revoked the *access* token, and Asana
answers a real access token with `400 unsupported_token_type`. Disconnect had
been clearing the local credential while leaving a live token in Asana. It
survived because the endpoint returns 200 for a token it does not recognise,
so every test against a made-up string passed. Fixed to revoke the refresh
token; four tests cover it.

## 8. What Asana's response headers actually contain

`GET /users/me`, headers inspected directly:

| Header | Observed |
| --- | --- |
| `X-RateLimit-*` / `RateLimit-*` | **Absent** — no remaining-quota header of any kind |
| `Retry-After` | Only on a 429, i.e. only after rejection |
| `Asana-Change` | Five deprecation notices, one `affected=true` |

The first row validates a design decision: the client paces requests with its
own token bucket *before* sending, because there is no budget header to read.

---

## 9. Local gates

```
typecheck    PASS
lint         PASS (0 errors, 0 warnings, --max-warnings 0)
secrets      clean (147 files)
licences     clean (516 packages, all permissive)
contracts    connector.yaml and openapi.yaml current
tests        801 connector + 29 console = 830
build        PASS
```

CI runs the same set on Node 20.19 / 22 / 24, plus a `production-security`
job that boots the built server and asserts it **refuses to start** without
`MCP_AUTH_TOKEN` in production or on a non-loopback bind.

---

## Still not independently verified

- **No video recording.** This document is a reproducible written walkthrough;
  it is not a screen capture.
- **The 30 extended actions** were not re-run live in this pass. They run
  through the same client, validation and error path against the in-memory
  provider.
- **A real 429 from Asana.** The quota was never exhausted, so the
  `Retry-After` path is covered against a double rather than live.
- **Multi-instance idempotency.** Not implemented, so there is nothing to
  test — see [`LIMITATIONS.md`](LIMITATIONS.md).
