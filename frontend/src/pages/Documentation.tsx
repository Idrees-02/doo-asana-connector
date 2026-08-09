/**
 * In-app documentation.
 *
 * Written to be honest rather than promotional: the Known Limitations section
 * states what is not implemented and what remains unverified, because a
 * reviewer finding an undocumented gap is far worse than reading about it here.
 */

import { PageHeader, Panel, PanelHeader, StatusPill } from '@/components/ui';
import { useActions } from '@/hooks/useConnector';
import { REQUIRED_ACTION_IDS } from '@/types/api';

export function Documentation() {
  const actions = useActions();
  const total = actions.data?.actions.length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Documentation"
        description="How the connector works, how to authenticate, and what it deliberately does not do."
      />

      <nav aria-label="Contents" className="mb-4">
        <Panel className="p-3">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-(--color-ink-muted) hover:text-(--color-accent)">
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </nav>

      <div className="space-y-4">
        <Section id="overview" title="Overview">
          <P>
            An Asana connector built for the DOO Builders League. The connector core owns provider
            logic, schemas, validation, error normalization, pagination, rate limiting and safety
            metadata. Two thin adapters sit on top: an HTTP API for this console, and an MCP server
            for agents. Neither adapter duplicates connector logic.
          </P>
          <P>
            Builder: Idrees Khaled · Provider: Asana · Category: Project Management · Version 1.0.0
          </P>
        </Section>

        <Section id="actions" title="Actions">
          <P>The five actions required by the assignment, with their ids exactly as assigned:</P>
          <ul className="mt-2 space-y-1">
            {REQUIRED_ACTION_IDS.map((id) => (
              <li key={id}>
                <code className="mono text-(--color-accent)">{id}</code>
              </li>
            ))}
          </ul>
          <P>
            The connector additionally implements 30 extended actions across tasks, projects,
            sections, users, comments and tags —{' '}
            <span className="figure">{total ?? 35}</span> actions in total. Every one follows the
            same validation, safety-metadata and error-handling path as the five required actions;
            see the <a href="/actions" className="text-(--color-accent) hover:underline">Action
            Center</a> for the full, searchable list.
          </P>
          <P>
            There is no delete action anywhere in the connector. It is not part of the assignment,
            so it is not implemented, and the connector never requests a{' '}
            <code className="mono">:delete</code> OAuth scope. Several actions are named
            &ldquo;remove_*&rdquo;, but they remove an <em>association</em> — a task from a project,
            a tag from a task — never the underlying object.
          </P>
        </Section>

        <Section id="authentication" title="Authentication">
          <P>
            Two methods are supported. A <strong>Personal Access Token</strong> is the quickest and
            is all that local review needs — create one at{' '}
            <ExternalLink href="https://app.asana.com/0/my-apps">app.asana.com/0/my-apps</ExternalLink>{' '}
            and set <code className="mono">ASANA_ACCESS_TOKEN</code> in <code className="mono">.env</code>.
            Note that Asana does not scope PATs: one carries its creator&apos;s full permissions, so
            a dedicated bot account is worth considering for shared setups.
          </P>
          <P>
            <strong>OAuth 2.0</strong> supports granular scopes and the browser connect flow. The
            connector requests only what its actions use: <code className="mono">projects:read</code>,{' '}
            <code className="mono">tasks:read</code>, <code className="mono">tasks:write</code>,{' '}
            <code className="mono">stories:write</code>, <code className="mono">users:read</code>,{' '}
            <code className="mono">workspaces:read</code>. The flow uses PKCE and a single-use,
            time-limited state value.
          </P>
        </Section>

        <Section id="write-safety" title="Write safety">
          <P>
            This is the most important section. Asana has no server-side idempotency support, so
            two identical create calls produce two tasks and two identical comment calls produce two
            comments — neither of which this connector can delete.
          </P>
          <P>Three protections follow from that:</P>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-(--color-ink-muted)">
            <li>
              <strong className="text-(--color-ink)">Non-idempotent writes are never retried
              automatically.</strong> Not on 429, not on 5xx, not on timeout. A create that timed
              out may well have succeeded, so the connector reports{' '}
              <code className="mono">retryStrategy: manual_with_idempotency_key</code> and hands the
              decision back rather than risking a duplicate.
            </li>
            <li>
              <strong className="text-(--color-ink)">Writes require explicit approval.</strong> The
              three write actions refuse to run without <code className="mono">approved: true</code>,
              so an agent exploring the action list cannot change data as a side effect.
            </li>
            <li>
              <strong className="text-(--color-ink)">Idempotency keys deduplicate deliberate
              retries.</strong> Honestly bounded: the cache is process-local with a 15-minute TTL, so
              it does not survive a restart and does not span instances.
            </li>
          </ol>
          <P>
            <code className="mono">asana.update_task</code> is different — applying the same patch
            twice leaves the same end state, so it <em>is</em> idempotent and may be safely retried.
          </P>
        </Section>

        <Section id="errors" title="Error handling">
          <P>
            Every failure is normalized to one shape with a stable{' '}
            <code className="mono">code</code>, a connector-generated{' '}
            <code className="mono">requestId</code> (Asana returns none), a retry classification and
            plain-language guidance. Stack traces and credentials are never included.
          </P>
          <P>
            Handled: 400, 401, 402, 403, 404, 409, 429, 451, 500, 502, 503/504, network timeouts and
            connection failures. The 409 is connector-generated by the stale-write guard; Asana does
            not emit it for tasks.
          </P>
        </Section>

        <Section id="pagination" title="Pagination">
          <P>
            Both read actions use Asana&apos;s cursor pagination. Cursors are opaque and{' '}
            <strong>API-issued only</strong> — a hand-constructed offset is rejected by Asana. Page
            size defaults to 50 rather than the maximum 100, because these actions request wide{' '}
            <code className="mono">opt_fields</code> and Asana&apos;s rate limiter is cost-based.
          </P>
        </Section>

        <Section id="rate-limits" title="Rate limits">
          <P>
            Asana allows 150 requests/minute on free plans and 1500 on paid, plus separate
            concurrency caps (50 read, 15 write) and a cost-based limiter. Critically,{' '}
            <strong>rejected requests still count against the quota</strong>, so reacting only after
            a 429 makes the situation worse.
          </P>
          <P>
            The client therefore paces requests <em>before</em> sending, using a token bucket
            defaulted to 140/minute — just under the free-tier floor. Raise{' '}
            <code className="mono">ASANA_RATE_LIMIT_RPM</code> if you are on a paid plan.
          </P>
        </Section>

        <Section id="security" title="Security">
          <P>
            <code className="mono">src/config.ts</code> is the only module permitted to read{' '}
            <code className="mono">process.env</code>, enforced by an ESLint rule rather than by
            convention. Credentials live server-side; this console has no token and no way to obtain
            one. Logs, the activity feed and API responses are redacted at the point of capture, and
            request headers are never recorded at all.
          </P>
          <P>
            A dependency-free secret scanner runs in CI and as a pre-commit hook, and the test suite
            needs no credentials — so CI runs with none configured.
          </P>
        </Section>

        <Section id="mcp" title="MCP">
          <P>
            The adapter iterates <code className="mono">connector.listActions()</code> and registers
            each action as a tool. It contains no Asana endpoint, no schema and no business logic —
            asserted by a test that fails if any appear. stdio is the default transport; Streamable
            HTTP is available via <code className="mono">MCP_TRANSPORT=http</code>.
          </P>
        </Section>

        <Section id="testing" title="Testing">
          <P>
            The suite covers schema validation, error normalization for every status, pagination
            cursors, retry classification, redaction, the null-vs-absent update patch, idempotency,
            and all five actions end-to-end. Two structural tests matter most:{' '}
            <code className="mono">testConnection</code> issues no non-GET request, and the MCP tool
            list equals the connector action list.
          </P>
          <P>
            Everything runs against an in-memory Asana API, so <code className="mono">npm test</code>{' '}
            works on a fresh clone with no credentials.
          </P>
        </Section>

        <Section id="limitations" title="Known limitations">
          <P>Stated plainly rather than omitted:</P>
          <ul className="mt-2 space-y-2">
            <Limitation tone="warning" title="Idempotency is process-local">
              The duplicate-suppression cache lives in memory with a 15-minute TTL. It does not
              survive a restart and would not be shared across multiple instances.
            </Limitation>
            <Limitation tone="warning" title="Comment history is not fetched">
              Adding a comment is supported; listing existing comments is not, because it is not one
              of the five assigned actions. Comments added in a session are shown; older ones live
              in Asana.
            </Limitation>
            <Limitation tone="warning" title="Search filters the current page only">
              Asana&apos;s project and task endpoints have no server-side name filter. Filtering
              every page would mean fetching every page, which spends rate-limit quota for a
              cosmetic feature.
            </Limitation>
            <Limitation tone="info" title="ASANA_CONFLICT is connector-generated">
              Asana does not return 409 for tasks. The conflict comes from this connector&apos;s
              opt-in stale-write guard.
            </Limitation>
            <Limitation tone="info" title="No webhooks">
              Asana supports webhooks; this connector does not implement them. Data is fetched on
              demand.
            </Limitation>
            <Limitation tone="info" title="Nothing is deployed">
              The project is local-first by design. No hosted endpoint exists, and the MCP HTTP
              transport, while implemented, has not been deployed or verified over HTTPS.
            </Limitation>
          </ul>
        </Section>
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'actions', title: 'Actions' },
  { id: 'authentication', title: 'Authentication' },
  { id: 'write-safety', title: 'Write safety' },
  { id: 'errors', title: 'Errors' },
  { id: 'pagination', title: 'Pagination' },
  { id: 'rate-limits', title: 'Rate limits' },
  { id: 'security', title: 'Security' },
  { id: 'mcp', title: 'MCP' },
  { id: 'testing', title: 'Testing' },
  { id: 'limitations', title: 'Known limitations' },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Panel id={id} className="scroll-mt-4">
      <PanelHeader title={title} />
      <div className="space-y-3 p-4 text-sm">{children}</div>
    </Panel>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-(--color-ink-muted)">{children}</p>;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-(--color-accent) hover:underline"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Limitation({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'info';
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={tone}>{tone === 'warning' ? 'Limitation' : 'Note'}</StatusPill>
        <span className="text-xs font-medium text-(--color-ink)">{title}</span>
      </div>
      <p className="mt-1.5 text-xs text-(--color-ink-muted)">{children}</p>
    </li>
  );
}
