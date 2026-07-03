import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../stores/agentStore';
import type { AgentIdentityInfo } from '../types';
import './AgentSelectionStrip.css';

interface AgentSelectionStripProps {
  userId: string;
  visible: boolean;
  maxSelected: number;
  onManageClick: () => void;
}

const MAX_VISIBLE_PILLS = 3;

interface AgentNameGroup {
  key: string;
  representative: AgentIdentityInfo;
  agents: AgentIdentityInfo[];
}

export default function AgentSelectionStrip({
  userId,
  visible,
  maxSelected,
  onManageClick,
}: AgentSelectionStripProps) {
  const { t } = useTranslation();
  const identities = useAgentStore((state) => state.identities);
  const loading = useAgentStore((state) => state.loading);
  const error = useAgentStore((state) => state.error);
  const selectedIds = useAgentStore((state) => state.selectedIds);
  const fetchIdentities = useAgentStore((state) => state.fetchIdentities);
  const toggleSelection = useAgentStore((state) => state.toggleSelection);

  useEffect(() => {
    if (visible && userId) {
      void fetchIdentities(userId);
    }
  }, [visible, userId, fetchIdentities]);

  const customAgentGroups = useMemo<AgentNameGroup[]>(() => {
    // The identity store can legally hold several agents with the same display name
    // (one per scenario/continuity key). The quick-select strip shows one pill per
    // name — the full attach panel still lists every identity for precise picking.
    const groupsByName = new Map<string, AgentNameGroup>();
    if (!identities || typeof identities[Symbol.iterator] !== 'function') {
      return [];
    }
    for (const agent of identities) {
      if (agent.kind !== 'custom') continue;
      const nameKey = agent.display_name.trim();
      const existing = groupsByName.get(nameKey);
      if (existing) {
        existing.agents.push(agent);
      } else {
        groupsByName.set(nameKey, {
          key: nameKey,
          representative: agent,
          agents: [agent],
        });
      }
    }
    return Array.from(groupsByName.values());
  }, [identities]);

  if (!visible) return null;

  if (loading) {
    return (
      <div className="agent-strip agent-strip--state" role="status" aria-live="polite">
        <span className="agent-strip__status-text">{t('agents.quick_select_loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="agent-strip agent-strip--state" role="alert">
        <span className="agent-strip__status-text agent-strip__status-text--error">
          {t('agents.quick_select_error')}
        </span>
      </div>
    );
  }

  if (customAgentGroups.length === 0) {
    return (
      <fieldset className="agent-strip agent-strip--empty">
        <legend className="sr-only">{t('agents.quick_select')}</legend>
        <span className="agent-strip__status-text">{t('agents.empty_cta')}</span>
        <button type="button" className="agent-strip__manage" onClick={onManageClick}>
          {t('agents.manage_all')}
        </button>
      </fieldset>
    );
  }

  const visibleGroups = customAgentGroups.slice(0, MAX_VISIBLE_PILLS);
  const moreCount = Math.max(0, customAgentGroups.length - MAX_VISIBLE_PILLS);
  const selectionFull = selectedIds.size >= maxSelected;

  return (
    <fieldset className="agent-strip">
      <legend className="sr-only">{t('agents.quick_select')}</legend>
      <ul className="agent-strip__pills">
        {visibleGroups.map((group) => {
          const agent = group.representative;
          const selectedGroupIds = group.agents
            .filter((candidate) => selectedIds.has(candidate.id))
            .map((candidate) => candidate.id);
          const isSelected = selectedGroupIds.length > 0;
          const isDisabled = !isSelected && selectionFull;
          return (
            <li key={agent.id} className="agent-strip__pill-item">
              <label
                className={[
                  'agent-strip__pill',
                  isSelected ? 'agent-strip__pill--selected' : '',
                  isDisabled ? 'agent-strip__pill--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={isSelected}
                  disabled={isDisabled}
                  onChange={() => {
                    if (selectedGroupIds.length > 0) {
                      for (const selectedId of selectedGroupIds) {
                        toggleSelection(selectedId, maxSelected);
                      }
                    } else {
                      toggleSelection(agent.id, maxSelected);
                    }
                  }}
                />
                <span className="agent-strip__pill-text">{agent.display_name}</span>
              </label>
            </li>
          );
        })}
        {moreCount > 0 && (
          <li className="agent-strip__more">
            {t('agents.more_count', { count: moreCount })}
          </li>
        )}
      </ul>
      <button type="button" className="agent-strip__manage" onClick={onManageClick}>
        {t('agents.manage_all')}
      </button>
    </fieldset>
  );
}
