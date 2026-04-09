/* ═══════════════════════════════════════════════════════════
   P1-1 — Agent Profile Modal
   Displays agent identity details, cross-scenario memories,
   and growth events timeline. Triggered from AgentLibrary
   cards or ReturningBadge.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentIdentityInfo, AgentMemoryEntry, AgentGrowthEvent, KnowledgeDomain } from '../types';
import { getIdentityMemory, getIdentityGrowthEvents } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { MemoryTimeline } from './MemoryTimeline';

interface Props {
  identity: AgentIdentityInfo | null;
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL_I18N: Record<string, [string, string]> = {
  generated: ['agent_profile.kind_generated', 'Generated'],
  custom: ['agent_profile.kind_custom', 'Custom'],
};

export function AgentProfileModal({ identity, open, onClose }: Props) {
  const { t } = useTranslation();
  const { loading: capLoading, enabled: identityEnabled } = useCapabilityCheck('agent_identity');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const [memories, setMemories] = useState<AgentMemoryEntry[]>([]);
  const [events, setEvents] = useState<AgentGrowthEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open/close dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && identity) {
      triggerRef.current = document.activeElement;
      dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, identity]);

  // Return focus on close
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      (triggerRef.current as HTMLElement)?.focus?.();
      onClose();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  // Fetch data when identity changes
  const fetchData = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const [memRes, evtRes] = await Promise.all([
        getIdentityMemory(id),
        getIdentityGrowthEvents(id),
      ]);
      setMemories(memRes.memories);
      setEvents(evtRes.events);
    } catch {
      setError('LOAD_ERROR');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open && identity && identityEnabled) {
      fetchData(identity.id);
    } else {
      setMemories([]);
      setEvents([]);
    }
  }, [open, identity, identityEnabled, fetchData]);

  // ESC handling is built into <dialog>
  if (!identity) return <dialog ref={dialogRef} />;

  const domains: KnowledgeDomain[] = (() => {
    try {
      return identity.knowledge_domain_json ? JSON.parse(identity.knowledge_domain_json) : [];
    } catch { return []; }
  })();

  const kindPair = KIND_LABEL_I18N[identity.kind];
  const kindLabel = kindPair ? t(kindPair[0], kindPair[1]) : identity.kind;

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('agent_profile.dialog_label', 'Agent Profile')}
      style={{
        maxWidth: 520,
        width: '90vw',
        maxHeight: '85vh',
        borderRadius: 12,
        border: '1px solid #333',
        background: '#1a1a2e',
        color: '#e0e0e0',
        padding: 0,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '1rem 1.25rem',
        borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
      }}>
        {/* Avatar placeholder */}
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: identity.kind === 'custom' ? '#9b59b622' : '#4a90d922',
          border: `2px solid ${identity.kind === 'custom' ? '#9b59b6' : '#4a90d9'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.2rem', flexShrink: 0,
        }}>
          {identity.kind === 'custom' ? '🎭' : '🤖'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', lineHeight: 1.3 }}>
            {identity.display_name}
          </h2>
          <div style={{ fontSize: '0.75rem', color: '#888', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span>{identity.role}</span>
            <span style={{
              padding: '0 4px', borderRadius: 3, fontSize: '0.65rem',
              background: identity.kind === 'custom' ? '#9b59b622' : '#4a90d922',
              color: identity.kind === 'custom' ? '#9b59b6' : '#4a90d9',
            }}>
              {kindLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          style={{
            background: 'none', border: 'none', color: '#888',
            fontSize: '1.2rem', cursor: 'pointer', padding: 4,
          }}
        >
          ✕
        </button>
      </div>

      {/* Body — scrollable */}
      <div style={{ padding: '1rem 1.25rem', overflowY: 'auto', maxHeight: 'calc(85vh - 80px)' }}>
        {/* Persona */}
        {identity.persona && (
          <section style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: '#aaa' }}>
              {t('agent_profile.persona', 'Persona')}
            </h3>
            <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.5, color: '#ccc' }}>
              {identity.persona}
            </p>
          </section>
        )}

        {/* Knowledge domains */}
        {domains.length > 0 && (
          <section style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: '#aaa' }}>
              {t('agent_profile.domains', 'Knowledge Domains')}
            </h3>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {domains.map(d => (
                <span
                  key={d}
                  style={{
                    padding: '2px 8px', borderRadius: 4,
                    background: '#2a2a4e', fontSize: '0.75rem', color: '#8ab4f8',
                  }}
                >
                  {d}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Meta */}
        <section style={{ marginBottom: '1rem', fontSize: '0.75rem', color: '#666', display: 'flex', gap: 12 }}>
          <span>ID: {identity.continuity_key}</span>
          <span>{t('agent_profile.created', 'Created')}: {new Date(identity.created_at).toLocaleDateString()}</span>
        </section>

        {/* Divider */}
        <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '0.75rem 0' }} />

        {/* Timeline */}
        <section>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
            {t('agent_profile.timeline_title', 'Growth Timeline')}
          </h3>
          {capLoading && (
            <p style={{ fontSize: '0.85rem', color: '#888' }}>
              {t('common.loading', 'Loading...')}
            </p>
          )}
          {!capLoading && !identityEnabled && (
            <p style={{ fontSize: '0.85rem', color: '#888' }}>
              {t('agent_profile.identity_disabled', 'Agent identity feature is not enabled. Timeline data is unavailable.')}
            </p>
          )}
          {!capLoading && identityEnabled && loading && (
            <p style={{ fontSize: '0.85rem', color: '#888' }}>
              {t('common.loading', 'Loading...')}
            </p>
          )}
          {!capLoading && identityEnabled && error && (
            <p role="alert" style={{ fontSize: '0.85rem', color: '#e74c3c' }}>
              {t('agent_profile.load_error', 'Failed to load agent data.')}
            </p>
          )}
          {!capLoading && identityEnabled && !loading && !error && (
            <MemoryTimeline events={events} memories={memories} />
          )}
        </section>
      </div>
    </dialog>
  );
}
