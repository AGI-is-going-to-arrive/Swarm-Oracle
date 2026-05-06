import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type UIEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TypingIndicator } from './TypingIndicator';
import { copyText } from '../lib/copyText';
import { getEndingRoomModeLabel, getEndingRoomPhaseLabel, getEndingRoomStatusLabel } from '../lib/endingRoomLabels';
import {
  buildOracleTranscriptLayoutMap,
  captureTranscriptScrollSnapshot,
  computeBottomAnchoredScrollTop,
  summarizeOracleTranscriptLayout,
  type TranscriptScrollSnapshot,
} from '../lib/textLayout/oracleTranscriptLayout';
import {
  getGameplayProfileFrameSrc,
  type GameplayProfileId,
} from './gameplayCards';
import { useEndingRoomWS } from '../hooks/useEndingRoomWS';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import {
  type AnchorAction,
  type AnchorSummary,
  roleLabel,
  threadLabel,
  participantSprite,
  scopeText,
  getArchivistModeLabel,
  getHotseatModeLabel,
  getAllPresentModeLabel,
  getInteractionModeNote,
  buildEndingVerdictPrompt,
  buildEndingInsightPrompt,
  buildEndingAnchorId,
  buildEndingQuotePrompt,
  describeEndingAnchor,
  stripOracleReasoningText,
} from './endingChatHelpers';
import type {
  AgentMessage,
  EndingRoomInteractionMode,
  EndingRoomParticipant,
  EndingRoomPhase,
  EndingRoomResult,
  EndingRoomSnapshot,
  EndingRoomThreadSnapshot,
  EndingRoomType,
  StoryData,
} from '../types';

import { FactionBadge } from './FactionBadge';
import { SafeMarkdown } from './SafeMarkdown';
import { useFactionOverlay } from '../hooks/useFactionOverlay';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet';
import './EndingChatModal.css';

const EMPTY_SELECTED_BRANCH_IDS: string[] = [];
const EMPTY_SELECTED_AGENT_IDS: string[] = [];
const EMPTY_FALLBACK_MESSAGES: AgentMessage[] = [];

function shouldAlwaysShowBubbleActions(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || window.matchMedia('(hover: none), (pointer: coarse)').matches;
}

interface EndingChatModalProps {
  open: boolean;
  scenarioId: string;
  branch: StoryData['branches'][number] | null;
  roomType: EndingRoomType;
  selectedBranchIds?: string[];
  selectedAgentIds?: string[];
  language: 'zh' | 'en';
  readOnly: boolean;
  fallbackMessages?: AgentMessage[];
  galleryBranches?: StoryData['branches'];
  replayState?: {
    snapshot: EndingRoomSnapshot;
    result: EndingRoomResult | null;
    roomType?: EndingRoomType;
    scenarioId?: string;
    selectedBranchIds?: string[];
    activeThreadId?: string | null;
    selectedAgentIds?: string[];
  } | null;
  profileId?: GameplayProfileId | null;
  profileLabel?: string | null;
  profileHooks?: string[];
  headerActions?: ReactNode;
  onClose: () => void;
  onModeChange: (mode: 'ending_chamber' | 'one_move_only') => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

interface EndingChatRenderDraft {
  key: string;
  participantId: string | null;
  phase: EndingRoomPhase;
  content: string;
  variant: 'stream' | 'placeholder';
}

export default function EndingChatModal({
  open,
  scenarioId,
  branch,
  roomType,
  selectedBranchIds: selectedBranchIdsProp,
  selectedAgentIds: selectedAgentIdsProp,
  language,
  readOnly,
  fallbackMessages: fallbackMessagesProp,
  galleryBranches = [],
  replayState = null,
  profileId = null,
  profileLabel = null,
  profileHooks = [],
  headerActions = null,
  onClose,
  onModeChange,
  onAutomationStateChange,
}: EndingChatModalProps) {
  const { t } = useTranslation();
  const selectedBranchIds = selectedBranchIdsProp ?? EMPTY_SELECTED_BRANCH_IDS;
  const selectedAgentIds = selectedAgentIdsProp ?? EMPTY_SELECTED_AGENT_IDS;
  const fallbackMessages = fallbackMessagesProp ?? EMPTY_FALLBACK_MESSAGES;
  const modalRef = useRef<HTMLDivElement>(null);
  const transcriptListRef = useRef<HTMLDivElement>(null);
  const transcriptHydratedRef = useRef(false);
  const transcriptAutoStickRef = useRef(false);
  // Stable ref for automation callback — breaks the render loop caused by
  // onAutomationStateChange being recreated by the parent on every render.
  const automationCallbackRef = useRef(onAutomationStateChange);
  const lastAutomationJsonRef = useRef<string | null>(null);
  const transcriptScrollSnapshotRef = useRef<TranscriptScrollSnapshot | null>(null);
  const [storyExpanded, setStoryExpanded] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [replayActiveThreadId, setReplayActiveThreadId] = useState<string | null>(null);
  const [briefCopied, setBriefCopied] = useState(false);
  const [pendingQuestionAnchorIds, setPendingQuestionAnchorIds] = useState<string[]>([]);
  const [participantsExpanded, setParticipantsExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false);
  const [sheetContainer, setSheetContainer] = useState<HTMLElement | null>(null);
  const participantDetailsId = useId();
  const sidebarSheetId = useId();
  const threadRailId = useId();
  const threadPanelId = useId();
  const threadTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingThreadFocusIdRef = useRef<string | null>(null);
  const isZh = language === 'zh';
  const profileFrameSrc = profileId ? getGameplayProfileFrameSrc(profileId) : null;
  const syncTranscriptScrollSnapshot = (nextSnapshot: TranscriptScrollSnapshot | null) => {
    transcriptScrollSnapshotRef.current = nextSnapshot;
  };
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

  const effectiveRoomType = (readOnly && replayState?.snapshot
    ? replayState.snapshot.room_type
    : snapshot?.room_type) ?? roomType;
  const isCrosslineGallery = effectiveRoomType === 'crossline_gallery';
  const alwaysShowBubbleActions = shouldAlwaysShowBubbleActions();

  useEndingRoomWS(
    snapshot?.id,
    open && !readOnly && !isCrosslineGallery && Boolean(snapshot?.id) && status !== 'error',
  );

  const effectiveSnapshot = readOnly && replayState?.snapshot
    ? replayState.snapshot
    : snapshot;
  const effectiveResult = readOnly && replayState
    ? replayState.result
    : result;
  const branchId = branch?.id ?? '';
  const branchInsight = branch?.insight ?? '';
  const effectiveThreadsById = useMemo(() => {
    if (!readOnly || !replayState?.snapshot) {
      return threadsById;
    }
    return replayState.snapshot.threads.reduce<Record<string, EndingRoomThreadSnapshot>>((acc, thread) => {
      const turns = replayState.snapshot.turns
        .filter((turn) => {
          if (turn.thread_id) {
            return turn.thread_id === thread.id;
          }
          return thread.mode === 'room';
        })
        .sort((left, right) => left.sequence - right.sequence);
      acc[thread.id] = {
        ...thread,
        room_type: replayState.snapshot.room_type,
        room_title: replayState.snapshot.title,
        room_status: replayState.snapshot.status,
        language: replayState.snapshot.language,
        turns,
      };
      return acc;
    }, {});
  }, [readOnly, replayState, threadsById]);

  useEffect(() => {
    automationCallbackRef.current = onAutomationStateChange;
  }, [onAutomationStateChange]);

  useEffect(() => {
    automationCallbackRef.current = onAutomationStateChange;
  }, [onAutomationStateChange]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sidebarSheetOpen) {
        setSidebarSheetOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, sidebarSheetOpen]);

  // D-9: Sync sheet container from ref (avoids accessing ref during render)
  useEffect(() => {
    setSheetContainer(modalRef.current);
  }, [open]);

  // D-9: Track mobile breakpoint for sidebar sheet
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(max-width: 560px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    handler(mq);
    mq.addEventListener('change', handler as (e: MediaQueryListEvent) => void);
    return () => mq.removeEventListener('change', handler as (e: MediaQueryListEvent) => void);
  }, []);

  useEffect(() => {
    const resetTimerId = window.setTimeout(() => {
      setParticipantsExpanded(false);
      setSidebarSheetOpen(false);
    }, 0);
    return () => window.clearTimeout(resetTimerId);
  }, [branch?.id, open]);

  useEffect(() => {
    if (!open || !branch) {
      return;
    }
    const resetTimerId = window.setTimeout(() => {
      setStoryExpanded(false);
      setSelectedAgentId(null);
    }, 0);
    if (modalRef.current) {
      modalRef.current.scrollTop = 0;
    }
    if (readOnly) {
      reset();
      return () => window.clearTimeout(resetTimerId);
    }

    let cancelled = false;
    let bootstrapDelayTimer: number | null = null;
    reset();
    void openRoom(scenarioId, {
      roomType,
      anchorBranchId: branch.id,
      selectedBranchIds: selectedBranchIds.length > 0 ? selectedBranchIds : [branch.id],
      ...(selectedAgentIds.length > 0 ? { selectedAgentIds } : {}),
      language,
    }).then(async (roomId) => {
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        bootstrapDelayTimer = window.setTimeout(() => {
          bootstrapDelayTimer = null;
          resolve();
        }, 150);
      });
      if (cancelled) return;
      await loadRoom(roomId);
    }).catch(() => {
      // Store already captures the localized error state.
    });

    return () => {
      window.clearTimeout(resetTimerId);
      cancelled = true;
      if (bootstrapDelayTimer !== null) {
        window.clearTimeout(bootstrapDelayTimer);
      }
    };
  }, [branch, language, loadRoom, open, openRoom, readOnly, reset, roomType, scenarioId, selectedAgentIds, selectedBranchIds]);

  const finalResultSyncRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || readOnly || !snapshot?.id) {
      finalResultSyncRef.current = null;
      return;
    }
    if (result || snapshot.status !== 'done') {
      finalResultSyncRef.current = null;
      return;
    }
    if (finalResultSyncRef.current === snapshot.id) {
      return;
    }
    finalResultSyncRef.current = snapshot.id;
    void loadRoom(snapshot.id);
  }, [loadRoom, open, readOnly, result, snapshot?.id, snapshot?.status]);

  const defaultThreadId = useMemo(
    () => effectiveSnapshot?.threads.find((thread) => thread.mode === 'room')?.id ?? effectiveSnapshot?.threads[0]?.id ?? null,
    [effectiveSnapshot?.threads],
  );
  const effectiveActiveThreadId = readOnly && replayState
    ? (replayActiveThreadId ?? replayState.activeThreadId ?? defaultThreadId)
    : activeThreadId;

  const activeThread = useMemo(
    () => (effectiveActiveThreadId ? effectiveThreadsById[effectiveActiveThreadId] : null)
      ?? (defaultThreadId ? effectiveThreadsById[defaultThreadId] : null)
      ?? null,
    [defaultThreadId, effectiveActiveThreadId, effectiveThreadsById],
  );

  const activeThreadSelectionId = activeThread?.id ?? defaultThreadId;

  useLayoutEffect(() => {
    if (!pendingThreadFocusIdRef.current) return;
    const targetId = pendingThreadFocusIdRef.current;
    threadTabRefs.current[targetId]?.focus();
    if (activeThreadSelectionId === targetId) {
      pendingThreadFocusIdRef.current = null;
    }
  }, [activeThreadSelectionId]);

  const threads = useMemo(() => {
    const order = readOnly && replayState?.snapshot
      ? replayState.snapshot.threads.map((thread) => thread.id)
      : threadOrder;
    return order.map((threadId) => effectiveThreadsById[threadId]).filter(Boolean);
  }, [effectiveThreadsById, readOnly, replayState, threadOrder]);

  const participants = useMemo(
    () => (effectiveSnapshot?.participants ?? []).filter((participant) => participant.role_slot !== 'user'),
    [effectiveSnapshot?.participants],
  );

  const targetableParticipants = useMemo(
    () => participants.filter((participant) => participant.role_slot !== 'archivist' && participant.source_agent_id),
    [participants],
  );

  const speakerIndexMap = useMemo(() => {
    const seen = new Map<string, number>();
    let idx = 0;
    for (const p of participants) {
      if (!seen.has(p.display_name)) {
        seen.set(p.display_name, idx++);
      }
    }
    return seen;
  }, [participants]);
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
    const replayTurns = readOnly && replayState?.snapshot
      ? replayState.snapshot.turns.filter((turn) => turn.participant_id === participant.id)
      : [];
    const relatedMessages = replayTurns.length > 0
      ? replayTurns.map((turn) => ({
          round: turn.sequence,
          message: turn.content,
        }))
      : (
        participant.source_agent_id
          ? fallbackMessages.filter((message) => message.agent_id === participant.source_agent_id)
          : []
      );
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
    const currentStillValid = selectedAgentId
      ? targetableParticipants.some((participant) => participant.source_agent_id === selectedAgentId)
      : false;
    if (currentStillValid) {
      return;
    }
    const preferredAgentId = replayState?.selectedAgentIds?.[0] ?? selectedAgentIds[0] ?? null;
    let nextSelectedAgentId: string | null = null;
    if (preferredAgentId && targetableParticipants.some((participant) => participant.source_agent_id === preferredAgentId)) {
      nextSelectedAgentId = preferredAgentId;
    } else if (targetableParticipants.length > 0) {
      nextSelectedAgentId = targetableParticipants[0].source_agent_id ?? null;
    } else if (selectedAgentId === null) {
      return;
    }
    const syncTimerId = window.setTimeout(() => {
      setSelectedAgentId(nextSelectedAgentId);
    }, 0);
    return () => window.clearTimeout(syncTimerId);
  }, [replayState?.selectedAgentIds, selectedAgentId, selectedAgentIds, targetableParticipants]);

  const participantsById = useMemo(
    () => new Map((effectiveSnapshot?.participants ?? []).map((participant) => [participant.id, participant])),
    [effectiveSnapshot?.participants],
  );

  // P1-8: Faction overlay — call hook internally with branch from props
  const { enabled: factionsEnabled } = useCapabilityCheck('factions');
  const factionMap = useFactionOverlay(scenarioId, branch?.id, participantsById, factionsEnabled);

  const currentTurns = (() => {
    if (readOnly && replayState?.snapshot) {
      const defaultRoomTurns = (effectiveSnapshot?.turns ?? []).filter((turn) => {
        if (turn.thread_id && defaultThreadId) {
          return turn.thread_id === defaultThreadId;
        }
        if (effectiveSnapshot?.memory_partition_id && turn.memory_partition_id) {
          return turn.memory_partition_id === effectiveSnapshot.memory_partition_id;
        }
        return !turn.thread_id;
      });
      const replayTurns = activeThread?.turns.length
        ? activeThread.turns
        : activeThread?.mode === 'followup'
          ? (effectiveSnapshot?.turns ?? []).filter((turn) => turn.thread_id === activeThread.id)
          : defaultRoomTurns;
      return replayTurns.map((turn) => {
        const participant = participantsById.get(turn.participant_id);
        return {
          key: turn.id,
          speaker: participant?.display_name
            ?? (turn.source === 'user_turn' ? (isZh ? '你' : 'You') : t('ending_room.participant_unknown')),
          phase: getEndingRoomPhaseLabel(turn.phase, t),
          content: turn.source === 'user_turn' ? turn.content : stripOracleReasoningText(turn.content),
          participantId: turn.participant_id,
          roleSlot: participant?.role_slot ?? (turn.source === 'user_turn' ? 'user' : null),
        };
      });
    }
    if (readOnly) {
      return fallbackMessages.map((message, index) => ({
        key: `${message.branch}-${message.round}-${message.agent_id}-${index}`,
        speaker: message.agent,
        phase: `R${message.round}`,
        content: stripOracleReasoningText(message.message),
        participantId: null,
        roleSlot: null,
      }));
    }

    const defaultRoomTurns = (snapshot?.turns ?? []).filter((turn) => {
      if (turn.thread_id && defaultThreadId) {
        return turn.thread_id === defaultThreadId;
      }
      if (effectiveSnapshot?.memory_partition_id && turn.memory_partition_id) {
        return turn.memory_partition_id === effectiveSnapshot.memory_partition_id;
      }
      return !turn.thread_id;
    });
    const turns = activeThread?.turns.length
      ? activeThread.turns
      : activeThread?.mode === 'followup'
        ? (snapshot?.turns ?? []).filter((turn) => turn.thread_id === activeThread.id)
        : defaultRoomTurns;
    return turns.map((turn) => {
      const participant = participantsById.get(turn.participant_id);
      return {
        key: turn.id,
        speaker: participant?.display_name
          ?? (turn.source === 'user_turn' ? (isZh ? '你' : 'You') : t('ending_room.participant_unknown')),
        phase: getEndingRoomPhaseLabel(turn.phase, t),
        content: turn.source === 'user_turn' ? turn.content : stripOracleReasoningText(turn.content),
        participantId: turn.participant_id,
        roleSlot: participant?.role_slot ?? (turn.source === 'user_turn' ? 'user' : null),
      };
    });
  })();

  const sortedDrafts = useMemo(
    () => Object.values(pendingDrafts).sort((left, right) => left.sequence - right.sequence),
    [pendingDrafts],
  );
  const visibleDrafts = (() => {
    if (readOnly) return [];
    const targetThreadId = activeThread?.id ?? defaultThreadId;
    if (!targetThreadId) return sortedDrafts;
    if (activeThread?.mode === 'followup') {
      return sortedDrafts.filter((draft) => draft.threadId === activeThread.id);
    }
    return sortedDrafts.filter((draft) => draft.threadId === targetThreadId);
  })();

  const effectiveInteractionMode = readOnly
    ? (activeThread?.mode === 'followup' ? activeThread.interaction_mode : 'archivist_route')
    : interactionMode;
  const composerEnabled = !readOnly && !isCrosslineGallery && Boolean(effectiveResult) && Boolean(effectiveSnapshot?.id);
  const selectedHotseatParticipant = targetableParticipants.find(
    (participant) => participant.source_agent_id === selectedAgentId,
  ) ?? null;
  const displayedDrafts = useMemo<EndingChatRenderDraft[]>(
    () => {
      if (visibleDrafts.length > 0) {
        return visibleDrafts.map((draft) => {
          const sanitizedContent = stripOracleReasoningText(draft.content);
          return {
            key: draft.turnId,
            participantId: draft.participantId,
            phase: draft.phase,
            content: sanitizedContent.trim()
              ? sanitizedContent
              : (
                effectiveInteractionMode === 'hotseat'
                  ? (isZh ? '当前点名角色正在组织回应…' : 'The targeted role is lining up a reply…')
                  : effectiveInteractionMode === 'all_present'
                    ? (isZh ? '当前阵容正在接力回应…' : 'The current lineup is responding in sequence…')
                    : (isZh ? '档案官正在组织最相关的回应…' : 'The Archivist is routing the most relevant reply…')
              ),
            variant: sanitizedContent.trim() ? 'stream' : 'placeholder',
          };
        });
      }
      if (readOnly || !sending || !composerEnabled) {
        return [];
      }
      const activeThreadTurns = activeThread?.turns;
      const placeholderParticipantId = effectiveInteractionMode === 'hotseat'
        ? (selectedHotseatParticipant?.id ?? null)
        : participants.find((participant) => participant.role_slot === 'archivist')?.id
          ?? participants[0]?.id
          ?? null;
      const placeholderContent = effectiveInteractionMode === 'hotseat'
        ? (isZh ? '当前点名角色正在组织回应…' : 'The targeted role is lining up a reply…')
        : effectiveInteractionMode === 'all_present'
          ? (isZh ? '当前阵容正在接力回应…' : 'The current lineup is responding in sequence…')
          : (isZh ? '档案官正在组织最相关的回应…' : 'The Archivist is routing the most relevant reply…');
      const latestActiveTurn = activeThreadTurns && activeThreadTurns.length > 0
        ? activeThreadTurns[activeThreadTurns.length - 1]
        : undefined;
      return [
        {
          key: '__local-pending__',
          participantId: placeholderParticipantId,
          phase: latestActiveTurn?.phase
            ?? effectiveSnapshot?.current_phase
            ?? 'verdict',
          content: placeholderContent,
          variant: 'placeholder',
        },
      ];
    },
    [
      activeThread?.turns,
      composerEnabled,
      effectiveInteractionMode,
      effectiveSnapshot?.current_phase,
      isZh,
      participants,
      readOnly,
      selectedHotseatParticipant?.id,
      sending,
      visibleDrafts,
    ],
  );
  const latestDisplayedDraft = displayedDrafts[displayedDrafts.length - 1];
  const latestCurrentTurn = currentTurns[currentTurns.length - 1];
  const currentSpeakerTurnKey = latestDisplayedDraft?.key ?? latestCurrentTurn?.key ?? null;
  const currentSpeakerParticipantId = latestDisplayedDraft?.participantId
    ?? latestCurrentTurn?.participantId
    ?? null;
  const handleThreadSelect = (threadId: string) => {
    const thread = effectiveThreadsById[threadId];
    if (!thread) return;
    if (readOnly) {
      setReplayActiveThreadId(thread.id);
    } else {
      setActiveThread(thread.id);
      setInteractionMode(thread.mode === 'followup' ? thread.interaction_mode : 'archivist_route');
    }
    setSelectedAgentId(thread.addressed_agent_ids_json?.[0] ?? null);
    if (!readOnly && thread.mode === 'followup') {
      void loadThread(thread.id);
    }
  };
  const handleThreadRailKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (threads.length < 2) return;
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % threads.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + threads.length) % threads.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = threads.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextThread = threads[nextIndex];
    if (!nextThread) return;
    pendingThreadFocusIdRef.current = nextThread.id;
    handleThreadSelect(nextThread.id);
  };
  const automationPendingDrafts = useMemo(
    () => displayedDrafts.map((draft) => ({
      turn_key: draft.key,
      participant_id: draft.participantId,
      phase: draft.phase,
      variant: draft.variant,
      content_length: draft.content.trim().length,
    })),
    [displayedDrafts],
  );
  const automationStreamState = automationPendingDrafts.length === 0
    ? null
    : automationPendingDrafts.some((draft) => draft.variant === 'stream')
      ? 'turn_delta'
      : 'turn_start';
  const currentTurnSignature = useMemo(
    () => currentTurns.map((turn) => `${turn.key}:${turn.content.length}`).join('|'),
    [currentTurns],
  );
  const displayedDraftSignature = useMemo(
    () => displayedDrafts.map((draft) => `${draft.key}:${draft.content.length}`).join('|'),
    [displayedDrafts],
  );
  const transcriptLocale = isZh ? 'zh' : 'en';
  const transcriptBubbleLayouts = useMemo(
    () => buildOracleTranscriptLayoutMap(
      currentTurns.map((turn) => ({ key: turn.key, content: turn.content })),
      'ending_turn',
      transcriptLocale,
    ),
    [currentTurns, transcriptLocale],
  );
  const transcriptDraftLayouts = useMemo(
    () => buildOracleTranscriptLayoutMap(
      displayedDrafts.map((draft) => ({ key: draft.key, content: draft.content })),
      'ending_draft',
      transcriptLocale,
    ),
    [displayedDrafts, transcriptLocale],
  );
  const threadDisplayLabels = useMemo(() => {
    const seen = new Map<string, number>();
    const labels: Record<string, string> = {};
    for (const thread of threads) {
      const base = threadLabel(thread, isZh);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      labels[thread.id] = count === 1
        ? base
        : `${base}${isZh ? ` · 线程 ${count}` : ` · Thread ${count}`}`;
    }
    return labels;
  }, [isZh, threads]);
  const threadAnchorSummaries = useMemo(
    () => threads.reduce<Record<string, AnchorSummary>>((acc, thread) => {
      const summary = describeEndingAnchor(
        thread.question_anchor_ids_json,
        isZh,
        branch?.key_moments ?? [],
        thread.turns.map((turn) => ({ key: turn.id, content: turn.content })),
      );
      if (summary) {
        acc[thread.id] = summary;
      }
      return acc;
    }, {}),
    [branch?.key_moments, isZh, threads],
  );
  const activeThreadAnchorSummary = useMemo(
    () => (activeThread ? threadAnchorSummaries[activeThread.id] ?? null : null),
    [activeThread, threadAnchorSummaries],
  );

  useEffect(() => {
    const syncTimerId = window.setTimeout(() => {
      setReplayActiveThreadId(replayState?.activeThreadId ?? null);
    }, 0);
    return () => window.clearTimeout(syncTimerId);
  }, [replayState?.activeThreadId, replayState?.snapshot?.id]);

  useEffect(() => {
    transcriptHydratedRef.current = false;
    transcriptAutoStickRef.current = false;
    transcriptScrollSnapshotRef.current = null;
  }, [activeThread?.id, effectiveSnapshot?.id]);

  useLayoutEffect(() => {
    const transcriptList = transcriptListRef.current;
    if (!transcriptList) return;
    const visibleTurnCount = currentTurns.length + displayedDrafts.length;
    if (visibleTurnCount === 0) {
      transcriptHydratedRef.current = false;
      transcriptAutoStickRef.current = false;
      syncTranscriptScrollSnapshot(captureTranscriptScrollSnapshot(transcriptList));
      return;
    }
    if (!transcriptHydratedRef.current) {
      transcriptHydratedRef.current = true;
      transcriptList.scrollTop = 0;
      syncTranscriptScrollSnapshot(captureTranscriptScrollSnapshot(transcriptList));
      return;
    }
    if (displayedDrafts.length > 0 || transcriptAutoStickRef.current) {
      transcriptList.scrollTop = computeBottomAnchoredScrollTop(
        transcriptList,
        transcriptScrollSnapshotRef.current,
      );
      if (displayedDrafts.length === 0) {
        transcriptAutoStickRef.current = false;
      }
    }
    syncTranscriptScrollSnapshot(captureTranscriptScrollSnapshot(transcriptList));
  }, [activeThread?.id, currentTurnSignature, currentTurns.length, displayedDraftSignature, displayedDrafts.length, effectiveSnapshot?.id]);

  useEffect(() => {
    if (!open || !branch) {
      if (lastAutomationJsonRef.current !== null) {
        lastAutomationJsonRef.current = null;
        automationCallbackRef.current?.(null);
      }
      return;
    }

    const transcriptLayoutTelemetry = summarizeOracleTranscriptLayout(
      transcriptBubbleLayouts,
      transcriptDraftLayouts,
      transcriptScrollSnapshotRef.current,
    );
    const nextState = {
      kind: 'ending_room_modal',
      branch_id: branch.id,
      room_id: effectiveSnapshot?.id ?? null,
      room_type: effectiveSnapshot?.room_type ?? roomType,
      read_only: readOnly,
      read_only_source: readOnly
        ? (replayState?.snapshot ? 'ending_room_replay' : 'scenario_replay')
        : 'live',
      status: readOnly ? 'done' : status,
      has_result: Boolean(effectiveResult),
      turn_count: currentTurns.length,
      pending_draft_count: displayedDrafts.length,
      active_phase: effectiveSnapshot?.current_phase ?? null,
      active_thread_id: activeThread?.id ?? null,
      thread_count: threads.length,
      interaction_mode: effectiveInteractionMode,
      current_speaker_turn_key: currentSpeakerTurnKey,
      current_speaker_participant_id: currentSpeakerParticipantId,
      question_anchor_ids: activeThread?.question_anchor_ids_json ?? [],
      thread_question_anchor_ids_json: activeThread?.question_anchor_ids_json ?? [],
      pending_question_anchor_ids: pendingQuestionAnchorIds,
      pending_drafts: automationPendingDrafts,
      stream_state: automationStreamState,
      anchor_kind: activeThreadAnchorSummary?.kind ?? null,
      anchor_kind_label: activeThreadAnchorSummary?.kindLabel ?? null,
      anchor_label: activeThreadAnchorSummary?.label ?? null,
      transcript_layout: transcriptLayoutTelemetry,
      can_send: Boolean(composerEnabled),
      can_share_replay: Boolean(effectiveSnapshot?.id && effectiveResult),
      can_import_replay: Boolean(readOnly && replayState?.snapshot),
      sending,
    };
    const nextJson = JSON.stringify(nextState);
    if (nextJson === lastAutomationJsonRef.current) {
      return;
    }
    lastAutomationJsonRef.current = nextJson;
    automationCallbackRef.current?.(nextState);

    return () => {
      automationCallbackRef.current?.(null);
    };
  }, [
    activeThread?.id,
    branch,
    composerEnabled,
    currentSpeakerParticipantId,
    currentSpeakerTurnKey,
    currentTurns.length,
    displayedDrafts.length,
    effectiveInteractionMode,
    interactionMode,
    automationPendingDrafts,
    automationStreamState,
    open,
    readOnly,
    effectiveResult,
    replayState?.snapshot,
    roomType,
    sending,
    effectiveSnapshot?.current_phase,
    effectiveSnapshot?.id,
    effectiveSnapshot?.room_type,
    pendingQuestionAnchorIds,
    status,
    threads.length,
    activeThread?.question_anchor_ids_json,
    activeThreadAnchorSummary,
    transcriptBubbleLayouts,
    transcriptDraftLayouts,
  ]);
  const transcriptSubtitle = activeThread
    ? scopeText(activeThread, scopeNotice, isZh)
    : (isZh ? '只基于当前世界线与当前桌面' : 'Only using the current worldline and room desk');

  const verdictPrompt = buildEndingVerdictPrompt(effectiveResult?.summary ?? '', isZh);
  const insightPrompt = branchInsight ? buildEndingInsightPrompt(branchInsight, isZh) : '';
  const verdictAnchorAction: AnchorAction = {
    anchorIds: [buildEndingAnchorId('verdict', branchId)],
    prompt: verdictPrompt,
    threadTitle: null,
  };
  const insightAnchorAction: AnchorAction | null = branchInsight
    ? {
        anchorIds: [buildEndingAnchorId('insight', branchId)],
        prompt: insightPrompt,
        threadTitle: null,
      }
    : null;
  const keyMomentAnchorActions: AnchorAction[] = branchKeyMoments.slice(0, 3).map((moment, index) => ({
    anchorIds: [buildEndingAnchorId('key_moment', branchId, index)],
    prompt: isZh ? `为什么这里会转向：${moment}` : `Why did the worldline turn here: ${moment}`,
    threadTitle: isZh ? '关键转折' : 'Key moment',
  }));
  const anchorSuggestions = [
    ...keyMomentAnchorActions.map((action) => ({
      label: isZh ? '关键转折' : 'Key moment',
      action,
    })),
    {
      label: isZh ? '档案结论' : 'Archivist verdict',
      action: verdictAnchorAction,
    },
  ];
  const meetingBrief = !branch ? '' : (() => {
    const lines = [
      `# ${branch.title}`,
      '',
      isZh ? '## 当前范围' : '## Scope',
      transcriptSubtitle,
    ];
    if (effectiveResult?.summary) {
      lines.push('', isZh ? '## 档案结论' : '## Archivist Verdict', effectiveResult.summary);
    }
    if (effectiveResult?.next_move && effectiveResult.next_move !== effectiveResult.summary) {
      lines.push('', isZh ? '## 只改一步' : '## One Move Only', effectiveResult.next_move);
    }
    if (branch.insight) {
      lines.push('', isZh ? '## 当前洞察' : '## Current Insight', branch.insight);
    }
    if ((branch.key_moments?.length ?? 0) > 0) {
      lines.push('', isZh ? '## 关键转折' : '## Key Moments');
      (branch.key_moments ?? []).slice(0, 3).forEach((moment) => {
        lines.push(`- ${moment}`);
      });
    }
    return lines.join('\n');
  })();

  if (!open || !branch) {
    return null;
  }

  const storyText = branch.story || '—';
  const collapsedStory = storyText.length > 280 && !storyExpanded
    ? `${storyText.slice(0, 280)}…`
    : storyText;
  const addressedAgentIds = interactionMode === 'hotseat' && selectedAgentId
    ? [selectedAgentId]
    : interactionMode === 'all_present'
      ? targetableParticipants
        .map((participant) => participant.source_agent_id)
        .filter((value): value is string => Boolean(value))
      : [];
  const galleryCards = galleryBranches
    .filter((candidate) => candidate.id !== branch.id)
    .sort((left, right) => right.probability - left.probability);
  const transcriptTitle = isCrosslineGallery ? t('roundtable.gallery_title') : t('ending_room.transcript_title');
  const transcriptHeaderCopy = isCrosslineGallery ? t('roundtable.gallery_hint') : transcriptSubtitle;
  const transcriptHeaderNote = isCrosslineGallery
    ? t('ending_room.foreign_summary_badge')
    : (activeThread ? (threadDisplayLabels[activeThread.id] ?? threadLabel(activeThread, isZh)) : t('ending_room.loading'));
  const interactionModeNote = readOnly
    ? t('ending_room.replay_readonly')
    : getInteractionModeNote(effectiveInteractionMode, isZh, selectedHotseatParticipant?.display_name ?? null);

  const handleCopyBrief = async () => {
    if (!meetingBrief) return;
    await copyText(meetingBrief);
    setBriefCopied(true);
    window.setTimeout(() => setBriefCopied(false), 1800);
  };

  const activateAnchor = (action: AnchorAction) => {
    setComposerDraft(action.prompt);
    setPendingQuestionAnchorIds(action.anchorIds);
  };

  const handleStartAnchoredThread = async (action: AnchorAction) => {
    if (!snapshot?.id || readOnly || isCrosslineGallery) return;
    const thread = await createThread(snapshot.id, {
      title: action.threadTitle ?? null,
      questionAnchorIds: action.anchorIds,
      interactionMode: 'thread_followup',
    });
    setActiveThread(thread.id);
    setInteractionMode('thread_followup');
    await loadThread(thread.id);
    activateAnchor(action);
  };

  const handleFollowQuote = (anchorId: string, speaker: string, content: string) => {
    activateAnchor({
      anchorIds: [anchorId],
      prompt: buildEndingQuotePrompt(speaker, content, isZh),
      threadTitle: speaker,
    });
  };

  const handleQuoteThread = async (anchorId: string, speaker: string, content: string) => {
    await handleStartAnchoredThread({
      anchorIds: [anchorId],
      prompt: buildEndingQuotePrompt(speaker, content, isZh),
      threadTitle: speaker,
    });
  };

  const handleCreateThread = async () => {
    if (!snapshot?.id || readOnly || isCrosslineGallery) return;
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
    if (isCrosslineGallery) return;
    const content = composerDraft.trim();
    if (!content) return;
    const transcriptList = transcriptListRef.current;
    transcriptScrollSnapshotRef.current = transcriptList
      ? {
          ...captureTranscriptScrollSnapshot(transcriptList),
          bottomOffset: 0,
        }
      : transcriptScrollSnapshotRef.current;
    transcriptAutoStickRef.current = true;
    if ((interactionMode === 'archivist_route' || interactionMode === 'all_present') && defaultThreadId && activeThread?.mode === 'followup') {
      setActiveThread(defaultThreadId);
    }
    if (interactionMode === 'hotseat' && selectedAgentId && snapshot?.id) {
      const activeThreadAgentId = activeThread?.addressed_agent_ids_json?.[0] ?? null;
      const existingHotseatThread = threads.find((thread) => (
        thread.mode === 'followup'
        && thread.interaction_mode === 'hotseat'
        && thread.addressed_agent_ids_json?.includes(selectedAgentId)
      ));
      const needsDedicatedThread = !activeThread
        || activeThread.mode !== 'followup'
        || activeThread.interaction_mode !== 'hotseat'
        || activeThreadAgentId !== selectedAgentId;
      if (needsDedicatedThread) {
        if (existingHotseatThread) {
          setActiveThread(existingHotseatThread.id);
          await loadThread(existingHotseatThread.id);
        } else {
          const thread = await createThread(snapshot.id, {
            title: participants.find((participant) => participant.source_agent_id === selectedAgentId)?.display_name ?? null,
            addressedAgentIds,
            questionAnchorIds: pendingQuestionAnchorIds,
            interactionMode: 'hotseat',
          });
          await loadThread(thread.id);
        }
      }
    }
    await appendUserTurn({
      content,
      addressedAgentIds,
      questionAnchorIds: pendingQuestionAnchorIds,
      interactionMode,
    });
    setPendingQuestionAnchorIds([]);
  };

  const handleTranscriptScroll = (event: UIEvent<HTMLDivElement>) => {
    syncTranscriptScrollSnapshot(captureTranscriptScrollSnapshot(event.currentTarget));
  };

  return (
    <div className="ending-chat-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className={`ending-chat-modal ${profileId ? `oracle-skin oracle-skin--${profileId}` : ''}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ending-chat-title"
        data-testid="ending-chat-modal"
        data-profile={profileId ?? undefined}
        style={
          profileFrameSrc
            ? ({ '--oracle-profile-frame': `url(${profileFrameSrc})` } as CSSProperties)
            : undefined
        }
      >
        <header className="ending-chat-header">
          <div>
            <p className="ending-chat-kicker">{t('ending_room.title')}</p>
            <h2 id="ending-chat-title" className="ending-chat-title">{branch.title}</h2>
            <div className="ending-chat-meta-row">
              <span className="ending-chat-badge ending-chat-badge--primary">
                {getEndingRoomModeLabel(effectiveRoomType, t)}
              </span>
              <span className="ending-chat-badge">
                {getEndingRoomStatusLabel(readOnly ? 'done' : (effectiveSnapshot?.status ?? (status === 'loading' ? 'draft' : 'error')), t)}
              </span>
              <span className="ending-chat-badge">{t('ending_room.current_branch_badge')}</span>
              <span className="ending-chat-probability">{((branch.probability ?? 0) * 100).toFixed(1)}%</span>
              {profileLabel && (
                <span className="ending-chat-badge ending-chat-badge--profile">{profileLabel}</span>
              )}
            </div>
            {profileHooks.length > 0 && (
              <div className="ending-chat-theme-strip" aria-label={isZh ? '题材提示' : 'Theme cues'}>
                {profileHooks.slice(0, 2).map((hook) => (
                  <span key={hook} className="ending-chat-theme-chip">{hook}</span>
                ))}
              </div>
            )}
          </div>
          <div className="ending-chat-header__actions">
            {headerActions}
            <button
              type="button"
              className="ending-chat-sidebar-sheet-trigger"
              aria-controls={sidebarSheetId}
              aria-expanded={sidebarSheetOpen}
              aria-haspopup="dialog"
              onClick={() => setSidebarSheetOpen(true)}
            >
              {t('ending_room.sidebar_mobile_label')}
            </button>
            <button type="button" className="ending-chat-close" onClick={onClose} aria-label={t('common.close')}>
              ×
            </button>
          </div>
        </header>

        {!readOnly && !isCrosslineGallery && (
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
        )}

        <div className="ending-chat-body">
          {(() => {
            const sidebarContent = (
              <>
                {isCrosslineGallery ? (
                  <section className="ending-chat-panel ending-chat-panel--notice">
                    <div className="ending-chat-panel__heading">
                      <h3>{t('roundtable.gallery_title')}</h3>
                    </div>
                    <p>{t('roundtable.gallery_hint')}</p>
                  </section>
                ) : (
                  <>
                    {/* D-7: Verdict panel moved before participants */}
                    {effectiveResult && (
                      <section className="ending-chat-panel ending-chat-panel--summary">
                        <div className="ending-chat-panel__heading">
                          <h3>{t('roundtable.phase_verdict')}</h3>
                          <div className="ending-chat-panel__actions">
                            {!readOnly && (
                              <>
                                <button
                                  type="button"
                                  className="ending-chat-inline-button"
                                  onClick={() => activateAnchor(verdictAnchorAction)}
                                  disabled={!composerEnabled}
                                >
                                  {t('ending_room.action_continue')}
                                </button>
                                <button
                                  type="button"
                                  className="ending-chat-inline-button"
                                  onClick={() => void handleStartAnchoredThread(verdictAnchorAction)}
                                  disabled={!composerEnabled}
                                >
                                  {t('ending_room.action_new_thread')}
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className="ending-chat-inline-button"
                              onClick={() => void handleCopyBrief()}
                              disabled={!meetingBrief}
                            >
                              {briefCopied ? t('ending_room.action_brief_copied') : t('ending_room.action_copy_brief')}
                            </button>
                            {composerEnabled && (
                              <button
                                type="button"
                                className={`ending-chat-inline-button ${isMobile ? 'ending-chat-epilogue-btn--summary' : 'ending-chat-epilogue-btn'}`}
                                onClick={() => {
                                  setComposerDraft(t('ending_room.epilogue_prompt'));
                                  setInteractionMode('epilogue');
                                }}
                                title={t('ending_room.epilogue_hint')}
                              >
                                {t('ending_room.action_epilogue')}
                              </button>
                            )}
                          </div>
                        </div>
                        <p>{effectiveResult.summary}</p>
                        {effectiveResult.next_move && effectiveResult.next_move !== effectiveResult.summary && (
                          <>
                            <h4>{t('ending_room.mode_one_move_only')}</h4>
                            <p>{effectiveResult.next_move}</p>
                          </>
                        )}
                      </section>
                    )}

                    <section className="ending-chat-panel">
                      <div className="ending-chat-panel__heading">
                        <h3>{isZh ? '当前参与者' : 'Current participants'}</h3>
                        {!readOnly && effectiveSnapshot?.id && (
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
                      <div
                        id={participantDetailsId}
                        className={`ending-chat-participant-strip ${!participantsExpanded ? 'ending-chat-participant-strip--collapsed' : ''}`}
                      >
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
                          const isCurrentSpeaker = currentSpeakerParticipantId === participant.id;
                          const isHotseatFocus = effectiveInteractionMode === 'hotseat' && isSelected;
                          return (
                            <button
                              key={participant.id}
                              type="button"
                              className={`ending-chat-participant-card ${hotseatSelectable && isSelected ? 'is-selected' : ''} ${isCurrentSpeaker ? 'is-current-speaker' : ''} ${isHotseatFocus ? 'is-hotseat-focus' : ''}`}
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
                                <strong>
                                  {participant.display_name}
                                  {isCurrentSpeaker && (
                                    <span className="ending-chat-participant-flag ending-chat-participant-flag--speaker">
                                      {isZh ? '正在发言' : 'Speaking'}
                                    </span>
                                  )}
                                  {!isCurrentSpeaker && isHotseatFocus && (
                                    <span className="ending-chat-participant-flag ending-chat-participant-flag--hotseat">
                                      {isZh ? '当前追问对象' : 'Current target'}
                                    </span>
                                  )}
                                </strong>
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
                                  {isZh ? '兜底阵容' : 'Fallback lineup'}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {participants.length > 0 && (
                        <button
                          type="button"
                          className="ending-chat-participant-expand-btn"
                          onClick={() => setParticipantsExpanded((v) => !v)}
                          aria-expanded={participantsExpanded}
                          aria-controls={participantDetailsId}
                        >
                          {participantsExpanded ? t('ending_room.collapse_details') : t('ending_room.expand_details')}
                        </button>
                      )}
                    </section>
                  </>
                )}

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
                    <div className="ending-chat-panel__heading">
                      <h3>{t('result.insight')}</h3>
                      {!readOnly && (
                        <div className="ending-chat-panel__actions">
                          <button
                            type="button"
                            className="ending-chat-inline-button"
                            onClick={() => {
                              if (!insightAnchorAction) return;
                              activateAnchor(insightAnchorAction);
                            }}
                            disabled={!composerEnabled}
                          >
                            {t('ending_room.action_follow_insight')}
                          </button>
                        </div>
                      )}
                    </div>
                    <blockquote>{branch.insight}</blockquote>
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
              </>
            );

            return (
              <>
                {/* D-9: Desktop inline sidebar */}
                <aside className="ending-chat-sidebar ending-chat-sidebar--inline">
                  {sidebarContent}
                </aside>

                {/* D-9: Mobile bottom sheet sidebar */}
                {(isMobile || sidebarSheetOpen) && (
                  <Sheet open={sidebarSheetOpen} onOpenChange={setSidebarSheetOpen}>
                    <SheetContent
                      id={sidebarSheetId}
                      side="bottom"
                      container={sheetContainer ?? undefined}
                      className="ending-chat-sidebar"
                      style={{ maxHeight: '70vh', overflowY: 'auto' }}
                    >
                      <SheetTitle className="sr-only">{t('ending_room.sidebar_mobile_label')}</SheetTitle>
                      <SheetDescription className="sr-only">
                        {t('ending_room.sidebar_mobile_description')}
                      </SheetDescription>
                      {sidebarContent}
                    </SheetContent>
                  </Sheet>
                )}
              </>
            );
          })()}

            <section
              className="ending-chat-transcript"
              id={threadPanelId}
              role={!isCrosslineGallery && threads.length > 0 ? 'tabpanel' : undefined}
              aria-labelledby={!isCrosslineGallery && threads.length > 0 && activeThreadSelectionId
                ? `${threadRailId}-${activeThreadSelectionId}`
                : undefined}
            >
              <div className="ending-chat-transcript-header">
                <div>
                  <h3>{transcriptTitle}</h3>
                  <p>{transcriptHeaderCopy}</p>
                </div>
                <div className="ending-chat-transcript-header__meta">
                  <span className="ending-chat-note">{transcriptHeaderNote}</span>
                  {activeThreadAnchorSummary && (
                    <div className="ending-chat-anchor-summary" title={activeThreadAnchorSummary.label}>
                      <span className="ending-chat-anchor-summary__kind">{activeThreadAnchorSummary.kindLabel}</span>
                      <span className="ending-chat-anchor-summary__label">{activeThreadAnchorSummary.label}</span>
                    </div>
                  )}
                </div>
              </div>

            {!isCrosslineGallery && threads.length > 0 && (
              <div className="ending-chat-thread-rail" role="tablist" aria-label={isZh ? '追问线程' : 'Follow-up threads'}>
                {threads.map((thread, index) => {
                  const isActive = activeThreadSelectionId === thread.id;
                  return (
                  <button
                    key={thread.id}
                    id={`${threadRailId}-${thread.id}`}
                    ref={(node) => {
                      threadTabRefs.current[thread.id] = node;
                    }}
                    type="button"
                    role="tab"
                    aria-controls={threadPanelId}
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`ending-chat-thread-chip ${isActive ? 'is-active' : ''} ${thread.mode === 'room' ? 'is-room-thread' : ''} ${thread.interaction_mode === 'hotseat' ? 'is-hotseat-thread' : ''}`}
                    onClick={() => handleThreadSelect(thread.id)}
                    onKeyDown={(event) => handleThreadRailKeyDown(event, index)}
                  >
                    {thread.mode === 'room' && <span className="ending-chat-thread-chip__icon ending-chat-thread-chip__icon--archivist" aria-hidden="true" />}
                    <span className="ending-chat-thread-chip__label">{threadDisplayLabels[thread.id] ?? threadLabel(thread, isZh)}</span>
                    {threadAnchorSummaries[thread.id] && (
                      <span className="ending-chat-thread-chip__anchor" title={threadAnchorSummaries[thread.id].label}>
                        {threadAnchorSummaries[thread.id].kindLabel}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>
            )}

            <div
              ref={transcriptListRef}
              className="ending-chat-transcript-list"
              onScroll={handleTranscriptScroll}
            >
              {isCrosslineGallery && (
                <div className="ending-chat-gallery-list">
                  {galleryCards.length === 0 ? (
                    <div className="ending-chat-empty-state">{t('roundtable.gallery_hint')}</div>
                  ) : (
                    galleryCards.map((galleryBranch) => (
                      <article key={galleryBranch.id} className="ending-chat-gallery-card">
                        <header className="ending-chat-gallery-card__header">
                          <div>
                            <strong>{galleryBranch.title}</strong>
                            <span>{t('ending_room.foreign_summary_badge')}</span>
                          </div>
                          <em>{`${(galleryBranch.probability * 100).toFixed(1)}%`}</em>
                        </header>
                        <p>{galleryBranch.story || galleryBranch.insight || '—'}</p>
                        {galleryBranch.insight && (
                          <blockquote>{galleryBranch.insight}</blockquote>
                        )}
                        {galleryBranch.key_moments.length > 0 && (
                          <ul className="ending-chat-gallery-card__moments">
                            {galleryBranch.key_moments.slice(0, 3).map((moment) => (
                              <li key={moment}>{moment}</li>
                            ))}
                          </ul>
                        )}
                        {composerEnabled && (
                          <button
                            type="button"
                            className="ending-chat-inline-button ending-chat-evidence-btn"
                            onClick={() => {
                              const evidenceSummary = galleryBranch.insight || galleryBranch.story || galleryBranch.title;
                              void appendUserTurn({
                                content: `[${t('ending_room.evidence_card_label')}] ${galleryBranch.title}: ${evidenceSummary}`,
                                interactionMode: 'evidence_card',
                                citedBranchId: galleryBranch.id,
                                citedRefsJson: {
                                  kind: 'evidence_card',
                                  evidence_card_kind: 'summary',
                                  source_branch_title: galleryBranch.title,
                                  source_summary: galleryBranch.story || '',
                                  source_insight: galleryBranch.insight || '',
                                },
                              });
                            }}
                            title={t('ending_room.evidence_card_hint')}
                          >
                            {t('ending_room.action_evidence_card')}
                          </button>
                        )}
                      </article>
                    ))
                  )}
                </div>
              )}
              {!isCrosslineGallery && composerEnabled && galleryCards.length > 0 && (
                <details className="ending-chat-evidence-drawer">
                  <summary>{t('ending_room.evidence_card_drop_hint')}</summary>
                  <div className="ending-chat-gallery-list">
                    {galleryCards.map((galleryBranch) => (
                      <article key={galleryBranch.id} className="ending-chat-gallery-card ending-chat-evidence-card">
                        <header className="ending-chat-gallery-card__header">
                          <div>
                            <strong>{galleryBranch.title}</strong>
                            <span>{t('ending_room.foreign_summary_badge')}</span>
                          </div>
                          <em>{`${(galleryBranch.probability * 100).toFixed(1)}%`}</em>
                        </header>
                        <p>{galleryBranch.insight || galleryBranch.story || '—'}</p>
                        <button
                          type="button"
                          className="ending-chat-inline-button ending-chat-evidence-btn"
                          onClick={() => {
                            const evidenceSummary = galleryBranch.insight || galleryBranch.story || galleryBranch.title;
                            void appendUserTurn({
                              content: `[${t('ending_room.evidence_card_label')}] ${galleryBranch.title}: ${evidenceSummary}`,
                              interactionMode: 'evidence_card',
                              citedBranchId: galleryBranch.id,
                              citedRefsJson: {
                                kind: 'evidence_card',
                                evidence_card_kind: 'summary',
                                source_branch_title: galleryBranch.title,
                                source_summary: galleryBranch.story || '',
                                source_insight: galleryBranch.insight || '',
                              },
                            });
                          }}
                          title={t('ending_room.evidence_card_hint')}
                        >
                          {t('ending_room.action_evidence_card')}
                        </button>
                      </article>
                    ))}
                  </div>
                </details>
              )}
              {!isCrosslineGallery && !readOnly && currentTurns.length === 0 && displayedDrafts.length === 0 && status === 'loading' && (
                <div className="ending-chat-empty-state">{t('ending_room.loading')}</div>
              )}
              {!isCrosslineGallery && !readOnly && currentTurns.length === 0 && displayedDrafts.length === 0 && status !== 'loading' && (
                <div className="ending-chat-empty-state">
                  {readOnly ? t('ending_room.replay_readonly') : t('ending_room.empty')}
                </div>
              )}
              {!isCrosslineGallery && currentTurns.map((message) => (
                <article
                  key={message.key}
                  className={`ending-chat-bubble ${message.key === currentSpeakerTurnKey ? 'is-current-speaker' : ''} ${message.roleSlot === 'archivist' ? 'is-archivist' : ''} ${message.roleSlot === 'user' ? 'is-user' : ''} ${message.phase === 'verdict' ? 'ending-chat-bubble--verdict' : ''}`}
                  style={{ minHeight: `${transcriptBubbleLayouts[message.key]?.minHeightPx ?? 0}px` }}
                  data-speaker={speakerIndexMap.get(message.speaker) ?? 0}
                  data-layout-lines={transcriptBubbleLayouts[message.key]?.lineCount ?? undefined}
                  data-layout-overflow={transcriptBubbleLayouts[message.key]?.overflow ? 'true' : 'false'}
                >
                  <header>
                    {message.roleSlot === 'archivist' && <span className="ending-chat-bubble__icon ending-chat-bubble__icon--archivist" aria-hidden="true" />}
                    <strong>{message.speaker}</strong>
                    {message.participantId && <FactionBadge faction={factionMap?.get(message.participantId)} />}
                    <span>{message.phase}</span>
                  </header>
                  {message.roleSlot === 'user'
                    ? <p>{message.content}</p>
                    : <SafeMarkdown className="ending-chat-markdown">{message.content}</SafeMarkdown>
                  }
                  {composerEnabled && message.roleSlot !== 'user' && (
                    <div
                      className={`ending-chat-bubble__actions${alwaysShowBubbleActions ? ' ending-chat-bubble__actions--always-visible' : ''}`}
                      style={alwaysShowBubbleActions ? { opacity: 1, transition: 'none' } : undefined}
                    >
                      <button
                        type="button"
                        className="ending-chat-inline-button"
                        onClick={() => handleFollowQuote(buildEndingAnchorId('quote', branch.id, message.key), message.speaker, message.content)}
                      >
                        {t('ending_room.action_follow_quote')}
                      </button>
                      <button
                        type="button"
                        className="ending-chat-inline-button"
                        onClick={() => void handleQuoteThread(buildEndingAnchorId('quote', branch.id, message.key), message.speaker, message.content)}
                      >
                        {t('ending_room.action_new_thread')}
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {!isCrosslineGallery && displayedDrafts.map((draft) => (
                <article
                  key={draft.key}
                  className={`ending-chat-bubble ending-chat-bubble--draft ${draft.variant === 'placeholder' ? 'ending-chat-bubble--placeholder' : ''} ${draft.key === currentSpeakerTurnKey ? 'is-current-speaker' : ''}`}
                  aria-busy={draft.variant === 'placeholder'}
                  style={{ minHeight: `${transcriptDraftLayouts[draft.key]?.minHeightPx ?? 0}px` }}
                  data-layout-lines={transcriptDraftLayouts[draft.key]?.lineCount ?? undefined}
                  data-layout-overflow={transcriptDraftLayouts[draft.key]?.overflow ? 'true' : 'false'}
                >
                  <header>
                    <strong>{participantsById.get(draft.participantId ?? '')?.display_name ?? t('ending_room.participant_unknown')}</strong>
                    <span>{getEndingRoomPhaseLabel(draft.phase, t)}</span>
                    <em className="ending-chat-draft-badge">{t('ending_room.draft_badge')}</em>
                  </header>
                  {draft.variant === 'placeholder' ? (
                    <p>
                      <TypingIndicator
                        ariaLabel={draft.content}
                      />
                      {' '}{draft.content}
                    </p>
                  ) : (
                    <p>{draft.content}</p>
                  )}
                </article>
              ))}
            </div>

            {readOnly || isCrosslineGallery ? (
              <div className="ending-chat-composer ending-chat-composer--readonly">
                <span className="ending-chat-scope-notice">{isCrosslineGallery ? t('roundtable.gallery_hint') : t('ending_room.replay_readonly')}</span>
              </div>
            ) : (
              <div className="ending-chat-composer">
              <div className="ending-chat-composer__row">
                <div className="ending-chat-mode-switch" role="group" aria-label={isZh ? '追问模式' : 'Follow-up mode'}>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'archivist_route' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('archivist_route')}
                    disabled={!composerEnabled}
                  >
                    {getArchivistModeLabel(isZh)}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'hotseat' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('hotseat')}
                    disabled={!composerEnabled}
                  >
                    {getHotseatModeLabel(isZh)}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'all_present' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('all_present')}
                    disabled={!composerEnabled || targetableParticipants.length === 0}
                  >
                    {getAllPresentModeLabel(isZh)}
                  </button>
                </div>
                <span className="ending-chat-scope-notice">{transcriptSubtitle}</span>
                {isMobile && composerEnabled && (
                  <button
                    type="button"
                    className="ending-chat-inline-button ending-chat-epilogue-btn ending-chat-epilogue-btn--mobile"
                    onClick={() => {
                      setComposerDraft(t('ending_room.epilogue_prompt'));
                      setInteractionMode('epilogue');
                    }}
                    title={t('ending_room.epilogue_hint')}
                  >
                    {t('ending_room.action_epilogue')}
                  </button>
                )}
              </div>
              <span className="ending-chat-mode-note">{interactionModeNote}</span>

              <div className="ending-chat-anchor-row">
                {anchorSuggestions.map((anchor) => (
                  <button
                    key={`${anchor.label}-${anchor.action.prompt}`}
                    type="button"
                    className="ending-chat-anchor-chip"
                    disabled={!composerEnabled}
                    onClick={() => activateAnchor(anchor.action)}
                  >
                    <span>{anchor.label}</span>
                  </button>
                ))}
              </div>

              {pendingQuestionAnchorIds.length > 0 && composerDraft.trim().length > 0 && (
                <div className="ending-chat-anchor-actions">
                  <button
                    type="button"
                    className="ending-chat-inline-button"
                    disabled={!composerEnabled}
                    onClick={() => void handleStartAnchoredThread({
                      anchorIds: pendingQuestionAnchorIds,
                      prompt: composerDraft,
                      threadTitle: null,
                    })}
                  >
                    {t('ending_room.action_thread_from_anchor')}
                  </button>
                </div>
              )}

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
                  rows={2}
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
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
