/**
 * Toast notifications.
 *
 * A minimal, accessible implementation rather than a dependency: toasts are
 * announced through an `aria-live` region so screen-reader users learn that a
 * task was created, and errors use `assertive` while successes use `polite`,
 * so a failure interrupts and a confirmation does not.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description?: string;
  /** Shown as monospace detail — used for request ids. */
  readonly meta?: string;
}

interface ToastContextValue {
  toast: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used within ToastProvider.');
  return context;
}

const AUTO_DISMISS_MS = 6_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (next: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { ...next, id }]);

      // Errors persist until dismissed: a failure the user missed is worse
      // than a lingering card, especially when it names a request id.
      if (next.tone !== 'error') {
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        // Sits above the mobile tab bar so it never obscures navigation.
        className="pointer-events-none fixed bottom-16 right-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4 md:bottom-0"
      >
        {toasts.map((item) => (
          <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONE_CONFIG: Record<ToastTone, { icon: typeof Info; classes: string; live: 'polite' | 'assertive' }> = {
  success: {
    icon: CheckCircle2,
    classes: 'border-(--color-success)/30 bg-(--color-success-muted) text-(--color-success)',
    live: 'polite',
  },
  error: {
    icon: AlertCircle,
    classes: 'border-(--color-danger)/30 bg-(--color-danger-muted) text-(--color-danger)',
    live: 'assertive',
  },
  info: {
    icon: Info,
    classes: 'border-(--color-info)/30 bg-(--color-info-muted) text-(--color-info)',
    live: 'polite',
  },
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const config = TONE_CONFIG[toast.tone];
  const Icon = config.icon;

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={config.live}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-(--radius-md) border p-3 shadow-lg',
        config.classes,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-(--color-ink)">{toast.title}</p>
        {toast.description !== undefined ? (
          <p className="mt-0.5 text-xs text-(--color-ink-muted)">{toast.description}</p>
        ) : null}
        {toast.meta !== undefined ? (
          <code className="mono mt-1.5 block text-[10px] text-(--color-ink-subtle)">{toast.meta}</code>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-(--color-ink-subtle) hover:text-(--color-ink)"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
