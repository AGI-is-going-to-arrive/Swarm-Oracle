/* ═══════════════════════════════════════════════════════════
   P1-1 — Agent Profile Modal
   Displays agent identity details, cross-scenario memories,
   and growth events timeline. Triggered from AgentLibrary
   cards or ReturningBadge.

   P2-3 — De-inlined to BEM classes; added decision bias
   visualization.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AgentIdentityInfo, AgentMemoryEntry, AgentGrowthEvent, KnowledgeDomain } from '../types';
import { getIdentityMemory, getIdentityGrowthEvents } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { MemoryTimeline } from './MemoryTimeline';
import './AgentProfileModal.css';

interface Props {
  identity: AgentIdentityInfo | null;
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL_I18N: Record<string, [string, string]> = {
  generated: ['agent_profile.kind_generated', 'Generated'],
  custom: ['agent_profile.kind_custom', 'Custom'],
};

function openDialogElement(dialog: HTMLDialogElement) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
    return;
  }
  dialog.setAttribute('open', '');
}

function closeDialogElement(dialog: HTMLDialogElement) {
  if (typeof dialog.close === 'function') {
    if (dialog.open) dialog.close();
    return;
  }
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
}

interface BiasRow {
  key: string;
  numeric: number | null;
  text: string;
  /** absolute |numeric| in [0, 1] for bar width relative to max-abs in this set */
  magnitude: number;
}

function parseDecisionBias(identity: AgentIdentityInfo): Record<string, unknown> | null {
  if (identity.decision_bias && typeof identity.decision_bias === 'object') {
    return identity.decision_bias;
  }
  if (identity.decision_bias_json) {
    try {
      const parsed = JSON.parse(identity.decision_bias_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function buildBiasRows(bias: Record<string, unknown>): BiasRow[] {
  const entries = Object.entries(bias);
  if (entries.length === 0) return [];
  // First pass: compute max absolute numeric so bars normalize to it
  let maxAbs = 0;
  for (const [, v] of entries) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
    }
  }
  if (maxAbs === 0) maxAbs = 1; // avoid div/0; fallback to 1.0 baseline
  return entries.map(([key, value]) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const magnitude = Math.min(1, Math.abs(value) / maxAbs);
      return { key, numeric: value, text: value.toFixed(2), magnitude };
    }
    if (typeof value === 'string') {
      return { key, numeric: null, text: value, magnitude: 0 };
    }
    if (typeof value === 'boolean') {
      return { key, numeric: null, text: value ? 'true' : 'false', magnitude: 0 };
    }
    if (value == null) {
      return { key, numeric: null, text: '—', magnitude: 0 };
    }
    try {
      return { key, numeric: null, text: JSON.stringify(value), magnitude: 0 };
    } catch {
      return { key, numeric: null, text: String(value), magnitude: 0 };
    }
  });
}

function parseKnowledgeDomains(raw: string | null | undefined): KnowledgeDomain[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((domain): domain is KnowledgeDomain => (
      typeof domain === 'string' && domain.trim().length > 0
    ));
  } catch {
    return [];
  }
}

export function AgentProfileModal({ identity, open, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language === 'zh' ? 'zh-CN' : 'en';
  const { loading: capLoading, enabled: identityEnabled } = useCapabilityCheck('agent_identity');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const requestSeqRef = useRef(0);

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
      openDialogElement(dialog);
    } else if (dialog.open) {
      closeDialogElement(dialog);
    }
  }, [open, identity]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || typeof dialog.showModal === 'function') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

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
    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const [memRes, evtRes] = await Promise.all([
        getIdentityMemory(id),
        getIdentityGrowthEvents(id),
      ]);
      if (requestSeqRef.current !== requestId) return;
      setMemories(memRes.memories);
      setEvents(evtRes.events);
    } catch {
      if (requestSeqRef.current !== requestId) return;
      setError('LOAD_ERROR');
    } finally {
      if (requestSeqRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open && identity && identityEnabled) {
      const timeoutId = window.setTimeout(() => {
        void fetchData(identity.id);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    requestSeqRef.current += 1;
    const resetTimeoutId = window.setTimeout(() => {
      setMemories([]);
      setEvents([]);
      setError(null);
      setLoading(false);
    }, 0);
    return () => window.clearTimeout(resetTimeoutId);
  }, [open, identity, identityEnabled, fetchData]);

  // Decision bias (computed before early return, but only used when identity exists)
  const biasRows = useMemo<BiasRow[]>(() => {
    if (!identity) return [];
    const bias = parseDecisionBias(identity);
    if (!bias) return [];
    return buildBiasRows(bias);
  }, [identity]);

  // S2-5: Growth metrics derived from events list.
  // - scenario_count: distinct scenario_id appearances
  // - stance_shifts: events of type 'stance_shift'
  // - growth_events: total events recorded
  const growthMetrics = useMemo(() => {
    const scenarioIds = new Set<string>();
    let stanceShifts = 0;
    for (const ev of events) {
      if (ev.scenario_id) scenarioIds.add(ev.scenario_id);
      if (ev.event_type === 'stance_shift') stanceShifts += 1;
    }
    return {
      scenarioCount: scenarioIds.size,
      stanceShifts,
      growthEvents: events.length,
    };
  }, [events]);
  const hasGrowthMetrics = growthMetrics.scenarioCount > 0
    || growthMetrics.stanceShifts > 0
    || growthMetrics.growthEvents > 0;

  // ESC handling is built into <dialog>
  if (!identity) return <dialog ref={dialogRef} />;

  const domains = parseKnowledgeDomains(identity.knowledge_domain_json);

  const kindPair = KIND_LABEL_I18N[identity.kind];
  const kindLabel = kindPair ? t(kindPair[0], kindPair[1]) : identity.kind;
  const isCustom = identity.kind === 'custom';

  return (
    <dialog
      ref={dialogRef}
      className="agent-profile-modal"
      aria-label={t('agent_profile.dialog_label', 'Agent Profile')}
    >
      {/* Header */}
      <div className="agent-profile-modal__header">
        <div
          className={`agent-profile-modal__avatar ${isCustom ? 'agent-profile-modal__avatar--custom' : 'agent-profile-modal__avatar--generated'}`}
          aria-hidden="true"
        >
          {isCustom ? '🎭' : '🤖'}
        </div>
        <div className="agent-profile-modal__title-wrap">
          <h2 className="agent-profile-modal__title">
            {identity.display_name}
          </h2>
          <div className="agent-profile-modal__subtitle">
            <span>{identity.role}</span>
            <span
              className={`agent-profile-modal__kind-badge ${isCustom ? 'agent-profile-modal__kind-badge--custom' : 'agent-profile-modal__kind-badge--generated'}`}
            >
              {kindLabel}
            </span>
            {identity.id && (
              <Link
                to={`/agents/identities/${identity.id}/memories`}
                className="agent-profile-modal__inspector-link"
                data-testid="agent-profile-modal-inspector"
              >
                {t('agent_profile.view_memory_inspector', 'View memory inspector')}
              </Link>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="agent-profile-modal__close-btn"
        >
          ✕
        </button>
      </div>

      {/* Body — scrollable */}
      <div className="agent-profile-modal__body">
        {/* Persona */}
        {identity.persona && (
          <section className="agent-profile-modal__section">
            <h3 className="agent-profile-modal__section-title">
              {t('agent_profile.persona', 'Persona')}
            </h3>
            <p className="agent-profile-modal__persona">
              {identity.persona}
            </p>
          </section>
        )}

        {/* Knowledge domains */}
        {domains.length > 0 && (
          <section className="agent-profile-modal__section">
            <h3 className="agent-profile-modal__section-title">
              {t('agent_profile.domains', 'Knowledge Domains')}
            </h3>
            <div className="agent-profile-modal__domains">
              {domains.map(d => (
                <span key={d} className="agent-profile-modal__domain-chip">
                  {d}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Decision Bias chart */}
        <section className="agent-profile-modal__section">
          <h3 className="agent-profile-modal__section-title">
            {t('agent_profile.decision_bias', 'Decision Bias')}
          </h3>
          {biasRows.length === 0 ? (
            <p className="agent-profile-modal__status">
              {t('agent_profile.no_bias', 'No bias data')}
            </p>
          ) : (
            <div
              className="agent-profile-modal__bias-chart"
              role="list"
              aria-label={t('agent_profile.decision_bias', 'Decision Bias')}
            >
              {biasRows.map(row => {
                const isNumeric = row.numeric != null;
                const isNegative = isNumeric && row.numeric! < 0;
                // half-track widths anchored at 50% midline
                const widthPct = `${(row.magnitude * 50).toFixed(2)}%`;
                return (
                  <div key={row.key} className="agent-profile-modal__bias-row" role="listitem">
                    <span className="agent-profile-modal__bias-key" title={row.key}>
                      {row.key}
                    </span>
                    {isNumeric ? (
                      <>
                        <span
                          className="agent-profile-modal__bias-track"
                          aria-hidden="true"
                        >
                          <span
                            className={`agent-profile-modal__bias-bar ${isNegative ? 'agent-profile-modal__bias-bar--negative' : 'agent-profile-modal__bias-bar--positive'}`}
                            style={{
                              width: widthPct,
                              left: isNegative ? `calc(50% - ${widthPct})` : '50%',
                            }}
                          />
                        </span>
                        <span className="agent-profile-modal__bias-value">
                          {row.text}
                        </span>
                      </>
                    ) : (
                      <span className="agent-profile-modal__bias-value agent-profile-modal__bias-value--text">
                        {row.text}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Meta */}
        <section className="agent-profile-modal__meta">
          <span>ID: {identity.continuity_key}</span>
          <span>{t('agent_profile.created', 'Created')}: {new Date(identity.created_at).toLocaleDateString(locale)}</span>
        </section>

        {/* Divider */}
        <hr className="agent-profile-modal__divider" />

        {/* S2-5: Growth metrics summary derived from events */}
        {!capLoading && identityEnabled && !loading && !error && (
          <section className="agent-profile-modal__section agent-profile-modal__metrics">
            <h3 className="agent-profile-modal__section-title">
              {t('agent_profile.metrics_title', 'Growth Metrics')}
            </h3>
            {hasGrowthMetrics ? (
              <ul className="agent-profile-modal__metrics-list">
                {growthMetrics.scenarioCount > 0 && (
                  <li className="agent-profile-modal__metrics-item">
                    {t(
                      'agent_profile.metrics_scenarios',
                      `Participated in ${growthMetrics.scenarioCount} scenarios`,
                      { count: growthMetrics.scenarioCount },
                    )}
                  </li>
                )}
                {growthMetrics.stanceShifts > 0 && (
                  <li className="agent-profile-modal__metrics-item">
                    {t(
                      'agent_profile.metrics_shifts',
                      `Shifted stance ${growthMetrics.stanceShifts} times`,
                      { count: growthMetrics.stanceShifts },
                    )}
                  </li>
                )}
                {growthMetrics.growthEvents > 0 && (
                  <li className="agent-profile-modal__metrics-item">
                    {t(
                      'agent_profile.metrics_growth',
                      `${growthMetrics.growthEvents} growth events recorded`,
                      { count: growthMetrics.growthEvents },
                    )}
                  </li>
                )}
              </ul>
            ) : (
              <p className="agent-profile-modal__status">
                {t('agent_profile.metrics_empty', 'No growth data yet')}
              </p>
            )}
          </section>
        )}

        {/* Timeline */}
        <section>
          <h3 className="agent-profile-modal__section-title agent-profile-modal__section-title--timeline">
            {t('agent_profile.timeline_title', 'Growth Timeline')}
          </h3>
          {capLoading && (
            <p className="agent-profile-modal__status">
              {t('common.loading', 'Loading...')}
            </p>
          )}
          {!capLoading && !identityEnabled && (
            <p className="agent-profile-modal__status">
              {t('agent_profile.identity_disabled', 'Agent identity feature is not enabled. Timeline data is unavailable.')}
            </p>
          )}
          {!capLoading && identityEnabled && loading && (
            <p className="agent-profile-modal__status">
              {t('common.loading', 'Loading...')}
            </p>
          )}
          {!capLoading && identityEnabled && error && (
            <p role="alert" className="agent-profile-modal__status agent-profile-modal__status--error">
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
