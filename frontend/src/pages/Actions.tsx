/**
 * Action Center.
 *
 * The five actions as cards, each showing its technical id verbatim, its
 * read/write classification, risk level and the safety metadata the connector
 * publishes. The ids are rendered exactly as assigned — this page is where a
 * reviewer checks that nothing has been renamed.
 */

import { Link } from 'react-router-dom';
import { ArrowRight, Lock, RefreshCcw, ShieldAlert, Unlock } from 'lucide-react';
import { AsyncBoundary, PageHeader, Panel, StatusPill, TableSkeleton } from '@/components/ui';
import { useActions } from '@/hooks/useConnector';
import type { ActionSummary } from '@/types/api';

export function Actions() {
  const actions = useActions();

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Action Center"
        description="The five connector actions, with their published safety contracts."
      />

      <AsyncBoundary
        isLoading={actions.isLoading}
        error={actions.error}
        data={actions.data}
        loadingFallback={<TableSkeleton rows={5} columns={3} />}
        onRetry={() => void actions.refetch()}
      >
        {(data) => (
          <div className="grid gap-3">
            {data.actions.map((action) => (
              <ActionCard key={action.id} action={action} />
            ))}
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

function ActionCard({ action }: { action: ActionSummary }) {
  const isWrite = action.type === 'write';

  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-(--color-ink)">{action.name}</h2>

            <StatusPill tone={isWrite ? 'warning' : 'info'}>
              {isWrite ? 'WRITE' : 'READ'}
            </StatusPill>

            <StatusPill
              tone={
                action.safety.risk === 'high'
                  ? 'danger'
                  : action.safety.risk === 'medium'
                    ? 'warning'
                    : 'neutral'
              }
            >
              Risk: {action.safety.risk}
            </StatusPill>

            {action.supportsPagination ? <StatusPill tone="neutral">Paginated</StatusPill> : null}
          </div>

          {/* The assigned id, shown verbatim. */}
          <code className="mono mt-1.5 block text-(--color-accent)">{action.id}</code>

          <p className="mt-2 max-w-2xl text-sm text-(--color-ink-muted)">{action.description}</p>
        </div>

        <Link
          to={`/playground?action=${action.id}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) px-3 py-1.5 text-xs font-medium text-(--color-ink) transition-colors hover:border-(--color-hairline-strong)"
        >
          Execute
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>

      {/* Safety contract */}
      <dl className="mt-4 grid gap-3 border-t border-(--color-hairline) pt-3 sm:grid-cols-2">
        <SafetyItem
          icon={isWrite ? Lock : Unlock}
          label="Approval"
          value={
            action.safety.requiresApproval
              ? 'Required — will not run without approved: true'
              : 'Not required (read-only)'
          }
        />
        <SafetyItem
          icon={RefreshCcw}
          label="Idempotent"
          value={
            action.safety.idempotent
              ? 'Yes — safe to repeat'
              : 'No — repeating creates a duplicate'
          }
        />
        <SafetyItem icon={ShieldAlert} label="Duplicates" value={action.safety.duplicateBehavior} />
        <SafetyItem icon={RefreshCcw} label="Retries" value={action.safety.retryBehavior} />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--color-hairline) pt-3">
        <span className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">Endpoints</span>
        {action.endpoints.map((endpoint) => (
          <code key={endpoint} className="id-chip">
            {endpoint}
          </code>
        ))}
        <span className="ml-2 text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
          Scopes
        </span>
        {action.scopes.map((scope) => (
          <code key={scope} className="id-chip">
            {scope}
          </code>
        ))}
      </div>
    </Panel>
  );
}

function SafetyItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Lock;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-ink-subtle)" aria-hidden="true" />
      <div className="min-w-0">
        <dt className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">{label}</dt>
        <dd className="mt-0.5 text-xs text-(--color-ink-muted)">{value}</dd>
      </div>
    </div>
  );
}
