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
import { NodeConversationSheet, type NodeConversationOrigin } from './kg/NodeConversationSheet';

export interface ResultConversationContext {
  branchId?: string | null;
  title?: string | null;
  insight?: string | null;
  forkReason?: string | null;
  keyMoments?: string[] | null;
  comparisonTitles?: string[] | null;
}

export interface ResultConversationWidgetProps {
  /** Scenario id for the conversation context. */
  scenarioId: string;
  /** Primary agent identity id (optional — maps to identityId on Sheet). */
  primaryAgentIdentityId?: string | null;
  /** Visible result branch context for result-specific prompts and starter questions. */
  resultContext?: ResultConversationContext | null;
}

function compactLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function buildResultOrigin(
  scenarioId: string,
  resultContext: ResultConversationContext | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): NodeConversationOrigin | undefined {
  const title = compactLine(resultContext?.title);
  if (!title) return undefined;

  const branchId = compactLine(resultContext?.branchId) || null;
  const insight = compactLine(resultContext?.insight);
  const forkReason = compactLine(resultContext?.forkReason);
  const keyMoments = (resultContext?.keyMoments ?? []).map(compactLine).filter(Boolean).slice(0, 2);
  const comparisonTitles = (resultContext?.comparisonTitles ?? []).map(compactLine).filter(Boolean).slice(0, 2);
  const excerpt = [
    title,
    insight,
    forkReason,
    ...keyMoments,
  ].filter(Boolean).join('\n');

  return {
    surface: 'result',
    nodeId: branchId ? `result:${branchId}` : `result:${scenarioId}`,
    nodeType: 'outcome',
    branchId,
    nodeLabel: title,
    excerpt: excerpt || title,
    targetLabel: t('node_context_banner.target_outcome_analyst_label', {
      defaultValue: 'Outcome analyst',
    }),
    targetDescription: t('node_context_banner.target_outcome_analyst_description', {
      defaultValue: 'Explains this outcome from its branch, nearby events, and causal links.',
    }),
    meaningTitle: t('node_context_banner.meaning_outcome_title', {
      defaultValue: 'Outcome card',
    }),
    meaningDescription: t('node_context_banner.meaning_outcome_description', {
      defaultValue: 'This is the endpoint of one branch. Incoming links explain which earlier moves carried the branch here.',
    }),
    causeContext: forkReason ? [forkReason] : [],
    relatedContext: comparisonTitles,
  };
}

export function ResultConversationWidget({
  scenarioId,
  primaryAgentIdentityId,
  resultContext,
}: ResultConversationWidgetProps) {
  const { t } = useTranslation();
  const { enabled, loading } = useCapabilityCheck('agent_conversation');
  const [sheetOpen, setSheetOpen] = useState(false);
  const resultOrigin = buildResultOrigin(scenarioId, resultContext, t);

  const handleOpen = useCallback(() => {
    setSheetOpen(true);
  }, []);

  if (loading || !enabled) return null;

  return (
    <>
      <div className="result-oracle-cta">
        <button
          type="button"
          data-testid="result-conversation-cta"
          onClick={handleOpen}
          className="result-oracle-cta__button"
        >
          {t('result_conversation.ask_oracle', {
            defaultValue: 'Ask the Oracle about this result',
          })}
        </button>
      </div>

      <NodeConversationSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        scenarioId={scenarioId}
        identityId={primaryAgentIdentityId ?? null}
        origin={resultOrigin}
        showResultDeepenHint
      />
    </>
  );
}

export default ResultConversationWidget;
