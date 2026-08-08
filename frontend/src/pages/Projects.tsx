/**
 * Projects — powered by `asana.list_projects`.
 *
 * Search filters the current page client-side and is debounced. That choice is
 * deliberate and its limitation is stated in the UI: Asana's project endpoint
 * has no server-side name filter, so searching across every page would mean
 * fetching every page, which burns rate-limit quota for a cosmetic feature.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, ExternalLink, RefreshCw, Search } from 'lucide-react';
import {
  AsyncBoundary,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Panel,
  StatusPill,
  TableSkeleton,
} from '@/components/ui';
import { useProjects } from '@/hooks/useConnector';
import { useDebounced } from '@/hooks/useDebounced';
import { formatRelativeTime } from '@/lib/utils';
import type { Project } from '@/types/api';

type ArchivedFilter = 'all' | 'active' | 'archived';

export function Projects() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ArchivedFilter>('active');
  const [cursor, setCursor] = useState<string | null>(null);
  // Cursor pagination is forward-only in Asana, so "previous" is implemented
  // by remembering the cursors already visited rather than by guessing one.
  const [history, setHistory] = useState<string[]>([]);

  const debouncedSearch = useDebounced(search, 250);

  const query = useProjects({
    cursor,
    ...(filter === 'all' ? {} : { archived: filter === 'archived' }),
  });

  const filtered = useMemo(() => {
    const projects = query.data?.projects ?? [];
    const term = debouncedSearch.trim().toLowerCase();
    if (term.length === 0) return projects;

    return projects.filter(
      (p) =>
        (p.name ?? '').toLowerCase().includes(term) ||
        p.id.includes(term) ||
        (p.workspace?.name ?? '').toLowerCase().includes(term),
    );
  }, [query.data, debouncedSearch]);

  const resetPaging = (next: ArchivedFilter): void => {
    setFilter(next);
    setCursor(null);
    setHistory([]);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Projects"
        description="Asana projects available to the authenticated account."
        actions={
          <Button
            icon={RefreshCw}
            onClick={() => void query.refetch()}
            loading={query.isFetching}
            aria-label="Refresh projects"
          >
            Refresh
          </Button>
        }
      />

      <Panel>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-(--color-hairline) p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--color-ink-subtle)"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter loaded projects by name, id or workspace…"
              aria-label="Filter projects"
              className="pl-8"
            />
          </div>

          <div
            role="group"
            aria-label="Filter by archived state"
            className="flex shrink-0 rounded-(--radius-md) border border-(--color-hairline) p-0.5"
          >
            {(['active', 'archived', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => resetPaging(value)}
                aria-pressed={filter === value}
                className={`rounded-(--radius-sm) px-2.5 py-1 text-xs capitalize transition-colors ${
                  filter === value
                    ? 'bg-(--color-surface-3) font-medium text-(--color-ink)'
                    : 'text-(--color-ink-muted) hover:text-(--color-ink)'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <AsyncBoundary
          isLoading={query.isLoading}
          error={query.error}
          data={query.data}
          loadingFallback={<TableSkeleton rows={6} columns={4} />}
          isEmpty={() => filtered.length === 0}
          emptyFallback={
            debouncedSearch.trim().length > 0 ? (
              <EmptyState
                icon={Search}
                title="No projects match your filter"
                description={`Nothing on this page matches "${debouncedSearch}". Filtering applies to loaded projects only — try the next page.`}
                action={
                  <Button size="sm" onClick={() => setSearch('')}>
                    Clear filter
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Boxes}
                title="No projects found"
                description={
                  filter === 'archived'
                    ? 'This workspace has no archived projects.'
                    : 'This Asana account has no projects in the selected workspace.'
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
                    Asana projects. Select a project to view its tasks.
                  </caption>
                  <thead>
                    <tr className="border-b border-(--color-hairline) text-xs text-(--color-ink-muted)">
                      <th scope="col" className="px-4 py-2 font-medium">Project</th>
                      <th scope="col" className="px-4 py-2 font-medium">Workspace</th>
                      <th scope="col" className="px-4 py-2 font-medium">Status</th>
                      <th scope="col" className="px-4 py-2 font-medium">Modified</th>
                      <th scope="col" className="px-4 py-2 font-medium">ID</th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((project) => (
                      <tr
                        key={project.id}
                        className="cursor-pointer border-b border-(--color-hairline) transition-colors last:border-0 hover:bg-(--color-surface-2)"
                        onClick={() => navigate(`/tasks/${project.id}`)}
                      >
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            className="text-left font-medium text-(--color-ink) hover:text-(--color-accent)"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/tasks/${project.id}`);
                            }}
                          >
                            {project.name ?? 'Untitled project'}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-(--color-ink-muted)">
                          {project.workspace?.name ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          {project.archived === true ? (
                            <StatusPill tone="neutral">Archived</StatusPill>
                          ) : (
                            <StatusPill tone="success">Active</StatusPill>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-(--color-ink-muted)">
                          {formatRelativeTime(project.modifiedAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          <code className="id-chip">{project.id}</code>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {project.url !== null ? (
                            <a
                              href={project.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-(--color-ink-muted) hover:text-(--color-accent)"
                            >
                              Asana
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              <span className="sr-only">
                                Open {project.name ?? 'project'} in Asana (opens in a new tab)
                              </span>
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — a horizontally-scrolling table on a phone is unusable. */}
              <ul className="divide-y divide-(--color-hairline) md:hidden">
                {filtered.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/tasks/${project.id}`)}
                      className="w-full px-4 py-3 text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-(--color-ink)">
                          {project.name ?? 'Untitled project'}
                        </span>
                        {project.archived === true ? (
                          <StatusPill tone="neutral">Archived</StatusPill>
                        ) : (
                          <StatusPill tone="success">Active</StatusPill>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-(--color-ink-muted)">
                        <span>{project.workspace?.name ?? '—'}</span>
                        <code className="id-chip">{project.id}</code>
                      </div>
                    </button>
                  </li>
                ))}
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
    </div>
  );
}

export function Pagination({
  hasMore,
  canGoBack,
  returned,
  isFetching,
  onNext,
  onPrevious,
}: {
  hasMore: boolean;
  canGoBack: boolean;
  returned: number;
  isFetching: boolean;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 border-t border-(--color-hairline) px-4 py-2.5"
    >
      <p className="text-xs text-(--color-ink-muted)" aria-live="polite">
        Showing {returned} item{returned === 1 ? '' : 's'}
        {hasMore ? ' · more available' : ''}
      </p>

      <div className="flex gap-2">
        <Button size="sm" onClick={onPrevious} disabled={!canGoBack || isFetching}>
          Previous
        </Button>
        <Button size="sm" onClick={onNext} disabled={!hasMore || isFetching} loading={isFetching}>
          Next
        </Button>
      </div>
    </nav>
  );
}

// Re-exported so Project types stay referenced for consumers of this module.
export type { Project };
