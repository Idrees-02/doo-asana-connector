/**
 * Architecture page.
 *
 * Two SVG diagrams showing the real request paths, with a subtle animated flow
 * along the connecting lines. The animation is decorative only — it is
 * disabled entirely under `prefers-reduced-motion`, and the diagram remains
 * fully legible without it.
 *
 * The diagrams use `currentColor` and theme tokens so they read correctly in
 * both light and dark themes rather than being baked for one.
 */

import { PageHeader, Panel, PanelHeader } from '@/components/ui';

export function Architecture() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Architecture"
        description="How requests actually flow, and why the layers are separated the way they are."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Console path"
            description="A human using the web console."
          />
          <div className="p-4">
            <FlowDiagram
              nodes={['User', 'Console (browser)', 'Connector API', 'Connector Core', 'Asana Client', 'Asana API']}
              highlight={3}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Agent path" description="DOO or any MCP client." />
          <div className="p-4">
            <FlowDiagram
              nodes={['DOO / MCP client', 'MCP Adapter', 'Connector Core', 'Asana Client', 'Asana API']}
              highlight={2}
            />
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHeader
          title="Why it is shaped this way"
          description="The separation is what makes the two paths behave identically."
        />
        <dl className="divide-y divide-(--color-hairline)">
          <Layer
            name="Connector Core"
            role="Owns everything that matters"
            detail="Action definitions, schemas, validation, authentication, error normalization, pagination, rate limiting, retry classification and safety metadata. Both adapters call the same execute() path, so a rule fixed here is fixed everywhere."
          />
          <Layer
            name="Asana Client"
            role="Transport only"
            detail="Paces requests under Asana's rate limits before sending, bounds concurrency, enforces timeouts, unwraps the {data, next_page} envelope, captures Asana-Change deprecation headers, and decides — strictly — what may be retried."
          />
          <Layer
            name="MCP Adapter"
            role="Thin by construction"
            detail="Iterates connector.listActions() and registers each as a tool. Contains no Asana endpoint, no schema and no business logic. A test asserts the exposed tool ids equal the connector's action ids, so it cannot drift."
          />
          <Layer
            name="Connector API"
            role="Adapter and credential boundary"
            detail="One generic route serves all five actions. Credentials live here, never in the browser: the console has no token and no way to obtain one."
          />
          <Layer
            name="Console"
            role="Interface only"
            detail="Calls the API on the same origin. Holds no privileged credentials and contains no Asana business logic — it imports domain types only, which are erased at compile time."
          />
        </dl>
      </Panel>
    </div>
  );
}

function Layer({ name, role, detail }: { name: string; role: string; detail: string }) {
  return (
    <div className="px-4 py-3">
      <dt className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-(--color-ink)">{name}</span>
        <span className="text-[10px] uppercase tracking-wide text-(--color-accent)">{role}</span>
      </dt>
      <dd className="mt-1 text-xs text-(--color-ink-muted)">{detail}</dd>
    </div>
  );
}

/**
 * A vertical flow diagram.
 *
 * Rendered as inline SVG so it scales cleanly and inherits theme colours.
 * `role="img"` plus a text alternative means a screen reader gets the sequence
 * as a sentence rather than a pile of unlabelled shapes.
 */
function FlowDiagram({ nodes, highlight }: { nodes: readonly string[]; highlight: number }) {
  const boxHeight = 40;
  const gap = 26;
  const width = 260;
  const height = nodes.length * boxHeight + (nodes.length - 1) * gap;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Request flow: ${nodes.join(', then ')}.`}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-hairline-strong)" />
        </marker>
      </defs>

      {nodes.map((node, index) => {
        const y = index * (boxHeight + gap);
        const isHighlighted = index === highlight;

        return (
          <g key={node}>
            {/* Connector line to the next node */}
            {index < nodes.length - 1 ? (
              <>
                <line
                  x1={width / 2}
                  y1={y + boxHeight}
                  x2={width / 2}
                  y2={y + boxHeight + gap}
                  stroke="var(--color-hairline-strong)"
                  strokeWidth="1"
                  markerEnd="url(#arrow)"
                />
                {/* Decorative pulse. Motion-safe only: the diagram is complete
                    and readable without it. */}
                <circle r="2" fill="var(--color-accent)" className="motion-safe:block motion-reduce:hidden">
                  <animate
                    attributeName="cy"
                    from={y + boxHeight}
                    to={y + boxHeight + gap}
                    dur="2s"
                    begin={`${index * 0.35}s`}
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="cx"
                    from={width / 2}
                    to={width / 2}
                    dur="2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    dur="2s"
                    begin={`${index * 0.35}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              </>
            ) : null}

            <rect
              x="10"
              y={y}
              width={width - 20}
              height={boxHeight}
              rx="6"
              fill="var(--color-surface-2)"
              stroke={isHighlighted ? 'var(--color-accent)' : 'var(--color-hairline)'}
              strokeWidth="1"
            />
            <text
              x={width / 2}
              y={y + boxHeight / 2 + 4}
              textAnchor="middle"
              fontSize="11"
              fill={isHighlighted ? 'var(--color-accent)' : 'var(--color-ink)'}
              fontFamily="var(--font-sans)"
            >
              {node}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
