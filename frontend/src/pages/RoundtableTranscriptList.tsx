import { type RefObject, Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndingRoomParticipant, EndingRoomPhase, EndingRoomRoleSlot } from '../types';
import type { OracleTranscriptBubbleLayout } from '../lib/textLayout/oracleTranscriptLayout';
import { getEndingRoomPhaseLabel } from '../lib/endingRoomLabels';
import { buildRoundtableAnchorId, ROUNDTABLE_COLLAPSED_TURN_MAX_LINES } from './roundtableHelpers';
import { FactionBadge } from '../components/FactionBadge';
import type { ParticipantFaction } from '../hooks/useFactionOverlay';

interface FormattedTurn {
  key: string;
  speaker: string;
  content: string;
  phase: string;
  roleSlot?: EndingRoomRoleSlot | 'user';
  participantId: string;
}

interface DisplayedDraft {
  key: string;
  content: string;
  phase: EndingRoomPhase;
  participantId?: string;
  variant?: string;
}

interface Props {
  listRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  isZh: boolean;
  currentTurns: FormattedTurn[];
  transcriptBubbleLayouts: Record<string, OracleTranscriptBubbleLayout>;
  activeThreadId: string | null;
  activeSpeakerTurnKey: string | null;
  hotseatParticipantId: string | null;
  expandedTurnKeys: Record<string, boolean>;
  onToggleExpand: (turnKey: string) => void;
  composerEnabled: boolean;
  isReplay: boolean;
  displayedDrafts: DisplayedDraft[];
  transcriptDraftLayouts: Record<string, OracleTranscriptBubbleLayout>;
  participantsById: Map<string, EndingRoomParticipant>;
  speakerIndexMap: Map<string, number>;
  factionMap?: Map<string, ParticipantFaction>;
  /** D-13: turn key of the currently speaking turn to spotlight */
  spotlightTurnKey?: string;
  onHotseatQuote: (participantId: string, speaker: string, content: string, anchorId: string) => void;
  onFollowQuote: (anchorId: string, speaker: string, content: string) => void;
  onQuoteThread: (anchorId: string, speaker: string, content: string) => void;
}

export default function RoundtableTranscriptList({
  listRef,
  onScroll,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isZh: _isZh,
  currentTurns,
  transcriptBubbleLayouts,
  activeThreadId,
  activeSpeakerTurnKey,
  hotseatParticipantId,
  expandedTurnKeys,
  onToggleExpand,
  composerEnabled,
  isReplay,
  displayedDrafts,
  transcriptDraftLayouts,
  participantsById,
  speakerIndexMap,
  factionMap,
  spotlightTurnKey,
  onHotseatQuote,
  onFollowQuote,
  onQuoteThread,
}: Props) {
  const { t } = useTranslation();

  const dividerTurnKeys = useMemo(() => {
    const keys = new Set<string>();
    let currentPhase = '';
    for (const turn of currentTurns) {
      if (turn.phase && turn.phase !== currentPhase) {
        keys.add(turn.key);
        currentPhase = turn.phase;
      }
    }
    return keys;
  }, [currentTurns]);

  return (
    <div
      ref={listRef}
      role="log"
      aria-label={t('roundtable.discussion_log')}
      className="ending-chat-transcript-list worldline-roundtable-transcript-list"
      onScroll={onScroll}
    >
      {currentTurns.map((turn) => {
        const showPhaseDivider = dividerTurnKeys.has(turn.key);
        const bubbleLayout = transcriptBubbleLayouts[turn.key];
        const turnAnchorId = buildRoundtableAnchorId('quote', activeThreadId ?? 'table', turn.key);
        const canCollapseTurn = (bubbleLayout?.lineCount ?? 0) > ROUNDTABLE_COLLAPSED_TURN_MAX_LINES;
        const isTurnExpanded = expandedTurnKeys[turn.key] ?? false;
        const showCollapsedTurn = canCollapseTurn && !isTurnExpanded;
        const speakerIdx = speakerIndexMap.get(turn.speaker) ?? 0;
        return (
          <Fragment key={turn.key}>
            {showPhaseDivider && (
              <h3 className="roundtable-phase-divider" id={`phase-${turn.phase.replace(/\s+/g, '-').toLowerCase()}`}>
                <span className="roundtable-phase-divider__label">{turn.phase}</span>
              </h3>
            )}
            <article
              className={`ending-chat-bubble ${turn.roleSlot === 'archivist' ? 'is-archivist' : ''} ${turn.key === activeSpeakerTurnKey ? 'is-current-speaker' : ''} ${turn.participantId === hotseatParticipantId ? 'is-hotseat-target' : ''} ${showCollapsedTurn ? 'is-collapsed' : ''} ${turn.key === spotlightTurnKey ? 'ending-chat-bubble--spotlight' : ''}`}
              style={showCollapsedTurn ? undefined : { minHeight: `${bubbleLayout?.minHeightPx ?? 0}px` }}
              data-layout-lines={bubbleLayout?.lineCount ?? undefined}
              data-layout-overflow={bubbleLayout?.overflow ? 'true' : 'false'}
              data-speaker={speakerIdx}
            >
            <header>
              {turn.roleSlot === 'archivist' && (
                <span className="ending-chat-bubble__icon ending-chat-bubble__icon--archivist" aria-hidden="true" />
              )}
              <strong>{turn.speaker}</strong>
              <FactionBadge faction={factionMap?.get(turn.participantId)} />
              {turn.key === activeSpeakerTurnKey && (
                <span className="worldline-roundtable-transcript-badge">
                  {t('roundtable.speaking_now')}
                </span>
              )}
              {turn.participantId === hotseatParticipantId && (
                <span className="worldline-roundtable-transcript-badge worldline-roundtable-transcript-badge--hotseat">
                  {t('roundtable.hotseat_target')}
                </span>
              )}
              {showCollapsedTurn && (
                <span className="worldline-roundtable-transcript-badge worldline-roundtable-transcript-badge--overflow">
                  {t('roundtable.long_turn')}
                </span>
              )}
              <span>{turn.phase}</span>
            </header>
            <p className={showCollapsedTurn ? 'worldline-roundtable-transcript-copy is-collapsed' : 'worldline-roundtable-transcript-copy'}>
              {turn.content}
            </p>
            {(canCollapseTurn || (composerEnabled && turn.roleSlot !== 'user')) && (
              <div className="ending-chat-bubble__actions">
                {canCollapseTurn && (
                  <button
                    type="button"
                    className="ending-chat-inline-button worldline-roundtable-transcript-toggle"
                    onClick={() => onToggleExpand(turn.key)}
                  >
                    {isTurnExpanded
                      ? t('roundtable.action_collapse_turn')
                      : t('roundtable.action_expand_turn')}
                  </button>
                )}
                {composerEnabled && turn.roleSlot !== 'user' && (
                  <>
                    {turn.roleSlot === 'representative' && (
                      <button
                        type="button"
                        className="ending-chat-inline-button"
                        onClick={() => onHotseatQuote(turn.participantId, turn.speaker, turn.content, turnAnchorId)}
                      >
                        {t('roundtable.action_hotseat_quote')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ending-chat-inline-button"
                      onClick={() => onFollowQuote(turnAnchorId, turn.speaker, turn.content)}
                    >
                      {t('roundtable.action_follow_quote')}
                    </button>
                    <button
                      type="button"
                      className="ending-chat-inline-button"
                      onClick={() => onQuoteThread(turnAnchorId, turn.speaker, turn.content)}
                    >
                      {t('roundtable.action_new_thread')}
                    </button>
                  </>
                )}
              </div>
            )}
            </article>
          </Fragment>
        );
      })}
      {!isReplay && displayedDrafts.map((draft) => (
        <article
          key={draft.key}
          className={`ending-chat-bubble ending-chat-bubble--draft ${draft.variant === 'placeholder' ? 'ending-chat-bubble--placeholder' : ''} ${draft.key === activeSpeakerTurnKey ? 'is-current-speaker' : ''}`}
          aria-busy={draft.variant === 'placeholder'}
          style={{ minHeight: `${transcriptDraftLayouts[draft.key]?.minHeightPx ?? 0}px` }}
          data-layout-lines={transcriptDraftLayouts[draft.key]?.lineCount ?? undefined}
          data-layout-overflow={transcriptDraftLayouts[draft.key]?.overflow ? 'true' : 'false'}
        >
          <header>
            <strong>{participantsById.get(draft.participantId ?? '')?.display_name ?? t('ending_room.participant_unknown')}</strong>
            <span>{getEndingRoomPhaseLabel(draft.phase, t)}</span>
          </header>
          <p>{draft.content}</p>
        </article>
      ))}
    </div>
  );
}
