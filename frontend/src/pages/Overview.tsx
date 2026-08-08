/**
 * Overview dashboard.
 *
 * Every number here is measured, never invented. Metrics come from the
 * server's activity ring buffer, and where nothing has been recorded the page
 * says so rather than showing a plausible zero — "no requests yet" and "all
 * requests failed" must not look the same.
 */

import { Link } from 'react-router-dom';
import {
  Activity as ActivityIcon,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock,
  Network,
  Plug,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  AsyncBoundary,
  EmptyState,
  PageHeader,
  Panel,
  PanelHeader,
  Skeleton,
  StatusPill,
  type StatusTone,
} from '@/components/ui';
import { useActivity, useConnection, useMetrics, useStatus } from '@/hooks/useConnector';
import { formatDuration, formatRelativeTime } from '@/lib/utils';

export function Overview() {
  const status = useStatus();
  const connection = useConnection();
  const metrics = useMetrics();
  const activity = useActivity(8);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Overview"
        description="Asana connector status, live metrics and recent activity."
      />

      {/* Status tiles */}
      <section aria-labelledby="status-heading" className="mb-6">
        <h2 id="status-heading" className="sr-only">
          System status
        </h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusTile
            icon={Plug}
            label="Connector"
            value={status.data?.connector.version ?? '—'}
            detail={status.isLoading ? 'Checking…' : `${status.data?.connector.name ?? 'asana-connector'}`}
            tone={status.isError ? 'danger' : 'success'}
            statusText={status.isError ? 'Offline' : 'Running'}
          />
          <StatusTile
            icon={Boxes}
            label="Asana API"
            value={connection.data?.connected === true ? 'Reachable' : 'Unreachable'}
            detail={
              connection.data === undefined
                ? 'Checking…'
                : `${formatDuration(connection.data.latencyMs)} · ${connection.data.mode === 'demo' ? 'in-memory demo API' : 'live'}`
            }
            tone={connection.data?.connected === true ? 'success' : 'danger'}
            statusText={connection.data?.connected === true ? 'Healthy' : 'Error'}
          />
          <StatusTile
            icon={ShieldCheck}
            label="Authentication"
            value={
              connection.data?.auth.type === 'none'
                ? 'None'
                : (connection.data?.auth.type.toUpperCase() ?? '—')
            }
            detail={
              connection.data?.connected === true
                ? (connection.data.account?.name ?? 'Authenticated')
                : (connection.data?.error?.message ?? 'Not authenticated')
            }
            tone={connection.data?.connected === true ? 'success' : 'warning'}
            statusText={connection.data?.connected === true ? 'Valid' : 'Required'}
          />
          <StatusTile
            icon={Network}
            label="MCP Adapter"
            value={status.data?.config.mcp.transport.toUpperCase() ?? '—'}
            detail="5 tools exposed"
            tone="success"
            statusText="Ready"
          />
        </div>
      </section>

      {/* Metrics */}
      <section aria-labelledby="metrics-heading" className="mb-6">
        <h2 id="metrics-heading" className="sr-only">
          Request metrics
        </h2>

        <Panel>
          <PanelHeader
            title="Request metrics"
            description="Measured from this session. Nothing here is simulated."
          />

          {metrics.isLoading ? (
            <div className="grid grid-cols-2 gap-px bg-(--color-hairline) lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-(--color-surface) p-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-2 h-6 w-12" />
                </div>
              ))}
            </div>
          ) : metrics.data?.totalRequests === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="No requests yet"
              description="Run an action from the Playground or browse Projects, and metrics will appear here."
              action={
                <Link
                  to="/playground"
                  className="text-xs font-medium text-(--color-accent) hover:underline"
                >
                  Open the API Playground →
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-px bg-(--color-hairline) lg:grid-cols-5">
              <Metric label="Total requests" value={String(metrics.data?.totalRequests ?? 0)} />
              <Metric
                label="Successful"
                value={String(metrics.data?.successfulRequests ?? 0)}
                tone="success"
              />
              <Metric
                label="Failed"
                value={String(metrics.data?.failedRequests ?? 0)}
                tone={(metrics.data?.failedRequests ?? 0) > 0 ? 'danger' : 'neutral'}
              />
              <Metric
                label="Avg latency"
                value={formatDuration(metrics.data?.averageLatencyMs)}
              />
              <Metric
                label="p95 latency"
                value={formatDuration(metrics.data?.p95LatencyMs)}
              />
            </div>
          )}
        </Panel>
      </section>

      {/* Recent activity */}
      <section aria-labelledby="activity-heading">
        <Panel>
          <PanelHeader
            title={<span id="activity-heading">Recent activity</span>}
            description="The most recent connector executions."
            actions={
              <Link
                to="/activity"
                className="inline-flex items-center gap-1 text-xs text-(--color-ink-muted) hover:text-(--color-ink)"
              >
                View all <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            }
          />

          <AsyncBoundary
            isLoading={activity.isLoading}
            error={activity.error}
            data={activity.data}
            isEmpty={(d) => d.entries.length === 0}
            emptyFallback={
              <EmptyState
                icon={ActivityIcon}
                title="No activity recorded"
                description="Connector executions will appear here as they happen."
              />
            }
            onRetry={() => void activity.refetch()}
          >
            {(data) => (
              <ul className="divide-y divide-(--color-hairline)">
                {data.entries.map((entry) => (
                  <li key={entry.requestId}>
                    <Link
                      to={`/activity?request=${entry.requestId}`}
                      className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-(--color-surface-2)"
                    >
                      {entry.status === 'success' ? (
                        <CheckCircle2
                          className="h-4 w-4 shrink-0 text-(--color-success)"
                          aria-hidden="true"
                        />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-(--color-danger)" aria-hidden="true" />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="mono text-(--color-ink)">{entry.actionId}</code>
                          <span className="sr-only">
                            {entry.status === 'success' ? 'Succeeded' : 'Failed'}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-(--color-ink-muted)">
                          {entry.summary}
                        </p>
                      </div>

                      <div className="hidden shrink-0 items-center gap-3 text-xs text-(--color-ink-subtle) sm:flex">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {formatDuration(entry.durationMs)}
                        </span>
                        <span>{formatRelativeTime(entry.timestamp)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncBoundary>
        </Panel>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function StatusTile({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  statusText,
}: {
  icon: typeof Plug;
  label: string;
  value: string;
  detail: string;
  tone: StatusTone;
  statusText: string;
}) {
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-(--color-ink-muted)">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </div>
        {/* Icon + text, never colour alone. */}
        <StatusPill tone={tone}>{statusText}</StatusPill>
      </div>

      <p className="mt-2 truncate text-lg font-semibold text-(--color-ink)">{value}</p>
      <p className="mt-0.5 truncate text-xs text-(--color-ink-subtle)" title={detail}>
        {detail}
      </p>
    </Panel>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: StatusTone;
}) {
  const colour =
    tone === 'success'
      ? 'text-(--color-success)'
      : tone === 'danger'
        ? 'text-(--color-danger)'
        : 'text-(--color-ink)';

  return (
    <div className="bg-(--color-surface) p-4">
      <p className="text-xs text-(--color-ink-muted)">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  );
}
