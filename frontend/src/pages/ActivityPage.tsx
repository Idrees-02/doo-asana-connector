/**
 * Activity log and Request Inspector.
 *
 * Everything shown here has already been redacted server-side, at the moment
 * it was recorded. The inspector deliberately shows no headers at all — an
 * Authorization header is the one thing that must never reach this screen, and
 * the safest way to guarantee that is for the data never to include it.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity as ActivityIcon, CheckCircle2, Clock, X, XCircle } from 'lucide-react';
import {
  AsyncBoundary,
  EmptyState,
  PageHeader,
  Panel,
  Select,
  StatusPill,
  TableSkeleton,
} from '@/components/ui';
import { CopyButton } from './Playground';
import { useActions, useActivity } from '@/hooks/useConnector';
import { formatDuration, formatTimestamp, prettyJson } from '@/lib/utils';
import type { ActivityEntry } from '@/types/api';

export function ActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<string>('all');
  const activity = useActivity(100);
  const actions = useActions();

  const selectedId = searchParams.get('request');
  const entries = (activity.data?.entries ?? []).filter(
    (entry) => filter === 'all' || entry.actionId === filter,
  );
  const selected = entries.find((e) => e.requestId === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Activity"
        description="Recent connector executions. Inputs and outputs are redacted before they are recorded."
      />

      <Panel>
        <div className="flex items-center justify-between gap-3 border-b border-(--color-hairline) p-3">
          <label htmlFor="activity-filter" className="sr-only">
            Filter by action
          </label>
          <Select
            id="activity-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          >
            <option value="all">All actions</option>
            {(actions.data?.actions ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </Select>

          <span className="text-xs text-(--color-ink-muted)" aria-live="polite">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          </span>
        </div>

        <AsyncBoundary
          isLoading={activity.isLoading}
          error={activity.error}
          data={activity.data}
          loadingFallback={<TableSkeleton rows={8} columns={4} />}
          isEmpty={() => entries.length === 0}
          emptyFallback={
            <EmptyState
              icon={ActivityIcon}
              title="No activity recorded"
              description="Executions appear here as soon as an action runs."
            />
          }
          onRetry={() => void activity.refetch()}
        >
          {() => (
            <ul className="divide-y divide-(--color-hairline)">
              {entries.map((entry) => (
                <li key={entry.requestId}>
                  <button
                    type="button"
                    onClick={() => setSearchParams({ request: entry.requestId })}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-(--color-surface-2)"
                  >
                    {entry.status === 'success' ? (
                      <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0 text-(--color-success)"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle
                        className="mt-0.5 h-4 w-4 shrink-0 text-(--color-danger)"
                        aria-hidden="true"
                      />
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="mono text-(--color-ink)">{entry.actionId}</code>
                        <span className="sr-only">
                          {entry.status === 'success' ? 'Succeeded' : 'Failed'}
                        </span>
                        {entry.error !== null ? (
                          <StatusPill tone="danger">{entry.error.code}</StatusPill>
                        ) : null}
                      </div>

                      <p className="mt-0.5 text-xs text-(--color-ink-muted)">{entry.summary}</p>

                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-(--color-ink-subtle)">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                          {formatDuration(entry.durationMs)}
                        </span>
                        <span>{formatTimestamp(entry.timestamp)}</span>
                        <code className="id-chip">{entry.requestId}</code>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </AsyncBoundary>
      </Panel>

      {selected !== null ? (
        <RequestInspector entry={selected} onClose={() => setSearchParams({})} />
      ) : null}
    </div>
  );
}

function RequestInspector({ entry, onClose }: { entry: ActivityEntry; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]" />

        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-(--color-hairline) bg-(--color-surface) sm:w-[min(640px,100vw)]">
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-(--color-hairline) p-4">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-(--color-ink)">
                Request inspector
              </Dialog.Title>
              <Dialog.Description className="mt-1">
                <code className="id-chip">{entry.requestId}</code>
              </Dialog.Description>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close inspector"
                className="rounded-(--radius-md) p-1.5 text-(--color-ink-muted) hover:bg-(--color-surface-2)"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline) sm:grid-cols-4">
              <Cell label="Status" value={entry.status} />
              <Cell label="Duration" value={formatDuration(entry.durationMs)} />
              <Cell label="Upstream calls" value={String(entry.upstreamCalls)} />
              <Cell label="Attempts" value={String(entry.attempts)} />
            </div>

            <dl className="mb-4 space-y-2 text-xs">
              <Row label="Action">
                <code className="mono text-(--color-ink)">{entry.actionId}</code>
              </Row>
              <Row label="Timestamp">{formatTimestamp(entry.timestamp)}</Row>
              <Row label="Mode">
                {entry.demoData ? (
                  <StatusPill tone="warning">Demo data</StatusPill>
                ) : (
                  <StatusPill tone="success">Live</StatusPill>
                )}
              </Row>
            </dl>

            {entry.error !== null ? (
              <section className="mb-4">
                <h3 className="mb-2 text-xs font-semibold text-(--color-ink)">Error</h3>
                <div className="rounded-(--radius-md) border border-(--color-danger)/30 bg-(--color-danger-muted) p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="id-chip">{entry.error.code}</code>
                    {entry.error.httpStatus !== null ? (
                      <code className="id-chip">HTTP {entry.error.httpStatus}</code>
                    ) : null}
                    <StatusPill tone={entry.error.retryable ? 'warning' : 'neutral'}>
                      {entry.error.retryable ? 'Retryable' : 'Not retryable'}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-xs text-(--color-ink)">{entry.error.message}</p>
                  <p className="mt-1 text-xs text-(--color-ink-muted)">{entry.error.guidance}</p>
                  <p className="mt-2 text-[10px] text-(--color-ink-subtle)">
                    Retry classification:{' '}
                    <code className="mono">{entry.error.retryStrategy}</code>
                  </p>
                </div>
              </section>
            ) : null}

            <JsonSection title="Input" value={entry.input} />
            {entry.output !== null ? <JsonSection title="Output" value={entry.output} /> : null}

            {/* Stated explicitly, because its absence is a deliberate design
                decision rather than an oversight. */}
            <p className="mt-4 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-2.5 text-[10px] text-(--color-ink-subtle)">
              Request headers are not recorded. Authorization headers, tokens and client secrets
              never enter the activity log, so they cannot appear here or in a screenshot of it.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const json = prettyJson(value);

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-(--color-ink)">{title}</h3>
        <CopyButton value={json} label="Copy" />
      </div>
      <pre className="mono max-h-64 overflow-auto rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) p-3 text-(--color-ink-muted)">
        {json}
      </pre>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-(--color-surface) p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">{label}</p>
      <p className="mt-0.5 text-xs font-medium capitalize text-(--color-ink)">{value}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <dt className="text-(--color-ink-muted)">{label}</dt>
      <dd className="col-span-2 text-(--color-ink)">{children}</dd>
    </div>
  );
}
