# Security

How this connector protects the credential it holds and the workspace it can
write to, and what a deployment has to get right.

---

## The threat that shapes everything

The `/mcp` endpoint executes real connector actions — including creating tasks
and posting comments — using **this server's own Asana credential**. It is not
a proxy for the caller's credential. Anyone who can reach an unauthenticated
`/mcp` can drive the workspace as the server.

That single fact drives the design below.

---

## Three independent controls, and why they are not interchangeable

The most common way to get this wrong is to let one control stand in for
another. They are separate, and the code enforces the separation at three
different layers:

| Control | Question it answers | Layer | Failure |
| --- | --- | --- | --- |
| **Authentication** | May you talk to this server at all? | HTTP transport, before the body is read | `401` |
| **Validation** | Is this request well-formed? | Execution pipeline, before any network call | `ASANA_VALIDATION_ERROR` |
| **Approval** | Do you consent to *this specific write*? | Execution pipeline, after validation | `ASANA_APPROVAL_REQUIRED` |

**`approved: true` is not, and can never become, authentication.** It is a
field in a JSON-RPC request body. An unauthenticated caller is rejected before
that body is ever parsed, so `approved` never gets the chance to matter.
Conversely, authenticating grants no consent: an authenticated caller who omits
approval is still refused.

Both directions are asserted:

- `tests/integration/mcp-http.test.ts` — an approved `create_task` from an
  unauthenticated caller returns `401`, and an authenticated caller without
  approval returns `ASANA_APPROVAL_REQUIRED`.
- `tests/integration/acceptance.test.ts` — approval does not disable
  validation, and an idempotency key does not substitute for approval.

---

## MCP endpoint: fail closed

`src/runtime/mcp-security.ts` resolves the posture from three inputs —
`NODE_ENV`, `MCP_AUTH_TOKEN`, and the bind address — and **throws** for any
combination that would expose an unauthenticated endpoint. The throw propagates
out of `createApp`, so the process exits before `listen` is reached. There is no
code path that starts an insecure production MCP server.

| `NODE_ENV` | Bind | `MCP_AUTH_TOKEN` | `MCP_ALLOW_UNAUTHENTICATED` | Result |
| --- | --- | --- | --- | --- |
| production | any | set (≥16 chars) | unset | **Starts**, token required |
| production | any | missing / blank / whitespace | any | **Startup error** |
| production | any | missing | `true` | **Startup error** — the bypass is refused, not ignored |
| any | non-loopback | missing | any | **Startup error** |
| development | loopback | missing | unset | **Starts**, with a token minted for the process and printed to stderr |
| development | loopback | missing | `true` | **Starts unauthenticated** — explicit, local only |
| any | any | set | `true` | **Startup error** — contradictory |

Three things about this table are deliberate:

1. **Blank is not "open".** `MCP_AUTH_TOKEN=` and `MCP_AUTH_TOKEN="   "` are
   both treated as missing, and missing is never permission to skip
   authentication.
2. **The bypass cannot reach production.** Setting
   `MCP_ALLOW_UNAUTHENTICATED=true` in production or on an externally-bound
   socket is a *startup error*, not a silently ignored value. Ignoring an
   operator's security setting is its own failure mode.
3. **The zero-configuration default is authenticated.** A developer who sets
   nothing gets a random 256-bit token minted for the process and printed to
   stderr — not an open door.

`tests/unit/mcp-security.test.ts` covers the matrix as a pure function;
`tests/integration/startup-security.test.ts` proves it is wired into the real
Express app; the `production-security` CI job runs the built server and asserts
it refuses to start.

### The bind address is a security input

`HOST` defaults to `127.0.0.1` outside production and `0.0.0.0` in production.
A development server therefore does not publish the API to the local network by
accident, and that is what makes the unauthenticated local mode safe to offer
at all. Setting `HOST=0.0.0.0` in development is allowed — but then
`MCP_AUTH_TOKEN` becomes mandatory.

---

## Token handling

- **Comparison is constant-time over fixed-length digests.** Both the supplied
  and expected tokens are SHA-256 hashed and compared with `timingSafeEqual`.
  Hashing first is what keeps it constant-length: an earlier
  `a.length === b.length && timingSafeEqual(…)` returned before the
  constant-time step on a wrong-length guess, leaking the token's length.
- **The `Bearer` scheme is mandatory.** A bare `Authorization: <token>` is
  rejected. One accepted form is easier to reason about than two.
- **Duplicate `Authorization` headers cannot smuggle.** Node discards
  duplicates for this header and keeps the first.
- **Minimum length 16.** A four-character token is theatre; a short one in
  production is a startup error.

---

## Credentials never leave the process

- **`src/config.ts` is the only module permitted to read `process.env`.** An
  ESLint `no-restricted-properties` rule fails the build if anything else
  touches it.
- **`describeConfig()` has no field capable of carrying a secret** — presence
  booleans, an opaque fingerprint, and the *source* of the MCP token, never the
  token.
- **`src/runtime/redact.ts`** masks by property name *and* by value shape, so a
  credential is caught whether it appears under a suspicious key or in free
  text.
- **The browser never holds an Asana token.** It calls the API; the server
  attaches authentication server-side.
- **OAuth tokens at rest** are AES-256-GCM encrypted under
  `CREDENTIAL_ENCRYPTION_KEY`, written mode `0600`, with a fresh IV per write.
  Without a key, credentials stay in memory only. Plaintext-on-disk is not an
  option the code offers.

Asserted by `tests/integration/startup-security.test.ts` (no diagnostic
endpoint discloses the token, including the ephemeral one),
`tests/integration/acceptance.test.ts` (`testConnection` returns a fingerprint,
never a token), and `tests/unit/errors.test.ts`.

---

## Other transport protections

| Protection | Where |
| --- | --- |
| DNS-rebinding protection (host allow-list) | `mcp/http-transport.ts` |
| Request body limit, with the socket destroyed on breach | `mcp/http-transport.ts` (4 MB) |
| Idle MCP session reaping | 10 minutes, swept every 60 s |
| Rate limiting on `/mcp` and the API | `express-rate-limit` |
| CORS locked to the console's origin | `server/app.ts` |
| `helmet`, `x-powered-by` disabled | `server/app.ts` |
| JSON body limit on the API | 1 MB |

`/mcp/health` and `/api/ready` are deliberately unauthenticated so platform
probes work, and therefore deliberately carry nothing worth having: a status, a
count, and booleans.

---

## Automated gates

Run locally with `npm run verify`; CI runs the same set plus a build.

| Gate | Command | Fails on |
| --- | --- | --- |
| Secret scan | `npm run secrets:scan` | PAT / bearer / private-key / API-key shapes in tracked files |
| Privacy scan | part of `npm test` | Real account identifiers anywhere in the repository |
| Licence audit | `npm run licenses:check` | An unknown or copyleft dependency licence, or stale notices |
| Contract freshness | `npm run generate:check` | `openapi.yaml` / `connector.yaml` drifting from the code |
| Schema soundness | part of `npm test` | A schema that cannot be represented exactly, or is not valid Draft 2020-12 |
| Production security | CI job `production-security` | The built server starting with an unauthenticated `/mcp` |

A pre-commit hook (`.githooks/pre-commit`) blocks staged `.env` files and
re-scans staged content.

---

## Reporting

This is a portfolio submission, not a hosted service. If you find a problem,
open an issue on the repository — please do not include a real credential in
it.
