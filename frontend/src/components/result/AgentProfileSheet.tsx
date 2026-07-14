/* ═══════════════════════════════════════════════════════════
   SwarmOracle — AgentProfileSheet
   In-context modal that surfaces an agent's persona + persistent
   memories + growth events without leaving the result page. Used
   for generated/replay agents whose identity is scoped to this
   scenario (custom agents continue to deep-link to /agents).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import type {
  AgentGrowthEvent,
  AgentIdentityProfile,
  AgentInfo,
  AgentMemoryEntry,
} from '../../types';
import type { AgentProfileObservation } from '../../lib/agentProfileObservation';
export type { AgentProfileObservation } from '../../lib/agentProfileObservation';
import { getAgentProfileData, normalizeScenarioAgentSource } from '../../api/client';
import {
  DECISION_BIAS_KEYS,
  clampBias,
  type DecisionBiasKey,
} from '../Controls/decisionBias';
import './AgentProfileSheet.css';

export interface AgentProfileSheetProps {
  agent: AgentInfo | null;
  observation?: AgentProfileObservation;
  userId: string;
  onClose: () => void;
  onStartConversation?: (agent: AgentInfo) => void;
}

function nameInitial(name?: string | null): string {
  if (!name) return '?';
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en');
  } catch {
    return '';
  }
}

const DECISION_BIAS_LABELS: Record<DecisionBiasKey, [string, string]> = {
  caution: ['agent_workshop.bias_caution', 'Caution'],
  optimism: ['agent_workshop.bias_optimism', 'Optimism'],
  conservatism: ['agent_workshop.bias_conservatism', 'Conservatism'],
  risk_tolerance: ['agent_workshop.bias_risk_tolerance', 'Risk Tolerance'],
  creativity: ['agent_workshop.bias_creativity', 'Creativity'],
};

const PUBLIC_METADATA_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function visibleMetadataFailureCode(code: unknown): string {
  return typeof code === 'string' && PUBLIC_METADATA_FAILURE_CODE.test(code)
    ? code
    : 'LLM_FAILED';
}

function visibleDecisionBias(
  value: Record<string, unknown> | null | undefined,
): Array<{ key: DecisionBiasKey; value: number }> {
  if (!value) return [];
  return DECISION_BIAS_KEYS.flatMap((key) => {
    const raw = value[key];
    return typeof raw === 'number' && Number.isFinite(raw)
      ? [{ key, value: clampBias(raw) }]
      : [];
  });
}

type GrowthEventScope = 'current' | 'past' | null;

function growthEventScope(
  event: AgentGrowthEvent,
  currentScenarioId: string | null,
  currentBranchId: string | null,
): GrowthEventScope {
  if (!currentScenarioId || !event.scenario_id) return null;
  if (event.scenario_id !== currentScenarioId) return 'past';
  if (!currentBranchId || !event.branch_id) return null;
  return event.branch_id === currentBranchId ? 'current' : 'past';
}

export function AgentProfileSheet({
  agent,
  observation,
  userId,
  onClose,
  onStartConversation,
}: AgentProfileSheetProps) {
  const { t, i18n } = useTranslation();
  const { id: routeScenarioId } = useParams<{ id: string }>();
  const locale = i18n?.language || 'en';
  const requestSeqRef = useRef(0);
  const [profile, setProfile] = useState<AgentIdentityProfile | null>(null);
  const [memories, setMemories] = useState<AgentMemoryEntry[]>([]);
  const [events, setEvents] = useState<AgentGrowthEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = agent !== null;
  const identityId = agent?.agent_identity_id ?? null;
  const sourceType = normalizeScenarioAgentSource(agent?.source_type);
  const currentScenarioId = routeScenarioId?.trim() || null;
  // Observation coordinates are evidence provenance. Only a selected branch
  // is an explicit statement about which worldline the user is viewing.
  const currentBranchId = observation?.selectedBranchId?.trim() || null;

  const fetchData = useCallback(
    async (id: string, uid: string, source: string | null) => {
      const reqId = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await getAgentProfileData(
          { agent_identity_id: id, source_type: source },
          uid,
        );
        if (requestSeqRef.current !== reqId) return;
        setProfile(result.profile);
        setMemories(result.memories ?? []);
        setEvents(result.growth_events ?? []);
      } catch {
        if (requestSeqRef.current !== reqId) return;
        setError(t('result.agent_profile_sheet.error', {
          defaultValue: 'Failed to load agent profile',
        }));
      } finally {
        if (requestSeqRef.current === reqId) {
          setLoading(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (open && identityId) {
      void fetchData(identityId, userId, sourceType);
    } else {
      requestSeqRef.current++;
      setProfile(null);
      setMemories([]);
      setEvents([]);
      setError(null);
      setLoading(false);
    }
  }, [open, identityId, userId, sourceType, fetchData]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  const handleStartConversation = useCallback(() => {
    if (agent && sourceType !== 'replay') {
      onStartConversation?.(agent);
    }
  }, [agent, onStartConversation, sourceType]);

  if (!agent) return null;

  const initial = nameInitial(agent.name);
  const tier = agent.tier ?? 'CROWD';
  const tierKey = tier.toLowerCase();
  const knowledgeDomains = Array.isArray(profile?.knowledge_domains)
    ? profile.knowledge_domains
        .filter((domain): domain is string => typeof domain === 'string')
        .slice(0, 5)
    : [];
  const decisionBias = visibleDecisionBias(profile?.decision_bias);
  const observationSource = observation?.source ?? 'snapshot';
  const displayedEmotion = observationSource === 'replay_unavailable'
    ? t('result.agent_profile_sheet.no_observation_value', {
        defaultValue: 'No matching observation',
      })
    : observation?.emotionMetadataStatus === 'unavailable'
      ? t('result.agent_profile_sheet.emotion_metadata_unavailable', {
          defaultValue: 'Emotion metadata unavailable',
        })
      : observation?.emotion ?? agent.emotion;
  const displayedMetadataFailureCode = observation?.emotionMetadataStatus === 'unavailable'
    ? visibleMetadataFailureCode(observation.emotionMetadataFailureCode)
    : null;
  const branchLabel = observation?.branchTitle
    ?? observation?.branchId
    ?? t('common.unknown', { defaultValue: 'Unknown' });
  const roundLabel = observation?.round
    ?? t('common.unknown', { defaultValue: 'Unknown' });
  const selectedBranchLabel = observation?.selectedBranchTitle
    ?? observation?.selectedBranchId
    ?? branchLabel;
  const selectedRoundLabel = observation?.selectedRound ?? roundLabel;
  const observationSourceLabel = observationSource === 'live'
    ? t('result.agent_profile_sheet.live_observation_source', {
        defaultValue: 'Latest observed on {{branch}} · R{{round}}',
        branch: branchLabel,
        round: roundLabel,
      })
    : observationSource === 'replay'
      ? t('result.agent_profile_sheet.replay_observation_source', {
          defaultValue: 'Replay selection {{selectedBranch}} · R{{selectedRound}}; latest matching observation {{branch}} · R{{round}}',
          selectedBranch: selectedBranchLabel,
          selectedRound: selectedRoundLabel,
          branch: branchLabel,
          round: roundLabel,
        })
      : observationSource === 'result'
        ? t('result.agent_profile_sheet.result_observation_source', {
            defaultValue: 'Result branch {{selectedBranch}}; latest matching observation {{branch}} · R{{round}}',
            selectedBranch: selectedBranchLabel,
            branch: branchLabel,
            round: roundLabel,
          })
        : observationSource === 'replay_unavailable'
          ? t('result.agent_profile_sheet.replay_no_observation_source', {
              defaultValue: 'No matching observation in replay selection {{selectedBranch}} · R{{selectedRound}}.',
              selectedBranch: selectedBranchLabel,
              selectedRound: selectedRoundLabel,
            })
          : observationSource === 'snapshot'
            ? t('result.agent_profile_sheet.snapshot_emotion_source', {
                defaultValue: 'No branch and round observation context is available for this snapshot.',
              })
            : t('result.agent_profile_sheet.baseline_emotion_source', {
                defaultValue: 'No message observation yet; showing the configured starting emotion.',
              });
  const sourceLabel =
    sourceType === 'custom'
      ? t('result.agent_profile_sheet.source_custom', { defaultValue: 'Custom' })
      : sourceType === 'replay'
        ? t('result.agent_profile_sheet.source_replay', { defaultValue: 'Replay' })
        : t('result.agent_profile_sheet.source_generated', { defaultValue: 'AI-generated' });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="agent-profile-sheet"
        data-testid="agent-profile-sheet"
      >
        <div className="agent-profile-sheet__header">
          <div
            className="agent-profile-sheet__avatar"
            data-tier={tierKey}
            aria-hidden="true"
          >
            {initial}
          </div>
          <div className="agent-profile-sheet__header-text">
            <DialogTitle className="agent-profile-sheet__name">
              {agent.name || t('common.unknown', { defaultValue: 'Unknown' })}
            </DialogTitle>
            <DialogDescription className="agent-profile-sheet__role">
              {agent.role}
            </DialogDescription>
            <div className="agent-profile-sheet__badges">
              <span className="agent-profile-sheet__badge" data-badge="tier">
                {tier}
              </span>
              <span className="agent-profile-sheet__badge" data-badge="source">
                {sourceLabel}
              </span>
            </div>
          </div>
        </div>

        <div className="agent-profile-sheet__body">
          <section
            className="agent-profile-sheet__section agent-profile-sheet__current-state"
            data-testid="agent-profile-sheet-current-state"
          >
            <h3>{t('result.agent_profile_sheet.state_reference_title', { defaultValue: 'State reference' })}</h3>
            <dl>
              {agent.stance ? (
                <div>
                  <dt>{t('result.agent_profile_sheet.baseline_stance_label', { defaultValue: 'Configured stance' })}</dt>
                  <dd>{agent.stance}</dd>
                </div>
              ) : null}
              <div>
                <dt>
                  {t(
                    observationSource === 'baseline'
                      ? 'result.agent_profile_sheet.configured_emotion_label'
                      : observationSource === 'snapshot'
                        ? 'result.agent_profile_sheet.snapshot_emotion_label'
                        : 'result.agent_profile_sheet.observed_emotion_label',
                    {
                      defaultValue: observationSource === 'baseline'
                        ? 'Configured starting emotion'
                        : observationSource === 'snapshot'
                          ? 'Scenario emotion snapshot'
                          : 'Observed emotion',
                    },
                  )}
                </dt>
                <dd>
                  {displayedEmotion}
                  {displayedMetadataFailureCode ? ` (${displayedMetadataFailureCode})` : ''}
                </dd>
              </div>
            </dl>
            <p
              className="agent-profile-sheet__observation-source"
              data-testid="agent-profile-sheet-observation-source"
              aria-live="polite"
            >
              {observationSourceLabel}
            </p>
          </section>

          {agent.persona ? (
            <details className="agent-profile-sheet__persona">
              <summary>{t('result.agent_profile_sheet.persona', { defaultValue: 'Persona' })}</summary>
              <p>{agent.persona}</p>
            </details>
          ) : null}

          {!identityId ? (
            <p className="agent-profile-sheet__no-identity" data-testid="agent-profile-sheet-no-identity">
              {t('result.agent_profile_sheet.no_persistent_identity', {
                defaultValue: 'This agent is generated for this scenario only.',
              })}
            </p>
          ) : null}

          {identityId && loading ? (
            <div
              role="status"
              aria-live="polite"
              className="agent-profile-sheet__loading"
              data-testid="agent-profile-sheet-loading"
            >
              {t('result.agent_profile_sheet.loading', { defaultValue: 'Loading profile...' })}
            </div>
          ) : null}

          {identityId && error ? (
            <div role="alert" className="agent-profile-sheet__error" data-testid="agent-profile-sheet-error">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => void fetchData(identityId, userId, sourceType)}
              >
                {t('result.agent_profile_sheet.retry', { defaultValue: 'Retry' })}
              </button>
            </div>
          ) : null}

          {identityId && !loading && !error ? (
            <>
              {knowledgeDomains.length > 0 ? (
                <section className="agent-profile-sheet__section" data-testid="agent-profile-sheet-domains">
                  <h3>{t('result.agent_profile_sheet.knowledge_domains_title', { defaultValue: 'Knowledge domains' })}</h3>
                  <p className="agent-profile-sheet__profile-meta">{knowledgeDomains.join(' · ')}</p>
                </section>
              ) : null}

              {decisionBias.length > 0 ? (
                <section className="agent-profile-sheet__section" data-testid="agent-profile-sheet-decision-bias">
                  <h3>{t('result.agent_profile_sheet.decision_bias_title', { defaultValue: 'Decision style' })}</h3>
                  <ul className="agent-profile-sheet__bias-list">
                    {decisionBias.map(({ key, value }) => {
                      const [labelKey, defaultValue] = DECISION_BIAS_LABELS[key];
                      const label = t(labelKey, { defaultValue });
                      const percentage = Math.round(value * 100);
                      return (
                        <li key={key}>
                          <span>{label}</span>
                          <meter min={0} max={100} value={percentage} aria-label={label} />
                          <span>{percentage}%</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              {memories.length > 0 ? (
                <section className="agent-profile-sheet__section">
                  <h3>{t('result.agent_profile_sheet.memories_title', { defaultValue: 'Memories' })}</h3>
                  <ul className="agent-profile-sheet__list" data-testid="agent-profile-sheet-memories">
                    {memories.map((entry, idx) => (
                      <li key={`mem-${idx}`}>
                        <span className="agent-profile-sheet__date">
                          {formatDate(entry.created_at, locale)}
                        </span>
                        <span>{entry.summary}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {events.length > 0 ? (
                <section className="agent-profile-sheet__section">
                  <h3>{t('result.agent_profile_sheet.events_title', { defaultValue: 'Growth Events' })}</h3>
                  <ul className="agent-profile-sheet__list" data-testid="agent-profile-sheet-events">
                    {events.map((event) => {
                      const scope = growthEventScope(
                        event,
                        currentScenarioId,
                        currentBranchId,
                      );
                      const unknown = t('common.unknown', { defaultValue: 'Unknown' });
                      return (
                        <li
                          key={event.id}
                          data-testid={`agent-profile-sheet-event-${event.id}`}
                          data-history-scope={scope ?? undefined}
                        >
                          <span className="agent-profile-sheet__date">
                            {formatDate(event.created_at, locale)}
                          </span>
                          <span>
                            {scope === 'current' ? (
                              <strong>
                                {t('result.agent_profile_sheet.history_current', {
                                  defaultValue: 'Current',
                                })}
                                {' · '}
                                {t('result.agent_profile_sheet.history_current_worldline', {
                                  defaultValue: 'selected branch segment',
                                })}
                                {' · '}
                              </strong>
                            ) : scope === 'past' ? (
                              <strong>
                                {t('result.agent_profile_sheet.history_past', {
                                  defaultValue: 'Past',
                                })}
                                {' · '}
                              </strong>
                            ) : null}
                            {event.summary}
                            <br />
                            <span className="agent-profile-sheet__profile-meta">
                              {t('result.agent_profile_sheet.history_coordinates', {
                                defaultValue: 'Scenario {{scenario}} · Branch {{branch}} · R{{round}} · {{eventType}}',
                                scenario: event.scenario_id ?? unknown,
                                branch: event.branch_id ?? unknown,
                                round: event.round_number ?? unknown,
                                eventType: event.event_type || unknown,
                              })}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              {memories.length === 0 && events.length === 0 ? (
                <p className="agent-profile-sheet__empty" data-testid="agent-profile-sheet-empty">
                  {t('result.agent_profile_sheet.empty_history', {
                    defaultValue: 'No memories or growth events recorded yet.',
                  })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="agent-profile-sheet__footer">
          {identityId ? (
            <Link
              to={`/agents/identities/${identityId}/memories`}
              className="agent-profile-sheet__btn-inspector"
              data-testid="agent-profile-sheet-inspector"
            >
              {t('agent_profile.view_memory_inspector', {
                defaultValue: 'View memory inspector',
              })}
            </Link>
          ) : null}
          {onStartConversation && sourceType !== 'replay' ? (
            <button
              type="button"
              className="agent-profile-sheet__btn-start"
              onClick={handleStartConversation}
              data-testid="agent-profile-sheet-start-conversation"
            >
              {t('result.agent_profile_sheet.start_conversation', {
                defaultValue: 'Start conversation',
              })}
            </button>
          ) : null}
          <button
            type="button"
            className="agent-profile-sheet__btn-close"
            onClick={onClose}
            data-testid="agent-profile-sheet-close"
          >
            {t('result.agent_profile_sheet.close', { defaultValue: 'Close' })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AgentProfileSheet;
