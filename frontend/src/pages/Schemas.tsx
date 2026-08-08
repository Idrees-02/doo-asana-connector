/**
 * Schema Inspector.
 *
 * Renders the JSON Schema the server generates from the connector's Zod
 * schemas. Nothing on this page is hand-written documentation — what is shown
 * is mechanically derived from the definitions the runtime validates against,
 * so it cannot describe a contract the code does not enforce.
 */

import { useState } from 'react';
import { AsyncBoundary, PageHeader, Panel, PanelHeader, StatusPill, TableSkeleton } from '@/components/ui';
import { CopyButton } from './Playground';
import { useSchema } from '@/hooks/useConnector';
import { prettyJson } from '@/lib/utils';
import { ACTION_IDS, type ActionId } from '@/types/api';

export function Schemas() {
  const [selected, setSelected] = useState<ActionId>('asana.list_projects');
  const schema = useSchema(selected);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Schema Inspector"
        description="Input and output JSON Schema for each action, generated from the connector's own validation schemas."
      />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Action list */}
        <nav aria-label="Actions">
          <Panel className="overflow-hidden">
            <ul>
              {ACTION_IDS.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setSelected(id)}
                    aria-current={selected === id ? 'true' : undefined}
                    className={`w-full border-b border-(--color-hairline) px-3 py-2.5 text-left text-xs transition-colors last:border-0 ${
                      selected === id
                        ? 'bg-(--color-surface-3) font-medium text-(--color-ink)'
                        : 'text-(--color-ink-muted) hover:bg-(--color-surface-2)'
                    }`}
                  >
                    <code className="mono block truncate">{id}</code>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </nav>

        <AsyncBoundary
          isLoading={schema.isLoading}
          error={schema.error}
          data={schema.data}
          loadingFallback={<TableSkeleton rows={6} columns={2} />}
          onRetry={() => void schema.refetch()}
        >
          {(data) => (
            <div className="min-w-0 space-y-4">
              <Panel className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-(--color-ink)">{data.name}</h2>
                  <StatusPill tone={data.safety.write ? 'warning' : 'info'}>
                    {data.safety.write ? 'WRITE' : 'READ'}
                  </StatusPill>
                  <StatusPill tone={data.safety.requiresApproval ? 'warning' : 'neutral'}>
                    {data.safety.requiresApproval ? 'Approval required' : 'No approval needed'}
                  </StatusPill>
                  <StatusPill tone={data.safety.idempotent ? 'success' : 'danger'}>
                    {data.safety.idempotent ? 'Idempotent' : 'Not idempotent'}
                  </StatusPill>
                </div>

                <p className="mt-2 text-sm text-(--color-ink-muted)">{data.description}</p>

                <dl className="mt-3 space-y-2 border-t border-(--color-hairline) pt-3 text-xs">
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
                      Duplicate behaviour
                    </dt>
                    <dd className="mt-0.5 text-(--color-ink-muted)">
                      {data.safety.duplicateBehavior}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
                      Retry behaviour
                    </dt>
                    <dd className="mt-0.5 text-(--color-ink-muted)">{data.safety.retryBehavior}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
                      Idempotency
                    </dt>
                    <dd className="mt-0.5 text-(--color-ink-muted)">
                      {data.safety.idempotencyBehavior}
                    </dd>
                  </div>
                </dl>
              </Panel>

              <SchemaPanel title="Input schema" schema={data.input} />
              <SchemaPanel title="Output schema" schema={data.output} />

              <Panel>
                <PanelHeader title="Examples" />
                <div className="space-y-3 p-4">
                  {data.examples.map((example) => (
                    <div key={example.title}>
                      <p className="text-xs font-medium text-(--color-ink)">{example.title}</p>
                      {example.description !== undefined ? (
                        <p className="mt-0.5 text-[11px] text-(--color-ink-subtle)">
                          {example.description}
                        </p>
                      ) : null}
                      <pre className="mono mt-1.5 overflow-x-auto rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) p-2.5 text-(--color-ink-muted)">
                        {prettyJson(example.input)}
                      </pre>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          )}
        </AsyncBoundary>
      </div>
    </div>
  );
}

function SchemaPanel({ title, schema }: { title: string; schema: Record<string, unknown> }) {
  const json = prettyJson(schema);
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const properties =
    typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? Object.keys(schema['properties'] as Record<string, unknown>)
      : [];
  const optional = properties.filter((p) => !required.includes(p));

  return (
    <Panel>
      <PanelHeader
        title={title}
        description={
          properties.length > 0
            ? `${required.length} required, ${optional.length} optional`
            : undefined
        }
        actions={<CopyButton value={json} />}
      />

      {properties.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-(--color-hairline) px-4 py-2.5">
          {required.map((field) => (
            <code key={field} className="id-chip border-(--color-accent)/40 text-(--color-accent)">
              {field}*
            </code>
          ))}
          {optional.map((field) => (
            <code key={field} className="id-chip">
              {field}
            </code>
          ))}
        </div>
      ) : null}

      <pre className="mono max-h-96 overflow-auto p-4 text-(--color-ink-muted)">{json}</pre>
    </Panel>
  );
}
