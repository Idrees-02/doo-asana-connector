# Authentication

How to get Asana credentials, and how this connector handles them.

> **Never paste a token into a chat window, an issue, a pull request, a
> screenshot, or any file that git tracks.** It goes into `.env` on your machine
> and nowhere else. `.env` is gitignored, a pre-commit hook blocks it even if
> that is bypassed, and `npm run secrets:scan` will find it if both fail.

---

## Which method to use

| | Personal Access Token | OAuth 2.0 |
| --- | --- | --- |
| Setup effort | One page, one minute | Register an app, configure redirect URI |
| Scopes | **None** — full permissions of the creating user | Granular, least privilege |
| Expiry | Never | ~1 hour, auto-refreshed |
| Best for | Local review, single user, scripts | Multi-user, production |

**Start with a PAT.** It is all local review needs, and you can add OAuth later
without changing any application code.

---

## Personal Access Token

1. Sign in at <https://app.asana.com>. A **free** account is enough.
2. Open <https://app.asana.com/0/my-apps>
   (or: profile photo → **My Settings** → **Apps** → **Manage Developer Apps**).
3. Click **Create new token**.
4. Name it something identifiable, e.g. `doo-asana-connector-dev`.
5. Accept the API terms, then **Create token**.
6. **Copy it immediately — Asana displays it exactly once.**
   Format: `1/1234567890123456:abcdef0123456789…`
7. Create your `.env` and paste it in:

   ```bash
   cp .env.example .env
   ```

   Then set the one line that matters:

   ```
   ASANA_ACCESS_TOKEN=1/your-token-here
   ```

8. Restart. The amber **DEMO MODE** banner disappears, and
   **Settings → Test connection** shows your real account and workspaces.

### PATs are unscoped — plan accordingly

Asana does **not** apply granular permissions to Personal Access Tokens. A PAT
can do anything its creating user can do, across every workspace they belong to.

Two consequences:

- **Attribution.** Tasks and comments created through a PAT appear in Asana as
  authored by *you*.
- **Blast radius.** A leaked PAT is equivalent to a leaked password for the API.

For anything shared or long-lived, create a dedicated bot user, invite it only
to the projects it needs, and generate the PAT from that account.

### Revoking

Same page: <https://app.asana.com/0/my-apps> → find the token → **Deauthorize**.
Do this immediately if a token is ever exposed. Revocation is instant, and
generating a replacement takes a minute.

---

## OAuth 2.0

Needed only for the browser-based connect flow or multi-user access.

1. <https://app.asana.com/0/my-apps> → **Create new app**.
2. Name the app and accept the terms.
3. Under **OAuth**, add this **exact** redirect URL:

   ```
   http://localhost:8787/api/auth/oauth/callback
   ```

   It must match `ASANA_OAUTH_REDIRECT_URI` character for character, or Asana
   rejects the authorization request.

4. Copy the **Client ID** and **Client Secret** into `.env`:

   ```
   ASANA_OAUTH_CLIENT_ID=...
   ASANA_OAUTH_CLIENT_SECRET=...
   ASANA_OAUTH_REDIRECT_URI=http://localhost:8787/api/auth/oauth/callback
   ```

5. Restart, then **Settings → Connect with Asana**.

### Scopes requested

```
projects:read  tasks:read  tasks:write  stories:write  users:read  workspaces:read
```

Computed from the actions themselves rather than hand-listed, so the connector
cannot silently request more than it uses. Notably absent: **any `:delete`
scope** — delete is not one of the five assigned actions, so the connector never
asks for the ability to do it.

`users:read` is required by `testConnection` (`GET /users/me`) even though no
action declares it. Omitting it would let the OAuth grant succeed and then fail
the connection test — confusing at exactly the wrong moment.

### Flow details

- **PKCE** (S256) on top of the confidential-client flow. Asana does not require
  it, but it binds the authorization code to this specific request, so an
  intercepted code is useless alone.
- **`state`** is cryptographically random, single-use, and expires after 10
  minutes. Without it the callback is open to CSRF: an attacker could complete
  the flow with their own code and silently bind your session to their account.
- The code-for-token exchange happens **server-side**. The browser never sees a
  token.
- Refresh happens automatically 60 seconds before expiry. Concurrent refreshes
  are de-duplicated, because Asana may invalidate a refresh token on use and
  parallel refreshes can race into logging you out.

---

## How credentials are handled

### Storage

| Mode | Where | Survives restart |
| --- | --- | --- |
| PAT | Environment only, read once at boot | n/a |
| OAuth, default | Memory | No — reconnect |
| OAuth + `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM file, mode 0600 | Yes |

Plaintext-on-disk is deliberately not an option. Defaulting to memory means the
safe choice needs no configuration; durability requires a deliberate act:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

GCM rather than CBC because it is authenticated — tampering is detected rather
than silently decrypting to garbage.

### Boundaries

- **`src/config.ts` is the only module permitted to read `process.env`.** An
  ESLint rule (`no-restricted-properties`) fails the build if anything else
  does, so a credential cannot spread through the codebase by accident.
- **The browser never holds a token.** The console calls the connector API,
  which attaches authentication server-side. There is no client code path that
  could receive one.
- **`describeConfig()` has no field capable of carrying a secret.** Making the
  unsafe thing unrepresentable is more reliable than remembering to strip it.
- **Identification is by fingerprint, not by masking.** Settings shows
  `fp_a1b2c3d4e5f6` — a SHA-256 prefix. It answers "which credential is loaded?"
  and "did it change?" while remaining non-reversible. Even four real characters
  of a token is four more than necessary.
- **Logs and the activity feed are redacted at the point of capture**, not on
  read. Request headers are never recorded at all, so an `Authorization` header
  cannot appear in the Request Inspector or a screenshot of it.

### Verification

```bash
npm run secrets:scan   # Asana PAT format, bearer tokens, private keys, credential assignments
```

Runs in CI and as a pre-commit hook. The test suite requires no credentials, so
CI runs with none configured — if a test ever needed a real token, that would be
a design bug.

---

## Sandbox workspace

Before running any write action, create a throwaway project (e.g. *Connector
Sandbox*) and point the connector at it.

This connector never deletes anything — but it does create tasks and post
comments, and neither can be removed through it. A sandbox means a mistake costs
nothing.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Banner still says DEMO MODE | `.env` not loaded | Confirm `.env` is in the project root and restart |
| `ASANA_AUTHENTICATION_ERROR` | Token invalid, revoked, or truncated on copy | Generate a new PAT |
| `ASANA_PERMISSION_DENIED` | Account not a member of the workspace/project | Invite the account, or use a different token |
| `workspace must be specified` | Account is in several workspaces | Pass `workspace`, or set `ASANA_DEFAULT_WORKSPACE` |
| OAuth: `redirect_uri_mismatch` | URI differs from the app config | Make both exactly `http://localhost:8787/api/auth/oauth/callback` |
| Startup fails: "ASANA_MODE=live but no credentials" | Intentional | Add a credential, or use `ASANA_MODE=auto` to fall back to demo |

That last one is deliberate: silently serving synthetic data to someone who
asked for real data would be the worst possible failure mode.
