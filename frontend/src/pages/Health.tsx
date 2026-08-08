/**
 * Health page.
 *
 * The health check is strictly read-only: server-side it reuses
 * `testConnection`, the one operation proven side-effect-free by test. Running
 * it repeatedly is safe, which is the whole point of a health check.
 */

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HeartPulse, KeyRound, RefreshCw, XCircle } from 'lucide-react';
import {
  AsyncBoundary,
  Button,
  PageHeader,
  Panel,
  PanelHeader,
  StatusPill,
  TableSkeleton,
  type StatusTone,
} from '@/components/ui';
import { keys, useHealth, useStatus } from '@/hooks/useConnector';
import { formatDuration, formatTimestamp } from '@/lib/utils';
import type { ComponentStatus } from '@/types/api';

const STATUS_META: Record<
  ComponentStatus,
  { tone: StatusTone; label: string; icon: typeof CheckCircle2 }
> = {
  healthy: { tone: 'success', label: 'Healthy', icon: CheckCircle2 },
  warning: { tone: 'warning', label: 'Warning', icon: AlertTriangle },
  offline: { tone: 'danger', label: 'Offline', icon: XCircle },
  auth_required: { tone: 'warning', label: 'Authentication required', icon: KeyRound },
};

export function Health() {
  const health = useHealth();
  const status = useStatus();
  const queryClient = useQueryClient();

  const runCheck = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.health });
    void queryClient.invalidateQueries({ queryKey: keys.connection });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Connector Health"
        description="Component status. Health checks are read-only and never modify Asana data."
        actions={
          <Button icon={RefreshCw} onClick={runCheck} loading={health.isFetching}>
            Run health check
          </Button>
        }
      />

      <AsyncBoundary
        isLoading={health.isLoading}
        error={health.error}
        data={health.data}
        loadingFallback={<TableSkeleton rows={5} columns={3} />}
        onRetry={runCheck}
      >
        {(data) => (
          <>
            <Panel className="mb-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <HeartPulse
                    className={
                      data.status === 'healthy'
                        ? 'h-5 w-5 text-(--color-success)'
                        : 'h-5 w-5 text-(--color-warning)'
                    }
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm font-semibold capitalize text-(--color-ink)">
                      {data.status === 'unauthenticated' ? 'Authentication required' : data.status}
                    </p>
                    <p className="text-xs text-(--color-ink-muted)">
                      Last checked {formatTimestamp(data.checkedAt)}
                    </p>
                  </div>
                </div>

                <StatusPill
                  tone={
                    data.status === 'healthy'
                      ? 'success'
                      : data.status === 'degraded'
                        ? 'warning'
                        : 'warning'
                  }
                >
                  {data.components.filter((c) => c.status === 'healthy').length}/
                  {data.components.length} healthy
                </StatusPill>
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Components" />
              <ul className="divide-y divide-(--color-hairline)">
                {data.components.map((component) => {
                  const meta = STATUS_META[component.status];
                  const Icon = meta.icon;

                  return (
                    <li
                      key={component.name}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            meta.tone === 'success'
                              ? 'text-(--color-success)'
                              : meta.tone === 'danger'
                                ? 'text-(--color-danger)'
                                : 'text-(--color-warning)'
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-(--color-ink)">{component.name}</p>
                          <p className="text-xs text-(--color-ink-muted)">{component.detail}</p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        {component.latencyMs !== null ? (
                          <span className="text-xs tabular-nums text-(--color-ink-subtle)">
                            {formatDuration(component.latencyMs)}
                          </span>
                        ) : null}
                        {/* Icon + text label: status never depends on colour alone. */}
                        <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            {status.data !== undefined ? (
              <Panel className="mt-4">
                <PanelHeader
                  title="Client counters"
                  description="Cumulative since the API process started."
                />
                <dl className="grid grid-cols-2 gap-px bg-(--color-hairline) sm:grid-cols-4">
                  <Counter label="Requests" value={status.data.client.totalRequests} />
                  <Counter label="Retries" value={status.data.client.totalRetries} />
                  <Counter label="Rate-limit hits" value={status.data.client.rateLimitHits} />
                  <Counter label="In flight" value={status.data.client.inFlight} />
                </dl>
              </Panel>
            ) : null}
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-(--color-surface) p-4">
      <dt className="text-xs text-(--color-ink-muted)">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-(--color-ink)">{value}</dd>
    </div>
  );
}
