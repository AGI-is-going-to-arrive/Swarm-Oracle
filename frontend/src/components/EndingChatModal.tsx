import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getEndingRoomModeLabel, getEndingRoomPhaseLabel, getEndingRoomStatusLabel } from '../lib/endingRoomLabels';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';
import { useEndingRoomWS } from '../hooks/useEndingRoomWS';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import type {
  AgentMessage,
  EndingRoomInteractionMode,
  EndingRoomParticipant,
  EndingRoomThreadSnapshot,
  EndingRoomType,
  StoryData,
} from '../types';

import './EndingChatModal.css';

interface EndingChatModalProps {
  open: boolean;
  scenarioId: string;
  branch: StoryData['branches'][number] | null;
  roomType: EndingRoomType;
  selectedAgentIds?: string[];
  language: 'zh' | 'en';
  readOnly: boolean;
  fallbackMessages?: AgentMessage[];
  onClose: () => void;
  onModeChange: (mode: 'ending_chamber' | 'one_move_only') => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

function roleLabel(participant: EndingRoomParticipant, isZh: boolean): string {
  switch (participant.role_slot) {
    case 'archivist':
      return isZh ? '档案官' : 'Archivist';
    case 'user':
      return isZh ? '你' : 'You';
    case 'representative':
      return isZh ? '结局代表' : 'Representative';
    case 'critic':
      return isZh ? '评论者' : 'Critic';
    case 'observer':
      return isZh ? '旁听席' : 'Observer';
    default:
      return isZh ? '当前世界线' : 'Current worldline';
  }
}

function threadLabel(thread: EndingRoomThreadSnapshot, isZh: boolean): string {
  return thread.mode === 'room'
    ? `${thread.title}${isZh ? ' · 主桌' : ' · Main Desk'}`
    : thread.title;
}

function participantSprite(participant: EndingRoomParticipant): string {
  const agentRole = String(participant.persona_snapshot_json?.agent_role ?? '');
  const spriteId = mapRoleToSpriteId(agentRole, participant.display_name);
  return `/assets/characters/${spriteId}.png`;
}

function scopeText(
  thread: EndingRoomThreadSnapshot | undefined,
  scopeNotice: { threadId: string; memoryPartitionId: string } | null,
  isZh: boolean,
): string {
  if (scopeNotice && thread && scopeNotice.threadId === thread.id) {
    return isZh
      ? `当前只基于线程分区 ${scopeNotice.memoryPartitionId}`
      : `Scoped to thread partition ${scopeNotice.memoryPartitionId}`;
  }
  if (thread?.mode === 'followup') {
    return isZh ? '只基于当前追问线程' : 'Only using the current follow-up thread';
  }
  return isZh ? '只基于当前世界线与当前桌面' : 'Only using the current worldline and room desk';
}

export default function EndingChatModal({
  open,
  scenarioId,
  branch,
  roomType,
  selectedAgentIds = [],
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
  const [storyExpanded, setStoryExpanded] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const isZh = language === 'zh';
  const {
    snapshot,
    result,
    threadsById,
    threadOrder,
    activeThreadId,
    interactionMode,
    composerDraft,
    scopeNotice,
    sending,
    status,
    error,
    pendingDrafts,
    openRoom,
    loadRoom,
    loadThread,
    createThread,
    appendUserTurn,
    setActiveThread,
    setInteractionMode,
    setComposerDraft,
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
    setStoryExpanded(false);
    setSelectedAgentId(null);
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
      ...(selectedAgentIds.length > 0 ? { selectedAgentIds } : {}),
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
  }, [branch, language, loadRoom, open, openRoom, readOnly, reset, roomType, scenarioId, selectedAgentIds]);

  const defaultThreadId = useMemo(
    () => snapshot?.threads.find((thread) => thread.mode === 'room')?.id ?? snapshot?.threads[0]?.id ?? null,
    [snapshot?.threads],
  );

  const activeThread = useMemo(
    () => (activeThreadId ? threadsById[activeThreadId] : null) ?? (defaultThreadId ? threadsById[defaultThreadId] : null) ?? null,
    [activeThreadId, defaultThreadId, threadsById],
  );

  const threads = useMemo(
    () => threadOrder.map((threadId) => threadsById[threadId]).filter(Boolean),
    [threadOrder, threadsById],
  );

  const participants = useMemo(
    () => (snapshot?.participants ?? []).filter((participant) => participant.role_slot !== 'user'),
    [snapshot?.participants],
  );

  const targetableParticipants = useMemo(
    () => participants.filter((participant) => participant.role_slot !== 'archivist' && participant.source_agent_id),
    [participants],
  );
  const branchKeyMoments = useMemo(
    () => branch?.key_moments ?? [],
    [branch?.key_moments],
  );

  function participantMetrics(participant: EndingRoomParticipant) {
    const role = String(participant.persona_snapshot_json?.agent_role ?? roleLabel(participant, isZh));
    const persona = participant.persona_snapshot_json?.bio_short
      ? String(participant.persona_snapshot_json.bio_short)
      : participant.persona_snapshot_json?.agent_persona
        ? String(participant.persona_snapshot_json.agent_persona)
      : null;
    const relatedMessages = participant.source_agent_id
      ? fallbackMessages.filter((message) => message.agent_id === participant.source_agent_id)
      : [];
    const turnCount = relatedMessages.length;
    const lastRoundSpoken = relatedMessages.reduce((maxRound, message) => Math.max(maxRound, message.round ?? 0), 0);
    const keyMomentHits = relatedMessages.reduce((count, message) => (
      count + (branchKeyMoments.some((moment) => message.message.includes(moment)) ? 1 : 0)
    ), 0);
    const impactScore = Number(participant.persona_snapshot_json?.impact_score ?? (
      participant.role_slot === 'archivist'
        ? 0.92
        : Math.min(0.96, 0.2 + turnCount * 0.18 + keyMomentHits * 0.2 + lastRoundSpoken * 0.05)
    ));
    return {
      role,
      persona,
      turnCount,
      keyMomentHits,
      lastRoundSpoken,
      impactScore,
      fallbackCast: Boolean(participant.persona_snapshot_json?.fallback_cast) || (participant.role_slot === 'agent' && turnCount === 0),
    };
  }

  useEffect(() => {
    const preferredAgentId = selectedAgentIds[0] ?? null;
    if (preferredAgentId && targetableParticipants.some((participant) => participant.source_agent_id === preferredAgentId)) {
      setSelectedAgentId(preferredAgentId);
      return;
    }
    if (!selectedAgentId && targetableParticipants.length > 0) {
      setSelectedAgentId(targetableParticipants[0].source_agent_id ?? null);
    }
  }, [selectedAgentId, selectedAgentIds, targetableParticipants]);

  const participantsById = useMemo(
    () => new Map((snapshot?.participants ?? []).map((participant) => [participant.id, participant])),
    [snapshot?.participants],
  );

  const currentTurns = useMemo(() => {
    if (readOnly) {
      return fallbackMessages.map((message, index) => ({
        key: `${message.branch}-${message.round}-${message.agent_id}-${index}`,
        speaker: message.agent,
        phase: `R${message.round}`,
        content: message.message,
        participantId: null,
        roleSlot: null,
      }));
    }

    const defaultRoomTurns = (snapshot?.turns ?? []).filter((turn) => {
      if (turn.thread_id && defaultThreadId) {
        return turn.thread_id === defaultThreadId;
      }
      if (snapshot?.memory_partition_id && turn.memory_partition_id) {
        return turn.memory_partition_id === snapshot.memory_partition_id;
      }
      return !turn.thread_id;
    });
    const turns = activeThread?.mode === 'followup'
      ? (activeThread.turns.length > 0
        ? activeThread.turns
        : (snapshot?.turns ?? []).filter((turn) => turn.thread_id === activeThread.id))
      : defaultRoomTurns;
    return turns.map((turn) => {
      const participant = participantsById.get(turn.participant_id);
      return {
        key: turn.id,
        speaker: participant?.display_name
          ?? (turn.source === 'user_turn' ? (isZh ? '你' : 'You') : t('ending_room.participant_unknown')),
        phase: getEndingRoomPhaseLabel(turn.phase, t),
        content: turn.content,
        participantId: turn.participant_id,
        roleSlot: participant?.role_slot ?? (turn.source === 'user_turn' ? 'user' : null),
      };
    });
  }, [activeThread, defaultThreadId, fallbackMessages, isZh, participantsById, readOnly, snapshot?.turns, t]);

  const sortedDrafts = useMemo(
    () => Object.values(pendingDrafts).sort((left, right) => left.sequence - right.sequence),
    [pendingDrafts],
  );

  useEffect(() => {
    if (transcriptListRef.current) {
      transcriptListRef.current.scrollTop = transcriptListRef.current.scrollHeight;
    }
  }, [currentTurns.length, sortedDrafts.length]);

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
      turn_count: currentTurns.length,
      pending_draft_count: sortedDrafts.length,
      active_phase: snapshot?.current_phase ?? null,
      active_thread_id: activeThread?.id ?? null,
      thread_count: threads.length,
      interaction_mode: interactionMode,
      can_send: Boolean(!readOnly && result && snapshot?.id),
      sending,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [
    activeThread?.id,
    branch,
    currentTurns.length,
    interactionMode,
    onAutomationStateChange,
    open,
    readOnly,
    result,
    roomType,
    sending,
    snapshot?.current_phase,
    snapshot?.id,
    sortedDrafts.length,
    status,
    threads.length,
  ]);

  if (!open || !branch) {
    return null;
  }

  const storyText = branch.story || '—';
  const collapsedStory = storyText.length > 280 && !storyExpanded
    ? `${storyText.slice(0, 280)}…`
    : storyText;
  const composerEnabled = !readOnly && Boolean(result) && Boolean(snapshot?.id);
  const addressedAgentIds = interactionMode === 'hotseat' && selectedAgentId
    ? [selectedAgentId]
    : interactionMode === 'all_present'
      ? targetableParticipants
        .map((participant) => participant.source_agent_id)
        .filter((value): value is string => Boolean(value))
      : [];
  const anchorSuggestions = [
    ...(branch.key_moments?.slice(0, 3) ?? []).map((moment) => ({
      label: isZh ? '关键转折' : 'Key moment',
      value: isZh ? `为什么这里会转向：${moment}` : `Why did the worldline turn here: ${moment}`,
    })),
    {
      label: isZh ? '档案结论' : 'Archivist verdict',
      value: isZh
        ? `沿着当前结局继续追问：为什么这个结论会成立？`
        : 'Continue from this ending: why did this verdict hold?',
    },
  ];
  const transcriptSubtitle = activeThread
    ? scopeText(activeThread, scopeNotice, isZh)
    : (isZh ? '只基于当前世界线与当前桌面' : 'Only using the current worldline and room desk');

  const handleCreateThread = async () => {
    if (!snapshot?.id || readOnly) return;
    if (interactionMode === 'hotseat' && !selectedAgentId) return;
    const payload = interactionMode === 'hotseat' && selectedAgentId
      ? {
          title: participants.find((participant) => participant.source_agent_id === selectedAgentId)?.display_name ?? null,
          addressedAgentIds,
          interactionMode,
        }
      : {
          title: null,
          interactionMode: 'thread_followup' as EndingRoomInteractionMode,
        };
    const thread = await createThread(snapshot.id, payload);
    await loadThread(thread.id);
  };

  const handleSend = async () => {
    const content = composerDraft.trim();
    if (!content) return;
    if (interactionMode !== 'hotseat' && defaultThreadId && activeThread?.mode === 'followup') {
      setActiveThread(defaultThreadId);
    }
    if (interactionMode === 'hotseat' && selectedAgentId && snapshot?.id) {
      const activeThreadAgentId = activeThread?.addressed_agent_ids_json?.[0] ?? null;
      const needsDedicatedThread = !activeThread
        || activeThread.mode !== 'followup'
        || activeThread.interaction_mode !== 'hotseat'
        || activeThreadAgentId !== selectedAgentId;
      if (needsDedicatedThread) {
        const thread = await createThread(snapshot.id, {
          title: participants.find((participant) => participant.source_agent_id === selectedAgentId)?.display_name ?? null,
          addressedAgentIds,
          interactionMode: 'hotseat',
        });
        await loadThread(thread.id);
      }
    }
    await appendUserTurn({
      content,
      addressedAgentIds,
      interactionMode,
    });
  };

  return (
    <div className="ending-chat-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="ending-chat-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ending-chat-title"
        data-testid="ending-chat-modal"
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
              <div className="ending-chat-panel__heading">
                <h3>{t('result.story')}</h3>
                {storyText.length > 280 && (
                  <button
                    type="button"
                    className="ending-chat-inline-button"
                    onClick={() => setStoryExpanded((current) => !current)}
                  >
                    {storyExpanded ? (isZh ? '收起' : 'Collapse') : (isZh ? '展开' : 'Expand')}
                  </button>
                )}
              </div>
              <p>{collapsedStory}</p>
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

            <section className="ending-chat-panel">
              <div className="ending-chat-panel__heading">
                <h3>{isZh ? '当前参与者' : 'Current participants'}</h3>
                {!readOnly && snapshot?.id && (
                  <div className="ending-chat-panel__actions">
                    <button
                      type="button"
                      className="ending-chat-inline-button"
                      onClick={() => void handleCreateThread()}
                    >
                      {isZh ? '新建追问线程' : 'New thread'}
                    </button>
                  </div>
                )}
              </div>
              <div className="ending-chat-participant-strip">
                {participants.length === 0 && (
                  <div className="ending-chat-participant-empty">
                    {isZh
                      ? '当前世界线没有稳定的参与者 roster，已退回档案官独立复盘。'
                      : 'No stable worldline roster is available yet, so the chamber falls back to an Archivist-only debrief.'}
                  </div>
                )}
                {participants.map((participant) => {
                  const metrics = participantMetrics(participant);
                  const isSelected = selectedAgentId === participant.source_agent_id;
                  const hotseatSelectable = interactionMode === 'hotseat' && participant.source_agent_id;
                  return (
                    <button
                      key={participant.id}
                      type="button"
                      className={`ending-chat-participant-card ${hotseatSelectable && isSelected ? 'is-selected' : ''}`}
                      onClick={() => {
                        if (!hotseatSelectable) return;
                        setSelectedAgentId(participant.source_agent_id ?? null);
                      }}
                      disabled={!hotseatSelectable}
                    >
                      <img
                        className="ending-chat-participant-card__avatar"
                        src={participantSprite(participant)}
                        alt=""
                        aria-hidden="true"
                      />
                      <div className="ending-chat-participant-card__copy">
                        <strong>{participant.display_name}</strong>
                        <span>{metrics.role || roleLabel(participant, isZh)}</span>
                        {metrics.persona && <small>{metrics.persona}</small>}
                      </div>
                      <div className="ending-chat-participant-metrics">
                        <em>{isZh ? `影响 ${Math.round(metrics.impactScore * 100)}` : `Impact ${Math.round(metrics.impactScore * 100)}`}</em>
                        <em>{isZh ? `发言 ${metrics.turnCount}` : `${metrics.turnCount} turns`}</em>
                        <em>{isZh ? `转折 ${metrics.keyMomentHits}` : `${metrics.keyMomentHits} hinge hits`}</em>
                        {metrics.lastRoundSpoken > 0 && <em>{`R${metrics.lastRoundSpoken}`}</em>}
                      </div>
                      {metrics.fallbackCast && (
                        <span className="ending-chat-participant-flag">
                          Fallback cast
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

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
                <p>{transcriptSubtitle}</p>
              </div>
              <span className="ending-chat-note">
                {activeThread ? threadLabel(activeThread, isZh) : t('ending_room.loading')}
              </span>
            </div>

            {threads.length > 0 && (
              <div className="ending-chat-thread-rail" role="tablist" aria-label={isZh ? '追问线程' : 'Follow-up threads'}>
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`ending-chat-thread-chip ${(activeThread?.id ?? defaultThreadId) === thread.id ? 'is-active' : ''} ${thread.mode === 'room' ? 'is-room-thread' : ''} ${thread.interaction_mode === 'hotseat' ? 'is-hotseat-thread' : ''}`}
                    onClick={() => {
                      setActiveThread(thread.id);
                      setInteractionMode(thread.mode === 'followup' ? thread.interaction_mode : 'archivist_route');
                      setSelectedAgentId(thread.addressed_agent_ids_json?.[0] ?? null);
                      if (thread.mode === 'followup') {
                        void loadThread(thread.id);
                      }
                    }}
                  >
                    {thread.mode === 'room' && <span className="ending-chat-thread-chip__icon ending-chat-thread-chip__icon--archivist" aria-hidden="true" />}
                    {threadLabel(thread, isZh)}
                  </button>
                ))}
              </div>
            )}

            <div ref={transcriptListRef} className="ending-chat-transcript-list">
              {!readOnly && currentTurns.length === 0 && sortedDrafts.length === 0 && status === 'loading' && (
                <div className="ending-chat-empty-state">{t('ending_room.loading')}</div>
              )}
              {!readOnly && currentTurns.length === 0 && sortedDrafts.length === 0 && status !== 'loading' && (
                <div className="ending-chat-empty-state">
                  {readOnly ? t('ending_room.replay_readonly') : t('ending_room.empty')}
                </div>
              )}
              {currentTurns.map((message) => (
                <article
                  key={message.key}
                  className={`ending-chat-bubble ${message.participantId && currentTurns[currentTurns.length - 1]?.participantId === message.participantId ? 'is-current-speaker' : ''} ${message.roleSlot === 'archivist' ? 'is-archivist' : ''} ${message.roleSlot === 'user' ? 'is-user' : ''}`}
                >
                  <header>
                    {message.roleSlot === 'archivist' && <span className="ending-chat-bubble__icon ending-chat-bubble__icon--archivist" aria-hidden="true" />}
                    <strong>{message.speaker}</strong>
                    <span>{message.phase}</span>
                  </header>
                  <p>{message.content}</p>
                </article>
              ))}
              {(activeThread?.mode !== 'followup' ? sortedDrafts : []).map((draft) => (
                <article key={draft.turnId} className="ending-chat-bubble ending-chat-bubble--draft">
                  <header>
                    <strong>{participantsById.get(draft.participantId)?.display_name ?? t('ending_room.participant_unknown')}</strong>
                    <span>{getEndingRoomPhaseLabel(draft.phase, t)}</span>
                    <em className="ending-chat-draft-badge">{t('ending_room.draft_badge')}</em>
                  </header>
                  <p>{draft.content}</p>
                </article>
              ))}
            </div>

            <div className="ending-chat-composer">
              <div className="ending-chat-composer__row">
                <div className="ending-chat-mode-switch" role="group" aria-label={isZh ? '追问模式' : 'Follow-up mode'}>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'archivist_route' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('archivist_route')}
                    disabled={!composerEnabled}
                  >
                    {isZh ? '档案官路由' : 'Archivist route'}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'hotseat' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('hotseat')}
                    disabled={!composerEnabled}
                  >
                    {isZh ? '角色热座' : 'Hotseat'}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'all_present' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('all_present')}
                    disabled={!composerEnabled || targetableParticipants.length === 0}
                  >
                    {isZh ? '当前全员回应' : 'All present'}
                  </button>
                </div>
                <span className="ending-chat-scope-notice">{transcriptSubtitle}</span>
              </div>

              <div className="ending-chat-anchor-row">
                {anchorSuggestions.map((anchor) => (
                  <button
                    key={`${anchor.label}-${anchor.value}`}
                    type="button"
                    className="ending-chat-anchor-chip"
                    disabled={!composerEnabled}
                    onClick={() => setComposerDraft(anchor.value)}
                  >
                    <span>{anchor.label}</span>
                  </button>
                ))}
              </div>

              {interactionMode === 'hotseat' && targetableParticipants.length > 0 && (
                <div className="ending-chat-hotseat-row">
                  {targetableParticipants.map((participant) => (
                    <button
                      key={participant.id}
                      type="button"
                      className={`ending-chat-hotseat-pill ${selectedAgentId === participant.source_agent_id ? 'is-active' : ''}`}
                      onClick={() => setSelectedAgentId(participant.source_agent_id ?? null)}
                      disabled={!composerEnabled}
                    >
                      {participant.display_name}
                    </button>
                  ))}
                </div>
              )}

              <div className="ending-chat-composer__row">
                <textarea
                  className="ending-chat-composer__input"
                  value={composerDraft}
                  placeholder={isZh ? '继续追问这个结局为什么成立，或追问某位当前世界线参与者。' : 'Keep probing why this ending held, or question one participant from the current worldline.'}
                  onChange={(event) => setComposerDraft(event.target.value)}
                  disabled={!composerEnabled || sending}
                  rows={3}
                />
                <button
                  type="button"
                  className="ending-chat-send"
                  onClick={() => void handleSend()}
                  disabled={!composerEnabled || sending || composerDraft.trim().length === 0}
                >
                  {sending ? (isZh ? '发送中…' : 'Sending…') : (isZh ? '发送追问' : 'Send')}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
