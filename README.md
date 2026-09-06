# Asana Connector

**Project management integration console** · DOO Builders League

Builder: **Idrees Khaled** · Provider: **Asana** · Version: **v1.0.0**

A production-oriented Asana connector: a reusable connector core with five typed
actions, normalized errors, pagination and rate-limit handling, a thin MCP
adapter, and a dark-first developer console over the top.

**Live deployment**

| | |
| --- | --- |
| Console | <https://doo-asana-connectorfrontend-production-80e4.up.railway.app/overview> |
| MCP endpoint | `https://doo-asana-connectorfrontend-production-80e4.up.railway.app/mcp` — Streamable HTTP, bearer token required |
| MCP liveness | <https://doo-asana-connectorfrontend-production-80e4.up.railway.app/mcp/health> — open, so platform probes work |

The MCP endpoint answers **401** without `Authorization: Bearer <MCP_AUTH_TOKEN>`.

---

## Quickstart

Runs with **no credentials and no configuration**. A fresh clone boots into
clearly-labelled demo mode, so you can review the whole surface immediately.

```bash
git clone https://github.com/Idrees-02/doo-asana-connector.git
cd doo-asana-connector
npm install
npm run dev
```

- Console → <http://localhost:5173>
- API → <http://localhost:8787>

Requires Node **≥ 20.19** and nothing else. No Docker, no global installs, no
hosted services.

### Reviewing the engineering rather than the UI

```bash
npm test              # connector suite: 757 tests
npm run test:frontend # console suite: 29 tests
npm run verify        # typecheck + lint + secret scan + licence audit + both suites
npm run mcp           # MCP server over stdio
```

The suite includes a five-action acceptance scenario
(`tests/integration/acceptance.test.ts`) that walks the required actions in
order and asserts approval, idempotency, pagination, request ids, the
stale-read guard and error normalization at the point each applies.

---

## The five actions

These IDs are fixed by the assignment and are used verbatim throughout the
manifest, schemas, OpenAPI spec, MCP tools and console.

| Action | Type | Asana endpoint |
| --- | --- | --- |
| `asana.list_projects` | READ | `GET /projects` |
| `asana.list_project_tasks` | READ | `GET /projects/{gid}/tasks` |
| `asana.create_task` | WRITE | `POST /tasks` |
| `asana.update_task` | WRITE | `PUT /tasks/{gid}` |
| `asana.add_comment` | WRITE | `POST /tasks/{gid}/stories` |

There is deliberately **no delete action** — it is not part of the assignment,
and the connector never requests a `:delete` OAuth scope.

---

## Getting your Asana credentials

> **Never paste a token into a chat window, an issue, a screenshot, or any file
> that git tracks.** It goes into `.env` on your machine and nowhere else.
> `.env` is gitignored, and a pre-commit hook blocks it even if that is bypassed.

### Option A — Personal Access Token (recommended to start)

A PAT is the quickest path and is all you need for local review.

1. Sign in at <https://app.asana.com> — a **free** account is enough.
2. Open <https://app.asana.com/0/my-apps>
   (or: profile photo → **My Settings** → **Apps** → **Manage Developer Apps**).
3. Click **Create new token**.
4. Name it something identifiable, e.g. `doo-asana-connector-dev`.
5. Accept the API terms, then click **Create token**.
6. **Copy it immediately — Asana shows it exactly once.**
7. Run the setup command and paste it when prompted:

   ```bash
   npm run setup
   ```

   Input is hidden while you type, so the token never appears on screen, in a
   screen recording, or in your shell history. It is written to `.env` with
   permissions `0600` and verified against Asana immediately — without ever
   being displayed back to you.

   Prefer doing it by hand? `cp .env.example .env`, then edit the
   `ASANA_ACCESS_TOKEN=` line in your editor.

8. Restart `npm run dev`. The amber **DEMO MODE** banner disappears and
   **Settings → Test Connection** shows your real account and workspaces.

> **`.env.example` is tracked by git and is public.** Only ever put
> placeholders there. Real values belong in `.env`, which is gitignored.

**Tip:** actions performed through a PAT are attributed to *you* in Asana's
activity feed. For a shared or demo setup, create a dedicated bot user and
generate the PAT from that account instead.

### Option B — OAuth 2.0 (multi-user)

Needed only if you want the browser-based connect flow rather than a
pre-shared token.

1. Same page: <https://app.asana.com/0/my-apps> → **Create new app**.
2. Name the app and accept the terms.
3. Under **OAuth → Redirect URLs**, add this exact redirect URL:

   ```
   http://localhost:8787/api/auth/oauth/callback
   ```

   Character for character — `http` not `https`, port `8787`, no trailing
   slash. Asana only checks this **after** you log in, so getting it wrong
   shows a normal login page and then fails at the very end with
   `invalid_request: The redirect_uri parameter does not match a valid url
   for the application`.

4. Copy the **Client ID** and **Client Secret** into `.env`:

   ```
   ASANA_OAUTH_CLIENT_ID=...
   ASANA_OAUTH_CLIENT_SECRET=...
   ASANA_OAUTH_REDIRECT_URI=http://localhost:8787/api/auth/oauth/callback
   ```

5. Connect. Either use **Settings → Connect with Asana** in the console, or
   run the guided flow:

   ```bash
   npm run oauth:connect
   ```

   It prints the URL to open, waits for Asana's redirect, then proves the
   resulting token works by calling `testConnection` with it.

   > **A PAT takes precedence over OAuth.** If `ASANA_ACCESS_TOKEN` is set,
   > the connector keeps using it and a successful OAuth connection is
   > silently ignored. `npm run oauth:connect` checks for this and refuses
   > rather than letting you complete a flow whose result is discarded —
   > comment the PAT out first to exercise the OAuth path.

   To check everything *before* the consent click, against the real Asana
   authorization endpoint:

   ```bash
   npm run verify:oauth
   ```

Scopes requested (least privilege — nothing more than the five actions need):

```
projects:read  tasks:read  tasks:write  stories:write  users:read  workspaces:read
```

> **If you get `forbidden_scopes`:** Asana's granular scopes have to be
> enabled per-app in the developer console, and apps do not have them by
> default. Either enable them on your app at
> <https://app.asana.com/0/my-apps>, or set `ASANA_OAUTH_SCOPES=` (blank) in
> `.env` — blank omits the `scope` parameter entirely and asks for the app's
> default permissions, which is Asana's documented fallback.

### Recommended: a sandbox workspace

Before running any write action, create a throwaway project (e.g. *Connector
Sandbox*) and point the connector at it. Write tests then never touch anything
that matters. The connector never deletes anything, but it does create tasks and
comments.

---

## Secrets policy

Every credential lives in `.env` and nowhere else. This is enforced
mechanically, not by convention:

- **`src/config.ts` is the only module permitted to read `process.env`.** An
  ESLint rule (`no-restricted-properties`) fails the build if anything else
  touches it, so credentials cannot spread through the codebase.
- **`describeConfig()`** is the only way config reaches a log, an API response
  or the UI, and its return type has no field capable of carrying a secret
  value — presence booleans and an opaque fingerprint only.
- **`npm run secrets:scan`** pattern-scans tracked files (Asana PAT format,
  bearer tokens, private keys, credential-shaped assignments) and runs in CI.
- **A pre-commit hook** blocks staged `.env` files outright and re-scans staged
  content.
- **The test suite requires no credentials**, so CI runs with no secrets
  configured at all.
- **A repository-wide privacy scan** (`tests/integration/privacy.test.ts`)
  fails the build if a real Asana identifier — a workspace gid, a project name,
  a non-reserved email domain — appears anywhere in tracked files.
- **A dependency licence audit** (`npm run licenses:check`) fails on an unknown
  or copyleft licence.

Full detail: [`docs/SECURITY.md`](docs/SECURITY.md).

### The `/mcp` endpoint fails closed

`/mcp` runs real actions with **this server's own Asana credential**, so the
connector refuses to start rather than expose it unauthenticated:

| Configuration | Result |
| --- | --- |
| `NODE_ENV=production` without `MCP_AUTH_TOKEN` | **Startup error** |
| Non-loopback `HOST` without a token | **Startup error** |
| `MCP_ALLOW_UNAUTHENTICATED=true` in production | **Startup error** — refused, not ignored |
| Local development with no token | Starts with a token minted for the process and printed to stderr |
| Local development with `MCP_ALLOW_UNAUTHENTICATED=true` | Starts unauthenticated — explicit, loopback only |

`approved: true` is **not** authentication. It is write consent inside an
already-authenticated request body, and the two controls are asserted
independently.

---

## Configuration

All configuration is environment-driven (12-factor), so the same build runs
locally and deployed with nothing changed but the environment. See
[`.env.example`](.env.example) for every variable with inline documentation.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASANA_MODE` | `auto` | `auto` \| `live` \| `demo`. `auto` picks live when credentials exist |
| `ASANA_ACCESS_TOKEN` | — | Personal Access Token |
| `ASANA_RATE_LIMIT_RPM` | `140` | Client-side throttle, just under the 150/min free tier |
| `ASANA_TIMEOUT_MS` | `15000` | Per-request timeout |
| `ASANA_MAX_CONCURRENCY` | `8` | In-flight request cap (Asana allows 50 GET / 15 write) |
| `PORT` | `8787` | API port |
| `HOST` | loopback in dev, `0.0.0.0` in prod | Bind interface. **Security-relevant** — a non-loopback bind makes `MCP_AUTH_TOKEN` mandatory |
| `MCP_TRANSPORT` | `stdio` | `stdio` locally, `http` for a deployed endpoint |
| `MCP_AUTH_TOKEN` | — | Bearer token for `/mcp`. **Mandatory in production**; ≥16 characters |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Run the local `/mcp` open. Refused in production and on a non-loopback bind |
| `IDEMPOTENCY_STORE` | `memory` | `memory` or `file`. `file` survives a restart; neither is distributed |
| `PUBLIC_BASE_URL` | — | This deployment's public origin. The console prints `<origin>/mcp` as the MCP endpoint |

`ASANA_MODE=live` without credentials **fails at startup on purpose** — silently
serving synthetic data to someone who asked for real data would be the worst
possible failure mode.

---

## Project structure

```
doo-asana-connector/
├── connector.yaml          # generated manifest
├── openapi.yaml            # generated from the same Zod schemas
├── src/
│   ├── connector.ts        # DooConnector: manifest, testConnection, listActions, execute
│   ├── client.ts           # Asana HTTP client: pagination, throttle, retry classification
│   ├── config.ts           # the only reader of process.env
│   ├── auth/               # PAT + OAuth 2.0
│   ├── actions/            # the five actions
│   ├── schemas/            # Zod schemas — single source of truth
│   ├── errors/             # normalized error system
│   ├── runtime/            # shared execution pipeline
│   └── demo/               # demo provider
├── mcp/server.ts           # thin MCP adapter
├── server/                 # HTTP API consumed by the console
├── frontend/               # the console
├── tests/ · fixtures/ · examples/ · docs/
└── .env.example
```

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/SECURITY.md`](docs/SECURITY.md) | The threat model, the fail-closed MCP policy, token handling, and every automated gate |
| [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) | Getting a PAT or OAuth app, and how credentials are handled |
| [`docs/WRITE-SAFETY.md`](docs/WRITE-SAFETY.md) | Why writes are never auto-retried, approval, idempotency, concurrency |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | What is not built, and what is not yet verified |
| [`openapi.yaml`](openapi.yaml) | Generated API contract |
| [`connector.yaml`](connector.yaml) | Generated connector manifest |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | Generated dependency licence inventory (516 packages) |

In-app documentation is also available at **/docs** in the running console.

---

## MCP

```bash
npm run mcp           # stdio — Claude Desktop, MCP Inspector
npm run mcp:inspect   # interactive tool explorer
```

Claude Desktop (`claude_desktop_config.json`), replacing the path with this
project's absolute location:

```json
{
  "mcpServers": {
    "asana-connector": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/doo-asana-connector/mcp/server.ts"]
    }
  }
}
```

The adapter iterates `connector.listActions()` and registers each as a tool. It
contains no Asana endpoint, no schema and no business logic — a test asserts the
exposed tool ids equal the connector's action ids, so it cannot drift.

### Over HTTPS

The API server also mounts the same adapter at `/mcp`, so a deployment exposes
both surfaces on one origin and one process:

```
https://doo-asana-connectorfrontend-production-80e4.up.railway.app/mcp          # Streamable HTTP endpoint
https://doo-asana-connectorfrontend-production-80e4.up.railway.app/mcp/health   # liveness, unauthenticated
```

**`MCP_AUTH_TOKEN` is mandatory in production — the server will not start
without it.** The endpoint executes real actions using the server's own Asana
credential, so without a token anyone who learns the URL can drive the
workspace. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Clients send it as a bearer token:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Running locally with no token configured is fine: the server mints one for the
process and prints it to stderr at startup.

The standalone process (`npm run mcp` with `MCP_TRANSPORT=http`) remains
available for running MCP on a port of its own.

---

## Assistant

The console includes an assistant: plain language in, connector actions out. It
is a third adapter over the same core, and it holds one rule —

**The assistant never writes.** Reads run immediately; a write is returned as a
proposal, rendered with its duplicate-behaviour warning, and executed only after
the user approves it — through the same action route with `approved: true`.

That matters because Asana text flows back into the model, which is the shape of
a prompt-injection attack, and because this connector cannot delete what it
creates.

Set `GROQ_API_KEY` to enable it. Without a key the console runs unchanged and
hides the assistant.

---

## Assignment checklist

Marked honestly. Anything not demonstrated is called out rather than assumed.
Live results below are from **6 September 2026**; see
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for the full record.

| Requirement | Status |
| --- | --- |
| Manifest exists | Yes — generated, `connector.yaml`, 35 actions |
| Asana authentication (PAT + OAuth 2.0) | PAT **verified live**; OAuth authorize step verified live (real `client_id`, PKCE, scopes accepted); interactive consent not clicked through — see below |
| `testConnection` has no side effects | Yes — asserted by test (no non-GET request), and it returns a `requestId` |
| All five required actions implemented | Yes — **verified live, 9/9**, plus 30 extended actions (35 total) |
| Captured provider fixtures for all five | Yes — including real `POST /tasks`, `PUT /tasks/{gid}` and `POST /tasks/{gid}/stories` responses |
| Typed input/output schemas | Yes — Zod, single source of truth |
| Inputs validated | Yes — before any network call |
| Errors normalized | Yes — 19 `ASANA_*` codes; the published enum equals the runtime's, asserted by test |
| Request IDs | Yes — connector-generated on every result and every error; Asana returns none |
| Retry classification | Yes — including `manual_with_idempotency_key` |
| Pagination | Yes — cursor-based, all list actions, asserted to advance |
| Rate limits handled | Yes — client-side pacing before sending, `Retry-After` honoured |
| Approval / idempotency / duplicates documented | Yes — `docs/WRITE-SAFETY.md`; all 21 write actions require approval |
| Idempotency | Replay, key-conflict detection, concurrent collapse, optional durable store — **not distributed**, and stated as such |
| No secrets committed | Yes — scanner + privacy scan + pre-commit hook + CI |
| Unit and fixture tests pass | Yes — **786 total** (757 connector + 29 console), executed |
| OpenAPI exists | Yes — generated, 3.1.0, **validated by a real OpenAPI parser in CI** |
| JSON Schema | Draft 2020-12, **compiled by Ajv in CI**; conversion is fail-closed |
| MCP adapter exists, duplicates no logic | Yes — enforced by test, all 35 actions exposed as tools |
| MCP endpoint security | **Fails closed** — production or external bind without `MCP_AUTH_TOKEN` refuses to start; asserted by a dedicated CI job |
| Frontend connected to the real backend | Yes — no mocked UI data, all 35 actions surfaced |
| Frontend responsive and accessible | Yes — per-breakpoint layouts, 29 tests |
| Documentation and known limitations | Yes — including what is *not* verified |
| Licensing | Root `LICENSE` (MIT) + generated `THIRD-PARTY-NOTICES.md`; audit gate in CI |
| Versioned v1.0.0 | Yes |
| **Real sandbox/test-account flow** | **Verified 2026-09-06** — required 5 actions live end-to-end (9/9), including idempotency replay creating no duplicate |
| **MCP endpoint driving live Asana** | **Verified 2026-09-06** — authenticated Streamable HTTP session, 35 tools listed, `asana_list_projects` returned live data, unapproved write refused |
| **OAuth interactive consent** | **Not clicked through** — requires a human login. Token exchange/refresh/revoke covered by tests against a double matching Asana's contract |
| **HTTPS MCP endpoint deployed** | **Deployed** — `https://doo-asana-connectorfrontend-production-80e4.up.railway.app/mcp`, HTTPS, returns 401 unauthenticated |

See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for what remains
externally unverified.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API + console together |
| `npm test` | Connector suite (757 tests) |
| `npm run test:frontend` | Console suite (29 tests) |
| `npm run verify` | typecheck + lint + secret scan + licence audit + both suites |
| `npm run generate` | Regenerate `openapi.yaml` and `connector.yaml` |
| `npm run generate:check` | Fail if the committed contracts are stale |
| `npm run licenses` | Regenerate `THIRD-PARTY-NOTICES.md` |
| `npm run licenses:check` | Fail on an unknown/copyleft licence or stale notices |
| `npm run setup` | Interactive .env setup — hidden token input, verifies the connection |
| `npm run verify:oauth` | Live-check the OAuth flow up to the consent click (PKCE, scopes, state) |
| `npm run oauth:connect` | Guided consent flow, then verifies the resulting token |
| `npm run smoke:live` | Read-only check against real Asana (needs a PAT) |
| `npm run smoke:live -- --writes` | Also exercises create/update/comment |
| `npx tsx examples/use-connector.ts` | Use the connector as a library |

## License

MIT — see [`LICENSE`](LICENSE).

Dependency licences are inventoried in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), regenerated by
`npm run licenses` and verified in CI. All 516 packages carry permissive
licences; the repository vendors no third-party source.
