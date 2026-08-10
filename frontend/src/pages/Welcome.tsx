/**
 * The landing page.
 *
 * Rendered outside the console shell, on its own dark canvas, because it is
 * the first thing a reviewer sees and it has one job: say what this is and
 * offer the two ways in — the console for people, the MCP endpoint for agents.
 *
 * Every animation here is decorative and disabled under
 * `prefers-reduced-motion`. The page reads identically without any of it.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, LayoutDashboard, Network, ShieldCheck, Zap } from 'lucide-react';

import { useActions, useStatus } from '@/hooks/useConnector';

export function Welcome() {
  const status = useStatus();
  const actions = useActions();
  const total = actions.data?.actions.length ?? 35;
  const live = status.data?.demoMode === false;

  // Held one frame so the entrance transition has a state to animate from.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const rise = (delayMs: number): React.CSSProperties => ({
    transitionDelay: `${delayMs}ms`,
    opacity: entered ? 1 : 0,
    transform: entered ? 'none' : 'translateY(14px)',
  });

  return (
    <div className="welcome min-h-dvh">
      <Aurora />

      <main className="relative mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 py-20 text-center">
        <div className="welcome-rise" style={rise(0)}>
          <Wordmark />
        </div>

        <p
          className="welcome-rise mt-7 text-xs font-medium tracking-[0.28em] text-white/45 uppercase"
          style={rise(80)}
        >
          Builders League · Cohort 01
        </p>

        <h1
          className="welcome-rise mt-4 text-4xl font-semibold tracking-tight text-balance text-white sm:text-6xl"
          style={rise(140)}
        >
          The Asana Connector
        </h1>

        <p
          className="welcome-rise mt-5 max-w-xl text-base text-pretty text-white/60 sm:text-lg"
          style={rise(200)}
        >
          One reusable core. <span className="text-white">{total} typed actions</span>, a console
          for people and an MCP endpoint for agents — both calling exactly the same code.
        </p>

        <div className="welcome-rise mt-12 grid w-full gap-4 sm:grid-cols-2" style={rise(280)}>
          <EntryCard
            to="/overview"
            icon={LayoutDashboard}
            eyebrow="For people"
            title="Open the console"
            body="Browse projects and tasks, inspect schemas, run any action, and talk to the assistant."
          />
          <EntryCard
            to="/mcp"
            icon={Network}
            eyebrow="For agents"
            title="Connect over MCP"
            body="The same actions as Model Context Protocol tools, over stdio or Streamable HTTP."
          />
        </div>

        <ul
          className="welcome-rise mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs text-white/45"
          style={rise(360)}
        >
          <Fact icon={ShieldCheck} label="Approval-gated writes" />
          <Fact icon={Zap} label="267 automated tests" />
          <Fact
            icon={Network}
            label={live ? 'Live Asana workspace' : 'Demo data'}
            tone={live ? 'live' : 'demo'}
          />
        </ul>

        <a
          href="#what-it-is"
          className="welcome-rise mt-16 flex flex-col items-center gap-1.5 text-[0.7rem] tracking-widest text-white/35 uppercase transition-colors hover:text-white/70"
          style={rise(440)}
        >
          What it is
          <ChevronDown className="welcome-bob size-4" aria-hidden="true" />
        </a>
      </main>

      <section id="what-it-is" className="relative border-t border-white/10 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-2xl font-semibold text-white sm:text-3xl">
            One core, three surfaces
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-white/55">
            Provider logic lives in one place. Every surface is a thin adapter over it, so a rule
            fixed once is fixed everywhere.
          </p>

          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <Surface
              title="HTTP API"
              body="Serves this console. Owns routing, CORS, rate limiting and the activity log — and holds the credential, so the browser never does."
            />
            <Surface
              title="MCP adapter"
              body="Registers each connector action as a tool by iteration. A test fails the build if it ever contains an Asana call of its own."
            />
            <Surface
              title="Assistant"
              body="Plain language over the same actions. Reads run immediately; writes are proposed and wait for a human to approve them."
            />
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/overview"
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-[#150726] transition-transform hover:-translate-y-0.5"
            >
              Open the console
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              to="/docs"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:border-white/50 hover:text-white"
            >
              Read the documentation
            </Link>
          </div>

          <p className="mt-14 text-center text-xs text-white/30">
            Built by Idrees Khaled · Asana Connector v1.0.0
          </p>
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The DOO wordmark, drawn rather than imported.
 *
 * Two rings and a D, which is the mark's whole idea: an SVG stays crisp at any
 * size and inherits the page's colour, where a bitmap would do neither.
 */
function Wordmark() {
  return (
    <svg
      viewBox="0 0 132 44"
      role="img"
      aria-label="DOO"
      className="h-11 w-auto text-white"
      fill="none"
    >
      <path
        d="M6 6h14a16 16 0 0 1 0 32H6z"
        stroke="currentColor"
        strokeWidth="7.5"
        strokeLinejoin="round"
      />
      <circle cx="66" cy="22" r="16" stroke="currentColor" strokeWidth="7.5" />
      <circle cx="110" cy="22" r="16" stroke="currentColor" strokeWidth="7.5" />
    </svg>
  );
}

/** Slow-drifting colour fields. Purely atmospheric; nothing reads on top of it. */
function Aurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="welcome-orb welcome-orb-a" />
      <div className="welcome-orb welcome-orb-b" />
      <div className="welcome-grid" />
    </div>
  );
}

function EntryCard({
  to,
  icon: Icon,
  eyebrow,
  title,
  body,
}: {
  to: string;
  icon: typeof LayoutDashboard;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="welcome-card group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-left backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.07]"
    >
      <span className="welcome-card-glow" aria-hidden="true" />

      <span className="relative flex size-10 items-center justify-center rounded-xl bg-white/10 text-white transition-colors group-hover:bg-white group-hover:text-[#150726]">
        <Icon className="size-5" aria-hidden="true" />
      </span>

      <p className="relative mt-5 text-[0.7rem] tracking-[0.18em] text-white/40 uppercase">
        {eyebrow}
      </p>
      <h2 className="relative mt-1.5 flex items-center gap-2 text-lg font-semibold text-white">
        {title}
        <ArrowRight
          className="size-4 opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100"
          aria-hidden="true"
        />
      </h2>
      <p className="relative mt-2 text-sm text-white/55">{body}</p>
    </Link>
  );
}

function Fact({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  tone?: 'live' | 'demo';
}) {
  return (
    <li className="flex items-center gap-2">
      {tone === undefined ? (
        <Icon className="size-3.5" aria-hidden="true" />
      ) : (
        <span
          className={`size-1.5 rounded-full ${tone === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`}
          aria-hidden="true"
        />
      )}
      {label}
    </li>
  );
}

function Surface({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-white/55">{body}</p>
    </div>
  );
}
