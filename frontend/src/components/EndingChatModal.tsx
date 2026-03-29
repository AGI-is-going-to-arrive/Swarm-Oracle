import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { getEndingRoomModeLabel, getEndingRoomPhaseLabel, getEndingRoomStatusLabel } from '../lib/endingRoomLabels';
import { useEndingRoomWS } from '../hooks/useEndingRoomWS';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import type { AgentMessage, EndingRoomType, StoryData } from '../types';

import './EndingChatModal.css';

interface EndingChatModalProps {
  open: boolean;
  scenarioId: string;
  branch: StoryData['branches'][number] | null;
  roomType: EndingRoomType;
  language: 'zh' | 'en';
  readOnly: boolean;
  fallbackMessages?: AgentMessage[];
  onClose: () => void;
  onModeChange: (mode: 'ending_chamber' | 'one_move_only') => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export default function EndingChatModal({
  open,
  scenarioId,
  branch,
  roomType,
  language,
  readOnly,
  fallbackMessages = [],
  onClose,
  onModeChange,
  onAutomationStateChange,
}: EndingChatModalProps) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const transcriptListRef = useRef<HTMLDivElement>(null);
  const {
    snapshot,
    result,
    status,
    error,
    pendingDrafts,
    openRoom,
    loadRoom,
    reset,
  } = useEndingRoomStore();

  useEndingRoomWS(
    snapshot?.id,
    open && !readOnly && Boolean(snapshot?.id) && status !== 'done' && status !== 'error',
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !branch) {
      return;
    }
    if (modalRef.current) {
      modalRef.current.scrollTop = 0;
    }
    if (readOnly) {
      reset();
      return;
    }

    let cancelled = false;
    reset();
    void openRoom(scenarioId, {
      roomType,
      anchorBranchId: branch.id,
      selectedBranchIds: [branch.id],
      language,
    }).then(async (roomId) => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (cancelled) return;
      await loadRoom(roomId);
    }).catch(() => {
      // Store already captures the localized error state.
    });

    return () => {
      cancelled = true;
    };
  }, [branch, language, loadRoom, open, openRoom, readOnly, reset, roomType, scenarioId]);

  useEffect(() => {
    if (transcriptListRef.current) {
      transcriptListRef.current.scrollTop = transcriptListRef.current.scrollHeight;
    }
  }, [fallbackMessages.length, pendingDrafts, snapshot?.turns.length]);

  const participantsById = useMemo(
    () => new Map((snapshot?.participants ?? []).map((participant) => [participant.id, participant])),
    [snapshot?.participants],
  );

  const sortedDrafts = useMemo(
    () => Object.values(pendingDrafts).sort((left, right) => left.sequence - right.sequence),
    [pendingDrafts],
  );

  const transcriptMessages = useMemo(() => {
    if (!readOnly) {
      return (snapshot?.turns ?? []).map((turn) => ({
        key: turn.id,
        speaker: participantsById.get(turn.participant_id)?.display_name ?? t('ending_room.participant_unknown'),
        phase: getEndingRoomPhaseLabel(turn.phase, t),
        content: turn.content,
      }));
    }

    return fallbackMessages.map((message, index) => ({
      key: `${message.branch}-${message.round}-${message.agent_id}-${index}`,
      speaker: message.agent,
      phase: `R${message.round}`,
      content: message.message,
    }));
  }, [fallbackMessages, participantsById, readOnly, snapshot?.turns, t]);

  useEffect(() => {
    if (!open || !branch) {
      onAutomationStateChange?.(null);
      return;
    }

    onAutomationStateChange?.({
      kind: 'ending_room_modal',
      branch_id: branch.id,
      room_id: snapshot?.id ?? null,
      room_type: roomType,
      read_only: readOnly,
      status,
      has_result: Boolean(result),
      turn_count: transcriptMessages.length,
      pending_draft_count: sortedDrafts.length,
      active_phase: snapshot?.current_phase ?? null,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [
    branch,
    onAutomationStateChange,
    open,
    readOnly,
    result,
    roomType,
    snapshot?.current_phase,
    snapshot?.id,
    sortedDrafts.length,
    status,
    transcriptMessages.length,
  ]);

  if (!open || !branch) {
    return null;
  }

  return (
    <div className="ending-chat-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="ending-chat-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ending-chat-title"
      >
        <header className="ending-chat-header">
          <div>
            <p className="ending-chat-kicker">{t('ending_room.title')}</p>
            <h2 id="ending-chat-title" className="ending-chat-title">{branch.title}</h2>
            <div className="ending-chat-meta-row">
              <span className="ending-chat-badge ending-chat-badge--primary">
                {getEndingRoomModeLabel(roomType, t)}
              </span>
              <span className="ending-chat-badge">
                {getEndingRoomStatusLabel(readOnly ? 'done' : (snapshot?.status ?? (status === 'loading' ? 'draft' : 'error')), t)}
              </span>
              <span className="ending-chat-badge">{t('ending_room.current_branch_badge')}</span>
              <span className="ending-chat-probability">{((branch.probability ?? 0) * 100).toFixed(1)}%</span>
            </div>
          </div>
          <button type="button" className="ending-chat-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>

        <div className="ending-chat-tabs" role="tablist" aria-label={t('ending_room.title')}>
          <button
            type="button"
            className={`ending-chat-tab ${roomType === 'ending_chamber' ? 'is-active' : ''}`}
            onClick={() => onModeChange('ending_chamber')}
          >
            {t('ending_room.mode_debrief')}
          </button>
          <button
            type="button"
            className={`ending-chat-tab ${roomType === 'one_move_only' ? 'is-active' : ''}`}
            onClick={() => onModeChange('one_move_only')}
          >
            {t('ending_room.mode_one_move_only')}
          </button>
        </div>

        <div className="ending-chat-body">
          <aside className="ending-chat-sidebar">
            <section className="ending-chat-panel">
              <h3>{t('result.story')}</h3>
              <p>{branch.story || '—'}</p>
            </section>

            {branch.insight && (
              <section className="ending-chat-panel">
                <h3>{t('result.insight')}</h3>
                <blockquote>{branch.insight}</blockquote>
              </section>
            )}

            {result && (
              <section className="ending-chat-panel ending-chat-panel--summary">
                <h3>{t('roundtable.phase_verdict')}</h3>
                <p>{result.summary}</p>
                {result.next_move && result.next_move !== result.summary && (
                  <>
                    <h4>{t('ending_room.mode_one_move_only')}</h4>
                    <p>{result.next_move}</p>
                  </>
                )}
              </section>
            )}

            {readOnly && (
              <section className="ending-chat-panel ending-chat-panel--notice">
                <p>{t('ending_room.replay_readonly')}</p>
              </section>
            )}

            {error && (
              <section className="ending-chat-panel ending-chat-panel--error">
                <p>{error}</p>
              </section>
            )}
          </aside>

          <section className="ending-chat-transcript">
            <div className="ending-chat-transcript-header">
              <div>
                <h3>{t('ending_room.transcript_title')}</h3>
                <p>
                  {snapshot
                    ? getEndingRoomPhaseLabel(snapshot.current_phase, t)
                    : (readOnly ? t('ending_room.replay_readonly') : t('ending_room.loading'))}
                </p>
              </div>
            </div>

            {status === 'loading' && !readOnly && transcriptMessages.length === 0 && sortedDrafts.length === 0 && (
              <div className="ending-chat-empty-state">{t('ending_room.loading')}</div>
            )}

            {status !== 'loading' && transcriptMessages.length === 0 && sortedDrafts.length === 0 && (
              <div className="ending-chat-empty-state">
                {readOnly ? t('ending_room.replay_readonly') : t('ending_room.empty')}
              </div>
            )}

            <div ref={transcriptListRef} className="ending-chat-transcript-list">
              {transcriptMessages.map((message) => (
                <article key={message.key} className="ending-chat-bubble">
                  <header>
                    <strong>{message.speaker}</strong>
                    <span>{message.phase}</span>
                  </header>
                  <p>{message.content}</p>
                </article>
              ))}

              {!readOnly && sortedDrafts.map((draft) => (
                <article key={draft.turnId} className="ending-chat-bubble ending-chat-bubble--draft">
                  <header>
                    <strong>{participantsById.get(draft.participantId)?.display_name ?? t('ending_room.participant_unknown')}</strong>
                    <span>{getEndingRoomPhaseLabel(draft.phase, t)}</span>
                    <em>{t('ending_room.draft_badge')}</em>
                  </header>
                  <p>{draft.content || '…'}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
