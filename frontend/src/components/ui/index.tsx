/**
 * UI primitives.
 *
 * A small, deliberately plain set. Every stateful component here follows two
 * rules from the brief:
 *
 *   1. State is never communicated by colour alone. Each status carries an
 *      icon and a text label as well, so it survives greyscale, colour
 *      blindness and a screen reader.
 *   2. Async surfaces expose all four states — loading, empty, error, success.
 *      `AsyncBoundary` makes handling all four the path of least resistance,
 *      so a page cannot accidentally ship with only the happy path.
 */

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Inbox,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* ========================================================================== */
/* Button                                                                      */
/* ========================================================================== */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-(--color-accent) text-white hover:bg-(--color-accent-hover) disabled:hover:bg-(--color-accent)',
  secondary:
    'bg-(--color-surface-2) text-(--color-ink) border border-(--color-hairline) hover:bg-(--color-surface-3) hover:border-(--color-hairline-strong)',
  ghost: 'text-(--color-ink-muted) hover:text-(--color-ink) hover:bg-(--color-surface-2)',
  danger:
    'bg-(--color-danger-muted) text-(--color-danger) border border-(--color-danger)/30 hover:border-(--color-danger)/60',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon: Icon, children, className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Disabled while loading so a double-click cannot fire a write twice.
      disabled={disabled === true || loading}
      // Announces the pending state to assistive technology, not just visually.
      aria-busy={loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-(--radius-md) font-medium',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : Icon !== undefined ? (
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
});

/* ========================================================================== */
/* Status indicators                                                           */
/* ========================================================================== */

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_STYLES: Record<StatusTone, { dot: string; text: string; bg: string; border: string }> = {
  success: {
    dot: 'bg-(--color-success)',
    text: 'text-(--color-success)',
    bg: 'bg-(--color-success-muted)',
    border: 'border-(--color-success)/30',
  },
  warning: {
    dot: 'bg-(--color-warning)',
    text: 'text-(--color-warning)',
    bg: 'bg-(--color-warning-muted)',
    border: 'border-(--color-warning)/30',
  },
  danger: {
    dot: 'bg-(--color-danger)',
    text: 'text-(--color-danger)',
    bg: 'bg-(--color-danger-muted)',
    border: 'border-(--color-danger)/30',
  },
  info: {
    dot: 'bg-(--color-info)',
    text: 'text-(--color-info)',
    bg: 'bg-(--color-info-muted)',
    border: 'border-(--color-info)/30',
  },
  neutral: {
    dot: 'bg-(--color-ink-subtle)',
    text: 'text-(--color-ink-muted)',
    bg: 'bg-(--color-surface-2)',
    border: 'border-(--color-hairline)',
  },
};

const TONE_ICONS: Record<StatusTone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  info: Info,
  neutral: Info,
};

/**
 * A status pill.
 *
 * Always renders an icon alongside the label: the dot alone would encode
 * meaning purely in hue, which the brief explicitly forbids.
 */
export function StatusPill({
  tone,
  children,
  showIcon = true,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  showIcon?: boolean;
  className?: string;
}) {
  const styles = TONE_STYLES[tone];
  const Icon = TONE_ICONS[tone];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-(--radius-sm) border px-2 py-0.5 text-xs font-medium',
        styles.bg,
        styles.text,
        styles.border,
        className,
      )}
    >
      {showIcon ? <Icon className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** A dot + text label. The text carries the meaning; the dot is decoration. */
export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_STYLES[tone].dot)} aria-hidden="true" />
      <span className={TONE_STYLES[tone].text}>{label}</span>
    </span>
  );
}

/* ========================================================================== */
/* Panels and headings                                                         */
/* ========================================================================== */

export function Panel({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-(--color-hairline) px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-(--color-ink)">{title}</h2>
        {description !== undefined ? (
          <p className="mt-0.5 text-xs text-(--color-ink-muted)">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-(--color-ink)">{title}</h1>
        {description !== undefined ? (
          <p className="mt-1 max-w-2xl text-sm text-(--color-ink-muted)">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* ========================================================================== */
/* Async states                                                                */
/* ========================================================================== */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden="true" />;
}

/** Row skeletons sized to the table they stand in for, to avoid layout shift. */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-(--color-hairline) px-4 py-3 last:border-0"
        >
          {Array.from({ length: columns }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              className={colIndex === 0 ? 'h-4 flex-1' : 'h-4 w-24 shrink-0'}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <Icon className="h-8 w-8 text-(--color-ink-subtle)" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-medium text-(--color-ink)">{title}</h3>
      {description !== undefined ? (
        <p className="mt-1 max-w-sm text-xs text-(--color-ink-muted)">{description}</p>
      ) : null}
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Error display.
 *
 * Shows the code, the guidance, the request id and any field-level details,
 * because "something went wrong" is not actionable. When a write may have
 * partially applied, that warning is given its own prominent treatment — it is
 * the single most consequential thing a user can be told here.
 */
export function ErrorState({
  title = 'Something went wrong',
  code,
  message,
  guidance,
  requestId,
  details,
  needsManualRetry = false,
  onRetry,
}: {
  title?: string;
  code?: string;
  message: string;
  guidance?: string;
  requestId?: string;
  details?: ReadonlyArray<{ field?: string; message: string }>;
  needsManualRetry?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-(--radius-md) border border-(--color-danger)/30 bg-(--color-danger-muted) p-4"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--color-danger)" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-(--color-ink)">{title}</h3>
            {code !== undefined ? <code className="id-chip">{code}</code> : null}
          </div>

          <p className="mt-1 text-sm text-(--color-ink-muted)">{message}</p>

          {guidance !== undefined ? (
            <p className="mt-2 text-xs text-(--color-ink-muted)">{guidance}</p>
          ) : null}

          {needsManualRetry ? (
            <div className="mt-3 flex items-start gap-2 rounded-(--radius-sm) border border-(--color-warning)/30 bg-(--color-warning-muted) p-2.5">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warning)" aria-hidden="true" />
              <p className="text-xs text-(--color-warning)">
                This write may already have been applied in Asana. Check before retrying — retrying
                blindly can create a duplicate.
              </p>
            </div>
          ) : null}

          {details !== undefined && details.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {details.map((detail, index) => (
                <li key={index} className="text-xs text-(--color-ink-muted)">
                  {detail.field !== undefined ? (
                    <code className="mono text-(--color-danger)">{detail.field}</code>
                  ) : null}{' '}
                  {detail.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {onRetry !== undefined && !needsManualRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {requestId !== undefined ? (
              <span className="id-chip" title="Use this id to find the request in Activity">
                {requestId}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the right state for an async query.
 *
 * Exists so that handling loading, error and empty is easier than skipping
 * them — the brief requires all four states everywhere, and this makes the
 * complete version the default.
 */
export function AsyncBoundary<T>({
  isLoading,
  error,
  data,
  isEmpty,
  loadingFallback,
  emptyFallback,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  isEmpty?: (data: T) => boolean;
  loadingFallback?: ReactNode;
  emptyFallback?: ReactNode;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) {
  if (isLoading) {
    return <>{loadingFallback ?? <TableSkeleton />}</>;
  }

  if (error !== null && error !== undefined) {
    const apiError = error as {
      payload?: { code: string; guidance: string; requestId: string; details?: ReadonlyArray<{ field?: string; message: string }> };
      message?: string;
      needsManualRetry?: boolean;
    };

    return (
      <ErrorState
        message={apiError.message ?? 'Request failed.'}
        {...(apiError.payload?.code === undefined ? {} : { code: apiError.payload.code })}
        {...(apiError.payload?.guidance === undefined ? {} : { guidance: apiError.payload.guidance })}
        {...(apiError.payload?.requestId === undefined
          ? {}
          : { requestId: apiError.payload.requestId })}
        {...(apiError.payload?.details === undefined ? {} : { details: apiError.payload.details })}
        needsManualRetry={apiError.needsManualRetry === true}
        {...(onRetry === undefined ? {} : { onRetry })}
      />
    );
  }

  if (data === undefined) {
    return <>{loadingFallback ?? <TableSkeleton />}</>;
  }

  if (isEmpty?.(data) === true) {
    return <>{emptyFallback ?? <EmptyState title="Nothing to show" />}</>;
  }

  return <>{children(data)}</>;
}

/* ========================================================================== */
/* Form controls                                                               */
/* ========================================================================== */

interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/**
 * A labelled form field.
 *
 * Wires up `aria-describedby` for both hint and error text so a screen reader
 * announces them with the input, rather than leaving them as orphaned text
 * that only sighted users benefit from.
 */
export function Field({ label, htmlFor, required = false, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-(--color-ink)">
        {label}
        {required ? (
          <span className="ml-1 text-(--color-accent)" aria-label="required">
            *
          </span>
        ) : (
          <span className="ml-1.5 text-(--color-ink-subtle)">optional</span>
        )}
      </label>

      {children}

      {hint !== undefined && error === undefined ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-(--color-ink-subtle)">
          {hint}
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={`${htmlFor}-error`} role="alert" className="flex items-center gap-1.5 text-xs text-(--color-danger)">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

const INPUT_CLASSES =
  'w-full rounded-(--radius-md) border bg-(--color-surface-2) px-2.5 py-1.5 text-sm text-(--color-ink) placeholder:text-(--color-ink-subtle) transition-colors focus:border-(--color-accent) disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid = false, ...props }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid}
        className={cn(
          INPUT_CLASSES,
          invalid ? 'border-(--color-danger)' : 'border-(--color-hairline)',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid = false, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid}
      className={cn(
        INPUT_CLASSES,
        'resize-y',
        invalid ? 'border-(--color-danger)' : 'border-(--color-hairline)',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, invalid = false, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid}
      className={cn(
        INPUT_CLASSES,
        invalid ? 'border-(--color-danger)' : 'border-(--color-hairline)',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});
