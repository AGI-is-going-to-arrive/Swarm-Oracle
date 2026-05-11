/* ═══════════════════════════════════════════════════════════
   Agent Favorite Card — reusable identity tile with favorite toggle
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentIdentityInfo } from '../types';
import './AgentCard.css';

export interface AgentCardProps {
  identity: AgentIdentityInfo;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSelect?: () => void;
}

interface DecisionBiasEntry {
  label: string;
  value: number;
}

/** Coerce an unknown decision_bias map into ordered numeric entries (-1..1). */
function readDecisionBias(
  raw: AgentIdentityInfo['decision_bias'],
  rawJson: AgentIdentityInfo['decision_bias_json'],
): DecisionBiasEntry[] {
  let source: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    source = raw as Record<string, unknown>;
  } else if (typeof rawJson === 'string' && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      source = null;
    }
  }
  if (!source) return [];
  const entries: DecisionBiasEntry[] = [];
  for (const [label, value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = Math.max(-1, Math.min(1, value));
    entries.push({ label, value: clamped });
  }
  return entries.slice(0, 4);
}

export function AgentCard({
  identity,
  isFavorite,
  onToggleFavorite,
  onSelect,
}: AgentCardProps) {
  const { t } = useTranslation();
  const tier = (identity.preferred_tier ?? 'IMPORTANT').toUpperCase();
  const tierLower = tier.toLowerCase();
  const isGenerated = identity.kind === 'generated';
  const biasEntries = useMemo(
    () => readDecisionBias(identity.decision_bias, identity.decision_bias_json),
    [identity.decision_bias, identity.decision_bias_json],
  );

  const favoriteLabel = isFavorite
    ? t('agent_library.unfavorite_aria', 'Remove from favorites')
    : t('agent_library.favorite_aria', 'Add to favorites');

  const sourceLabel = isGenerated
    ? t('agent_library.source_generated', 'Generated')
    : t('agent_library.source_custom', 'Custom');

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite();
  };

  return (
    <article
      className={`agent-card-tile${isFavorite ? ' agent-card-tile--favorite' : ''}${
        isGenerated ? ' agent-card-tile--generated' : ''
      }`}
      aria-labelledby={`agent-card-title-${identity.id}`}
    >
      <header className="agent-card-tile__head">
        <div className="agent-card-tile__head-text">
          <h3
            className="agent-card-tile__name"
            id={`agent-card-title-${identity.id}`}
          >
            {identity.display_name}
          </h3>
          <p className="agent-card-tile__role">{identity.role}</p>
        </div>
        <button
          type="button"
          className="agent-card-tile__favorite"
          aria-label={favoriteLabel}
          aria-pressed={isFavorite}
          onClick={handleFavoriteClick}
        >
          <svg
            className="agent-card-tile__heart"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M12 21s-7.5-4.65-7.5-10.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 7.5 4.5C19.5 16.35 12 21 12 21z"
              fill={isFavorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <div className="agent-card-tile__meta">
        <span className={`agent-tier-badge agent-tier-badge--${tierLower}`}>
          {tier}
        </span>
        <span
          className={`agent-card-tile__source agent-card-tile__source--${
            isGenerated ? 'generated' : 'custom'
          }`}
          aria-label={t('agent_library.source_label', { source: sourceLabel })}
        >
          {sourceLabel}
        </span>
      </div>

      {biasEntries.length > 0 && (
        <ul className="agent-card-tile__bias" aria-label={t('agent_library.bias_label', 'Decision bias')}>
          {biasEntries.map((entry) => {
            const pct = Math.round(((entry.value + 1) / 2) * 100);
            const positive = entry.value >= 0;
            return (
              <li key={entry.label} className="agent-card-tile__bias-row">
                <span className="agent-card-tile__bias-label">{entry.label}</span>
                <span
                  className={`agent-card-tile__bias-bar agent-card-tile__bias-bar--${
                    positive ? 'pos' : 'neg'
                  }`}
                  role="img"
                  aria-label={`${entry.label}: ${entry.value.toFixed(2)}`}
                >
                  <span
                    className="agent-card-tile__bias-fill"
                    style={{ width: `${pct}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {identity.persona && (
        <p className="agent-card-tile__persona">
          {(() => {
            // Use Array.from to count by code points so we don't slice in the
            // middle of a CJK / emoji surrogate pair (which would render as
            // a replacement character).
            const codepoints = Array.from(identity.persona);
            return codepoints.length > 140
              ? `${codepoints.slice(0, 140).join('')}…`
              : identity.persona;
          })()}
        </p>
      )}

      {onSelect && (
        <div className="agent-card-tile__actions">
          <button
            type="button"
            className="agent-card-tile__action"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          >
            {t('agent_library.view_details', 'View details')}
          </button>
        </div>
      )}
    </article>
  );
}

export default AgentCard;
