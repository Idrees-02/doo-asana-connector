/**
 * The demo-mode banner.
 *
 * Persistent and unmissable by design. The brief is unambiguous that synthetic
 * data must never be presentable as real Asana data, so this is:
 *
 *   - not dismissible — a dismissed banner would leave demo data looking real
 *     for the rest of the session, which is the exact failure being guarded against
 *   - driven by the server's own `demoMode` flag, not a client-side guess
 *   - rendered above the layout, so it appears on every page
 *
 * It also states how to switch to live data, so the banner is useful rather
 * than merely a warning.
 */

import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { api } from '@/services/api';

export function DemoBanner() {
  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => api.getStatus(signal),
    // Cheap and important enough to keep current: if the operator adds a
    // token and restarts, the banner should disappear without a hard reload.
    refetchInterval: 30_000,
    retry: false,
  });

  if (data?.demoMode !== true) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-(--color-warning)/30 bg-(--color-warning-muted) px-4 py-2 text-center text-xs text-(--color-warning)"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-semibold">DEMO MODE</span>
      <span className="text-(--color-warning)/85">
        All data shown is synthetic and is not from a real Asana workspace.
      </span>
      <span className="hidden text-(--color-warning)/70 sm:inline">
        Add ASANA_ACCESS_TOKEN to .env and restart to use live data.
      </span>
    </div>
  );
}
