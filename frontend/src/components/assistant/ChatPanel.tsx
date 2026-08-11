/**
 * The assistant conversation.
 *
 * Shared by the Assistant page and the pop-up the landing-page robot opens, so
 * there is one chat implementation rather than two that drift apart — and, more
 * importantly, one place where the write-approval gate lives.
 *
 * Reads run automatically; a write comes back as a proposal the user has to
 * approve, and only then is it executed through the ordinary action route with
 * `approved: true`. That gate is the whole design: the connector cannot delete
 * a task or a comment, so a model that could write unsupervised would make
 * messes nobody can clean up — and Asana text flowing back into the model is
 * exactly the shape of a prompt injection.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUp, Bot, Check, Sparkles, User, X } from 'lucide-react';

import { Button, StatusPill } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/services/api';
import type { ChatProposal, ChatTurn } from '@/types/api';

interface Turn extends ChatTurn {
  readonly steps?: ReadonlyArray<{ actionId: string; ok: boolean; summary: string }>;
  readonly proposal?: ChatProposal | null;
  /** Set once the user has decided, so the card stops offering the choice. */
  readonly settled?: 'approved' | 'declined';
}

const SUGGESTIONS = [
  'What projects do I have?',
  'Show the open tasks in my first project',
  'Who is on my workspace?',
  'Add a comment to the newest task saying the review is done',
];

export function ChatPanel() {
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: ({ signal }) => api.getAiStatus(signal),
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const { toast } = useToast();
  const endRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (history: ChatTurn[]) => api.chat(history),
    onSuccess: (reply) => {
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: reply.reply,
          steps: reply.steps,
          proposal: reply.proposal,
        },
      ]);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiError ? error.message : 'The assistant could not be reached.';
      setTurns((prev) => [...prev, { role: 'assistant', content: message }]);
    },
  });

  const approve = useMutation({
    mutationFn: (proposal: ChatProposal) =>
      // The same route every other write goes through, approval included.
      api.execute(proposal.actionId, proposal.input, { approved: true }),
    onSuccess: (result, proposal) => {
      settle(proposal, 'approved');
      if (result.ok) {
        toast({ tone: 'success', title: `${proposal.name} completed.` });
        setTurns((prev) => [
          ...prev,
          { role: 'assistant', content: `Done — ${proposal.name.toLowerCase()} completed.` },
        ]);
      } else {
        toast({ tone: 'error', title: result.error.code, description: result.error.message });
      }
    },
    onError: (error: unknown, proposal) => {
      settle(proposal, 'approved');
      toast({
        tone: 'error',
        title: 'The change failed.',
        description: error instanceof ApiError ? error.message : 'Unknown error.',
      });
    },
  });

  function settle(proposal: ChatProposal, outcome: 'approved' | 'declined'): void {
    setTurns((prev) =>
      prev.map((turn) =>
        turn.proposal?.actionId === proposal.actionId && turn.settled === undefined
          ? { ...turn, settled: outcome }
          : turn,
      ),
    );
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, ask.isPending]);

  function send(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '' || ask.isPending) return;

    const next: Turn = { role: 'user', content: trimmed };
    const history = [...turns, next].map(({ role, content }) => ({ role, content }));

    setTurns((prev) => [...prev, next]);
    setDraft('');
    ask.mutate(history);
  }

  const disabled = status.data?.enabled === false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {disabled && (
        <div className="flex items-center gap-2 border-b border-(--color-hairline) p-3 text-xs text-(--color-ink-muted)">
          <AlertTriangle className="size-4 shrink-0 text-(--color-warning)" aria-hidden="true" />
          <span>
            No assistant provider is configured. Set <code className="mono">GROQ_API_KEY</code> to
            enable it.
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && <Empty onPick={send} disabled={disabled} />}

        {turns.map((turn, index) => (
          <Message
            key={index}
            turn={turn}
            onApprove={(proposal) => approve.mutate(proposal)}
            onDecline={(proposal) => {
              settle(proposal, 'declined');
              setTurns((prev) => [
                ...prev,
                { role: 'assistant', content: 'Understood — I have not made that change.' },
              ]);
            }}
            busy={approve.isPending}
          />
        ))}

        {ask.isPending && <Thinking />}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-(--color-hairline) p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline, as in every chat app.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
          rows={1}
          disabled={disabled || ask.isPending}
          placeholder={disabled ? 'Assistant unavailable' : 'Ask about your workspace…'}
          aria-label="Message"
          className="max-h-32 min-h-9 flex-1 resize-none rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface) px-3 py-2 text-sm text-(--color-ink) outline-none focus-visible:border-(--color-accent) disabled:opacity-60"
        />
        <Button type="submit" disabled={disabled || ask.isPending || draft.trim() === ''}>
          <ArrowUp className="size-4" aria-hidden="true" />
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Empty({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="py-6 text-center">
      <Sparkles className="mx-auto size-6 text-(--color-accent)" aria-hidden="true" />
      <p className="mt-2 text-sm font-medium text-(--color-ink)">Ask about your Asana workspace</p>
      <p className="mt-1 text-xs text-(--color-ink-muted)">
        The assistant reads freely and asks before it changes anything.
      </p>

      <ul className="mx-auto mt-4 flex max-w-lg flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              className="rounded-full border border-(--color-hairline) px-3 py-1.5 text-xs text-(--color-ink-muted) transition-colors hover:border-(--color-accent) hover:text-(--color-accent) disabled:opacity-50"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-2 text-xs text-(--color-ink-muted)">
      <Bot className="size-4" aria-hidden="true" />
      <span className="flex gap-1" aria-live="polite">
        Thinking
        <span className="animate-pulse">…</span>
      </span>
    </div>
  );
}

function Message({
  turn,
  onApprove,
  onDecline,
  busy,
}: {
  turn: Turn;
  onApprove: (proposal: ChatProposal) => void;
  onDecline: (proposal: ChatProposal) => void;
  busy: boolean;
}) {
  const isUser = turn.role === 'user';

  return (
    <div className={`flex gap-2.5 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-(--color-accent-muted) text-(--color-accent)">
          <Bot className="size-3.5" aria-hidden="true" />
        </span>
      )}

      <div className={`min-w-0 max-w-[85%] ${isUser ? 'order-first' : ''}`}>
        <div
          className={`rounded-(--radius-md) px-3 py-2 text-sm whitespace-pre-wrap ${
            isUser
              ? 'bg-(--color-accent) text-white'
              : 'border border-(--color-hairline) bg-(--color-surface-2) text-(--color-ink)'
          }`}
        >
          {turn.content}
        </div>

        {turn.steps !== undefined && turn.steps.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {turn.steps.map((step, index) => (
              <li key={`${step.actionId}-${index}`}>
                <StatusPill tone={step.ok ? 'success' : 'danger'}>
                  <span className="mono">{step.actionId}</span>
                </StatusPill>
              </li>
            ))}
          </ul>
        )}

        {turn.proposal !== undefined && turn.proposal !== null && (
          <Proposal
            proposal={turn.proposal}
            settled={turn.settled}
            busy={busy}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        )}
      </div>

      {isUser && (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-(--color-surface-2) text-(--color-ink-muted)">
          <User className="size-3.5" aria-hidden="true" />
        </span>
      )}
    </div>
  );
}

/** The approval gate, rendered with the same warnings the API would enforce. */
function Proposal({
  proposal,
  settled,
  busy,
  onApprove,
  onDecline,
}: {
  proposal: ChatProposal;
  settled: Turn['settled'];
  busy: boolean;
  onApprove: (proposal: ChatProposal) => void;
  onDecline: (proposal: ChatProposal) => void;
}) {
  return (
    <div className="mt-2 rounded-(--radius-md) border border-(--color-warning)/40 bg-(--color-warning-muted) p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="warning">Approval required</StatusPill>
        <span className="mono text-xs text-(--color-ink)">{proposal.actionId}</span>
      </div>

      <pre className="mono mt-2 max-h-40 overflow-auto rounded-(--radius-sm) bg-(--color-surface) p-2 text-[0.7rem] text-(--color-ink-muted)">
        {JSON.stringify(proposal.input, null, 2)}
      </pre>

      <p className="mt-2 text-xs text-(--color-ink-muted)">{proposal.duplicateBehavior}</p>

      {settled === undefined ? (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => onApprove(proposal)}>
            <Check className="size-3.5" aria-hidden="true" />
            Approve and run
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecline(proposal)}>
            <X className="size-3.5" aria-hidden="true" />
            Decline
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs font-medium text-(--color-ink)">
          {settled === 'approved' ? 'Approved.' : 'Declined — nothing was changed.'}
        </p>
      )}
    </div>
  );
}
