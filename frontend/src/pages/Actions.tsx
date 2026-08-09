/**
 * Action Center.
 *
 * All 35 actions as cards, each showing its technical id verbatim, its
 * read/write classification, risk level and the safety metadata the connector
 * publishes. Ids are rendered exactly as assigned — this page is where a
 * reviewer checks that nothing has been renamed.
 *
 * At 35 actions, a flat list of fully-expanded cards is a wall of text rather
 * than a usable reference. This groups by category (mirroring the registry's
 * own grouping), collapses the safety detail behind a toggle so the page scans
 * quickly, and adds search/filter so the five required actions are still easy
 * to find at a glance.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ChevronDown,
  Lock,
  RefreshCcw,
  Search,
  ShieldAlert,
  Unlock,
} from 'lucide-react';
import {
  AsyncBoundary,
  Input,
  PageHeader,
  Panel,
  StatusPill,
  TableSkeleton,
} from '@/components/ui';
import { useActions } from '@/hooks/useConnector';
import { cn } from '@/lib/utils';
import { REQUIRED_ACTION_IDS, type ActionSummary } from '@/types/api';

const CATEGORY_LABELS: Record<ActionSummary['category'], string> = {
  tasks: 'Tasks',
  projects: 'Projects',
  sections: 'Sections',
  comments: 'Comments',
  tags: 'Tags',
  users: 'Users',
};

const CATEGORY_ORDER: readonly ActionSummary['category'][] = [
  'tasks',
  'projects',
  'sections',
  'comments',
  'tags',
  'users',
];

export function Actions() {
  const actions = useActions();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ActionSummary['category'] | 'all'>('all');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Action Center"
        description="All 35 connector actions, with their published safety contracts. The five assignment-required actions are marked."
      />

      <AsyncBoundary
        isLoading={actions.isLoading}
        error={actions.error}
        data={actions.data}
        loadingFallback={<TableSkeleton rows={5} columns={3} />}
        onRetry={() => void actions.refetch()}
      >
        {(data) => (
          <ActionsList allActions={data.actions} search={search} onSearch={setSearch} category={category} onCategory={setCategory} />
        )}
      </AsyncBoundary>
    </div>
  );
}

function ActionsList({
  allActions,
  search,
  onSearch,
  category,
  onCategory,
}: {
  allActions: readonly ActionSummary[];
  search: string;
  onSearch: (value: string) => void;
  category: ActionSummary['category'] | 'all';
  onCategory: (value: ActionSummary['category'] | 'all') => void;
}) {
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allActions.filter((a) => {
      if (category !== 'all' && a.category !== category) return false;
      if (term.length === 0) return true;
      return a.id.toLowerCase().includes(term) || a.name.toLowerCase().includes(term);
    });
  }, [allActions, search, category]);

  const grouped = useMemo(() => {
    const map = new Map<ActionSummary['category'], ActionSummary[]>();
    for (const action of filtered) {
      const list = map.get(action.category) ?? [];
      list.push(action);
      map.set(action.category, list);
    }
    return map;
  }, [filtered]);

  const counts = useMemo(() => {
    const c = new Map<ActionSummary['category'], number>();
    for (const action of allActions) c.set(action.category, (c.get(action.category) ?? 0) + 1);
    return c;
  }, [allActions]);

  return (
    <>
      <Panel className="mb-4 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--color-ink-subtle)"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Filter by id or name…"
              aria-label="Filter actions"
              className="pl-8"
            />
          </div>

          <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-1">
            <CategoryChip active={category === 'all'} onClick={() => onCategory('all')}>
              All ({allActions.length})
            </CategoryChip>
            {CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0).map((c) => (
              <CategoryChip key={c} active={category === c} onClick={() => onCategory(c)}>
                {CATEGORY_LABELS[c]} ({counts.get(c) ?? 0})
              </CategoryChip>
            ))}
          </div>
        </div>
      </Panel>

      {filtered.length === 0 ? (
        <Panel className="p-8 text-center text-sm text-(--color-ink-muted)">
          No actions match &ldquo;{search}&rdquo;.
        </Panel>
      ) : (
        <div className="space-y-6">
          {CATEGORY_ORDER.filter((c) => grouped.has(c)).map((c) => (
            <section key={c} aria-labelledby={`category-${c}`}>
              <h2
                id={`category-${c}`}
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-ink-subtle)"
              >
                {CATEGORY_LABELS[c]}
              </h2>
              <div className="grid gap-3">
                {grouped.get(c)!.map((action) => (
                  <ActionCard key={action.id} action={action} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-(--radius-sm) px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-(--color-accent-muted) text-(--color-ink-onBadge)'
          : 'text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink)',
      )}
    >
      {children}
    </button>
  );
}

function ActionCard({ action }: { action: ActionSummary }) {
  const isWrite = action.type === 'write';
  const isRequired = (REQUIRED_ACTION_IDS as readonly string[]).includes(action.id);
  // Required actions and any write action start expanded — everything else
  // is available on demand, since 35 always-open cards is unreadable.
  const [open, setOpen] = useState(isRequired);

  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-(--color-ink)">{action.name}</h3>

            {isRequired ? <StatusPill tone="success">Required</StatusPill> : null}
            <StatusPill tone={isWrite ? 'warning' : 'info'}>{isWrite ? 'WRITE' : 'READ'}</StatusPill>
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

          <code className="mono mt-1.5 block text-(--color-accent)">{action.id}</code>
          <p className="mt-2 max-w-2xl text-sm text-(--color-ink-muted)">{action.description}</p>
        </div>

        <ChevronDown
          className={cn(
            'mt-1 h-4 w-4 shrink-0 text-(--color-ink-subtle) transition-transform',
            open ? 'rotate-180' : '',
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="border-t border-(--color-hairline) px-4 pb-4 pt-3">
          <div className="mb-3">
            <Link
              to={`/playground?action=${action.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) px-3 py-1.5 text-xs font-medium text-(--color-ink) transition-colors hover:border-(--color-hairline-strong)"
            >
              Execute
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>

          <dl className="grid gap-3 border-t border-(--color-hairline) pt-3 sm:grid-cols-2">
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
                action.safety.idempotent ? 'Yes — safe to repeat' : 'No — repeating creates a duplicate'
              }
            />
            <SafetyItem icon={ShieldAlert} label="Duplicates" value={action.safety.duplicateBehavior} />
            <SafetyItem icon={RefreshCcw} label="Retries" value={action.safety.retryBehavior} />
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--color-hairline) pt-3">
            <span className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
              Endpoints
            </span>
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
        </div>
      ) : null}
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
