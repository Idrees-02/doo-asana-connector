/**
 * Create Task dialog — `asana.create_task`.
 *
 * Validates client-side against the same rules the connector enforces, so the
 * user is told about a problem before a request is made rather than after.
 * The success state shows the created task's identity and a link into Asana,
 * because "it worked" is much less useful than "here is what was created".
 */

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, ExternalLink, X } from 'lucide-react';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useCreateTask } from '@/hooks/useConnector';
import type { Project, Task } from '@/types/api';

interface CreateTaskDialogProps {
  projectId: string;
  projects: readonly Project[];
  onClose: () => void;
}

export function CreateTaskDialog({ projectId, projects, onClose }: CreateTaskDialogProps) {
  const create = useCreateTask();

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [project, setProject] = useState(projectId);
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [created, setCreated] = useState<Task | null>(null);
  const [touched, setTouched] = useState(false);

  const nameError =
    touched && name.trim().length === 0
      ? 'A task name is required.'
      : name.length > 1024
        ? 'Task names are limited to 1024 characters.'
        : undefined;

  const canSubmit = name.trim().length > 0 && name.length <= 1024;

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) return;

    // Only fields the user actually filled in are sent; empty strings would
    // be meaningless values rather than omissions.
    const input: Record<string, unknown> = { name: name.trim(), projectId: project };
    if (notes.trim().length > 0) input['notes'] = notes.trim();
    if (assignee.trim().length > 0) input['assignee'] = assignee.trim();
    if (dueOn.length > 0) input['dueOn'] = dueOn;

    create.mutate(input, { onSuccess: (result) => setCreated(result.task) });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-(--radius-lg) border border-(--color-hairline) bg-(--color-surface)">
          <header className="flex shrink-0 items-center justify-between border-b border-(--color-hairline) p-4">
            <div>
              <Dialog.Title className="text-sm font-semibold text-(--color-ink)">
                {created === null ? 'Create task' : 'Task created'}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-(--color-ink-muted)">
                {created === null
                  ? 'This creates a real task in Asana.'
                  : 'The task was created successfully.'}
              </Dialog.Description>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-(--radius-md) p-1.5 text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink)"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          {created !== null ? (
            <SuccessPanel task={created} onClose={onClose} onCreateAnother={() => {
              setCreated(null);
              setName('');
              setNotes('');
              setAssignee('');
              setDueOn('');
              setTouched(false);
            }} />
          ) : (
            <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                <Field
                  label="Task name"
                  htmlFor="create-name"
                  required
                  {...(nameError === undefined ? {} : { error: nameError })}
                >
                  <Input
                    id="create-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => setTouched(true)}
                    invalid={nameError !== undefined}
                    placeholder="Prepare launch documentation"
                    autoFocus
                  />
                </Field>

                <Field label="Project" htmlFor="create-project" required>
                  <Select
                    id="create-project"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name ?? 'Untitled project'}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Assignee"
                  htmlFor="create-assignee"
                  hint='A user gid, an email address, or "me".'
                >
                  <Input
                    id="create-assignee"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="me"
                  />
                </Field>

                <Field label="Description" htmlFor="create-notes">
                  <Textarea
                    id="create-notes"
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional details…"
                  />
                </Field>

                <Field label="Due date" htmlFor="create-due">
                  <Input
                    id="create-due"
                    type="date"
                    value={dueOn}
                    onChange={(e) => setDueOn(e.target.value)}
                  />
                </Field>
              </div>

              {/* States the consequence before the user commits to it. */}
              <p className="mt-4 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-2.5 text-xs text-(--color-ink-muted)">
                Asana does not deduplicate tasks. Submitting twice creates two separate tasks — this
                form sends an idempotency key so a retry of <em>this</em> submission is safe.
              </p>

              <div className="mt-4 flex items-center gap-2">
                <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit}>
                  Create task
                </Button>
                <Button type="button" onClick={onClose} disabled={create.isPending}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SuccessPanel({
  task,
  onClose,
  onCreateAnother,
}: {
  task: Task;
  onClose: () => void;
  onCreateAnother: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex items-start gap-3 rounded-(--radius-md) border border-(--color-success)/30 bg-(--color-success-muted) p-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-(--color-success)" aria-hidden="true" />
        <p className="text-sm text-(--color-ink)">{task.name ?? 'Task'}</p>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-xs text-(--color-ink-muted)">Task ID</dt>
          <dd className="col-span-2">
            <code className="id-chip">{task.id}</code>
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-xs text-(--color-ink-muted)">Project</dt>
          <dd className="col-span-2 text-(--color-ink)">
            {task.projects.map((p) => p.name ?? p.id).join(', ') || '—'}
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-xs text-(--color-ink-muted)">Assignee</dt>
          <dd className="col-span-2 text-(--color-ink)">{task.assignee?.name ?? 'Unassigned'}</dd>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-xs text-(--color-ink-muted)">Due date</dt>
          <dd className="col-span-2 text-(--color-ink)">{task.dueOn ?? 'None'}</dd>
        </div>
      </dl>

      {task.url !== null ? (
        <a
          href={task.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 inline-flex items-center gap-1.5 text-xs text-(--color-accent) hover:underline"
        >
          Open in Asana
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
        <Button onClick={onCreateAnother}>Create another</Button>
      </div>
    </div>
  );
}
