import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare, Zap, ArrowLeftRight, GitBranch, Clock, Gavel,
  Flag, FileCheck, ShieldAlert, Swords, ChevronDown, ChevronUp,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { NODE_TYPE_COLORS_HEX, NODE_ICONS, TYPE_LABEL_I18N } from '../../lib/graphTokens';
import type { NodeConversationOrigin } from './NodeConversationSheet';

const ICON_COMPONENTS: Record<string, LucideIcon> = {
  MessageSquare, Zap, ArrowLeftRight, GitBranch, Clock, Gavel,
  Flag, FileCheck, ShieldAlert, Swords,
};

const EXCERPT_CLAMP_CHARS = 50;

function normalizeBannerCopy(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export interface NodeContextBannerProps {
  origin: NodeConversationOrigin;
  className?: string;
}

export function NodeContextBanner({ origin, className }: NodeContextBannerProps) {
  const { t } = useTranslation();
  const {
    agentName,
    nodeLabel,
    excerpt,
    roundNumber,
    nodeType,
    typeColor,
    targetLabel,
    targetDescription,
    meaningTitle,
    meaningDescription,
    causeContext,
    effectContext,
    relationContext,
    relatedContext,
  } = origin;
  const [expanded, setExpanded] = useState(false);

  const visibleCauseContext = (causeContext ?? []).map(normalizeBannerCopy).filter(Boolean);
  const visibleEffectContext = (effectContext ?? []).map(normalizeBannerCopy).filter(Boolean);
  const visibleRelationContext = (relationContext ?? []).map(normalizeBannerCopy).filter(Boolean);
  const visibleRelatedContext = (relatedContext ?? []).map(normalizeBannerCopy).filter(Boolean);
  const hasSemanticContext = visibleCauseContext.length > 0
    || visibleEffectContext.length > 0
    || visibleRelationContext.length > 0;
  const hasContent = agentName || nodeLabel || excerpt || roundNumber != null || targetLabel || targetDescription
    || meaningTitle || meaningDescription || hasSemanticContext || visibleRelatedContext.length > 0;
  if (!hasContent) return null;

  const resolvedColor = typeColor ?? NODE_TYPE_COLORS_HEX[nodeType] ?? '#888';
  const iconName = NODE_ICONS[nodeType];
  const IconComponent = iconName ? ICON_COMPONENTS[iconName] : null;
  const [typeLabelKey, typeLabelFallback] = TYPE_LABEL_I18N[nodeType] ?? ['', nodeType];
  const typeLabel = typeLabelKey ? t(typeLabelKey, { defaultValue: typeLabelFallback }) : nodeType;
  const normalizedExcerpt = normalizeBannerCopy(excerpt);
  const showExcerpt = Boolean(normalizedExcerpt)
    && normalizedExcerpt !== normalizeBannerCopy(nodeLabel)
    && normalizedExcerpt !== normalizeBannerCopy(agentName);

  const isLong = showExcerpt ? Array.from(excerpt ?? '').length > EXCERPT_CLAMP_CHARS : false;

  return (
    <section
      className={cn('node-context-banner', className)}
      data-testid="node-context-banner"
      aria-label={t('node_context_banner.aria_label', { defaultValue: 'Node context' })}
    >
      <span
        className="node-context-banner__strip"
        style={{ backgroundColor: resolvedColor }}
        aria-hidden="true"
        data-testid="node-context-banner-strip"
      />
      <div className="node-context-banner__body">
        <div className="node-context-banner__meta">
          {IconComponent ? (
            <IconComponent
              className="node-context-banner__icon"
              size={14}
              aria-hidden="true"
              data-testid="node-context-banner-icon"
            />
          ) : null}
          <span className="node-context-banner__type" data-testid="node-context-banner-type">
            {typeLabel}
          </span>
          {roundNumber != null ? (
            <span className="node-context-banner__round" data-testid="node-context-banner-round">
              {t('node_context_banner.round', { round: roundNumber, defaultValue: `R{{round}}` })}
            </span>
          ) : null}
        </div>
        {targetLabel ? (
          <div className="node-context-banner__target" data-testid="node-context-banner-target">
            <span className="node-context-banner__target-prefix">
              {t('node_context_banner.asking_target', { defaultValue: 'Asking' })}:
            </span>{' '}
            {targetLabel}
          </div>
        ) : null}
        {targetDescription ? (
          <div
            className="node-context-banner__target-description"
            data-testid="node-context-banner-target-description"
          >
            {targetDescription}
          </div>
        ) : null}
        {meaningTitle || meaningDescription ? (
          <div className="node-context-banner__meaning" data-testid="node-context-banner-meaning">
            {meaningTitle ? (
              <div className="node-context-banner__meaning-title">
                {meaningTitle}
              </div>
            ) : null}
            {meaningDescription ? (
              <p className="node-context-banner__meaning-description">
                {meaningDescription}
              </p>
            ) : null}
          </div>
        ) : null}
        {hasSemanticContext ? (
          <div
            className="node-context-banner__causal-groups"
            data-testid="node-context-banner-causal-groups"
          >
            {visibleCauseContext.length > 0 ? (
              <div className="node-context-banner__causal-group">
                <div className="node-context-banner__relations-title">
                  {t('node_context_banner.cause_title', { defaultValue: 'Why it appears' })}
                </div>
                <ul className="node-context-banner__relations-list">
                  {visibleCauseContext.map((line, index) => (
                    <li key={`${line}-${index}`} className="node-context-banner__relations-item">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {visibleEffectContext.length > 0 ? (
              <div className="node-context-banner__causal-group">
                <div className="node-context-banner__relations-title">
                  {t('node_context_banner.effect_title', { defaultValue: 'What it changes' })}
                </div>
                <ul className="node-context-banner__relations-list">
                  {visibleEffectContext.map((line, index) => (
                    <li key={`${line}-${index}`} className="node-context-banner__relations-item">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {visibleRelationContext.length > 0 ? (
              <div className="node-context-banner__causal-group">
                <div className="node-context-banner__relations-title">
                  {t('node_context_banner.relation_title', { defaultValue: 'How it relates' })}
                </div>
                <ul className="node-context-banner__relations-list">
                  {visibleRelationContext.map((line, index) => (
                    <li key={`${line}-${index}`} className="node-context-banner__relations-item">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {!hasSemanticContext && visibleRelatedContext.length > 0 ? (
          <div
            className="node-context-banner__relations"
            data-testid="node-context-banner-relations"
          >
            <div className="node-context-banner__relations-title">
              {t('node_context_banner.related_title', { defaultValue: 'Related links' })}
            </div>
            <ul className="node-context-banner__relations-list">
              {visibleRelatedContext.map((line, index) => (
                <li key={`${line}-${index}`} className="node-context-banner__relations-item">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {agentName ? (
          <div className="node-context-banner__agent" data-testid="node-context-banner-agent">
            {agentName}
          </div>
        ) : null}
        {nodeLabel && !agentName ? (
          <div className="node-context-banner__label" data-testid="node-context-banner-label">
            {nodeLabel}
          </div>
        ) : null}
        {showExcerpt ? (
          <div data-testid="node-context-banner-excerpt-wrap">
            <p
              className={cn(
                'node-context-banner__excerpt',
                !expanded && isLong && 'node-context-banner__excerpt--clamped',
              )}
              data-testid="node-context-banner-excerpt"
            >
              {excerpt}
            </p>
            {isLong ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="node-context-banner__toggle"
                data-testid="node-context-banner-toggle"
                aria-expanded={expanded}
              >
                {expanded ? (
                  <><ChevronUp size={12} aria-hidden="true" /> {t('common.collapse', { defaultValue: 'Collapse' })}</>
                ) : (
                  <><ChevronDown size={12} aria-hidden="true" /> {t('common.expand', { defaultValue: 'Expand' })}</>
                )}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
