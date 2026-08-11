/**
 * The landing page.
 *
 * Rendered outside the console shell, on the console's own light palette, and
 * it has one job: say what this is and offer the two ways in — the console for
 * people, the MCP endpoint for agents.
 *
 * It reads as one continuous scroll sequence: the robot in a field of purple
 * particles, then a ring of domain cards that tilts into depth as it comes into
 * view, then the three surfaces, then the two ways in. Two rules keep that from
 * being noise:
 *
 *   1. Motion is driven by CSS custom properties written from one rAF-throttled
 *      listener each. React never re-renders on pointer or scroll movement.
 *   2. All of it is decorative and off under `prefers-reduced-motion`, where
 *      the page reads identically as a still document.
 */

import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, LayoutDashboard, Network, ShieldCheck, Zap } from 'lucide-react';

import { useActions, useStatus } from '@/hooks/useConnector';

// Only fetched when someone actually clicks the robot.
const AssistantPopup = lazy(() =>
  import('@/components/assistant/AssistantPopup').then((m) => ({ default: m.AssistantPopup })),
);

export function Welcome() {
  const status = useStatus();
  const actions = useActions();
  const total = actions.data?.actions.length ?? 35;
  const live = status.data?.demoMode === false;

  const stage = useRef<HTMLDivElement>(null);
  usePointer(stage);
  useScrollProgress(stage);

  const [chatOpen, setChatOpen] = useState(false);

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

      <header className="welcome-nav" style={rise(0)}>
        <Link to="/" className="welcome-nav-mark" aria-label="doo">
          <Wordmark className="h-6 w-auto" />
        </Link>
        <nav className="welcome-nav-links">
          <Link to="/docs">Documentation</Link>
          <Link to="/mcp">MCP</Link>
          <Link to="/overview" className="welcome-nav-cta">
            Open the console
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </nav>
      </header>

      <main className="relative mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 pt-28 pb-20 text-center">
        <div className="welcome-rise mt-2" style={rise(80)}>
          <Robot onOpen={() => setChatOpen(true)} />
        </div>

        <p
          className="welcome-rise mt-6 text-xs font-medium tracking-[0.28em] uppercase"
          style={{ ...rise(160), color: 'var(--color-ink-subtle)' }}
        >
          Builders League · Cohort 01
        </p>

        <h1
          className="welcome-rise welcome-title mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
          style={rise(220)}
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

      <section id="what-it-is" className="relative px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2
            className="text-center text-2xl font-semibold sm:text-3xl"
            style={{ color: 'var(--color-ink)' }}
          >
            Six domains, {total} connectors
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

      <section className="relative px-6 py-24">
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

      {chatOpen && (
        <Suspense fallback={null}>
          <AssistantPopup onClose={() => setChatOpen(false)} />
        </Suspense>
      )}
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

/**
 * Publish one element's full pass through the viewport as `--pass` (0…1).
 *
 * 0 the instant its top edge touches the bottom of the screen, 1 when its
 * bottom edge leaves the top. The ring reads it as extra rotation, so scrolling
 * turns it further — a shift the wheel drives directly and that reverses when
 * you scroll back up.
 *
 * It deliberately drives rotation only. An earlier version moved the ring
 * toward the camera, which read as a zoom and made the section feel like it was
 * stalling rather than turning.
 *
 * The listener is only attached while the element is near the viewport, so the
 * rest of the page scrolls without it.
 */
function useSectionProgress(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null || prefersReducedMotion()) return;

    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const span = window.innerHeight + rect.height;
      const travelled = (window.innerHeight - rect.top) / span;
      node.style.setProperty('--pass', Math.min(1, Math.max(0, travelled)).toFixed(4));
    };

    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          window.addEventListener('scroll', onScroll, { passive: true });
          apply();
        } else {
          window.removeEventListener('scroll', onScroll);
        }
      },
      // Start tracking a screen early, so the tilt has already begun when the
      // ring's first pixel appears.
      { rootMargin: '100% 0px' },
    );

    watcher.observe(node);
    apply();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      watcher.disconnect();
      window.removeEventListener('scroll', onScroll);
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
  const stage = useRef<HTMLDivElement>(null);
  useSectionProgress(stage);

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
    <div ref={stage} className="welcome-ring-stage">
      {/* Three layers, because each carries a different transform and one
          element cannot hold three: the tilt, the scroll-driven rotation, and
          the continuous turn. */}
      <div className="welcome-ring">
        <div className="welcome-ring-scroll">
          <div className="welcome-ring-cards">
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
        </div>
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
  // The mark appears more than once on this page, and two masks answering to
  // one id is a collision waiting to render the wrong shape.
  const mask = `doo-counters-${useId()}`;

  return (
    <svg viewBox="0 0 580 226" role="img" aria-label="DOO" className={className}>
      <mask id={mask}>
        {/* White keeps, black cuts. */}
        <circle cx="113" cy="113" r="113" fill="#fff" />
        <circle cx="290" cy="113" r="113" fill="#fff" />
        <circle cx="467" cy="113" r="113" fill="#fff" />

        {/* The D's counter: flat on the left, round on the right. */}
        <path d="M51 51H113a62 62 0 0 1 0 124H51z" fill="#000" />
        <circle cx="290" cy="113" r="62" fill="#000" />
        <circle cx="467" cy="113" r="62" fill="#000" />
      </mask>

      <rect width="580" height="226" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}

/**
 * The assistant, as a machine.
 *
 * Full body: it hovers, drifts as the page scrolls, waves, and — the part that
 * makes it feel awake — turns its head and eyes toward the pointer. Decorative:
 * `aria-hidden`, and every part of it is still under `prefers-reduced-motion`.
 */
function Robot({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="welcome-robot" onClick={onOpen}>
      {/* The machine is the affordance, so it says what it does on hover and
          to a screen reader — the drawing itself stays decorative. */}
      <span className="sr-only">Open the assistant</span>
      <span className="welcome-robot-hint" aria-hidden="true">
        Ask me anything
      </span>
      <span className="welcome-robot-halo" aria-hidden="true" />
      <Particles />

      <svg viewBox="0 0 180 260" className="welcome-robot-svg" fill="none" aria-hidden="true">
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
    </button>
  );
}

/**
 * The glow around the robot.
 *
 * Written out rather than randomised: a fixed set means the layout is the same
 * on every render and on the server, and a hand-placed ring reads better than
 * a random scatter, which always clumps. Each entry is an angle around the
 * machine, a radius, a size and a phase offset for its drift.
 */
const PARTICLES = [
  { angle: 8, radius: 46, size: 5, delay: 0 },
  { angle: 52, radius: 40, size: 3, delay: 1.1 },
  { angle: 96, radius: 48, size: 6, delay: 2.4 },
  { angle: 140, radius: 38, size: 4, delay: 0.6 },
  { angle: 186, radius: 45, size: 3, delay: 3.1 },
  { angle: 224, radius: 42, size: 5, delay: 1.8 },
  { angle: 268, radius: 47, size: 4, delay: 2.9 },
  { angle: 312, radius: 39, size: 3, delay: 0.3 },
  { angle: 348, radius: 44, size: 6, delay: 3.6 },
  { angle: 30, radius: 30, size: 3, delay: 2.1 },
  { angle: 160, radius: 28, size: 3, delay: 1.4 },
  { angle: 290, radius: 31, size: 4, delay: 3.3 },
];

function Particles() {
  return (
    <span className="welcome-particles" aria-hidden="true">
      {PARTICLES.map((particle) => (
        <span
          key={`${particle.angle}-${particle.radius}`}
          className="welcome-particle"
          style={
            {
              // Polar, so they sit on a ring around the machine rather than in
              // a box around it.
              left: `${50 + Math.cos((particle.angle * Math.PI) / 180) * particle.radius}%`,
              top: `${50 + Math.sin((particle.angle * Math.PI) / 180) * particle.radius}%`,
              width: `${particle.size}px`,
              height: `${particle.size}px`,
              animationDelay: `${particle.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}

/** Slow-drifting colour fields. Purely atmospheric; nothing reads on top of it. */
function Aurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="welcome-orb welcome-orb-a" />
      <div className="welcome-orb welcome-orb-b" />
      <div className="welcome-grid" />

      {/* The mark as a watermark, oversized in the top-left corner: part of the
          background, faint enough that the nav's logo stays the one you read. */}
      <Wordmark className="welcome-watermark" />

      <StreetLamp />
    </div>
  );
}

/**
 * A street lamp on the right-hand side, with a sign reading AI.
 *
 * Fixed to the viewport and completely still — no drift, no flicker, no
 * animation of any kind. It stands the height of the page and the page scrolls
 * past it, which is the only reason it can be this tall without ever pushing
 * anything around: it is out of the flow entirely.
 *
 * Drawn in the page's own purples, so it reads as part of the scene rather than
 * as an illustration dropped onto it, and only shown where there is a real
 * gutter to stand in — a narrow window has no room beside the column.
 */
function StreetLamp() {
  return (
    <svg
      className="welcome-lamppost"
      viewBox="0 0 140 900"
      fill="none"
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        {/* Lit from the left, where the page's light comes from. */}
        <linearGradient id="lamp-post" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--robot-edge)" />
          <stop offset="55%" stopColor="var(--robot-mid)" />
          <stop offset="100%" stopColor="var(--robot-deep)" />
        </linearGradient>
        <linearGradient id="lamp-sign" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--robot-mid)" />
          <stop offset="100%" stopColor="var(--robot-deep)" />
        </linearGradient>
        <radialGradient id="lamp-glow">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The pool of light. Static: a lamp that pulsed would be one more thing
          moving on a page that already has enough. */}
      <circle cx="70" cy="44" r="54" fill="url(#lamp-glow)" />

      {/* Lamp head, at the very top of the frame so it sits just under the bar */}
      <circle cx="70" cy="13" r="5" fill="var(--robot-edge)" />
      <rect x="66" y="17" width="8" height="16" rx="3" fill="var(--robot-edge)" />
      <path d="M46 58h48l-10-26H56z" fill="url(#lamp-post)" />
      <rect x="52" y="52" width="36" height="8" rx="4" fill="var(--color-accent)" />

      {/* Column, running the whole way down, with two collars to break up its
          length. The frame is 140 × 900 — deliberately narrow and tall, because
          an SVG scales to fit its box and a squarer frame would leave the post
          floating short of the floor. */}
      <rect x="63" y="58" width="14" height="818" rx="6" fill="url(#lamp-post)" />
      <rect x="58" y="330" width="24" height="9" rx="4" fill="var(--robot-edge)" />
      <rect x="58" y="660" width="24" height="9" rx="4" fill="var(--robot-edge)" />

      {/* Base, planted on the floor of the frame */}
      <ellipse cx="70" cy="896" rx="34" ry="7" fill="var(--robot-deep)" opacity="0.16" />
      <path d="M52 898h36l-5-30H57z" fill="url(#lamp-post)" />
      <rect x="49" y="862" width="42" height="10" rx="4" fill="var(--robot-edge)" />

      {/* The sign, hung off the left of the column on two short brackets, so it
          faces the page rather than the window edge. */}
      <rect x="53" y="164" width="10" height="4" rx="2" fill="var(--robot-edge)" />
      <rect x="53" y="226" width="10" height="4" rx="2" fill="var(--robot-edge)" />
      <rect
        x="4"
        y="148"
        width="52"
        height="98"
        rx="12"
        fill="url(#lamp-sign)"
        stroke="var(--robot-edge)"
        strokeWidth="2"
      />
      <text
        x="30"
        y="197"
        className="welcome-lamppost-label"
        textAnchor="middle"
        dominantBaseline="central"
      >
        AI
      </text>
    </svg>
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
      <span className="welcome-surface-glow" aria-hidden="true" />
      <span className="welcome-surface-index" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <h3 className="relative text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
        {title}
      </h3>
      <p className="relative mt-2 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
        {body}
      </p>
    </div>
  );
}
