/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Agent roster + Phase 3 extension sections
   ═══════════════════════════════════════════════════════════ */

import { useMemo, useState } from 'react';
import type { StoryData } from '../../types';
import { CounterfactualPanel } from '../../components/CounterfactualPanel';
import { CounterfactualBrand } from '../../components/result/CounterfactualBrand';
import { FactionTimeline } from '../../components/FactionTimeline';
import { ReturningBadge } from '../../components/ReturningBadge';
import { ResumePanel } from '../../components/ResumePanel';
import { useResultContext } from './ResultContext';

interface AgentRosterProps {
  factionTimelineBranch: StoryData['branches'][number] | null;
  factionTimelineLead: string;
}

export default function AgentRoster({
  factionTimelineBranch,
  factionTimelineLead,
}: AgentRosterProps) {
  const {
    t,
    id,
    isWorkbenchMode,
    isReplayMode,
    capabilities,
    activeScenarioId,
    agents,
    branches,
    analysisBranch,
    scenario,
    cfBranchId,
    cfInitialRound,
    setCfBranchId,
    setCfInitialRound,
  } = useResultContext();
  const [cfSourceBranchId, setCfSourceBranchId] = useState<string | null>(null);
  const [cfSelectionNotice, setCfSelectionNotice] = useState<string | null>(null);
  const counterfactualSourceBranch = useMemo(() => {
    if (!cfSourceBranchId) return analysisBranch;
    return branches.find((branch) => branch.id === cfSourceBranchId) ?? analysisBranch;
  }, [analysisBranch, branches, cfSourceBranchId]);
  const counterfactualSourceBranchId = counterfactualSourceBranch?.id ?? '';
  const causalGraphAvailable = Boolean(
    capabilities?.causal_graph?.enabled
      && scenario?.causal_graph_id
      && !isReplayMode,
  );

  return (
    <>
      {/* Agent Roster */}
      {isWorkbenchMode && agents.length > 0 && (
        <section className="result-agents">
          <h2 className="result-agents-title">{t('result.agents')}</h2>
          <div className="result-agents-grid">
            {agents.map((agent) => (
              <div key={agent.id} className="result-agent-card">
                <span className="result-agent-name">{agent.name}</span>
                <span className="result-agent-role">{agent.role}</span>
                {agent.tier && (
                  <span className={`tier-badge tier-${agent.tier.toLowerCase()}`}>
                    {agent.tier}
                  </span>
                )}
                {capabilities?.agent_identity?.enabled && (
                  <ReturningBadge isReturning={!!agent.is_returning} displayName={agent.name} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Phase 3 Replay-Safe Integration ───────────────── */}
      {isWorkbenchMode && activeScenarioId && (causalGraphAvailable || capabilities?.factions?.enabled) && (
        <section className="result-extension-section">
          {causalGraphAvailable && (
            <div className="result-extension-section__item">
              <a
                href={`/sim/${encodeURIComponent(activeScenarioId)}/causal-map`}
                className="result-extension-link"
              >
                {t('result.causal_graph_link', 'View Causal Graph →')}
              </a>
            </div>
          )}
          {capabilities?.factions?.enabled && factionTimelineBranch && (
            <section
              aria-labelledby="result-faction-timeline-heading"
              className="result-faction-panel"
            >
              <div className="result-faction-panel__header">
                <p
                  className="result-faction-panel__eyebrow"
                >
                  {t('result.faction_timeline_branch_analysis_label', 'Branch analysis')}
                </p>
                <h2
                  id="result-faction-timeline-heading"
                  className="result-faction-panel__title"
                >
                  {t('result.faction_timeline_title', 'Faction timeline analysis')}
                </h2>
                <p className="result-faction-panel__lead">
                  {factionTimelineLead}
                </p>
              </div>
              <FactionTimeline
                scenarioId={activeScenarioId}
                branchId={factionTimelineBranch.id}
                branchLabel={factionTimelineBranch.title}
                visible={true}
                agentNames={Object.fromEntries(agents.map((a) => [a.id, a.name]))}
              />
            </section>
          )}
        </section>
      )}

      {/* ── Phase 3 Live-Only Integration ────────────────── */}
      {isWorkbenchMode && id && !isReplayMode && (
        <section className="result-extension-section">
          {scenario?.status === 'done' && capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
            <>
              <CounterfactualBrand
                branches={branches}
                scenarioId={id}
                onExplore={(sourceBranchId, round) => {
                  const sourceBranch = branches.find((branch) => branch.id === sourceBranchId);
                  const sourceTitle = sourceBranch?.title || sourceBranchId;
                  setCfSourceBranchId(sourceBranchId);
                  setCfInitialRound(round);
                  setCfSelectionNotice(t('counterfactual.source_selected', {
                    branch: sourceTitle,
                    round,
                    defaultValue: 'Editing {{branch}} at round {{round}}',
                  }));
                  if (typeof window === 'undefined') return;
                  const panel = window.document.getElementById('cf-replacement');
                  if (panel) {
                    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
                      ? 'auto'
                      : 'smooth';
                    panel.scrollIntoView({ behavior, block: 'center' });
                    (panel as HTMLTextAreaElement).focus({ preventScroll: true });
                  }
                }}
              />
              {cfSelectionNotice && (
                <p
                  role="status"
                  aria-live="polite"
                  style={{ color: 'var(--color-success, #2ecc71)', fontSize: '0.85rem', margin: '0.5rem 0' }}
                >
                  {cfSelectionNotice}
                </p>
              )}
              <CounterfactualPanel
                scenarioId={id}
                branchId={counterfactualSourceBranchId}
                agents={agents}
                messages={scenario?.messages ?? []}
                totalRounds={scenario?.total_rounds ?? 10}
                initialRound={cfInitialRound}
                onCreated={(branchId) => setCfBranchId(branchId)}
              />
              {cfBranchId && (
                <div className="result-extension-section__item result-extension-section__item--compact">
                  <a
                    href={`/result/${encodeURIComponent(id)}/compare?branch_a=${encodeURIComponent(counterfactualSourceBranchId)}&branch_b=${encodeURIComponent(cfBranchId)}`}
                    className="result-extension-link result-extension-link--small"
                  >
                    {t('result.compare_link', 'Compare branches →')}
                  </a>
                </div>
              )}
            </>
          )}
          {capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
            <ResumePanel
              scenarioId={id}
              branches={branches}
              totalRounds={scenario?.total_rounds ?? 10}
            />
          )}
        </section>
      )}

      {/* Resume panel — always available when capability enabled */}
      {!isWorkbenchMode && id && !isReplayMode && scenario?.status === 'done' && capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
        <section className="result-extension-section">
          <ResumePanel
            scenarioId={id}
            branches={branches}
            totalRounds={scenario?.total_rounds ?? 10}
          />
        </section>
      )}
    </>
  );
}
