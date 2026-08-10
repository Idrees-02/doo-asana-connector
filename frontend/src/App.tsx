/**
 * Application root: providers, routing, and code splitting.
 *
 * Every page except Overview is lazy-loaded. The console has twelve routes and
 * a reviewer typically visits three or four, so shipping all of them in the
 * initial bundle would be paying for pages nobody opened.
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/ui/Toast';
import { TableSkeleton } from '@/components/ui';
import { ApiError } from '@/services/api';
import { Overview } from '@/pages/Overview';
import { Welcome } from '@/pages/Welcome';

/* Lazy routes. */
const Projects = lazy(() => import('@/pages/Projects').then((m) => ({ default: m.Projects })));
const Tasks = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.Tasks })));
const Actions = lazy(() => import('@/pages/Actions').then((m) => ({ default: m.Actions })));
const Playground = lazy(() =>
  import('@/pages/Playground').then((m) => ({ default: m.Playground })),
);
const ActivityPage = lazy(() =>
  import('@/pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);
const Schemas = lazy(() => import('@/pages/Schemas').then((m) => ({ default: m.Schemas })));
const Mcp = lazy(() => import('@/pages/Mcp').then((m) => ({ default: m.Mcp })));
const Health = lazy(() => import('@/pages/Health').then((m) => ({ default: m.Health })));
const Architecture = lazy(() =>
  import('@/pages/Architecture').then((m) => ({ default: m.Architecture })),
);
const Documentation = lazy(() =>
  import('@/pages/Documentation').then((m) => ({ default: m.Documentation })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const Assistant = lazy(() => import('@/pages/Assistant').then((m) => ({ default: m.Assistant })));
const NotFound = lazy(() => import('@/pages/NotFound').then((m) => ({ default: m.NotFound })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Refetching on every window focus is noisy for a console the user
      // tabs away from constantly, and each refetch costs Asana quota.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Respect the connector's own retry classification rather than
        // second-guessing it in the client. A write that "may already have
        // applied" must never be retried automatically from here.
        if (error instanceof ApiError) {
          if (!error.retryable || error.needsManualRetry) return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      // Writes are NEVER retried automatically. The connector cannot tell
      // whether a failed create took effect, so repeating it risks a
      // duplicate task or comment. Retrying is always the user's decision.
      retry: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/*
              The landing page sits outside the console shell: it has its own
              dark canvas and no sidebar, and it is the only route a first-time
              visitor sees before choosing a way in.
            */}
            <Route path="/" element={<Welcome />} />
            <Route path="/*" element={<Console />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function Console() {
  return (
    <AppShell>
      <Suspense fallback={<TableSkeleton rows={6} />}>
        <Routes>
          <Route path="/overview" element={<Overview />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:projectId" element={<Tasks />} />
          <Route path="/actions" element={<Actions />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/schemas" element={<Schemas />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/health" element={<Health />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/docs" element={<Documentation />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
