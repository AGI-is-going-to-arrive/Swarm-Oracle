/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ScenarioAgentPicker
   Opens from ExploreDeeperBridge agents card and lets the user
   pick one of the scenario's agents to start an in-context
   follow-up conversation (NodeConversationSheet).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import type { AgentInfo } from '../../types';
import { normalizeScenarioAgentSource } from '../../api/client';

export interface ScenarioAgentPickerProps {
  open: boolean;
  agents: AgentInfo[];
  onSelect: (agent: AgentInfo) => void;
  onClose: () => void;
  /**
   * Optional handler for in-context profile preview. When provided, generated /
   * replay agents render a button that opens AgentProfileSheet instead of
   * deep-linking to /agents (which would only work for custom agents).
   */
  onViewProfile?: (agent: AgentInfo) => void;
}

function tierLabelKey(tier: AgentInfo['tier']): string {
  switch (tier) {
    case 'CORE':
      return 'result.agent_picker_tier_core';
    case 'IMPORTANT':
      return 'result.agent_picker_tier_important';
    case 'CROWD':
    default:
      return 'result.agent_picker_tier_crowd';
  }
}

function agentInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

export function ScenarioAgentPicker({
  open,
  agents,
  onSelect,
  onClose,
  onViewProfile,
}: ScenarioAgentPickerProps) {
  const { t } = useTranslation();
  const firstCardRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      firstCardRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open, agents.length]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  const handleSelect = useCallback(
    (agent: AgentInfo) => {
      onSelect(agent);
    },
    [onSelect],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="scenario-agent-picker"
      >
        <header className="scenario-agent-picker__header">
          <DialogTitle className="scenario-agent-picker__title">
            {t('result.agent_picker_title', { defaultValue: 'Pick an Agent to Ask' })}
          </DialogTitle>
          <DialogDescription
            className="scenario-agent-picker__description"
          >
            {t('result.agent_picker_select', { defaultValue: 'Start conversation' })}
          </DialogDescription>
        </header>

        {agents.length === 0 ? (
          <p className="scenario-agent-picker__empty">
            {t('result.agent_picker_empty', {
              defaultValue: 'No agents available for follow-up',
            })}
          </p>
        ) : (
          <ul
            className="scenario-agent-picker__grid"
            data-testid="scenario-agent-picker-grid"
          >
            {agents.map((agent, index) => {
              const tier = agent.tier ?? 'CROWD';
              const tierLabel = t(tierLabelKey(tier), { defaultValue: tier });
              const persona = (agent.persona ?? '').trim();
              const identityId = agent.agent_identity_id ?? null;
              const sourceType = normalizeScenarioAgentSource(agent.source_type);
              const viewProfileLabel = t('result.agent_picker_view_profile', {
                defaultValue: 'View profile',
              });
              const canDeepLink = sourceType === 'custom' && Boolean(identityId);
              const canPreview = !canDeepLink && Boolean(identityId) && Boolean(onViewProfile);
              const profileHref = identityId
                ? `/agents#agent_profile=${encodeURIComponent(identityId)}&tab=memory`
                : '#';
              return (
                <li key={agent.id} className="scenario-agent-picker__item">
                  <button
                    ref={index === 0 ? firstCardRef : undefined}
                    type="button"
                    className="scenario-agent-picker__card"
                    data-agent-id={agent.id}
                    data-tier={tier}
                    onClick={() => handleSelect(agent)}
                  >
                    <span className="scenario-agent-picker__card-head">
                      <span className="scenario-agent-picker__identity">
                        <span className="scenario-agent-picker__avatar" aria-hidden="true">
                          {agentInitial(agent.name)}
                        </span>
                        <span className="scenario-agent-picker__card-name">{agent.name}</span>
                      </span>
                      <span
                        className={`scenario-agent-picker__tier scenario-agent-picker__tier--${tier.toLowerCase()}`}
                      >
                        {tierLabel}
                      </span>
                    </span>
                    <span className="scenario-agent-picker__card-role">{agent.role}</span>
                    {persona && (
                      <span className="scenario-agent-picker__card-persona">{persona}</span>
                    )}
                  </button>
                  {canDeepLink && (
                    <a
                      href={profileHref}
                      className="scenario-agent-picker__profile-link"
                      data-testid="scenario-agent-picker-view-profile"
                      data-agent-identity-id={identityId ?? undefined}
                      data-source-type={sourceType}
                      aria-label={`${viewProfileLabel}: ${agent.name}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {viewProfileLabel}
                    </a>
                  )}
                  {canPreview && (
                    <button
                      type="button"
                      className="scenario-agent-picker__profile-link"
                      data-testid="scenario-agent-picker-view-profile"
                      data-agent-identity-id={identityId ?? undefined}
                      data-source-type={sourceType}
                      aria-label={`${viewProfileLabel}: ${agent.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onViewProfile?.(agent);
                      }}
                    >
                      {viewProfileLabel}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ScenarioAgentPicker;
