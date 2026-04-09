/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Attach Panel (checkbox selection)
   Keyboard-only usable: tab + space to select agents.
   ═══════════════════════════════════════════════════════════ */

import { useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useTranslation } from 'react-i18next';

interface Props {
  userId: string;
  visible: boolean;
}

export function AgentAttachPanel({ userId, visible }: Props) {
  const { t } = useTranslation();
  const { identities, loading, selectedIds, fetchIdentities, toggleSelection } = useAgentStore();

  useEffect(() => {
    if (visible && identities.length === 0) {
      fetchIdentities(userId);
    }
  }, [visible, userId, identities.length, fetchIdentities]);

  if (!visible) return null;

  const customAgents = identities.filter(a => a.kind === 'custom');

  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (customAgents.length === 0) return null;

  return (
    <fieldset
      style={{
        border: '1px solid var(--color-border, #555)',
        borderRadius: 8,
        padding: '0.75rem',
        marginTop: '0.75rem',
      }}
    >
      <legend style={{ fontWeight: 600, fontSize: '0.9rem' }}>
        {t('agents.attach_title', 'Attach Custom Agents')}
        {selectedIds.size > 0 && (
          <span style={{ fontWeight: 400, fontSize: '0.8rem', marginLeft: 8, color: '#8ab4f8' }}>
            ({selectedIds.size}/5)
          </span>
        )}
      </legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {customAgents.map(agent => {
          const selected = selectedIds.has(agent.id);
          return (
            <label
              key={agent.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 6,
                border: selected ? '2px solid var(--color-accent, #4a90d9)' : '1px solid var(--color-border, #555)',
                background: selected ? 'rgba(74,144,217,0.15)' : 'transparent',
                cursor: 'pointer', fontSize: '0.85rem',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => toggleSelection(agent.id)}
                style={{ accentColor: 'var(--color-accent, #4a90d9)' }}
              />
              <span style={{ fontWeight: 600 }}>{agent.display_name}</span>
              <span style={{ color: '#888', fontSize: '0.75rem' }}>{agent.role}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
