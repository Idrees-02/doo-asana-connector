/**
 * API Playground.
 *
 * A developer console over the connector. The write-safety design shows up
 * here too: write actions require the approval switch to be turned on
 * deliberately before Execute is enabled, so the Playground cannot become a
 * way to create tasks by accident while exploring.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Copy, Play } from 'lucide-react';
import {
  Button,
  ErrorState,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  StatusPill,
} from '@/components/ui';
import { useActions, useSchema } from '@/hooks/useConnector';
import { api, ApiError } from '@/services/api';
import { copyToClipboard, formatDuration, prettyJson } from '@/lib/utils';
import type { ExecutionEnvelope } from '@/types/api';

export function Playground() {
  const [searchParams, setSearchParams] = useSearchParams();
  const actions = useActions();

  const selectedId = searchParams.get('action') ?? 'asana.list_projects';
  const schema = useSchema(selectedId);
  const action = actions.data?.actions.find((a) => a.id === selectedId);

  const [input, setInput] = useState('{}');
  const [approved, setApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionEnvelope<unknown> | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [view, setView] = useState<'pretty' | 'raw'>('pretty');

  // Seed the editor with the action's first documented example, and reset
  // approval whenever the action changes — approval must never carry over.
  useEffect(() => {
    setApproved(false);
    setResult(null);
    setFailure(null);

    const example = action?.examples[0]?.input;
    setInput(example === undefined ? '{}' : prettyJson(example));
  }, [selectedId, action]);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(input) as unknown };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : 'Invalid JSON' };
    }
  }, [input]);

  const requiresApproval = action?.safety.requiresApproval === true;
  const canExecute = parsed.ok && !running && (!requiresApproval || approved);

  const execute = async (): Promise<void> => {
    if (!parsed.ok) return;

    setRunning(true);
    setResult(null);
    setFailure(null);

    try {
      const envelope = await api.execute(selectedId, parsed.value, {
        ...(requiresApproval ? { approved } : {}),
      });
      setResult(envelope);
    } catch (error) {
      if (error instanceof ApiError) setFailure(error);
      else setFailure(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="API Playground"
        description="Execute connector actions and inspect the exact request and response."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Request */}
        <Panel>
          <PanelHeader
            title="Request"
            description={action?.description}
            actions={
              action !== undefined ? (
                <StatusPill tone={action.type === 'write' ? 'warning' : 'info'}>
                  {action.type.toUpperCase()}
                </StatusPill>
              ) : undefined
            }
          />

          <div className="space-y-3 p-4">
            <div>
              <label htmlFor="action-select" className="mb-1.5 block text-xs font-medium">
                Action
              </label>
              <Select
                id="action-select"
                value={selectedId}
                onChange={(e) => setSearchParams({ action: e.target.value })}
              >
                {actions.data?.actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </Select>
            </div>

            {/* Examples */}
            {action !== undefined && action.examples.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {action.examples.map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    onClick={() => setInput(prettyJson(example.input))}
                    className="rounded-(--radius-sm) border border-(--color-hairline) bg-(--color-surface-2) px-2 py-1 text-[11px] text-(--color-ink-muted) transition-colors hover:text-(--color-ink)"
                    title={example.description ?? example.title}
                  >
                    {example.title}
                  </button>
                ))}
              </div>
            ) : null}

            <div>
              <label htmlFor="input-editor" className="mb-1.5 block text-xs font-medium">
                Input JSON
              </label>
              <textarea
                id="input-editor"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                spellCheck={false}
                rows={12}
                aria-invalid={!parsed.ok}
                aria-describedby={parsed.ok ? undefined : 'json-error'}
                className={`mono w-full resize-y rounded-(--radius-md) border bg-(--color-canvas) p-3 text-(--color-ink) ${
                  parsed.ok ? 'border-(--color-hairline)' : 'border-(--color-danger)'
                }`}
              />
              {!parsed.ok ? (
                <p id="json-error" role="alert" className="mt-1 text-xs text-(--color-danger)">
                  Invalid JSON: {parsed.message}
                </p>
              ) : null}
            </div>

            {/* Approval gate for writes */}
            {requiresApproval ? (
              <div className="rounded-(--radius-md) border border-(--color-warning)/30 bg-(--color-warning-muted) p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warning)"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-(--color-warning)">
                      {action?.safety.duplicateBehavior}
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs font-medium text-(--color-ink)">
                      <input
                        type="checkbox"
                        checked={approved}
                        onChange={(e) => setApproved(e.target.checked)}
                        className="h-3.5 w-3.5 accent-(--color-accent)"
                      />
                      I approve this write to Asana
                    </label>
                  </div>
                </div>
              </div>
            ) : null}

            <Button
              variant="primary"
              icon={Play}
              onClick={() => void execute()}
              disabled={!canExecute}
              loading={running}
            >
              Execute
            </Button>
          </div>
        </Panel>

        {/* Response */}
        <Panel>
          <PanelHeader
            title="Response"
            actions={
              result !== null ? (
                <div className="flex items-center gap-2">
                  <div
                    role="group"
                    aria-label="Response format"
                    className="flex rounded-(--radius-md) border border-(--color-hairline) p-0.5"
                  >
                    {(['pretty', 'raw'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setView(mode)}
                        aria-pressed={view === mode}
                        className={`rounded-(--radius-sm) px-2 py-0.5 text-[11px] capitalize ${
                          view === mode
                            ? 'bg-(--color-surface-3) text-(--color-ink)'
                            : 'text-(--color-ink-muted)'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <CopyButton value={prettyJson(result)} />
                </div>
              ) : undefined
            }
          />

          <div className="p-4">
            {failure !== null ? (
              <ErrorState
                message={failure.message}
                code={failure.code}
                guidance={failure.guidance}
                requestId={failure.payload.requestId}
                details={failure.payload.details}
                needsManualRetry={failure.needsManualRetry}
              />
            ) : result === null ? (
              <p className="py-12 text-center text-xs text-(--color-ink-subtle)">
                Execute an action to see the response, status, duration and request id.
              </p>
            ) : (
              <>
                <div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline) sm:grid-cols-4">
                  <Meta label="Status" value={result.ok ? 'Success' : 'Error'} tone={result.ok} />
                  <Meta label="Duration" value={formatDuration(result.meta.durationMs)} />
                  <Meta label="Attempts" value={String(result.meta.attempts)} />
                  <Meta label="Mode" value={result.meta.mode} />
                </div>

                <div className="mb-3">
                  <span className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">
                    Request ID
                  </span>
                  <code className="id-chip ml-2">{result.meta.requestId}</code>
                </div>

                <pre className="mono max-h-[420px] overflow-auto rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) p-3 text-(--color-ink)">
                  {view === 'pretty'
                    ? prettyJson(result.ok ? result.data : result.error)
                    : JSON.stringify(result)}
                </pre>
              </>
            )}
          </div>
        </Panel>
      </div>

      {/* Schema reference */}
      {schema.data !== undefined ? (
        <Panel className="mt-4">
          <PanelHeader
            title="Input schema"
            description="Generated from the same Zod schema the connector validates against."
          />
          <pre className="mono max-h-80 overflow-auto p-4 text-(--color-ink-muted)">
            {prettyJson(schema.data.input)}
          </pre>
        </Panel>
      ) : null}
    </div>
  );
}

function Meta({ label, value, tone }: { label: string; value: string; tone?: boolean }) {
  return (
    <div className="bg-(--color-surface) p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-(--color-ink-subtle)">{label}</p>
      <p
        className={`mt-0.5 text-xs font-medium capitalize ${
          tone === undefined
            ? 'text-(--color-ink)'
            : tone
              ? 'text-(--color-success)'
              : 'text-(--color-danger)'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy JSON' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      icon={copied ? Check : Copy}
      onClick={() => {
        void copyToClipboard(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}
