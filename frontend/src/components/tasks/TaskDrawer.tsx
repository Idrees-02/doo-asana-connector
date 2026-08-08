/**
 * Task details drawer: view, edit, and comment.
 *
 * Three details here are load-bearing rather than cosmetic:
 *
 *   1. The edit form shows CURRENT vs NEW and submits only genuinely changed
 *      fields, mirroring the connector's partial-update contract. Sending
 *      untouched fields would risk clobbering a concurrent edit.
 *   2. Every edit passes `ifUnmodifiedSince` with the `modifiedAt` the drawer
 *      actually rendered, so a concurrent change is rejected with a clear
 *      conflict rather than silently overwriting someone else's work.
 *   3. The comment box guards against accidental double-posting, because
 *      duplicate comments are immediately visible to every task follower and
 *      this connector cannot delete them.
 */

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, MessageSquarePlus, Pencil, X } from 'lucide-react';
import { Button, Field, Input, StatusPill, Textarea } from '@/components/ui';
import { useAddComment, useUpdateTask } from '@/hooks/useConnector';
import { formatDueDate, formatTimestamp } from '@/lib/utils';
import type { Task } from '@/types/api';

interface TaskDrawerProps {
  task: Task;
  onClose: () => void;
  onChanged: (task: Task) => void;
}

export function TaskDrawer({ task, onClose, onChanged }: TaskDrawerProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        {/* Radix handles focus trapping, escape, scroll lock and aria wiring —
            all things a hand-rolled drawer routinely gets wrong. */}
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />

        <Dialog.Content
          className="fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-(--color-hairline) bg-(--color-surface) sm:w-[min(560px,100vw)]"
          aria-describedby="task-drawer-description"
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-(--color-hairline) p-4">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-(--color-ink)">
                {task.name ?? 'Untitled task'}
              </Dialog.Title>
              <p id="task-drawer-description" className="mt-1 flex flex-wrap items-center gap-2">
                <code className="id-chip">{task.id}</code>
                {task.completed === true ? (
                  <StatusPill tone="success">Complete</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Open</StatusPill>
                )}
              </p>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close task details"
                className="rounded-(--radius-md) p-1.5 text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink)"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {mode === 'view' ? (
              <TaskDetails task={task} onEdit={() => setMode('edit')} />
            ) : (
              <EditTaskForm
                task={task}
                onCancel={() => setMode('view')}
                onSaved={(updated) => {
                  onChanged(updated);
                  setMode('view');
                }}
              />
            )}

            <CommentComposer task={task} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* View                                                                        */
/* -------------------------------------------------------------------------- */

function TaskDetails({ task, onEdit }: { task: Task; onEdit: () => void }) {
  const due = formatDueDate(task.dueOn);

  return (
    <section className="border-b border-(--color-hairline) p-4">
      <div className="mb-4 flex items-center gap-2">
        <Button size="sm" icon={Pencil} onClick={onEdit}>
          Edit task
        </Button>
        {task.url !== null ? (
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-7 items-center gap-1.5 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) px-2.5 text-xs text-(--color-ink-muted) hover:text-(--color-ink)"
          >
            Open in Asana
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </div>

      <dl className="space-y-3 text-sm">
        <Detail label="Description">
          {task.notes !== null && task.notes.trim().length > 0 ? (
            <p className="whitespace-pre-wrap text-(--color-ink-muted)">{task.notes}</p>
          ) : (
            <span className="text-(--color-ink-subtle)">No description</span>
          )}
        </Detail>

        <Detail label="Assignee">
          {task.assignee?.name ?? <span className="text-(--color-ink-subtle)">Unassigned</span>}
        </Detail>

        <Detail label="Due date">
          {due.state === 'none' ? (
            <span className="text-(--color-ink-subtle)">No due date</span>
          ) : (
            <span className={due.state === 'overdue' ? 'text-(--color-danger)' : undefined}>
              {due.label}
            </span>
          )}
        </Detail>

        <Detail label="Project">
          {task.projects.map((p) => p.name ?? p.id).join(', ') || (
            <span className="text-(--color-ink-subtle)">None</span>
          )}
        </Detail>

        <Detail label="Created">
          {task.createdAt !== null ? (
            formatTimestamp(task.createdAt)
          ) : (
            <span className="text-(--color-ink-subtle)">—</span>
          )}
        </Detail>

        <Detail label="Last modified">
          {task.modifiedAt !== null ? (
            formatTimestamp(task.modifiedAt)
          ) : (
            <span className="text-(--color-ink-subtle)">—</span>
          )}
        </Detail>
      </dl>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <dt className="text-xs text-(--color-ink-muted)">{label}</dt>
      <dd className="col-span-2 text-(--color-ink)">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

function EditTaskForm({
  task,
  onCancel,
  onSaved,
}: {
  task: Task;
  onCancel: () => void;
  onSaved: (task: Task) => void;
}) {
  const update = useUpdateTask();

  const [name, setName] = useState(task.name ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [dueOn, setDueOn] = useState(task.dueOn ?? '');
  const [completed, setCompleted] = useState(task.completed ?? false);

  /*
   * Build a patch containing ONLY changed fields.
   *
   * An empty string in a cleared date input means "clear it", which the
   * connector expects as an explicit null — distinct from omitting the key,
   * which means "leave it alone".
   */
  const patch: Record<string, unknown> = {};
  if (name !== (task.name ?? '')) patch['name'] = name;
  if (notes !== (task.notes ?? '')) patch['notes'] = notes.length === 0 ? null : notes;
  if (dueOn !== (task.dueOn ?? '')) patch['dueOn'] = dueOn.length === 0 ? null : dueOn;
  if (completed !== (task.completed ?? false)) patch['completed'] = completed;

  const changedFields = Object.keys(patch);
  const nameError = name.trim().length === 0 ? 'A task name is required.' : undefined;

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (changedFields.length === 0 || nameError !== undefined) return;

    update.mutate(
      {
        taskId: task.id,
        patch,
        // Optimistic concurrency: reject rather than overwrite a newer edit.
        ...(task.modifiedAt === null ? {} : { ifUnmodifiedSince: task.modifiedAt }),
      },
      {
        onSuccess: (result) => onSaved(result.task),
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="border-b border-(--color-hairline) p-4">
      <h3 className="mb-3 text-sm font-semibold text-(--color-ink)">Edit task</h3>

      <div className="space-y-3">
        <Field label="Task name" htmlFor="edit-name" required {...(nameError === undefined ? {} : { error: nameError })}>
          <Input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={nameError !== undefined}
            maxLength={1024}
          />
        </Field>

        <Field label="Description" htmlFor="edit-notes" hint="Clear the field to remove the description.">
          <Textarea
            id="edit-notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <Field label="Due date" htmlFor="edit-due" hint="Clear the field to remove the due date.">
          <Input id="edit-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>

        <label className="flex items-center gap-2 text-sm text-(--color-ink)">
          <input
            type="checkbox"
            checked={completed}
            onChange={(e) => setCompleted(e.target.checked)}
            className="h-4 w-4 rounded border-(--color-hairline) bg-(--color-surface-2) accent-(--color-accent)"
          />
          Mark as complete
        </label>
      </div>

      {/* Change preview: the user sees exactly what will be sent. */}
      {changedFields.length > 0 ? (
        <div className="mt-4 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-3">
          <p className="mb-2 text-xs font-medium text-(--color-ink)">
            {changedFields.length} field{changedFields.length === 1 ? '' : 's'} will be updated
          </p>
          <ul className="space-y-1">
            {changedFields.map((field) => (
              <li key={field} className="flex flex-wrap items-baseline gap-2 text-xs">
                <code className="mono text-(--color-accent)">{field}</code>
                <span className="text-(--color-ink-subtle) line-through">
                  {formatValue(task[field as keyof Task])}
                </span>
                <span aria-hidden="true" className="text-(--color-ink-subtle)">
                  →
                </span>
                <span className="text-(--color-ink)">{formatValue(patch[field])}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-(--color-ink-subtle)">
            Unlisted fields are left untouched.
          </p>
        </div>
      ) : (
        <p className="mt-4 text-xs text-(--color-ink-subtle)">
          No changes yet. Edit a field to enable saving.
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={update.isPending}
          disabled={changedFields.length === 0 || nameError !== undefined}
        >
          Save changes
        </Button>
        <Button type="button" onClick={onCancel} disabled={update.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

function CommentComposer({ task }: { task: Task }) {
  const addComment = useAddComment();
  const [text, setText] = useState('');
  const [posted, setPosted] = useState<Array<{ id: string; text: string; at: string }>>([]);

  // Remembers the last text posted and when, to catch accidental re-posts.
  const lastPost = useRef<{ text: string; at: number } | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  // Reset the duplicate warning whenever the text changes.
  useEffect(() => {
    setConfirmDuplicate(false);
  }, [text]);

  const trimmed = text.trim();
  const isEmpty = trimmed.length === 0;

  const isLikelyDuplicate =
    lastPost.current !== null &&
    lastPost.current.text === trimmed &&
    Date.now() - lastPost.current.at < 60_000;

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (isEmpty) return;

    /*
     * Asana cannot deduplicate comments, and this connector cannot delete
     * them, so posting the same text twice within a minute is far more likely
     * to be an accident than an intention. Ask once before allowing it.
     */
    if (isLikelyDuplicate && !confirmDuplicate) {
      setConfirmDuplicate(true);
      return;
    }

    addComment.mutate(
      { taskId: task.id, text: trimmed },
      {
        onSuccess: (result) => {
          setPosted((current) => [
            ...current,
            {
              id: result.comment.id,
              text: result.comment.text ?? trimmed,
              at: result.comment.createdAt ?? new Date().toISOString(),
            },
          ]);
          lastPost.current = { text: trimmed, at: Date.now() };
          setText('');
          setConfirmDuplicate(false);
        },
      },
    );
  };

  return (
    <section className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-(--color-ink)">Comments</h3>

      {posted.length === 0 ? (
        <p className="mb-3 text-xs text-(--color-ink-subtle)">
          Comments you add in this session appear here. Existing comments live in Asana — open the
          task there to read the full history.
        </p>
      ) : (
        <ul className="mb-3 space-y-2">
          {posted.map((comment) => (
            <li
              key={comment.id}
              className="rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-2.5"
            >
              <p className="whitespace-pre-wrap text-sm text-(--color-ink)">{comment.text}</p>
              <p className="mt-1 flex items-center gap-2 text-[10px] text-(--color-ink-subtle)">
                <span>{formatTimestamp(comment.at)}</span>
                <code className="id-chip">{comment.id}</code>
              </p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit}>
        <Field label="Add a comment" htmlFor="comment-text">
          <Textarea
            id="comment-text"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a comment…"
            maxLength={65_535}
          />
        </Field>

        {confirmDuplicate ? (
          <div
            role="alert"
            className="mt-2 rounded-(--radius-md) border border-(--color-warning)/30 bg-(--color-warning-muted) p-2.5"
          >
            <p className="text-xs text-(--color-warning)">
              You just posted this exact comment. Posting again will create a second, separate
              comment that this connector cannot delete. Press "Add comment" again to confirm.
            </p>
          </div>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <Button
            type="submit"
            variant={confirmDuplicate ? 'danger' : 'primary'}
            icon={MessageSquarePlus}
            loading={addComment.isPending}
            disabled={isEmpty}
          >
            {confirmDuplicate ? 'Post anyway' : 'Add comment'}
          </Button>
          <span className="text-[10px] text-(--color-ink-subtle)">
            {trimmed.length.toLocaleString()} characters
          </span>
        </div>
      </form>
    </section>
  );
}
