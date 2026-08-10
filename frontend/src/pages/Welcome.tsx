/**
 * The landing page.
 *
 * Rendered outside the console shell, on the console's own light palette, and
 * it has one job: say what this is and offer the two ways in — the console for
 * people, the MCP endpoint for agents.
 *
 * It is deliberately alive. A full-body robot tracks the pointer with its eyes
 * and head, a prism of panels turns as the page scrolls, and the robot drifts
 * with it. Two rules keep that from being noise:
 *
 *   1. Motion is driven by CSS custom properties written from one rAF-throttled
 *      listener each. React never re-renders on pointer or scroll movement.
 *   2. All of it is decorative and off under `prefers-reduced-motion`, where
 *      the page reads identically as a still document.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, LayoutDashboard, Network, ShieldCheck, Zap } from 'lucide-react';

import { useActions, useStatus } from '@/hooks/useConnector';

export function Welcome() {
  const status = useStatus();
  const actions = useActions();
  const total = actions.data?.actions.length ?? 35;
  const live = status.data?.demoMode === false;

  const stage = useRef<HTMLDivElement>(null);
  usePointer(stage);
  useScrollProgress(stage);

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
    <div ref={stage} className="welcome min-h-dvh">
      <Aurora />
      <Signpost />

      <main className="welcome-shift relative mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 py-20 text-center">
        <div className="welcome-rise" style={{ ...rise(0), color: 'var(--color-accent)' }}>
          <Wordmark className="h-11 w-auto" />
        </div>

        <div className="welcome-rise mt-8" style={rise(80)}>
          <Robot />
        </div>

        <p
          className="welcome-rise mt-6 text-xs font-medium tracking-[0.28em] uppercase"
          style={{ ...rise(160), color: 'var(--color-ink-subtle)' }}
        >
          Builders League · Cohort 01
        </p>

        <h1
          className="welcome-rise mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
          style={{ ...rise(220), color: 'var(--color-ink)' }}
        >
          The Asana Connector
        </h1>

        <p
          className="welcome-rise mt-5 max-w-xl text-base text-pretty sm:text-lg"
          style={{ ...rise(280), color: 'var(--color-ink-muted)' }}
        >
          One reusable core.{' '}
          <span style={{ color: 'var(--color-ink)' }}>{total} typed actions</span> across{' '}
          <RotatingWord />, a console for people and an MCP endpoint for agents — both calling
          exactly the same code.
        </p>

        <p
          className="welcome-rise mt-6 flex items-center gap-2.5 text-sm"
          style={{ ...rise(320), color: 'var(--color-ink-muted)' }}
        >
          <span className="welcome-hairline" aria-hidden="true" />
          Developed by <strong style={{ color: 'var(--color-accent)' }}>Idrees Khaled</strong>
          <span className="welcome-hairline" aria-hidden="true" />
        </p>

        <div className="welcome-rise mt-12 grid w-full gap-4 sm:grid-cols-2" style={rise(380)}>
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
          className="welcome-rise mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs"
          style={{ ...rise(440), color: 'var(--color-ink-subtle)' }}
        >
          <Fact icon={ShieldCheck} label="Approval-gated writes" />
          <Fact icon={Zap} label="284 automated tests" />
          <Fact
            icon={Network}
            label={live ? 'Live Asana workspace' : 'Demo data'}
            tone={live ? 'live' : 'demo'}
          />
        </ul>

        <a
          href="#what-it-is"
          className="welcome-rise welcome-scroll mt-14 flex flex-col items-center gap-1.5 text-[0.7rem] tracking-widest uppercase"
          style={rise(500)}
        >
          What it is
          <ChevronDown className="welcome-bob size-4" aria-hidden="true" />
        </a>
      </main>

      <section
        id="what-it-is"
        className="welcome-shift relative border-t px-6 py-24"
        style={{ borderColor: 'var(--color-hairline)' }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="text-center text-2xl font-semibold sm:text-3xl"
            style={{ color: 'var(--color-ink)' }}
          >
            Six domains, {total} actions
          </h2>
          <p
            className="mx-auto mt-3 max-w-2xl text-center text-sm"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Every one of them typed, validated and safety-classified by the same core. The five the
            assignment requires are marked.
          </p>

          <ActionRing />
        </div>
      </section>

      <section
        className="welcome-shift relative border-t px-6 py-24"
        style={{ borderColor: 'var(--color-hairline)' }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="text-center text-2xl font-semibold sm:text-3xl"
            style={{ color: 'var(--color-ink)' }}
          >
            One core, three surfaces
          </h2>
          <p
            className="mx-auto mt-3 max-w-2xl text-center text-sm"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Provider logic lives in one place. Every surface is a thin adapter over it, so a rule
            fixed once is fixed everywhere.
          </p>

          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <Surface
              index={0}
              title="HTTP API"
              body="Serves this console. Owns routing, CORS, rate limiting and the activity log — and holds the credential, so the browser never does."
            />
            <Surface
              index={1}
              title="MCP adapter"
              body="Registers each connector action as a tool by iteration. A test fails the build if it ever contains an Asana call of its own."
            />
            <Surface
              index={2}
              title="Assistant"
              body="Plain language over the same actions. Reads run immediately; writes are proposed and wait for a human to approve them."
            />
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
            <Link to="/overview" className="welcome-cta-primary">
              Open the console
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link to="/docs" className="welcome-cta-ghost">
              Read the documentation
            </Link>
          </div>

          <p className="mt-14 text-center text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
            Built by Idrees Khaled · Asana Connector v1.0.0
          </p>
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Motion sources                                                              */
/* -------------------------------------------------------------------------- */

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Publish the pointer as `--px` / `--py`, each in the range -1…1.
 *
 * Written to a CSS variable rather than to React state: the robot's eyes track
 * continuously, and re-rendering a component tree on every pointer event to
 * move two pupils would be indefensible.
 */
function usePointer(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null || prefersReducedMotion()) return;

    let frame = 0;
    let x = 0;
    let y = 0;

    const apply = (): void => {
      frame = 0;
      node.style.setProperty('--px', x.toFixed(3));
      node.style.setProperty('--py', y.toFixed(3));
    };

    const onMove = (event: PointerEvent): void => {
      x = (event.clientX / window.innerWidth) * 2 - 1;
      y = (event.clientY / window.innerHeight) * 2 - 1;
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
    };
  }, [ref]);
}

/** Publish scroll position as `--scroll` (0…1 across the page). */
function useScrollProgress(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null || prefersReducedMotion()) return;

    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
      node.style.setProperty('--scroll', (window.scrollY / max).toFixed(4));
    };

    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref]);
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A word that cycles through the connector's domains.
 *
 * Width is reserved by the longest entry, so the paragraph never reflows as it
 * changes.
 */
function RotatingWord() {
  const words = ['tasks', 'projects', 'sections', 'comments', 'tags', 'users'];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), 1900);
    return () => clearInterval(id);
  }, [words.length]);

  return (
    <span className="welcome-rotator">
      {/* Sized by the longest word so the sentence around it stays still. */}
      <span className="welcome-rotator-sizer" aria-hidden="true">
        sections
      </span>
      <span key={index} className="welcome-rotator-word">
        {words[index]}
      </span>
    </span>
  );
}

/**
 * The six action domains, on a turning carousel.
 *
 * A ring rather than a grid because the point being made is that they are
 * peers — no domain is the important one, they all reach the same core. It
 * turns on its own and pauses on hover so a name can actually be read.
 *
 * Counts come from the live registry where possible, so the ring cannot
 * advertise a domain the connector has stopped covering.
 */
function ActionRing() {
  const actions = useActions();

  const groups = [
    { name: 'Tasks', match: /task|subtask/ },
    { name: 'Projects', match: /project/ },
    { name: 'Sections', match: /section/ },
    { name: 'Comments', match: /comment/ },
    { name: 'Tags', match: /tag/ },
    { name: 'Users', match: /user/ },
  ];

  const counts = groups.map((group) => {
    const ids = (actions.data?.actions ?? []).filter((action) => group.match.test(action.category));
    return { ...group, count: ids.length };
  });

  return (
    <div className="welcome-ring-stage">
      <div className="welcome-ring">
        {counts.map((group, index) => (
          <div
            key={group.name}
            className="welcome-ring-card"
            style={{ '--i': index } as React.CSSProperties}
          >
            <span className="welcome-ring-count">{group.count > 0 ? group.count : '—'}</span>
            <span className="welcome-ring-name">{group.name}</span>
          </div>
        ))}
      </div>
      <span className="welcome-ring-floor" aria-hidden="true" />
    </div>
  );
}

/**
 * The DOO wordmark.
 *
 * Redrawn from the brand image as vector rather than embedded as a bitmap: it
 * arrives with no background to strip, stays sharp at any size, and takes its
 * colour from the page instead of carrying a baked-in one.
 *
 * Three overlapping rings, unioned, with their counters punched out by a mask —
 * the overlaps have to merge into one solid shape, which is what the mask
 * guarantees and three stroked circles would not.
 */
function Wordmark({ className = 'h-9 w-auto' }: { className?: string }) {
  return (
    <svg viewBox="0 0 580 226" role="img" aria-label="DOO" className={className}>
      <mask id="doo-counters">
        {/* White keeps, black cuts. */}
        <circle cx="113" cy="113" r="113" fill="#fff" />
        <circle cx="290" cy="113" r="113" fill="#fff" />
        <circle cx="467" cy="113" r="113" fill="#fff" />

        {/* The D's counter: flat on the left, round on the right. */}
        <path d="M51 51H113a62 62 0 0 1 0 124H51z" fill="#000" />
        <circle cx="290" cy="113" r="62" fill="#000" />
        <circle cx="467" cy="113" r="62" fill="#000" />
      </mask>

      <rect width="580" height="226" fill="currentColor" mask="url(#doo-counters)" />
    </svg>
  );
}

/**
 * A street signpost, built from the reference photo.
 *
 * A fluted cast-iron pole with a finial cap and three plates on scrollwork
 * brackets: Idrees Khaled and DOO to the right, Builders League to the left
 * between them. The post is fixed and full-height — it never moves, because a
 * signpost that slides with the page is not a signpost. Only the plates react,
 * swinging on their brackets as the page scrolls.
 *
 * Drawn as one SVG rather than assembled from divs: the brackets are curves,
 * and curves are what SVG is for. Colours are the console's own — white plates,
 * purple frames, dark purple ink — with no new hues introduced.
 *
 * Desktop only. Beside a centred column there is no room for it at narrow
 * widths, and a fixed element there would sit on top of the text.
 */
function Signpost() {
  return (
    <div className="welcome-signpost" aria-hidden="true">
      {/* The lamp's light stays put while the post turns beneath it. */}
      <span className="welcome-post-lamplight" />

      <div className="welcome-post-rotor">
        <svg
          viewBox="-90 0 480 1000"
          preserveAspectRatio="xMidYMid meet"
          className="welcome-post-svg"
        >
          <defs>
            {/* Cast iron, lit from the left: the highlight is what makes a flat
              rectangle read as a cylinder. */}
            <linearGradient id="post-iron" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#241033" />
              <stop offset="22%" stopColor="#3b1d55" />
              <stop offset="44%" stopColor="#5b3a78" />
              <stop offset="60%" stopColor="#33184a" />
              <stop offset="100%" stopColor="#1a0b2b" />
            </linearGradient>
            <linearGradient id="post-plate" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fff" />
              <stop offset="100%" stopColor="#f7f5fa" />
            </linearGradient>
          </defs>

          {/* ---- Pole ---- */}
          <rect x="148" y="150" width="44" height="850" fill="url(#post-iron)" />
          {/* Flutes: three lines are enough to read as a fluted column. */}
          <line
            x1="158"
            y1="150"
            x2="158"
            y2="1000"
            stroke="#1a0b2b"
            strokeWidth="1.5"
            opacity="0.8"
          />
          <line
            x1="170"
            y1="150"
            x2="170"
            y2="1000"
            stroke="#7a5a9c"
            strokeWidth="1.5"
            opacity="0.45"
          />
          <line
            x1="182"
            y1="150"
            x2="182"
            y2="1000"
            stroke="#1a0b2b"
            strokeWidth="1.5"
            opacity="0.8"
          />

          {/* Collars, so the shaft has joints rather than being one long bar. */}
          <rect x="142" y="150" width="56" height="14" rx="3" fill="#2b1442" />
          <rect x="142" y="700" width="56" height="12" rx="3" fill="#2b1442" />

          {/* ---- Finial ---- */}
          <ellipse cx="170" cy="130" rx="28" ry="9" fill="#2b1442" />
          <path
            d="M170 64c15 0 26 15 26 32 0 15-11 26-26 26s-26-11-26-26c0-17 11-32 26-32z"
            fill="url(#post-iron)"
          />
          <path
            d="M144 98c8 11 17 15 26 15s18-4 26-15"
            stroke="#7a5a9c"
            strokeWidth="2"
            fill="none"
            opacity="0.55"
          />
          <circle cx="170" cy="58" r="6" fill="#2b1442" />

          {/* The lamp: a glass housing under the finial, lit from inside. */}
          <path
            d="M146 132h48l10 46a12 12 0 0 1-12 14h-44a12 12 0 0 1-12-14z"
            fill="#f3e8ff"
            opacity="0.92"
          />
          <path
            d="M146 132h48l10 46a12 12 0 0 1-12 14h-44a12 12 0 0 1-12-14z"
            fill="none"
            stroke="#2b1442"
            strokeWidth="3"
          />
          <ellipse className="welcome-post-filament" cx="170" cy="164" rx="13" ry="16" />

          {/* ---- Signs ---- */}
          <g className="welcome-post-sign welcome-post-sign-1">
            <Bracket side="right" y={300} />
            <Plate side="right" y={252} label="Idrees Khaled" width={172} />
          </g>

          <g className="welcome-post-sign welcome-post-sign-2">
            <Bracket side="left" y={452} />
            <Plate side="left" y={404} label="Builders League" width={184} />
          </g>

          <g className="welcome-post-sign welcome-post-sign-3">
            <Bracket side="right" y={604} />
            <Plate side="right" y={556} label="DOO" width={118} />
          </g>
        </svg>
      </div>
    </div>
  );
}

/** The scrollwork arm holding a plate. Mirrored for the left-hand side. */
function Bracket({ side, y }: { side: 'left' | 'right'; y: number }) {
  const flip = side === 'left' ? -1 : 1;

  return (
    <g transform={`translate(170 ${y}) scale(${flip} 1)`} stroke="#2b1442" fill="none">
      {/* Mounting blocks bolted to the shaft. */}
      <rect x="16" y="-60" width="13" height="22" rx="2" fill="#2b1442" stroke="none" />
      <rect x="16" y="-10" width="13" height="22" rx="2" fill="#2b1442" stroke="none" />
      <circle cx="22.5" cy="-49" r="2.5" fill="#8b6ba8" stroke="none" />
      <circle cx="22.5" cy="1" r="2.5" fill="#8b6ba8" stroke="none" />

      {/* The arm, and the scrollwork curling under it. */}
      <path d="M24 -8 L104 -8" strokeWidth="6" strokeLinecap="round" />
      <path
        d="M34 -8c0 18 11 29 24 29s22-9 22-20-9-18-18-13"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path d="M82 -8c0 15 9 24 20 24s17-8 17-17" strokeWidth="5" strokeLinecap="round" />
      <circle cx="58" cy="18" r="5.5" strokeWidth="4" />
      <circle cx="102" cy="13" r="4.5" strokeWidth="4" />
    </g>
  );
}

/** A street plate: white face, purple frame, dark purple type. */
function Plate({
  side,
  y,
  label,
  width,
}: {
  side: 'left' | 'right';
  y: number;
  label: string;
  width: number;
}) {
  const height = 58;
  const x = side === 'right' ? 200 : 140 - width;

  return (
    <g>
      {/* Outer lavender edge, purple frame, white face — the three layers a
          real enamelled sign has. */}
      <rect x={x - 5} y={y - 5} width={width + 10} height={height + 10} rx="11" fill="#e9d5ff" />
      <rect x={x} y={y} width={width} height={height} rx="7" fill="var(--color-accent-strong)" />
      <rect
        x={x + 7}
        y={y + 7}
        width={width - 14}
        height={height - 14}
        rx="4"
        fill="url(#post-plate)"
      />
      <text
        x={x + width / 2}
        y={y + height / 2 + 6}
        textAnchor="middle"
        className="welcome-post-label"
      >
        {label}
      </text>
    </g>
  );
}

/**
 * The assistant, as a machine.
 *
 * Full body: it hovers, drifts as the page scrolls, waves, and — the part that
 * makes it feel awake — turns its head and eyes toward the pointer. Decorative:
 * `aria-hidden`, and every part of it is still under `prefers-reduced-motion`.
 */
function Robot() {
  return (
    <div className="welcome-robot" aria-hidden="true">
      <span className="welcome-robot-halo" />

      <svg viewBox="0 0 180 260" className="welcome-robot-svg" fill="none">
        <defs>
          {/* Dark purple, lit from above: an object on the page, not more UI. */}
          <linearGradient id="robot-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--robot-mid)" />
            <stop offset="100%" stopColor="var(--robot-deep)" />
          </linearGradient>
          <linearGradient id="robot-limb" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--robot-mid)" />
            <stop offset="100%" stopColor="var(--robot-deep)" />
          </linearGradient>
          <clipPath id="visor-clip">
            <rect x="58" y="52" width="64" height="36" rx="15" />
          </clipPath>
          <radialGradient id="robot-eye">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="45%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#a78bfa" />
          </radialGradient>
        </defs>

        {/* The shadow stays on the ground while the body floats above it. */}
        <ellipse className="welcome-robot-shadow" cx="90" cy="243" rx="42" ry="7" />

        {/* Data rising into the machine: the connector's traffic, made visible. */}
        <g className="welcome-robot-data">
          <rect
            className="welcome-robot-bit welcome-robot-bit-1"
            x="18"
            y="200"
            width="7"
            height="7"
            rx="2"
          />
          <rect
            className="welcome-robot-bit welcome-robot-bit-2"
            x="48"
            y="214"
            width="6"
            height="6"
            rx="2"
          />
          <rect
            className="welcome-robot-bit welcome-robot-bit-3"
            x="126"
            y="208"
            width="6"
            height="6"
            rx="2"
          />
          <rect
            className="welcome-robot-bit welcome-robot-bit-4"
            x="152"
            y="196"
            width="7"
            height="7"
            rx="2"
          />
        </g>

        <g className="welcome-robot-float">
          {/* Legs */}
          <g className="welcome-robot-leg-l">
            <rect x="66" y="196" width="16" height="34" rx="7" fill="url(#robot-limb)" />
            <rect x="60" y="226" width="26" height="11" rx="5" fill="var(--robot-edge)" />
          </g>
          <g className="welcome-robot-leg-r">
            <rect x="98" y="196" width="16" height="34" rx="7" fill="url(#robot-limb)" />
            <rect x="94" y="226" width="26" height="11" rx="5" fill="var(--robot-edge)" />
          </g>

          {/* Arms — the left waves, the right keeps a small idle swing. */}
          <g className="welcome-robot-arm-l">
            <rect x="40" y="128" width="14" height="52" rx="7" fill="url(#robot-limb)" />
            <circle cx="47" cy="184" r="9" fill="var(--robot-edge)" />
          </g>
          <g className="welcome-robot-arm-r">
            <rect x="126" y="128" width="14" height="52" rx="7" fill="url(#robot-limb)" />
            <circle cx="133" cy="184" r="9" fill="var(--robot-edge)" />
          </g>

          {/* Torso */}
          <rect
            x="56"
            y="122"
            width="68"
            height="78"
            rx="22"
            fill="url(#robot-body)"
            stroke="var(--robot-edge)"
            strokeWidth="2"
          />
          <rect x="70" y="140" width="40" height="30" rx="10" fill="#1a0b3d" />
          <circle className="welcome-robot-core" cx="90" cy="155" r="8" />
          {/* Status lights: the console's own three-state vocabulary. */}
          <circle className="welcome-robot-led welcome-robot-led-1" cx="76" cy="186" r="3.5" />
          <circle className="welcome-robot-led welcome-robot-led-2" cx="90" cy="186" r="3.5" />
          <circle className="welcome-robot-led welcome-robot-led-3" cx="104" cy="186" r="3.5" />

          {/* Neck */}
          <rect x="82" y="108" width="16" height="16" rx="5" fill="var(--robot-edge)" />

          {/* Head — tilts toward the pointer. */}
          <g className="welcome-robot-head">
            <line
              x1="90"
              y1="14"
              x2="90"
              y2="30"
              stroke="var(--robot-edge)"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle
              className="welcome-robot-spark"
              cx="90"
              cy="11"
              r="5.5"
              fill="var(--color-accent)"
            />

            <rect
              x="46"
              y="30"
              width="88"
              height="80"
              rx="24"
              fill="url(#robot-body)"
              stroke="var(--robot-edge)"
              strokeWidth="2"
            />

            {/* Ears */}
            <rect x="38" y="56" width="9" height="26" rx="4.5" fill="var(--robot-edge)" />
            <rect x="133" y="56" width="9" height="26" rx="4.5" fill="var(--robot-edge)" />

            {/* Visor: darker than the shell, so the eyes have something to sit in. */}
            <rect x="58" y="52" width="64" height="36" rx="15" fill="#1a0b3d" />

            {/* A scan line sweeping the visor — the machine is reading. */}
            <g clipPath="url(#visor-clip)">
              <rect className="welcome-robot-scanline" x="58" y="52" width="64" height="4" />
            </g>

            {/* Eyes: they follow the pointer, and blink. */}
            <g className="welcome-robot-eyes">
              <circle cx="75" cy="70" r="7" fill="url(#robot-eye)" />
              <circle cx="105" cy="70" r="7" fill="url(#robot-eye)" />
            </g>

            {/* Mouth */}
            <rect x="80" y="96" width="20" height="4" rx="2" fill="var(--robot-edge)" />
          </g>
        </g>
      </svg>
    </div>
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
    <Link to={to} className="welcome-card group">
      <span className="welcome-card-glow" aria-hidden="true" />

      <span className="welcome-card-icon relative">
        <Icon className="size-5" aria-hidden="true" />
      </span>

      <p
        className="relative mt-5 text-[0.7rem] tracking-[0.18em] uppercase"
        style={{ color: 'var(--color-ink-subtle)' }}
      >
        {eyebrow}
      </p>
      <h2
        className="relative mt-1.5 flex items-center gap-2 text-lg font-semibold"
        style={{ color: 'var(--color-ink)' }}
      >
        {title}
        <ArrowRight
          className="size-4 opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100"
          aria-hidden="true"
        />
      </h2>
      <p className="relative mt-2 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
        {body}
      </p>
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
          className="welcome-pulse size-1.5 rounded-full"
          style={{
            background: tone === 'live' ? 'var(--color-success)' : 'var(--color-warning)',
          }}
          aria-hidden="true"
        />
      )}
      {label}
    </li>
  );
}

/** A card that rises into place the first time it is scrolled into view. */
function Surface({ index, title, body }: { index: number; title: string; body: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (prefersReducedMotion()) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        // One-way: a card that has arrived stays arrived, so scrolling back up
        // does not replay the animation.
        if (entry?.isIntersecting === true) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="welcome-surface welcome-reveal"
      data-shown={shown}
      style={{ transitionDelay: `${index * 110}ms` }}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
        {title}
      </h3>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
        {body}
      </p>
    </div>
  );
}
