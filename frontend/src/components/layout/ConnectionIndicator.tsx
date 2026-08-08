/**
 * Connection status in the sidebar footer.
 *
 * Reports what the server actually says rather than assuming connected-until-
 * proven-otherwise, and distinguishes "checking", "connected", "not
 * authenticated" and "API unreachable" — four genuinely different situations
 * that a single red/green dot would flatten into one.
 */

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/services/api';
import { StatusDot, type StatusTone } from '@/components/ui';

export function ConnectionIndicator() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['connection'],
    queryFn: ({ signal }) => api.testConnection(signal),
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-(--color-ink-subtle)">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Checking…
      </span>
    );
  }

  // The API itself is unreachable — a different problem from Asana rejecting us.
  if (isError) {
    return <StatusDot tone="danger" label="API offline" />;
  }

  const tone: StatusTone = data?.connected === true ? 'success' : 'warning';
  const label =
    data?.connected === true
      ? data.mode === 'demo'
        ? 'Demo connected'
        : 'Connected'
      : 'Not authenticated';

  return (
    <span title={data?.error?.message ?? data?.account?.name ?? undefined}>
      <StatusDot tone={tone} label={label} />
    </span>
  );
}
