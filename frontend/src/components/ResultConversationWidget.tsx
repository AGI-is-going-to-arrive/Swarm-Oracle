/* ═══════════════════════════════════════════════════════════
   ResultConversationWidget — "Ask the Oracle" entry point
   in ResultView. Opens NodeConversationSheet with
   result-context props and soft 3-turn hint enabled.

   Self-contained: no state leaks into the parent page.
   Capability-gated via useCapabilityCheck('agent_conversation').
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { NodeConversationSheet } from './kg/NodeConversationSheet';

export interface ResultConversationWidgetProps {
  /** Scenario id for the conversation context. */
  scenarioId: string;
  /** Primary agent identity id (optional — maps to identityId on Sheet). */
  primaryAgentIdentityId?: string | null;
}

export function ResultConversationWidget({
  scenarioId,
  primaryAgentIdentityId,
}: ResultConversationWidgetProps) {
  const { t } = useTranslation();
  const { enabled, loading } = useCapabilityCheck('agent_conversation');
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setSheetOpen(true);
  }, []);

  if (loading || !enabled) return null;

  return (
    <>
      <button
        type="button"
        data-testid="result-conversation-cta"
        onClick={handleOpen}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-purple-400/40 bg-purple-500/10 px-5 py-3 text-sm font-medium text-purple-200 transition-colors hover:bg-purple-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-300"
      >
        {t('result_conversation.ask_oracle', {
          defaultValue: 'Ask the Oracle about this result',
        })}
      </button>

      <NodeConversationSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        scenarioId={scenarioId}
        identityId={primaryAgentIdentityId ?? null}
        showResultDeepenHint
      />
    </>
  );
}

export default ResultConversationWidget;
