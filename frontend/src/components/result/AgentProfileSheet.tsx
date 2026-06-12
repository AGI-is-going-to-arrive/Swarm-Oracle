/* ═══════════════════════════════════════════════════════════
   SwarmOracle — AgentProfileSheet
   In-context modal that surfaces an agent's persona + persistent
   memories + growth events without leaving the result page. Used
   for generated/replay agents whose identity is scoped to this
   scenario (custom agents continue to deep-link to /agents).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import type {
  AgentGrowthEvent,
  AgentIdentityProfile,
  AgentInfo,
  AgentMemoryEntry,
} from '../../types';
import { getAgentProfileData, normalizeScenarioAgentSource } from '../../api/client';
import './AgentProfileSheet.css';

export interface AgentProfileSheetProps {
  agent: AgentInfo | null;
  userId: string;
  onClose: () => void;
  onStartConversation?: (agent: AgentInfo) => void;
}

function nameInitial(name?: string | null): string {
  if (!name) return '?';
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

export function AgentProfileSheet({
  agent,
  userId,
  onClose,
  onStartConversation,
}: AgentProfileSheetProps) {
  const { t } = useTranslation();
  const requestSeqRef = useRef(0);
  const [profile, setProfile] = useState<AgentIdentityProfile | null>(null);
  const [memories, setMemories] = useState<AgentMemoryEntry[]>([]);
  const [events, setEvents] = useState<AgentGrowthEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = agent !== null;
  const identityId = agent?.agent_identity_id ?? null;
  const sourceType = normalizeScenarioAgentSource(agent?.source_type);

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
              {profile && (profile.decision_bias || profile.knowledge_domains) ? (
                <section className="agent-profile-sheet__section">
                  {Array.isArray(profile.knowledge_domains) && profile.knowledge_domains.length > 0 ? (
                    <p className="agent-profile-sheet__profile-meta">
                      {(profile.knowledge_domains as string[]).slice(0, 5).join(' · ')}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {memories.length > 0 ? (
                <section className="agent-profile-sheet__section">
                  <h3>{t('result.agent_profile_sheet.memories_title', { defaultValue: 'Memories' })}</h3>
                  <ul className="agent-profile-sheet__list" data-testid="agent-profile-sheet-memories">
                    {memories.map((entry, idx) => (
                      <li key={`mem-${idx}`}>
                        <span className="agent-profile-sheet__date">
                          {formatDate(entry.created_at)}
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
                    {events.map((event) => (
                      <li key={event.id}>
                        <span className="agent-profile-sheet__date">
                          {formatDate(event.created_at)}
                        </span>
                        <span>{event.summary}</span>
                      </li>
                    ))}
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
