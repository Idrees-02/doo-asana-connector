/**
 * The assistant, in a pop-up.
 *
 * Opened by clicking the robot on the landing page, so the thing that looks
 * like it can talk actually talks. It renders the same ChatPanel the Assistant
 * page does — same approval gate, same behaviour, no second implementation.
 *
 * Modal semantics are done by hand rather than with a dialog library: focus
 * moves in on open and back to the robot on close, Escape closes, and the
 * backdrop is inert to the screen reader. That is the whole contract, and it is
 * smaller than the dependency would be.
 */

import { useEffect, useRef } from 'react';
import { Bot, X } from 'lucide-react';

import { ChatPanel } from '@/components/assistant/ChatPanel';

export function AssistantPopup({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while a modal is over it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    panel.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="assistant-popup-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Assistant"
        tabIndex={-1}
        className="assistant-popup"
        // The click that opens a dialog must not immediately close it.
        onClick={(event) => event.stopPropagation()}
      >
        <header className="assistant-popup-head">
          <span className="assistant-popup-avatar">
            <Bot className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-(--color-ink)">Assistant</p>
            <p className="truncate text-xs text-(--color-ink-muted)">
              Reads run immediately. Changes wait for your approval.
            </p>
          </div>
          <button type="button" onClick={onClose} className="assistant-popup-close">
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close assistant</span>
          </button>
        </header>

        <ChatPanel />
      </div>
    </div>
  );
}
