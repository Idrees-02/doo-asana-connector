# Asana Connector

**Project management integration console** · DOO Builders League

Builder: **Idrees Khaled** · Provider: **Asana** · Version: **v1.0.0**

A production-oriented Asana connector: a reusable connector core with five typed
actions, normalized errors, pagination and rate-limit handling, a thin MCP
adapter, and a dark-first developer console over the top.

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
npm test              # connector suite: all five actions, errors, pagination, rate limits
npm run test:frontend # console tests
npm run verify        # typecheck + lint + secret scan + tests
npm run mcp           # MCP server over stdio
```

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
3. Under **OAuth**, add this exact redirect URL:

   ```
   http://localhost:8787/api/auth/oauth/callback
   ```

4. Copy the **Client ID** and **Client Secret** into `.env`:

   ```
   ASANA_OAUTH_CLIENT_ID=...
   ASANA_OAUTH_CLIENT_SECRET=...
   ASANA_OAUTH_REDIRECT_URI=http://localhost:8787/api/auth/oauth/callback
   ```

5. Restart, then use **Settings → Connect with Asana**.

Scopes requested (least privilege — nothing more than the five actions need):

```
projects:read  tasks:read  tasks:write  stories:write  users:read  workspaces:read
```

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
| `MCP_TRANSPORT` | `stdio` | `stdio` locally, `http` for a deployed endpoint |
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
| [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) | Getting a PAT or OAuth app, and how credentials are handled |
| [`docs/WRITE-SAFETY.md`](docs/WRITE-SAFETY.md) | Why writes are never auto-retried, approval, idempotency, concurrency |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | What is not built, and what is not yet verified |
| [`openapi.yaml`](openapi.yaml) | Generated API contract |
| [`connector.yaml`](connector.yaml) | Generated connector manifest |

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
https://<your-host>/mcp          # Streamable HTTP endpoint
https://<your-host>/mcp/health   # liveness, unauthenticated
```

**Set `MCP_AUTH_TOKEN` before deploying.** The endpoint executes real actions
using the server's own Asana credential, so without a token anyone who learns
the URL can drive the workspace. Clients send it as a bearer token:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

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

| Requirement | Status |
| --- | --- |
| Manifest exists | Yes — generated, `connector.yaml`, 35 actions |
| Asana authentication (PAT + OAuth 2.0) | PAT **verified live**; OAuth authorize step **verified live** against Asana (real client_id, PKCE, scopes accepted); interactive consent not clicked through — see below |
| `testConnection` has no side effects | Yes — asserted by test (no non-GET request) |
| All five required actions implemented | Yes — end-to-end tested, plus 30 extended actions (35 total) |
| Typed input/output schemas | Yes — Zod, single source of truth |
| Inputs validated | Yes — before any network call |
| Errors normalized | Yes — 19 `ASANA_*` codes |
| Request IDs | Yes — connector-generated; Asana returns none |
| Retry classification | Yes — including `manual_with_idempotency_key` |
| Pagination | Yes — cursor-based, all list actions |
| Rate limits handled | Yes — client-side pacing before sending |
| Approval / idempotency / duplicates documented | Yes — `docs/WRITE-SAFETY.md`, all 21 write actions require approval |
| No secrets committed | Yes — scanner + pre-commit hook + CI |
| Unit and fixture tests pass | Yes — 263 total (238 connector + 25 console) |
| OpenAPI exists | Yes — generated, 35 endpoints |
| MCP adapter exists, duplicates no logic | Yes — enforced by test, all 35 actions exposed as tools |
| Frontend connected to the real backend | Yes — no mocked UI data, all 35 actions surfaced |
| Frontend responsive and accessible | Yes — per-breakpoint layouts, 25 tests |
| Documentation and known limitations | Yes |
| Versioned v1.0.0 | Yes |
| **Real sandbox/test-account flow** | **Verified** — required 5 actions live end-to-end (9/9), 30 extended actions live-checked via `asana.get_current_user` |
| **OAuth interactive consent** | **Not clicked through** — requires a human login, which this assistant will not perform. Authorization request verified live; token exchange/refresh/revoke covered by 21 tests against a double matching Asana's real contract |
| **HTTPS MCP endpoint deployed** | **Not met by design** — local-first; HTTP transport implemented but undeployed |

The remaining gap is the HTTPS MCP endpoint, which is not met by design
(local-first). See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API + console together |
| `npm test` | Connector suite (141 tests) |
| `npm run test:frontend` | Console suite (25 tests) |
| `npm run verify` | typecheck + lint + secret scan + tests |
| `npm run generate` | Regenerate `openapi.yaml` and `connector.yaml` |
| `npm run setup` | Interactive .env setup — hidden token input, verifies the connection |
| `npm run smoke:live` | Read-only check against real Asana (needs a PAT) |
| `npm run smoke:live -- --writes` | Also exercises create/update/comment |
| `npx tsx examples/use-connector.ts` | Use the connector as a library |

## License

MIT
