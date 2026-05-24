import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion';
import { getEndingRoomPhaseLabel } from '../../lib/endingRoomLabels';
import type { EndingRoomPhaseInsight } from '../../types';
import { isEndingRoomPhase } from '../roundtableHelpers';

export interface PhaseInsightTimelinePhase {
  phase: string;
  insight: string;
  turn_count?: number;
}

export interface PhaseInsightTimelineProps {
  /** Phases (raw or simplified) to render. */
  phases: PhaseInsightTimelinePhase[] | EndingRoomPhaseInsight[];
  /** Optional callback fired when a phase trigger is clicked (e.g. for scroll anchoring). */
  onPhaseClick?: (phase: string, index: number) => void;
  /** Optional currently-active phase id (string form `${phase}-${index}`). */
  activePhase?: string;
  /** When true, all items start collapsed. Default: true. */
  defaultCollapsed?: boolean;
  /** Optional render prop for trailing action buttons inside the expanded body. */
  renderActions?: (
    insight: EndingRoomPhaseInsight | PhaseInsightTimelinePhase,
    index: number,
  ) => ReactNode;
  /** Optional short phase title (overrides the default body insight text). */
  computeTitle?: (
    insight: EndingRoomPhaseInsight | PhaseInsightTimelinePhase,
    isZh: boolean,
  ) => string;
  /** Optional commentary text used inside the expanded body. */
  computeCommentary?: (
    insight: EndingRoomPhaseInsight | PhaseInsightTimelinePhase,
    isZh: boolean,
  ) => string;
}

/**
 * PhaseInsightTimeline
 * Renders an accessible accordion timeline of phase insights. Each item is a
 * collapsible row (default collapsed) showing a phase chip, short title and
 * optional stakes; expanding shows full commentary and (optional) action slot.
 *
 * Extracted from WorldlineRoundtableView.tsx to keep the page slim.
 */
export function PhaseInsightTimeline({
  phases,
  onPhaseClick,
  activePhase,
  defaultCollapsed = true,
  renderActions,
  computeTitle,
  computeCommentary,
}: PhaseInsightTimelineProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const handleTriggerClick = useCallback(
    (phase: string, index: number) => {
      if (onPhaseClick) {
        onPhaseClick(phase, index);
      }
    },
    [onPhaseClick],
  );

  if (!phases || phases.length === 0) {
    return null;
  }

  const accordionExtraProps =
    activePhase !== undefined
      ? { value: activePhase }
      : defaultCollapsed
        ? {}
        : { defaultValue: `${phases[0].phase}-0` };

  return (
    <Accordion
      type="single"
      collapsible
      className="roundtable-phase-timeline"
      aria-label={t('roundtable.phase_insights_label')}
      {...accordionExtraProps}
    >
      {phases.map((insight, index) => {
        const value = `${insight.phase}-${index}`;
        const phaseClass = isEndingRoomPhase(insight.phase)
          ? `phase-chip--${insight.phase}`
          : 'phase-chip--unknown';
        const chipLabel = isEndingRoomPhase(insight.phase)
          ? getEndingRoomPhaseLabel(insight.phase, t)
          : t('roundtable.phase_unknown');

        const stakes = 'stakes' in insight ? String(insight.stakes ?? '').trim() : '';
        const moderatorFocus =
          'moderator_focus' in insight ? String(insight.moderator_focus ?? '').trim() : '';
        const fallbackTitle =
          'commentary' in insight
            ? String(insight.commentary ?? '').trim() || stakes
            : String((insight as PhaseInsightTimelinePhase).insight ?? '').trim();
        const title = computeTitle ? computeTitle(insight, isZh) : fallbackTitle;
        const commentary = computeCommentary
          ? computeCommentary(insight, isZh)
          : fallbackTitle;

        return (
          <AccordionItem
            key={value}
            value={value}
            className="roundtable-phase-timeline__item"
          >
            <AccordionTrigger
              className="editorial-chapter-trigger roundtable-phase-timeline__trigger"
              onClick={() => handleTriggerClick(insight.phase, index)}
            >
              <span className="roundtable-phase-timeline__dot" aria-hidden="true" />
              <span className={`phase-chip ${phaseClass}`}>{chipLabel}</span>
              <span className="phase-insight-body">
                <span className="phase-insight-title">{title}</span>
                {stakes ? <span className="phase-insight-stakes">{stakes}</span> : null}
              </span>
            </AccordionTrigger>
            <AccordionContent className="roundtable-phase-timeline__content">
              <article className="worldline-roundtable-insight worldline-roundtable-insight__expanded-content phase-insight-expanded">
                <div className="phase-insight-expanded__meta">
                  {stakes ? (
                    <span className="phase-insight-expanded__stakes">{stakes}</span>
                  ) : null}
                  {moderatorFocus ? (
                    <span className="phase-insight-expanded__focus">
                      {t('roundtable.insight_focus_label')}: {moderatorFocus}
                    </span>
                  ) : null}
                </div>
                <p className="phase-insight-expanded__body">{commentary}</p>
                {renderActions ? (
                  <div className="worldline-roundtable-insight__actions phase-insight-expanded__actions">
                    {renderActions(insight, index)}
                  </div>
                ) : null}
              </article>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

export default PhaseInsightTimeline;
