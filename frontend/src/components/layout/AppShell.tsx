/**
 * The application shell.
 *
 * Navigation is built per breakpoint rather than by shrinking one layout:
 *
 *   >= 1024px  full sidebar with labels
 *   768-1023   icon rail with tooltips, reclaiming ~180px for dense tables
 *   < 768      bottom tab bar for the five primary destinations, plus a
 *              slide-over sheet for the rest
 *
 * A shrunken desktop sidebar on a phone would be unusable, and the brief
 * explicitly asks for real mobile navigation instead.
 */

import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Boxes,
  FileJson,
  FlaskConical,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  ListTodo,
  Menu,
  Network,
  Plug,
  Settings,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { DemoBanner } from './DemoBanner';
import { ConnectionIndicator } from './ConnectionIndicator';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof LayoutDashboard;
  /** Shown in the mobile bottom bar. Limited to five for touch-target width. */
  readonly primary?: boolean;
}

const NAV_SECTIONS: ReadonlyArray<{ title: string; items: readonly NavItem[] }> = [
  {
    title: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard, primary: true },
      { to: '/projects', label: 'Projects', icon: Boxes, primary: true },
      { to: '/tasks', label: 'Tasks', icon: ListTodo, primary: true },
    ],
  },
  {
    title: 'Developer',
    items: [
      { to: '/actions', label: 'Actions', icon: Plug, primary: true },
      { to: '/playground', label: 'API Playground', icon: FlaskConical, primary: true },
      { to: '/activity', label: 'Activity', icon: Activity },
      { to: '/schemas', label: 'Schemas', icon: FileJson },
      { to: '/mcp', label: 'MCP', icon: Network },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/health', label: 'Health', icon: HeartPulse },
      { to: '/architecture', label: 'Architecture', icon: Gauge },
      { to: '/docs', label: 'Documentation', icon: BookOpen },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const ALL_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
const PRIMARY_ITEMS = ALL_ITEMS.filter((i) => i.primary === true);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const location = useLocation();

  // Close the mobile sheet on navigation, otherwise it covers the page the
  // user just chose.
  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  // Escape closes the sheet — expected of any overlay, and required for
  // keyboard users who cannot reach the close button visually.
  useEffect(() => {
    if (!sheetOpen) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  return (
    <div className="min-h-screen bg-(--color-canvas)">
      {/* Keyboard users land here first and can jump past the navigation. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-(--radius-md) focus:bg-(--color-accent) focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>

      <DemoBanner />

      <div className="flex">
        {/* Desktop sidebar / tablet rail */}
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <MobileHeader onOpenMenu={() => setSheetOpen(true)} />

          <main
            id="main-content"
            className="min-w-0 flex-1 px-4 py-6 pb-24 md:px-6 lg:px-8 lg:pb-8"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </div>

      <MobileTabBar />
      {sheetOpen ? <MobileSheet onClose={() => setSheetOpen(false)} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Desktop sidebar and tablet rail                                             */
/* -------------------------------------------------------------------------- */

function Sidebar() {
  return (
    <nav
      aria-label="Main navigation"
      className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-(--color-hairline) bg-(--color-surface) md:flex md:w-16 lg:w-60"
    >
      <Brand />

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            <h2 className="mb-1 hidden px-2 text-[10px] font-semibold uppercase tracking-wider text-(--color-ink-subtle) lg:block">
              {section.title}
            </h2>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <SidebarLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <Footer />
    </nav>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      // On the icon rail the label is visually hidden, so the accessible name
      // has to come from the title/aria attributes instead.
      title={item.label}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-(--radius-md) px-2 py-1.5 text-sm transition-colors',
          'md:justify-center lg:justify-start',
          isActive
            ? 'bg-(--color-surface-3) font-medium text-(--color-ink)'
            : 'text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink)',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* A left rule marks the active item, so selection is not conveyed
              by background colour alone. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-0 h-5 w-0.5 rounded-r',
              isActive ? 'bg-(--color-accent)' : 'bg-transparent',
              'hidden lg:block',
            )}
          />
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden lg:inline">{item.label}</span>
          <span className="sr-only lg:hidden">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function Brand() {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-(--color-hairline) px-3 lg:px-4">
      <AsanaMark />
      <div className="hidden min-w-0 lg:block">
        <div className="truncate text-sm font-semibold leading-tight text-(--color-ink)">
          Asana Connector
        </div>
        <div className="truncate text-[10px] leading-tight text-(--color-ink-subtle)">
          Integration console
        </div>
      </div>
    </div>
  );
}

/** Three dots, echoing Asana's identity without reproducing their logo. */
function AsanaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-6 w-6 shrink-0', className)} aria-hidden="true">
      <circle cx="16" cy="9" r="5" fill="var(--color-accent)" />
      <circle cx="8" cy="22" r="5" fill="var(--color-accent)" />
      <circle cx="24" cy="22" r="5" fill="var(--color-accent)" />
    </svg>
  );
}

function Footer() {
  return (
    <div className="shrink-0 border-t border-(--color-hairline) p-3">
      <div className="hidden lg:block">
        <div className="text-[11px] font-medium text-(--color-ink-muted)">Idrees Khaled</div>
        <div className="mt-0.5 text-[10px] text-(--color-ink-subtle)">v1.0.0</div>
      </div>
      <div className="mt-2 lg:mt-2">
        <ConnectionIndicator />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mobile                                                                      */
/* -------------------------------------------------------------------------- */

function MobileHeader({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-(--color-hairline) bg-(--color-surface) px-4 md:hidden">
      <div className="flex items-center gap-2">
        <AsanaMark className="h-5 w-5" />
        <span className="text-sm font-semibold">Asana Connector</span>
      </div>
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        className="rounded-(--radius-md) p-2 text-(--color-ink-muted) hover:bg-(--color-surface-2) hover:text-(--color-ink)"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
    </header>
  );
}

/** Bottom tabs for the five primary destinations — thumb-reachable on a phone. */
function MobileTabBar() {
  return (
    <nav
      aria-label="Primary navigation"
      className="fixed bottom-0 left-0 right-0 z-20 grid grid-cols-5 border-t border-(--color-hairline) bg-(--color-surface) md:hidden"
    >
      {PRIMARY_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                // 56px tall: comfortably above the 44px minimum touch target.
                'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
                isActive ? 'text-(--color-accent)' : 'text-(--color-ink-muted)',
              )
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="max-w-full truncate px-1">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function MobileSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        aria-label="Close navigation menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute right-0 top-0 flex h-full w-72 max-w-[85vw] flex-col border-l border-(--color-hairline) bg-(--color-surface)"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-(--color-hairline) px-4">
          <span className="text-sm font-semibold">Navigation</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="rounded-(--radius-md) p-1.5 text-(--color-ink-muted) hover:bg-(--color-surface-2)"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="mb-4">
              <h2 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-(--color-ink-subtle)">
                {section.title}
              </h2>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-2.5 rounded-(--radius-md) px-2 py-2 text-sm',
                            isActive
                              ? 'bg-(--color-surface-3) font-medium text-(--color-ink)'
                              : 'text-(--color-ink-muted)',
                          )
                        }
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {item.label}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-(--color-hairline) p-4">
          <div className="text-[11px] text-(--color-ink-muted)">Idrees Khaled · v1.0.0</div>
          <div className="mt-2">
            <ConnectionIndicator />
          </div>
        </div>
      </div>
    </div>
  );
}
