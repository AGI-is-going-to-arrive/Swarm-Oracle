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

export interface NodeContextBannerProps {
  origin: NodeConversationOrigin;
  className?: string;
}

export function NodeContextBanner({ origin, className }: NodeContextBannerProps) {
  const { t } = useTranslation();
  const { agentName, nodeLabel, excerpt, roundNumber, nodeType, typeColor } = origin;
  const [expanded, setExpanded] = useState(false);

  const hasContent = agentName || nodeLabel || excerpt || roundNumber != null;
  if (!hasContent) return null;

  const resolvedColor = typeColor ?? NODE_TYPE_COLORS_HEX[nodeType] ?? '#888';
  const iconName = NODE_ICONS[nodeType];
  const IconComponent = iconName ? ICON_COMPONENTS[iconName] : null;
  const [typeLabelKey, typeLabelFallback] = TYPE_LABEL_I18N[nodeType] ?? ['', nodeType];
  const typeLabel = typeLabelKey ? t(typeLabelKey, { defaultValue: typeLabelFallback }) : nodeType;

  const isLong = excerpt ? Array.from(excerpt).length > EXCERPT_CLAMP_CHARS : false;

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
        {excerpt ? (
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
