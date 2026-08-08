# Write safety

How this connector avoids creating duplicate tasks and comments, and what it
honestly cannot protect against.

---

## The core problem

**Asana has no server-side idempotency support.** There is no `Idempotency-Key`
header, no request deduplication, and no way to ask "did this already happen?"

So:

- `POST /tasks` twice → **two tasks**, different gids
- `POST /tasks/{gid}/stories` twice → **two comments**, both visible to every
  follower of the task

And this connector implements no delete action, so it cannot clean either up.

The dangerous case is not a user clicking twice. It is a request that **fails
after Asana already processed it** — a timeout, a dropped connection, a 500
returned by a proxy after the write landed. The client cannot distinguish
"never arrived" from "arrived and succeeded, but the response was lost".

Retrying blindly in that situation is how duplicates get created.

---

## Rule 1 — non-idempotent writes are never retried automatically

| Action | Method | Auto-retry | Why |
| --- | --- | --- | --- |
| `asana.list_projects` | GET | **Yes** — 429, 5xx, timeout | No side effects |
| `asana.list_project_tasks` | GET | **Yes** — 429, 5xx, timeout | No side effects |
| `asana.create_task` | POST | **Never** | A retry creates a second task |
| `asana.add_comment` | POST | **Never** | A retry posts a second comment |
| `asana.update_task` | PUT | **Yes** — max 2 | Same patch ⇒ same end state |

This is enforced in two independent places, so no code path can bypass it:

1. **Transport** (`src/client.ts`) — `maxAttempts` is `1` when
   `idempotent: false`. The retry loop cannot run, whatever the status code.
2. **Error normalization** (`src/errors/normalize.ts`) — `applyWriteSafety`
   rewrites *any* retryable failure on a non-idempotent write to:

   ```json
   {
     "retryable": false,
     "retryStrategy": "manual_with_idempotency_key",
     "guidance": "This write may or may not have been applied in Asana. Do not blindly retry…"
   }
   ```

Note what this means in practice: a rate-limited `create_task` reports
`ASANA_RATE_LIMITED` with `retryable: false`. The rate limit is real and the
`retryAfterMs` is still reported, but the connector will not act on it for you,
because it does not know whether the task was created.

`asana.update_task` is genuinely different. Applying `{completed: true}` twice
leaves the task in the same state, so retrying is safe and the connector does it.

---

## Rule 2 — writes require explicit approval

All three write actions declare `requiresApproval: true`. A request without
`approved: true` is rejected with `ASANA_APPROVAL_REQUIRED` **before any network
call is made**.

```jsonc
// Rejected
{ "input": { "projectId": "123", "name": "New task" } }

// Executed
{ "input": { "projectId": "123", "name": "New task" }, "approved": true }
```

This exists for agents. A model enumerating the tool list, or "trying one to see
what it does", must not be able to create tasks as a side effect of exploration.
The MCP adapter surfaces `approved` as a required tool argument and states the
consequence in the tool description, because the description is what the model
actually reasons about.

In the console, the user pressing a clearly-labelled **Create task** button *is*
the approval — but the API Playground keeps it as a separate switch that must be
turned on deliberately.

---

## Rule 3 — idempotency keys, with honest limits

Supply `idempotencyKey` with a write and a repeat of the same key returns the
**original result** instead of performing the operation again.

```jsonc
{
  "input": { "projectId": "123", "name": "Prepare launch documentation" },
  "approved": true,
  "idempotencyKey": "launch-doc-2026-08-08"
}
```

Concurrent calls with the same key are collapsed — the second joins the first
rather than racing it.

### What this does not do

Stated plainly, because overstating it would be worse than not having it:

- **It is process-local.** The cache lives in memory. A server restart clears
  it, and a second instance behind a load balancer knows nothing about it.
- **It expires after 15 minutes.** A retry the next day will create a duplicate.
- **It cannot help when the response was lost.** If Asana created the task but
  the connector never saw the reply, nothing was cached — the key only helps
  once a result has been recorded.

That last point is exactly why Rule 1 exists. Idempotency keys make *deliberate*
retries safe; refusing to auto-retry is what prevents the *accidental* ones.

---

## Duplicate behaviour per action

Published in the manifest, the OpenAPI document, the MCP tool descriptions and
the console's Action Center — all generated from one definition in the action file.

### `asana.create_task`

> Asana has no server-side deduplication: calling this twice creates two
> separate tasks with different gids.

- Approval: **required**
- Auto-retry: **never**
- Recovery: check whether the task exists, then re-submit with an idempotency key

### `asana.update_task`

> Applying the same patch twice is harmless: the task ends in the same state,
> and no new object is created.

- Approval: **required**
- Auto-retry: **yes**, up to 2 further attempts
- Extra protection: `ifUnmodifiedSince` (see below)

### `asana.add_comment`

> Calling this twice posts two separate comments. They are visible to every task
> follower, and this connector cannot delete them.

- Approval: **required**
- Auto-retry: **never**
- The console additionally warns before re-posting identical text within 60 seconds

---

## Concurrency: the stale-write guard

`asana.update_task` accepts an optional `ifUnmodifiedSince`, which should be the
`modifiedAt` value the caller actually read:

```jsonc
{
  "taskId": "1201234567890123",
  "patch": { "notes": "Revised description" },
  "ifUnmodifiedSince": "2026-08-08T10:15:00.000Z"
}
```

The connector re-reads the task first and rejects with `ASANA_CONFLICT` if it
changed. Without this, read-modify-write over HTTP silently loses the other
person's edit — the classic lost-update problem.

Two caveats worth knowing:

- It costs one extra GET, which is why it is opt-in rather than automatic. The
  console's edit form always sends it; a bulk script probably should not.
- **`ASANA_CONFLICT` is connector-generated.** Asana does not return 409 for
  tasks. The guard is ours.

---

## Partial updates: `null` vs absent

`asana.update_task` sends **only the keys the caller supplied**, matching Asana's
own contract that unspecified fields are left untouched.

| Input | Sent to Asana | Result |
| --- | --- | --- |
| `{ "name": "New" }` | `{ "name": "New" }` | Only the name changes |
| `{ "dueOn": null }` | `{ "due_on": null }` | The due date is **cleared** |
| `{}` (dueOn absent) | *nothing* | The due date is **untouched** |

Collapsing `null` and absent would either make it impossible to clear a field,
or — much worse — silently wipe fields the caller never mentioned. An empty
patch is rejected outright rather than issuing a write that changes nothing and
reports success.

---

## Summary

| Protection | Guards against |
| --- | --- |
| No auto-retry on non-idempotent writes | Duplicates from timeouts and 5xx |
| Explicit approval | Accidental writes by agents |
| Idempotency keys | Duplicates from deliberate retries (process-local) |
| `ifUnmodifiedSince` | Silently overwriting a concurrent edit |
| `null` vs absent | Wiping fields the caller never mentioned |
| UI duplicate warning | A user re-posting the same comment |

Verified by tests in `tests/actions/actions.test.ts`,
`tests/unit/client.test.ts`, `tests/unit/errors.test.ts` and
`frontend/src/test/console.test.tsx`.
