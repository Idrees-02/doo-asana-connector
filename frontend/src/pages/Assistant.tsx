/**
 * The assistant page.
 *
 * Page chrome only: the conversation itself lives in ChatPanel, which the
 * landing page's robot pop-up renders too. One chat implementation, and one
 * place where the write-approval gate lives.
 */

import { useQuery } from '@tanstack/react-query';

import { ChatPanel } from '@/components/assistant/ChatPanel';
import { PageHeader, Panel, PanelHeader } from '@/components/ui';
import { api } from '@/services/api';

export function Assistant() {
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: ({ signal }) => api.getAiStatus(signal),
  });

  const model = status.data?.model;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <PageHeader
        title="Assistant"
        description="Ask in plain language. Reads run immediately; changes wait for your approval."
      />

      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          title="Conversation"
          description={
            model === null || model === undefined
              ? 'Connector actions, in plain language.'
              : `${model} · connector actions, in plain language.`
          }
        />

        <ChatPanel />
      </Panel>
    </div>
  );
}
