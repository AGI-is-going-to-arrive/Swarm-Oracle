import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../stores/agentStore';
import './AgentSelectionStrip.css';

interface AgentSelectionStripProps {
  userId: string;
  visible: boolean;
  maxSelected: number;
  onManageClick: () => void;
}

const MAX_VISIBLE_PILLS = 3;

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

  const customAgents = useMemo(
    () => identities.filter((agent) => agent.kind === 'custom'),
    [identities],
  );

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

  if (customAgents.length === 0) {
    return null;
  }

  const visibleAgents = customAgents.slice(0, MAX_VISIBLE_PILLS);
  const moreCount = Math.max(0, customAgents.length - MAX_VISIBLE_PILLS);
  const selectionFull = selectedIds.size >= maxSelected;

  return (
    <fieldset className="agent-strip">
      <legend className="sr-only">{t('agents.quick_select')}</legend>
      <ul className="agent-strip__pills">
        {visibleAgents.map((agent) => {
          const isSelected = selectedIds.has(agent.id);
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
                  onChange={() => toggleSelection(agent.id, maxSelected)}
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
