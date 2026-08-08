/**
 * Settings.
 *
 * Shows connection information only. There is no field on this page capable of
 * displaying a token — not masked, not truncated. The credential is identified
 * by an opaque SHA-256 fingerprint, which answers "which credential is loaded"
 * and "did it change" without any part of the secret being recoverable.
 */

import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2Off, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Button,
  PageHeader,
  Panel,
  PanelHeader,
  StatusPill,
  Skeleton,
} from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { keys, useConnection, useStatus } from '@/hooks/useConnector';
import { api } from '@/services/api';
import { formatDuration, formatTimestamp } from '@/lib/utils';

export function SettingsPage() {
  const status = useStatus();
  const connection = useConnection();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.connection });
    void queryClient.invalidateQueries({ queryKey: keys.status });
  };

  const disconnect = (): void => {
    void api
      .disconnect()
      .then((result) => {
        toast({ tone: 'info', title: 'Disconnected', description: result.note });
        refreshAll();
      })
      .catch(() => {
        toast({ tone: 'error', title: 'Disconnect failed' });
      });
  };

  const auth = connection.data?.auth;
  const config = status.data?.config;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        description="Connection and configuration. No credential values are displayed here."
        actions={
          <Button icon={RefreshCw} onClick={refreshAll} loading={connection.isFetching}>
            Test connection
          </Button>
        }
      />

      {/* Connection */}
      <Panel className="mb-4">
        <PanelHeader title="Connection" />

        {connection.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : (
          <dl className="divide-y divide-(--color-hairline)">
            <Row label="Provider">
              <span className="capitalize text-(--color-ink)">Asana</span>
            </Row>

            <Row label="Status">
              {connection.data?.connected === true ? (
                <StatusPill tone="success">Connected</StatusPill>
              ) : (
                <StatusPill tone="warning">Not connected</StatusPill>
              )}
            </Row>

            <Row label="Mode">
              {config?.mode === 'demo' ? (
                <div>
                  <StatusPill tone="warning">Demo</StatusPill>
                  <p className="mt-1 text-xs text-(--color-ink-subtle)">{config.modeReason}</p>
                </div>
              ) : (
                <StatusPill tone="success">Live</StatusPill>
              )}
            </Row>

            <Row label="Account">
              {connection.data?.account !== null && connection.data?.account !== undefined ? (
                <div>
                  <p className="text-(--color-ink)">{connection.data.account.name ?? 'Unknown'}</p>
                  <p className="text-xs text-(--color-ink-subtle)">
                    {connection.data.account.email ?? '—'}
                  </p>
                </div>
              ) : (
                <span className="text-(--color-ink-subtle)">Not authenticated</span>
              )}
            </Row>

            <Row label="Workspaces">
              {(connection.data?.workspaces.length ?? 0) > 0 ? (
                <ul className="space-y-1">
                  {connection.data?.workspaces.map((workspace) => (
                    <li key={workspace.id} className="flex items-center gap-2">
                      <span className="text-(--color-ink)">{workspace.name ?? 'Unnamed'}</span>
                      <code className="id-chip">{workspace.id}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-(--color-ink-subtle)">None visible</span>
              )}
            </Row>

            <Row label="Last verified">
              {connection.data !== undefined ? (
                <span className="text-xs text-(--color-ink-muted)">
                  {formatTimestamp(connection.data.checkedAt)} ·{' '}
                  {formatDuration(connection.data.latencyMs)}
                </span>
              ) : (
                '—'
              )}
            </Row>

            {connection.data?.error !== null && connection.data?.error !== undefined ? (
              <Row label="Error">
                <div>
                  <code className="id-chip">{connection.data.error.code}</code>
                  <p className="mt-1 text-xs text-(--color-ink-muted)">
                    {connection.data.error.guidance}
                  </p>
                </div>
              </Row>
            ) : null}
          </dl>
        )}
      </Panel>

      {/* Authentication */}
      <Panel className="mb-4">
        <PanelHeader
          title="Authentication"
          description="Credentials are held server-side. This console never receives one."
        />

        <dl className="divide-y divide-(--color-hairline)">
          <Row label="Method">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-(--color-ink-subtle)" aria-hidden="true" />
              <span className="text-(--color-ink)">
                {auth?.type === 'pat'
                  ? 'Personal Access Token'
                  : auth?.type === 'oauth'
                    ? 'OAuth 2.0'
                    : 'None configured'}
              </span>
            </div>
          </Row>

          <Row label="Credential">
            {auth?.fingerprint !== null && auth?.fingerprint !== undefined ? (
              <div>
                <code className="id-chip">{auth.fingerprint}</code>
                {/* Explains why this is a hash and not a masked token. */}
                <p className="mt-1 text-[11px] text-(--color-ink-subtle)">
                  A one-way SHA-256 fingerprint. It identifies which credential is loaded and
                  changes if the credential changes, but no part of the secret is recoverable from
                  it.
                </p>
              </div>
            ) : (
              <span className="text-(--color-ink-subtle)">None loaded</span>
            )}
          </Row>

          <Row label="Scopes">
            {(auth?.scopes.length ?? 0) > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {auth?.scopes.map((scope) => (
                  <code key={scope} className="id-chip">
                    {scope}
                  </code>
                ))}
              </div>
            ) : (
              <span className="text-xs text-(--color-ink-subtle)">
                {auth?.type === 'pat'
                  ? 'Asana does not scope Personal Access Tokens — a PAT carries its creator’s full permissions.'
                  : '—'}
              </span>
            )}
          </Row>

          <Row label="Expires">
            {auth?.expiresAt !== null && auth?.expiresAt !== undefined ? (
              formatTimestamp(auth.expiresAt)
            ) : (
              <span className="text-(--color-ink-subtle)">
                {auth?.type === 'pat' ? 'Does not expire' : '—'}
              </span>
            )}
          </Row>

          <Row label="Encryption at rest">
            {config?.credentialEncryptionEnabled === true ? (
              <StatusPill tone="success">AES-256-GCM enabled</StatusPill>
            ) : (
              <div>
                <StatusPill tone="neutral">Memory only</StatusPill>
                <p className="mt-1 text-[11px] text-(--color-ink-subtle)">
                  Credentials are not written to disk. Set CREDENTIAL_ENCRYPTION_KEY to persist
                  OAuth tokens across restarts.
                </p>
              </div>
            )}
          </Row>
        </dl>

        <div className="flex flex-wrap gap-2 border-t border-(--color-hairline) p-4">
          {config?.auth.oauthConfigured === true ? (
            <a
              href="/api/auth/oauth/start"
              className="inline-flex h-9 items-center gap-2 rounded-(--radius-md) bg-(--color-accent) px-3.5 text-sm font-medium text-white hover:bg-(--color-accent-hover)"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {connection.data?.connected === true ? 'Reconnect with Asana' : 'Connect with Asana'}
            </a>
          ) : (
            <p className="text-xs text-(--color-ink-subtle)">
              OAuth is not configured. Set ASANA_OAUTH_CLIENT_ID and ASANA_OAUTH_CLIENT_SECRET in
              .env to enable the browser connect flow, or use a Personal Access Token.
            </p>
          )}

          {auth?.type === 'oauth' ? (
            <Button variant="danger" icon={Link2Off} onClick={disconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </Panel>

      {/* Runtime configuration */}
      <Panel>
        <PanelHeader
          title="Runtime configuration"
          description="Resolved from environment variables. Secret values are structurally excluded."
        />
        <dl className="divide-y divide-(--color-hairline)">
          <Row label="API base URL">
            <code className="mono text-(--color-ink-muted)">{config?.asana.baseUrl ?? '—'}</code>
          </Row>
          <Row label="Rate limit">
            <span className="text-(--color-ink-muted)">
              {config?.asana.rateLimitRpm ?? '—'} requests/minute (client-side throttle)
            </span>
          </Row>
          <Row label="Timeout">
            <span className="text-(--color-ink-muted)">
              {formatDuration(config?.asana.timeoutMs)}
            </span>
          </Row>
          <Row label="Max concurrency">
            <span className="text-(--color-ink-muted)">{config?.asana.maxConcurrency ?? '—'}</span>
          </Row>
          <Row label="MCP transport">
            <span className="uppercase text-(--color-ink-muted)">
              {config?.mcp.transport ?? '—'}
            </span>
          </Row>
        </dl>
      </Panel>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 px-4 py-3 text-sm">
      <dt className="text-xs text-(--color-ink-muted)">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  );
}
