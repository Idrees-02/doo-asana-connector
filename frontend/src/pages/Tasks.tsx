/**
 * Tasks — powered by `asana.list_project_tasks`, with the three write actions
 * reachable from here.
 *
 * This is where the connector's write-safety rules become visible to a user:
 * every write is explicit, confirmed, and reports what actually happened.
 */

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Circle, ListTodo, Plus, RefreshCw, Search } from 'lucide-react';
import {
  AsyncBoundary,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Panel,
  Select,
  StatusPill,
  TableSkeleton,
} from '@/components/ui';
import { Pagination } from './Projects';
import { useProjectTasks, useProjects } from '@/hooks/useConnector';
import { useDebounced } from '@/hooks/useDebounced';
import { formatDueDate, initials } from '@/lib/utils';
import { TaskDrawer } from '@/components/tasks/TaskDrawer';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import type { Task } from '@/types/api';

export function Tasks() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const projects = useProjects({ archived: false });
  const projectId = routeProjectId ?? projects.data?.projects[0]?.id ?? null;

  const [search, setSearch] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const debouncedSearch = useDebounced(search, 250);
  const query = useProjectTasks(projectId, { cursor, includeCompleted: showCompleted });

  const filtered = useMemo(() => {
    const tasks = query.data?.tasks ?? [];
    const term = debouncedSearch.trim().toLowerCase();
    if (term.length === 0) return tasks;

    return tasks.filter(
      (t) =>
        (t.name ?? '').toLowerCase().includes(term) ||
        t.id.includes(term) ||
        (t.assignee?.name ?? '').toLowerCase().includes(term),
    );
  }, [query.data, debouncedSearch]);

  const activeProject = projects.data?.projects.find((p) => p.id === projectId);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Tasks"
        description={
          activeProject !== undefined
            ? `Tasks in ${activeProject.name ?? 'the selected project'}.`
            : 'Select a project to view its tasks.'
        }
        actions={
          <>
            <Button
              icon={RefreshCw}
              onClick={() => void query.refetch()}
              loading={query.isFetching}
              aria-label="Refresh tasks"
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => setCreateOpen(true)}
              disabled={projectId === null}
            >
              Create task
            </Button>
          </>
        }
      />

      <Panel>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-(--color-hairline) p-3 lg:flex-row lg:items-center">
          <div className="lg:w-64">
            <label htmlFor="project-select" className="sr-only">
              Project
            </label>
            <Select
              id="project-select"
              value={projectId ?? ''}
              onChange={(e) => {
                setCursor(null);
                setHistory([]);
                navigate(`/tasks/${e.target.value}`);
              }}
              disabled={projects.isLoading}
            >
              {projects.isLoading ? <option>Loading projects…</option> : null}
              {projects.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name ?? 'Untitled project'}
                </option>
              ))}
            </Select>
          </div>

          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--color-ink-subtle)"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter loaded tasks by name, assignee or id…"
              aria-label="Filter tasks"
              className="pl-8"
            />
          </div>

          <label className="flex shrink-0 items-center gap-2 text-xs text-(--color-ink-muted)">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => {
                setShowCompleted(e.target.checked);
                setCursor(null);
                setHistory([]);
              }}
              className="h-3.5 w-3.5 rounded border-(--color-hairline) bg-(--color-surface-2) accent-(--color-accent)"
            />
            Show completed
          </label>
        </div>

        <AsyncBoundary
          isLoading={query.isLoading || projects.isLoading}
          error={query.error}
          data={query.data}
          loadingFallback={<TableSkeleton rows={6} columns={5} />}
          isEmpty={() => filtered.length === 0}
          emptyFallback={
            debouncedSearch.trim().length > 0 ? (
              <EmptyState
                icon={Search}
                title="No tasks match your filter"
                description={`Nothing on this page matches "${debouncedSearch}".`}
                action={
                  <Button size="sm" onClick={() => setSearch('')}>
                    Clear filter
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ListTodo}
                title="No tasks in this project"
                description="Create the first task to get started."
                action={
                  <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreateOpen(true)}>
                    Create task
                  </Button>
                }
              />
            )
          }
          onRetry={() => void query.refetch()}
        >
          {() => (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Tasks in the selected project. Select a task to open its details.
                  </caption>
                  <thead>
                    <tr className="border-b border-(--color-hairline) text-xs text-(--color-ink-muted)">
                      <th scope="col" className="px-4 py-2 font-medium">Task</th>
                      <th scope="col" className="px-4 py-2 font-medium">Status</th>
                      <th scope="col" className="px-4 py-2 font-medium">Assignee</th>
                      <th scope="col" className="px-4 py-2 font-medium">Due</th>
                      <th scope="col" className="px-4 py-2 font-medium">ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((task) => (
                      <TaskRow key={task.id} task={task} onOpen={() => setOpenTask(task)} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="divide-y divide-(--color-hairline) md:hidden">
                {filtered.map((task) => {
                  const due = formatDueDate(task.dueOn);
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => setOpenTask(task)}
                        className="w-full px-4 py-3 text-left"
                      >
                        <div className="flex items-start gap-2">
                          {task.completed === true ? (
                            <CheckCircle2
                              className="mt-0.5 h-4 w-4 shrink-0 text-(--color-success)"
                              aria-hidden="true"
                            />
                          ) : (
                            <Circle
                              className="mt-0.5 h-4 w-4 shrink-0 text-(--color-ink-subtle)"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={
                              task.completed === true
                                ? 'text-(--color-ink-muted) line-through'
                                : 'text-(--color-ink)'
                            }
                          >
                            {task.name ?? 'Untitled task'}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6 text-xs text-(--color-ink-muted)">
                          <span>{task.assignee?.name ?? 'Unassigned'}</span>
                          {due.state !== 'none' ? (
                            <StatusPill tone={due.state === 'overdue' ? 'danger' : 'neutral'}>
                              {due.label}
                            </StatusPill>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <Pagination
                hasMore={query.data?.pagination.hasMore ?? false}
                canGoBack={history.length > 0}
                returned={filtered.length}
                isFetching={query.isFetching}
                onNext={() => {
                  const next = query.data?.pagination.nextCursor;
                  if (next === null || next === undefined) return;
                  setHistory((h) => [...h, cursor ?? '']);
                  setCursor(next);
                }}
                onPrevious={() => {
                  setHistory((h) => {
                    const previous = h[h.length - 1] ?? '';
                    setCursor(previous === '' ? null : previous);
                    return h.slice(0, -1);
                  });
                }}
              />
            </>
          )}
        </AsyncBoundary>
      </Panel>

      {openTask !== null ? (
        <TaskDrawer
          task={openTask}
          onClose={() => setOpenTask(null)}
          onChanged={(updated) => setOpenTask(updated)}
        />
      ) : null}

      {createOpen && projectId !== null ? (
        <CreateTaskDialog
          projectId={projectId}
          projects={projects.data?.projects ?? []}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const due = formatDueDate(task.dueOn);

  return (
    <tr
      className="cursor-pointer border-b border-(--color-hairline) transition-colors last:border-0 hover:bg-(--color-surface-2)"
      onClick={onOpen}
    >
      <td className="px-4 py-2.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="flex items-start gap-2 text-left"
        >
          {task.completed === true ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-(--color-success)" aria-hidden="true" />
          ) : (
            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-(--color-ink-subtle)" aria-hidden="true" />
          )}
          <span
            className={
              task.completed === true ? 'text-(--color-ink-muted) line-through' : 'text-(--color-ink)'
            }
          >
            {task.name ?? 'Untitled task'}
          </span>
        </button>
      </td>

      <td className="px-4 py-2.5">
        {task.completed === true ? (
          <StatusPill tone="success">Complete</StatusPill>
        ) : (
          <StatusPill tone="neutral">Open</StatusPill>
        )}
      </td>

      <td className="px-4 py-2.5">
        {task.assignee !== null ? (
          <span className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-(--color-surface-3) text-[9px] font-medium text-(--color-ink-muted)"
            >
              {initials(task.assignee.name)}
            </span>
            <span className="text-(--color-ink-muted)">{task.assignee.name ?? 'Unknown'}</span>
          </span>
        ) : (
          <span className="text-xs text-(--color-ink-subtle)">Unassigned</span>
        )}
      </td>

      <td className="px-4 py-2.5 text-xs">
        {due.state === 'none' ? (
          <span className="text-(--color-ink-subtle)">—</span>
        ) : (
          <span
            className={
              due.state === 'overdue'
                ? 'text-(--color-danger)'
                : due.state === 'today' || due.state === 'soon'
                  ? 'text-(--color-warning)'
                  : 'text-(--color-ink-muted)'
            }
          >
            {due.label}
          </span>
        )}
      </td>

      <td className="px-4 py-2.5">
        <code className="id-chip">{task.id}</code>
      </td>
    </tr>
  );
}
