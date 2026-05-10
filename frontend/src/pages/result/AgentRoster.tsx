/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Agent roster + Phase 3 extension sections
   ═══════════════════════════════════════════════════════════ */

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
      {isWorkbenchMode && activeScenarioId && (capabilities?.causal_graph?.enabled || capabilities?.factions?.enabled) && (
        <section className="result-extension-section">
          {capabilities?.causal_graph?.enabled && (
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
          {capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
            <>
              <CounterfactualBrand
                branches={branches}
                scenarioId={id}
                onExplore={(_branchId, round) => {
                  setCfInitialRound(round);
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
              <CounterfactualPanel
                scenarioId={id}
                branchId={analysisBranch?.id ?? ''}
                agents={agents}
                messages={scenario?.messages ?? []}
                totalRounds={scenario?.total_rounds ?? 10}
                initialRound={cfInitialRound}
                onCreated={(branchId) => setCfBranchId(branchId)}
              />
              {cfBranchId && (
                <div className="result-extension-section__item result-extension-section__item--compact">
                  <a
                    href={`/result/${encodeURIComponent(id)}/compare?branch_a=${encodeURIComponent(analysisBranch?.id ?? '')}&branch_b=${encodeURIComponent(cfBranchId)}`}
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
    </>
  );
}
