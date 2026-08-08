import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names, resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a duration for display, keeping magnitudes readable at a glance. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Relative time, falling back to an absolute date once it stops being useful. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A due date, with overdue and near-due states callers can style. */
export function formatDueDate(dueOn: string | null): {
  label: string;
  state: 'none' | 'overdue' | 'today' | 'soon' | 'future';
} {
  if (dueOn === null) return { label: 'No due date', state: 'none' };

  const due = new Date(`${dueOn}T00:00:00`);
  if (Number.isNaN(due.getTime())) return { label: dueOn, state: 'none' };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const label = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  if (days < 0) return { label: `${label} (overdue)`, state: 'overdue' };
  if (days === 0) return { label: 'Today', state: 'today' };
  if (days === 1) return { label: 'Tomorrow', state: 'soon' };
  if (days <= 7) return { label, state: 'soon' };
  return { label, state: 'future' };
}

/** Absolute timestamp, used where precision matters more than brevity. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Stable pretty-printed JSON for the inspector and playground. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Copy text, reporting success so the caller can show real feedback. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Initials for an avatar, without assuming a Western name order. */
export function initials(name: string | null): string {
  if (name === null || name.trim().length === 0) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
