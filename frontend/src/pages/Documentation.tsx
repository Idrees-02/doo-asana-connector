/**
 * In-app documentation.
 *
 * Mirrors the printed technical documentation section for section, so the PDF
 * a reviewer reads and the console they click through say exactly the same
 * thing. Written to be honest rather than promotional: the Known Limitations
 * section states what is not implemented and what remains unverified, because
 * a reviewer finding an undocumented gap is far worse than reading about it
 * here.
 */

import { useEffect, useState } from 'react';

import { PageHeader, Panel, PanelHeader, StatusPill } from '@/components/ui';
import { useActions } from '@/hooks/useConnector';

export function Documentation() {
  const actions = useActions();
  const total = actions.data?.actions.length ?? 35;
  const active = useActiveSection(SECTIONS.map((s) => s.id));

  return (
    <div className="lg:grid lg:grid-cols-[10.5rem_minmax(0,1fr)] lg:gap-5">
      <TableOfContents active={active} />

      <div className="min-w-0">
        <PageHeader
          title="Technical Documentation"
          description="Asana Connector v1.0.0 — architecture, action surface, security model, testing status and known limitations."
        />

        <div className="space-y-4">
          <Section id="summary" title="Executive summary">
            <dl className="mb-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Meta label="Built by" value="Idrees Khaled" />
              <Meta label="Organization" value="Doo" />
              <Meta label="Version" value="v1.0.0" />
              <Meta label="Prepared for" value="DOO Builders League" />
              <Meta label="Stack" value="TypeScript · Node.js · Express · React · Zod · MCP" />
              <Meta label="Status" value="Production-oriented · Local-first" />
            </dl>
            <P>
              A reusable, production-oriented Asana integration designed for the DOO Builders
              League. The connector exposes <span className="figure">{total}</span> typed actions
              across Tasks, Projects, Sections, Comments, Tags and Users. A shared connector core
              powers both the web console and the MCP adapter, keeping validation, safety, rate
              limiting, error handling and Asana communication in one source of truth.
            </P>
            <P>
              The project is deliberately local-first: it runs with{' '}
              <code className="mono">npm run dev</code> and does not require a public deployment.
              The MCP adapter is implemented, while a public HTTPS MCP endpoint remains an optional
              future deployment step.
            </P>
          </Section>

          <Section id="overview" title="1. Project overview">
            <P>
              The Asana Connector acts as a reliable bridge between applications or AI agents and
              the Asana API. Instead of implementing business logic separately for the web console
              and MCP, both adapters call the same connector core.
            </P>
            <div className="rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-2) p-3 text-xs">
              <p className="mono text-(--color-ink-muted)">
                React Console → Express API → Connector Core → Asana Client → Asana API
              </p>
              <p className="mono mt-1.5 text-(--color-ink-muted)">
                MCP Adapter → Connector Core → Asana Client → Asana API
              </p>
            </div>
            <P>
              The core owns typed schemas, validation, normalized errors, rate limiting and
              write-safety metadata. This prevents duplicated logic and keeps API and MCP behaviour
              consistent.
            </P>

            <H>Key capabilities</H>
            <Bullets>
              <B term={`${total} typed actions`}>
                covering the most useful Asana task and project workflows.
              </B>
              <B term="Real Asana API integration">
                with live verification of the required action cycle.
              </B>
              <B term="PAT authentication">for direct or local use, and verified live access.</B>
              <B term="OAuth 2.0 with PKCE">
                for multi-user authentication; authorization was verified against Asana&rsquo;s live
                endpoint.
              </B>
              <B term="MCP support">
                through the official Model Context Protocol SDK, over stdio and over HTTPS at{' '}
                <code className="mono">/mcp</code>, guarded by a bearer token.
              </B>
              <B term="Write safety">
                with explicit approval metadata and conservative retry behaviour.
              </B>
              <B term="Local console">
                built with React 19, Vite, Tailwind CSS 4, TanStack Query and Radix UI primitives.
              </B>
              <B term="267 automated tests">
                clean typecheck, lint and secret scan, and CI across Node 20, 22 and 24.
              </B>
            </Bullets>
          </Section>

          <Section id="stack" title="2. Technology stack">
            <Table
              head={['Layer', 'Technology', 'Purpose']}
              rows={[
                [
                  'Backend',
                  'TypeScript (strict), Node.js, Express',
                  'HTTP API, application services, integration runtime',
                ],
                ['Validation', 'Zod', 'Typed input and output schemas, runtime validation'],
                ['Frontend', 'React 19, Vite, Tailwind CSS 4', 'Console and action playground'],
                ['Data fetching', 'TanStack Query', 'Frontend server-state and request management'],
                ['UI primitives', 'Radix UI', 'Accessible, composable UI components'],
                ['MCP', '@modelcontextprotocol/sdk', 'AI-agent adapter and MCP tooling'],
                ['Testing', 'Vitest', '267 backend and frontend tests'],
                [
                  'Auth',
                  'PAT + OAuth 2.0 / PKCE',
                  'Direct authentication and multi-user authorization',
                ],
              ]}
            />
          </Section>

          <Section id="actions" title={`3. Action reference — ${total} actions`}>
            <P>
              The five assignment-required actions remain unchanged and first in the registry. The
              remaining 30 actions extend the same architecture. Every action uses typed schemas,
              the real Asana client, normalized errors, rate limiting and safety metadata. The{' '}
              <a href="/actions" className="text-(--color-accent) hover:underline">
                Action Center
              </a>{' '}
              carries the same list, searchable and live.
            </P>

            {ACTION_GROUPS.map((group) => (
              <div key={group.title} className="pt-1">
                <H>
                  {group.title} ({group.actions.length})
                </H>
                <Table
                  head={['Action', 'What it does']}
                  rows={group.actions.map(([id, what]) => [id, what])}
                  monoFirst
                />
              </div>
            ))}
          </Section>

          <Section id="authentication" title="4. Authentication and security">
            <H>Personal Access Token (PAT)</H>
            <P>
              PAT is the fastest authentication path for local development and live verification.
              Create one at{' '}
              <ExternalLink href="https://app.asana.com/0/my-apps">
                app.asana.com/0/my-apps
              </ExternalLink>{' '}
              and set <code className="mono">ASANA_ACCESS_TOKEN</code>. Secrets are kept in the
              private, gitignored <code className="mono">.env</code> file and are never intended to
              be committed.
            </P>

            <H>OAuth 2.0 + PKCE</H>
            <P>
              OAuth is implemented for multi-user scenarios. The connector uses the configured
              client ID, client secret, redirect URI and least-privilege scopes. The live Asana
              authorization endpoint accepted the application&rsquo;s client ID, PKCE parameters and
              requested scopes. Interactive user consent was intentionally not performed by the
              developer, because it requires the user&rsquo;s credentials.
            </P>

            <H>Credential hygiene</H>
            <Bullets>
              <B>
                Real credentials are stored in <code className="mono">.env</code>, not{' '}
                <code className="mono">.env.example</code>.
              </B>
              <B>The tracked template contains placeholders only.</B>
              <B>Secrets are excluded from Git through gitignore and secret scanning.</B>
              <B>Credentials exposed during development should be rotated immediately.</B>
              <B>No credentials are printed to logs or returned through action responses.</B>
            </Bullets>
          </Section>

          <Section id="write-safety" title="5. Write safety and idempotency">
            <P>
              There are <strong className="text-(--color-ink)">21 write actions</strong>. Every
              write requires explicit approval metadata, so a UI or AI agent can distinguish
              read-only operations from mutations.
            </P>
            <P>
              Six create operations are never automatically retried:{' '}
              <code className="mono">create_task</code>,{' '}
              <code className="mono">create_project</code>,{' '}
              <code className="mono">create_section</code>,{' '}
              <code className="mono">create_subtask</code>, <code className="mono">create_tag</code>{' '}
              and <code className="mono">add_comment</code>. Asana does not provide server-side
              idempotency for these operations, so a timeout could mean the object was created
              successfully. Retrying blindly could therefore create duplicates.
            </P>
            <Bullets>
              <B>
                Update-style mutations are treated as retryable only when repeating the same patch
                is safe.
              </B>
              <B>
                Association operations are designed to be safe to repeat where the resulting state
                is unchanged.
              </B>
              <B>There are zero delete actions.</B>
              <B>There are zero delete OAuth scopes.</B>
              <B>
                Safety behaviour is represented in shared metadata, so the same policy applies to
                API and MCP consumers.
              </B>
            </Bullets>
          </Section>

          <Section id="errors" title="6. Error handling and reliability">
            <P>
              The connector normalizes Asana and transport failures into stable application-level
              error categories. Validation occurs before the request is sent, and rate limiting is
              enforced client-side to reduce avoidable pressure on the Asana API.
            </P>
            <P>
              Pagination is implemented where Asana exposes cursor-based pagination. Where an Asana
              endpoint has known limitations, the connector documents those constraints instead of
              pretending the endpoint has capabilities it does not have.
            </P>
          </Section>

          <Section id="console" title="7. Console and frontend">
            <P>
              The console is a modern, dark-first interface for exploring and demonstrating the
              connector. It is built with React 19 and Vite, styled with Tailwind CSS 4, and uses
              TanStack Query plus Radix UI primitives.
            </P>
            <Bullets>
              <B term="Action Center">all {total} actions, grouped by domain and searchable.</B>
              <B term="Schema Inspector">
                exposes the current action schema rather than a hardcoded list.
              </B>
              <B term="Playground">provides an interactive surface for running actions.</B>
              <B term="Activity">filters and views use the live action registry.</B>
              <B term="Authentication">supports the configured PAT and OAuth paths.</B>
              <B term="Validation and error states">surface connector responses cleanly.</B>
              <B term="Assistant">
                plain language over the same actions; reads run immediately, writes wait for
                approval.
              </B>
              <B term="Accessibility">
                colour contrast was checked against WCAG; a slate-on-lavender badge contrast issue
                was found and fixed.
              </B>
            </Bullets>

            <H>Visual system</H>
            <Swatches />
          </Section>

          <Section id="testing" title="8. Testing and verification">
            <P>
              267 automated tests: 242 backend tests and 25 frontend tests. Four of the backend
              tests were added after load testing exposed two defects in the MCP HTTP transport.
            </P>
            <Bullets>
              <B>TypeScript typecheck: clean.</B>
              <B>ESLint: clean.</B>
              <B>Secret scan: clean.</B>
              <B>Frontend build: successful.</B>
              <B>CI: green on Node 20, Node 22 and Node 24.</B>
              <B>PAT authentication: verified live.</B>
              <B>
                All five required actions: verified against the real Asana account in a complete
                read and write cycle.
              </B>
              <B>
                OAuth authorize step: verified against Asana&rsquo;s real endpoint; PKCE and
                configured scopes were accepted.
              </B>
              <B>
                <code className="mono">get_current_user</code>: verified against the real account.
              </B>
              <B>Console: built against the shared connector architecture.</B>
            </Bullets>
          </Section>

          <Section id="load" title="9. Load and stress testing">
            <P>
              The deployed connector was exercised against the live Railway service and a real Asana
              account. The harness is{' '}
              <strong className="text-(--color-ink)">read-only by construction</strong> — it can
              only issue read actions, so no volume of load can mutate the workspace. Roughly 900
              HTTP requests, 730 MCP sessions and 760 tool calls were issued in total.
            </P>

            <H>Method</H>
            <Bullets>
              <B term="Tiered">
                connector metadata first (no upstream call), then the console shell, then real Asana
                reads — so a slow result can be attributed to the right layer.
              </B>
              <B term="Concurrency, not rate">
                N requests are released simultaneously and repeated in rounds, which is what a burst
                of N users actually looks like.
              </B>
              <B term="Percentiles, not averages">
                p50, p95 and p99 are reported, because one slow request hides behind a mean.
              </B>
              <B term="Sessions, not connections">
                every simulated MCP user performs its own initialize, tools/list and tool calls, so
                session handling is exercised rather than bypassed.
              </B>
            </Bullets>

            <H>HTTP API — deployed service, one replica</H>
            <Table
              head={['Scenario', 'Users', 'Requests', 'p50', 'p95', 'Errors']}
              rows={[
                ['Metadata endpoint', '1', '10', '377 ms', '1097 ms', '0'],
                ['Metadata endpoint', '10', '50', '433 ms', '859 ms', '0'],
                ['Metadata endpoint', '50', '100', '974 ms', '1625 ms', '0'],
                ['Metadata endpoint', '100', '100', '1568 ms', '1787 ms', '0'],
                ['Console shell', '50', '100', '954 ms', '2435 ms', '0'],
                ['Burst overload', '100', '400', '452 ms', '1587 ms', '0'],
                ['Real Asana read', '10', '30', '981 ms', '1387 ms', '0'],
                ['Real Asana read', '25', '50', '2416 ms', '2927 ms', '0'],
              ]}
            />
            <P>
              No request failed at any stage. Latency degrades gracefully rather than collapsing:
              throughput rose from 18 to 97 requests per second as concurrency rose, and the p50
              grew in proportion — the profile of a single replica queueing work, not of a service
              falling over.
            </P>

            <H>MCP adapter — concurrent sessions</H>
            <Table
              head={['Users', 'Sessions established', 'Tool calls', 'Handshake p95', 'Call p95']}
              rows={[
                ['1', '1 / 1', '3', '118 ms', '329 ms'],
                ['10', '10 / 10', '30', '118 ms', '397 ms'],
                ['50', '50 / 50', '100', '500 ms', '439 ms'],
                ['100', '100 / 100', '200', '645 ms', '587 ms'],
                ['200', '200 / 200', '200', '1194 ms', '892 ms'],
              ]}
            />
            <P>
              At the shipped default of 140 requests per minute, the same run tops out at roughly
              two actions per second and calls queue for tens of seconds beyond 50 users. That
              ceiling is the client-side rate limiter doing its job — protecting the Asana quota —
              not an adapter limit. The table above was measured with the limiter raised to a
              paid-plan setting, which isolates the adapter itself.
            </P>

            <H>What it found</H>
            <ul className="mt-2 space-y-2">
              <Limitation tone="warning" title="MCP over HTTP rejected every request">
                DNS-rebinding protection listed bare hostnames, but clients send the Host header
                with the port. Every request failed the host check. Fixed, with a regression test.
              </Limitation>
              <Limitation tone="warning" title="MCP over HTTP served one client only">
                A single shared transport meant the second client&rsquo;s initialize was refused
                with &ldquo;Server already initialized&rdquo;. Sessions are now created per
                initialize and routed by session id. Fixed, with a regression test.
              </Limitation>
              <Limitation tone="warning" title="Sessions leaked when clients vanished">
                A client that disconnects without sending DELETE left its session resident: 200
                stress clients left 362 transports behind. Idle sessions are now swept. Fixed.
              </Limitation>
              <Limitation tone="info" title="The API rate limiter does not bind per client">
                A 400-request burst from one machine drew zero 429 responses. The limiter is
                per-process and in-memory, and the client key varies behind the platform edge, so
                the effective limit is higher than the configured 300 per minute. Documented, not
                yet fixed — a shared store would be required.
              </Limitation>
              <Limitation tone="info" title="Unknown console routes answer 200">
                The SPA fallback serves index.html for any unmatched path, so a wrong URL renders
                the in-app not-found page with a 200 status. Correct for users, imprecise for
                crawlers.
              </Limitation>
            </ul>
          </Section>

          <Section id="limitations" title="10. Known limitations">
            <P>Documented, not hidden:</P>
            <ul className="mt-2 space-y-2">
              <Limitation tone="warning" title="search_tasks">
                Asana availability is premium-only, and pagination behaviour is not treated as
                universally stable.
              </Limitation>
              <Limitation tone="warning" title="list_tasks">
                Asana requires a specific filter combination for certain requests. The connector
                validates this rather than surfacing a cryptic upstream error.
              </Limitation>
              <Limitation tone="warning" title="Project memberships">
                The relevant endpoint is technically deprecated, but it is retained because the
                documented replacement does not clearly expose the required OAuth scope.
              </Limitation>
              <Limitation tone="info" title="OAuth interactive consent">
                The developer does not perform the user&rsquo;s login and consent step. The
                authorization endpoint itself was verified live.
              </Limitation>
              <Limitation tone="info" title="Public HTTPS MCP endpoint">
                Not deployed by design; the project is local-first. The MCP adapter is implemented.
              </Limitation>
              <Limitation tone="info" title="Delete">
                Intentionally unsupported. This is a safety and product decision, not an incomplete
                CRUD implementation.
              </Limitation>
            </ul>
          </Section>

          <Section id="setup" title="11. Local setup and demo">
            <ol className="list-decimal space-y-1.5 pl-5 text-(--color-ink-muted)">
              <li>Clone the repository.</li>
              <li>
                Run <code className="mono">npm install</code>.
              </li>
              <li>Create the private environment file from the provided template.</li>
              <li>Configure PAT and/or OAuth values as required.</li>
              <li>
                Run <code className="mono">npm run dev</code>.
              </li>
              <li>
                Use the console to browse the {total}-action registry, inspect schemas and run
                supported actions.
              </li>
              <li>
                For live Asana verification, use a valid credential and clean up temporary test data
                manually when required.
              </li>
            </ol>

            <H>Demo narrative</H>
            <P>
              A strong demonstration path is: open the Action Center → show the {total} live actions
              → inspect a schema → authenticate → read the current user and projects → create or
              update a safe demo task with explicit approval → add a comment → show the resulting
              Asana state → explain the write-safety policy and the shared MCP and API architecture.
            </P>
          </Section>

          <Section id="decisions" title="12. Engineering decisions">
            <H>Single-source connector core</H>
            <P>
              The most important architectural decision is keeping business and integration logic
              inside one core. The Express API and MCP adapter are intentionally thin. This reduces
              drift, simplifies testing, and ensures an AI agent and a human using the console
              receive the same validation and safety behaviour.
            </P>

            <H>Real-client demo path</H>
            <P>
              Demo behaviour is designed around the same client, action, validation and error
              pipeline rather than a completely separate feature implementation. This makes the
              console a useful review surface for the shipping architecture.
            </P>

            <H>Least privilege</H>
            <P>
              OAuth scopes are limited to the operations actually required. Delete scopes are
              intentionally absent, because the connector does not expose deletion.
            </P>

            <H>Honest compatibility</H>
            <P>
              The documentation distinguishes between live-verified behaviour and
              implemented-but-not-live-verified behaviour. This matters for an integration project,
              because an API contract can differ from an in-memory test implementation.
            </P>
          </Section>

          <Section id="snapshot" title="13. Submission snapshot">
            <Table
              head={['Item', 'Status']}
              rows={[
                ['Connector version', 'v1.0.0'],
                ['Actions', `${total} total`],
                ['Required actions', '5 — preserved unchanged'],
                ['Extended actions', '30'],
                ['Authentication', 'PAT + OAuth 2.0 / PKCE'],
                ['MCP', 'Implemented; stdio and Streamable HTTP; load tested to 200 sessions'],
                ['Tests', '267'],
                ['CI', 'Green — Node 20, 22 and 24'],
                ['Delete operations', 'None'],
                ['Primary author', 'Idrees Khaled'],
                ['Organization', 'Doo'],
                ['Prepared for', 'DOO Builders League'],
              ]}
            />
            <P>
              This document describes the implemented v1.0.0 connector architecture, action surface,
              security model, testing status and known limitations.
            </P>
          </Section>
        </div>
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: 'summary', title: 'Summary' },
  { id: 'overview', title: '1. Overview' },
  { id: 'stack', title: '2. Stack' },
  { id: 'actions', title: '3. Actions' },
  { id: 'authentication', title: '4. Authentication' },
  { id: 'write-safety', title: '5. Write safety' },
  { id: 'errors', title: '6. Errors' },
  { id: 'console', title: '7. Console' },
  { id: 'testing', title: '8. Testing' },
  { id: 'load', title: '9. Load testing' },
  { id: 'limitations', title: '10. Limitations' },
  { id: 'setup', title: '11. Setup' },
  { id: 'decisions', title: '12. Decisions' },
  { id: 'snapshot', title: '13. Snapshot' },
] as const;

/**
 * The action reference, in the same grouping and wording as the printed
 * documentation. The Action Center renders the live registry instead; this
 * table exists so the two documents read identically.
 */
const ACTION_GROUPS: ReadonlyArray<{
  title: string;
  actions: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    title: 'Tasks',
    actions: [
      ['asana.list_project_tasks', 'List tasks belonging to a specific project.'],
      ['asana.create_task', 'Create a new Asana task with supported task fields.'],
      ['asana.update_task', 'Update an existing task using a controlled patch.'],
      ['asana.get_task', 'Retrieve detailed information for a specific task.'],
      ['asana.list_tasks', 'List tasks using supported Asana filters and pagination.'],
      [
        'asana.search_tasks',
        'Search tasks using Asana search capabilities; premium availability and pagination limitations are documented.',
      ],
      ['asana.complete_task', 'Mark a task as completed.'],
      ['asana.reopen_task', 'Reopen a completed task.'],
      ['asana.assign_task', 'Assign a task to a user.'],
      ['asana.set_task_due_date', 'Set or update a task due date.'],
      ['asana.set_task_description', 'Set or update the task description or notes.'],
      ['asana.create_subtask', 'Create a subtask under a parent task.'],
      ['asana.list_subtasks', 'List subtasks belonging to a task.'],
      ['asana.add_task_to_project', 'Associate a task with a project.'],
      [
        'asana.remove_task_from_project',
        "Remove a task's project association without deleting the task.",
      ],
    ],
  },
  {
    title: 'Projects',
    actions: [
      ['asana.list_projects', 'List accessible Asana projects.'],
      ['asana.get_project', 'Retrieve project details.'],
      ['asana.create_project', 'Create a project.'],
      ['asana.update_project', 'Update project metadata.'],
      ['asana.list_project_members', 'List members associated with a project.'],
      ['asana.add_project_member', 'Add a user to a project membership.'],
      [
        'asana.remove_project_member',
        "Remove a user's project membership without deleting the user or project.",
      ],
    ],
  },
  {
    title: 'Sections',
    actions: [
      ['asana.list_project_sections', 'List sections within a project.'],
      ['asana.create_section', 'Create a new project section.'],
      ['asana.update_section', 'Update section properties.'],
      ['asana.move_task_to_section', 'Move a task into a project section.'],
    ],
  },
  {
    title: 'Comments',
    actions: [
      ['asana.add_comment', 'Add a comment or story to a task.'],
      ['asana.list_comments', 'List comments or stories associated with a task.'],
    ],
  },
  {
    title: 'Tags',
    actions: [
      ['asana.list_tags', 'List accessible tags.'],
      ['asana.create_tag', 'Create a tag.'],
      ['asana.add_tag_to_task', 'Associate a tag with a task.'],
      [
        'asana.remove_tag_from_task',
        'Remove a tag association from a task without deleting the tag.',
      ],
    ],
  },
  {
    title: 'Users',
    actions: [
      ['asana.get_current_user', "Retrieve the authenticated user's Asana profile."],
      ['asana.get_user', "Retrieve a specific user's profile."],
      ['asana.list_users', 'List accessible users.'],
    ],
  },
];

const SWATCHES: ReadonlyArray<readonly [string, string, string]> = [
  ['Background', '#FAF8FC', 'Soft off-white with a lavender hint'],
  ['Main heading', '#0F172A', 'Dark charcoal'],
  ['Heading highlight', '#6B21A8', 'Dark purple'],
  ['Body text', '#64748B', 'Slate grey'],
  ['Primary and numbers', '#7C3AED', 'Vibrant purple'],
  ['Badges and tags', '#F3E8FF', 'Light lavender'],
];

/**
 * Contents rail.
 *
 * A rail rather than a chip cloud: this page is thirteen sections long, and a
 * wrapped row of links gives no sense of position within it. On wide screens
 * it sticks alongside the text and marks the section being read; below the
 * grid breakpoint it collapses to one horizontally scrollable strip, which
 * keeps the same order without stealing vertical space on a phone.
 */
function TableOfContents({ active }: { active: string | undefined }) {
  return (
    <nav aria-label="Contents" className="mb-4 lg:mb-0">
      <div className="lg:sticky lg:top-4">
        <p className="mb-2 hidden px-2 text-[0.65rem] font-semibold tracking-wider text-(--color-ink-muted) uppercase lg:block">
          Contents
        </p>

        <Panel className="p-1.5 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {SECTIONS.map((section) => {
              const isActive = section.id === active;
              return (
                <li key={section.id} className="shrink-0 lg:shrink">
                  <a
                    href={`#${section.id}`}
                    aria-current={isActive ? 'location' : undefined}
                    className={[
                      'block rounded-(--radius-sm) px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors lg:whitespace-normal',
                      // The active row is marked twice — weight and a rule —
                      // so it does not depend on colour alone.
                      isActive
                        ? 'bg-(--color-accent-muted) font-medium text-(--color-accent) lg:border-l-2 lg:border-(--color-accent) lg:pl-2'
                        : 'text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink) lg:border-l-2 lg:border-transparent lg:pl-2',
                    ].join(' ')}
                  >
                    {section.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </nav>
  );
}

/**
 * Tracks which section is currently being read.
 *
 * Measured directly rather than through IntersectionObserver: the observer
 * reports which sections touch a band, not which one the reader is inside, so
 * it lands one section behind whenever a heading sits near the boundary. The
 * section being read is simply the last one whose top has passed the reading
 * line — which is what this computes, throttled to one frame.
 */
function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(undefined);
  const key = ids.join(',');

  useEffect(() => {
    const elements = key
      .split(',')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    // Just below the sticky rail's own offset, so the marked section is the
    // one whose heading the reader can actually see at the top.
    const READING_LINE = 96;

    const resolve = (): void => {
      // At the foot of the page there is no scroll left to bring the last
      // section past the line, so it could never light up on its own.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
        setActive(elements.at(-1)?.id);
        return;
      }

      let current = elements[0];
      for (const el of elements) {
        if (el.getBoundingClientRect().top > READING_LINE) break;
        current = el;
      }
      setActive(current?.id);
    };

    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolve();
      });
    };

    resolve();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [key]);

  return active;
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
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

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-1 text-xs font-semibold text-(--color-ink)">{children}</h3>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-(--color-ink-muted)">{label}</dt>
      <dd className="text-(--color-ink)">{value}</dd>
    </div>
  );
}

function Bullets({ children }: { children: React.ReactNode }) {
  return <ul className="mt-1 space-y-1.5 text-(--color-ink-muted)">{children}</ul>;
}

function B({ term, children }: { term?: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="text-(--color-accent)">
        ·
      </span>
      <span>
        {term !== undefined && <strong className="text-(--color-ink)">{term}: </strong>}
        {children}
      </span>
    </li>
  );
}

function Table({
  head,
  rows,
  monoFirst = false,
}: {
  head: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  monoFirst?: boolean;
}) {
  return (
    // Wide tables scroll on their own rather than pushing the page sideways.
    <div className="mt-2 overflow-x-auto rounded-(--radius-md) border border-(--color-hairline)">
      <table className="w-full min-w-[28rem] border-collapse text-xs">
        <thead>
          <tr className="bg-(--color-surface-2)">
            {head.map((cell) => (
              <th
                key={cell}
                scope="col"
                className="px-3 py-2 text-left font-medium text-(--color-ink)"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-(--color-hairline)">
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, index) => (
                <td
                  key={cell}
                  className={
                    index === 0
                      ? `px-3 py-2 align-top text-(--color-ink) ${monoFirst ? 'mono whitespace-nowrap' : ''}`
                      : 'px-3 py-2 align-top text-(--color-ink-muted)'
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Swatches() {
  return (
    <ul className="mt-2 grid gap-2 sm:grid-cols-2">
      {SWATCHES.map(([role, hex, note]) => (
        <li
          key={role}
          className="flex items-center gap-3 rounded-(--radius-md) border border-(--color-hairline) p-2"
        >
          <span
            aria-hidden="true"
            style={{ backgroundColor: hex }}
            className="size-7 shrink-0 rounded-(--radius-sm) border border-(--color-hairline)"
          />
          <span className="text-xs">
            <span className="block font-medium text-(--color-ink)">{role}</span>
            <span className="block text-(--color-ink-muted)">
              <span className="mono">{hex}</span> — {note}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
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
        {/* Identifiers are set in mono; prose titles are not. */}
        <span
          className={`text-xs font-medium text-(--color-ink) ${/^[\w.]+$/.test(title) ? 'mono' : ''}`}
        >
          {title}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-(--color-ink-muted)">{children}</p>
    </li>
  );
}
