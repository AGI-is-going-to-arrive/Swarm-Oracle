import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  createReplayArtifact,
  getAgents,
  getReplayArtifact,
  getScenario,
  getStory,
  importReplayScenario,
} from '../api/client';
import { copyText } from '../lib/copyText';
import {
  buildBranchEndingRoomCandidates,
} from '../lib/endingRoomCandidates';
import {
  chooseRepresentativeDefaults,
  chooseTraitMixRepresentatives,
} from '../lib/roundtableSelection';
import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  sanitizeOracleReplayPayload,
  type OracleReplayPayload,
} from '../lib/oracleReplay';
import { isReplayEnvelopeLikelyTooLarge } from '../lib/replayCodec';
import { loadScenarioMeta } from '../lib/scenarioMeta';
import {
  getEndingRoomPhaseLabel,
  getEndingRoomStatusLabel,
} from '../lib/endingRoomLabels';
import {
  buildOracleTranscriptLayoutMap,
  captureTranscriptScrollSnapshot,
  computeBottomAnchoredScrollTop,
  summarizeOracleTranscriptLayout,
  type TranscriptScrollSnapshot,
} from '../lib/textLayout/oracleTranscriptLayout';
import {
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  inferGameplayProfile,
} from '../components/gameplayCards';
import { ORACLE_UI_ASSETS } from '../lib/themeRegistry';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import { useWorldlineRoundtableWS } from '../hooks/useWorldlineRoundtableWS';
import { useWorldlineRoundtableStore } from '../stores/worldlineRoundtableStore';
import {
  type AnchorAction,
  type AnchorSummary,
  type RoundtableSelectionMode,
  type WitnessCandidate,
  MANUAL_SHORTLIST_MIN,
  MANUAL_SHORTLIST_MAX,
  ROUNDTABLE_COLLAPSED_TURN_MAX_LINES,
  isRoundtableParticipant,
  getParticipantSprite,
  getThreadLabel,
  getParticipantImpactScore,
  getSelectionReasonLabel,
  getArchivistModeLabel,
  getRepresentativeHotseatLabel,
  getRoundtableModeNote,
  buildRoundtableVerdictPrompt,
  buildRoundtablePhasePrompt,
  buildRoundtableAnchorId,
  buildRoundtableQuotePrompt,
  branchListChanged,
  sameWitnessSelection,
  describeRoundtableAnchor,
  normalizeManualShortlist,
  buildDefaultManualShortlist,
  chooseFaultLineBranchIds,
  chooseWitnessAugmentedSelection,
  buildReplayThreads,
  isEndingRoomPhase,
} from './roundtableHelpers';
import { stripOracleReasoningText } from '../components/endingChatHelpers';
import type {
  AgentInfo,
  RoundtableRepresentativeSelection,
  RoundtableWitnessSelection,
  EndingRoomThreadSnapshot,
  Scenario,
  StoryData,
} from '../types';
import RoundtablePickerPanel from './RoundtablePickerPanel';
import RoundtableTranscriptList from './RoundtableTranscriptList';
import PostVerdictPanel, { type PostVerdictTab } from './PostVerdictPanel';
import PersonalityDriftWarning from '../components/PersonalityDriftWarning';
import {
  createInitialAnalystCache,
  createInitialSurveyCache,
  type AnalystCacheState,
  type SurveyCacheState,
} from './postVerdictCaches';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useFactionOverlay } from '../hooks/useFactionOverlay';
import { AvatarRing } from '../components/ui/AvatarRing';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import './WorldlineRoundtable.css';
import '../components/EndingChatModal.css';

function getPreferredScrollBehavior(): ScrollBehavior {
  if (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return 'auto';
  }
  return 'smooth';
}

function buildRoundtableReplayArtifactPayload(
  payload: OracleReplayPayload,
): Record<string, unknown> {
  const sanitizedPayload = sanitizeOracleReplayPayload(payload);
  return {
    kind: sanitizedPayload.kind,
    scenarioReplay: sanitizedPayload.scenarioReplay,
    scenarioId: sanitizedPayload.scenarioId ?? null,
    roomSnapshot: sanitizedPayload.roomSnapshot,
    roomResult: sanitizedPayload.roomResult,
    branchId: sanitizedPayload.branchId ?? null,
    selectedAgentIds: sanitizedPayload.selectedAgentIds ?? [],
    activeThreadId: sanitizedPayload.activeThreadId ?? null,
  };
}

function buildPhaseInsightLabel(
  insight: { phase: string; commentary?: string; stakes?: string },
  options: {
    isZh: boolean;
    t: (key: string) => string;
  },
) {
  const { isZh, t } = options;
  const phaseLabel = isEndingRoomPhase(insight.phase)
    ? getEndingRoomPhaseLabel(insight.phase, t)
    : t('roundtable.phase_unknown');
  const normalizedCommentary = String(insight.commentary ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedCommentary) {
    return phaseLabel;
  }
  const firstSentence = normalizedCommentary.split(/[。！？!?]/)[0]?.trim() ?? '';
  const firstClause = firstSentence.split(/[:：]/)[0]?.trim() ?? '';
  const rawDetail = (firstClause || firstSentence || String(insight.stakes ?? '').trim()).trim();
  if (!rawDetail || rawDetail === phaseLabel || rawDetail === insight.stakes) {
    return phaseLabel;
  }
  const maxLength = isZh ? 32 : 50;
  const clipped = rawDetail.length > maxLength ? `${rawDetail.slice(0, maxLength).trimEnd()}…` : rawDetail;
  return `${phaseLabel}·${clipped}`;
}

function buildPhaseInsightTitle(
  insight: { phase: string; commentary?: string; stakes?: string },
  options: { isZh: boolean },
) {
  const normalizedCommentary = String(insight.commentary ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedCommentary) {
    return String(insight.stakes ?? '').trim() || '';
  }
  const maxLength = options.isZh ? 52 : 80;
  return normalizedCommentary.length > maxLength
    ? `${normalizedCommentary.slice(0, maxLength).trimEnd()}…`
    : normalizedCommentary;
}

function buildPhaseInsightCommentary(
  insight: { commentary?: string; stakes?: string; insight_body?: string },
  options: { isZh: boolean },
) {
  const body = String(insight.insight_body ?? '').replace(/\s+/g, ' ').trim();
  if (body) {
    const maxLength = options.isZh ? 120 : 180;
    return body.length > maxLength
      ? `${body.slice(0, maxLength).trimEnd()}…`
      : body;
  }
  const normalizedCommentary = String(insight.commentary ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedCommentary) {
    return String(insight.stakes ?? '').trim();
  }
  const firstSentence = normalizedCommentary.match(/^[^。！？.!?]+[。！？.!?]?/)?.[0]?.trim() || normalizedCommentary;
  const maxLength = options.isZh ? 120 : 180;
  return firstSentence.length > maxLength
    ? `${firstSentence.slice(0, maxLength).trimEnd()}…`
    : firstSentence;
}

export default function WorldlineRoundtableView() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.add('has-worldline-roundtable');
    return () => {
      document.body.classList.remove('has-worldline-roundtable');
    };
  }, []);

  const replayShareId = searchParams.get('roomShare') ?? searchParams.get('share');
  const replayLocalId = searchParams.get('roomLocal') ?? searchParams.get('local');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [replayPayload, setReplayPayload] = useState<OracleReplayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [localCopySaved, setLocalCopySaved] = useState(false);
  const [selectedRepresentativeId, setSelectedRepresentativeId] = useState<string | null>(null);
  const [replayActiveThreadId, setReplayActiveThreadId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<RoundtableSelectionMode>('representative');
  const [selectedRepresentatives, setSelectedRepresentatives] = useState<Record<string, string>>({});
  const [manualShortlistBranchIds, setManualShortlistBranchIds] = useState<string[]>([]);
  const [selectedWitness, setSelectedWitness] = useState<RoundtableWitnessSelection | null>(null);
  const [editingRepresentatives, setEditingRepresentatives] = useState(false);
  const [launchingRoom, setLaunchingRoom] = useState(false);
  const [showMobileRoster, setShowMobileRoster] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? 1024 : window.innerWidth
  ));
  const mobileRosterTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileRosterDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = () => setViewportWidth(window.innerWidth);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!showMobileRoster) return;
    const dialog = mobileRosterDialogRef.current;
    const trigger = mobileRosterTriggerRef.current;
    if (dialog) dialog.focus();
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowMobileRoster(false); };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      trigger?.focus();
    };
  }, [showMobileRoster]);
  const [rosterExpanded, setRosterExpanded] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState('');
  const [briefCopied, setBriefCopied] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [showPostVerdict, setShowPostVerdict] = useState(false);
  const [postVerdictTab, setPostVerdictTab] = useState<PostVerdictTab>('agent_chat');
  const [analystCache, setAnalystCache] = useState<AnalystCacheState>(() => createInitialAnalystCache());
  const [surveyCache, setSurveyCache] = useState<SurveyCacheState>(() => createInitialSurveyCache());
  const [postVerdictContextVersion, bumpPostVerdictContextVersion] = useReducer(
    (x: number) => x + 1,
    0,
  );
  const [pendingQuestionAnchorIds, setPendingQuestionAnchorIds] = useState<string[]>([]);
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Record<string, boolean>>({});
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptAutoStickRef = useRef(false);
  const transcriptHydratedRef = useRef(false);
  const transcriptListRef = useRef<HTMLDivElement>(null);
  const transcriptScrollSnapshotRef = useRef<TranscriptScrollSnapshot | null>(null);
  const prevTurnCountRef = useRef(0);
  const isZhRef = useRef(isZh);
  const tRef = useRef(t);

  useEffect(() => {
    isZhRef.current = isZh;
  }, [isZh]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!actionMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenuOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [actionMenuOpen]);

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
  } = useWorldlineRoundtableStore();

  const replaySnapshot = replayPayload?.roomSnapshot ?? null;
  const replayThreadsById = useMemo(
    () => (replaySnapshot ? buildReplayThreads(replaySnapshot) : {}),
    [replaySnapshot],
  );
  const effectiveSnapshot = replaySnapshot ?? snapshot;
  const effectiveResult = replayPayload?.roomResult ?? result;
  const prevEffectiveResultRef = useRef(effectiveResult);
  useEffect(() => {
    if (prevEffectiveResultRef.current !== effectiveResult) {
      prevEffectiveResultRef.current = effectiveResult;
      setAnalystCache(createInitialAnalystCache());
      setSurveyCache(createInitialSurveyCache());
      bumpPostVerdictContextVersion();
    }
  }, [effectiveResult]);

  const effectiveThreadsById = replaySnapshot ? replayThreadsById : threadsById;
  const effectiveThreadOrder = replaySnapshot
    ? replaySnapshot.threads.map((thread) => thread.id)
    : threadOrder;
  const isLiveRoom = Boolean(effectiveSnapshot && !replayPayload);
  const isTabletViewport = viewportWidth <= 980;
  const uiLanguage: 'zh' | 'en' = isZh ? 'zh' : 'en';
  const oracleProfile = useMemo(
    () => inferGameplayProfile(
      replayPayload?.scenarioReplay?.scenario.question
        ?? scenario?.question
        ?? storyData?.question
        ?? '',
      replayPayload?.scenarioReplay?.scenario.scene_theme
        ?? scenario?.scene_theme
        ?? null,
    ),
    [replayPayload?.scenarioReplay?.scenario.question, replayPayload?.scenarioReplay?.scenario.scene_theme, scenario?.question, scenario?.scene_theme, storyData?.question],
  );
  const oracleProfileLabel = getGameplayProfileLabel(oracleProfile.id, isZh);
  const oracleProfileHooks = getGameplayProfileSignatureHooks(oracleProfile.id, isZh);
  const oracleProfileFrameSrc = getGameplayProfileFrameSrc(oracleProfile.id);
  const defaultThreadId = useMemo(
    () => effectiveSnapshot?.threads.find((thread) => thread.mode === 'room')?.id
      ?? effectiveSnapshot?.threads[0]?.id
      ?? null,
    [effectiveSnapshot?.threads],
  );
  const effectiveActiveThreadId = replayPayload
    ? (replayActiveThreadId ?? replayPayload.activeThreadId ?? defaultThreadId)
    : activeThreadId;

  const activeThread = useMemo(
    () => (
      effectiveActiveThreadId
        ? effectiveThreadsById[effectiveActiveThreadId]
        : null
    ) ?? (
      defaultThreadId
        ? effectiveThreadsById[defaultThreadId]
        : null
    ) ?? null,
    [defaultThreadId, effectiveActiveThreadId, effectiveThreadsById],
  );

  const threadList = useMemo(
    () => effectiveThreadOrder
      .map((threadId) => effectiveThreadsById[threadId])
      .filter(Boolean),
    [effectiveThreadOrder, effectiveThreadsById],
  );

  useWorldlineRoundtableWS(
    snapshot?.id,
    !replayPayload && Boolean(snapshot?.id) && status !== 'error',
  );

  useEffect(() => {
    let cancelled = false;

    const applyReplay = (nextReplay: OracleReplayPayload) => {
      if (!nextReplay.scenarioReplay) {
        throw new Error(tRef.current('roundtable.error_missing_scenario'));
      }
      setReplayPayload(nextReplay);
      setScenario(nextReplay.scenarioReplay.scenario);
      setStoryData(nextReplay.scenarioReplay.storyData);
      setAgents(nextReplay.scenarioReplay.agents ?? []);
      const preferredTarget = nextReplay.roomSnapshot.participants.find((participant) => isRoundtableParticipant(participant));
      setSelectedRepresentativeId(preferredTarget?.id ?? null);
      setLoading(false);
    };

    const load = async () => {
      setLoading(true);
      setError('');
      setImportError('');

      try {
        if (replayShareId || replayLocalId || searchParams.get('roomReplay')) {
          const rawReplay = replayLocalId
            ? loadOracleReplayLocalCopy(replayLocalId, 'worldline_roundtable_v1')
            : replayShareId
              ? await Promise.resolve()
                .then(() => getReplayArtifact(replayShareId))
                .then((artifact) => normalizeOracleReplayPayload(artifact.payload, 'worldline_roundtable_v1'))
              : await readOracleReplayPayload(searchParams, 'worldline_roundtable_v1');
          if (!rawReplay) {
            throw new Error(tRef.current('roundtable.error_invalid_replay'));
          }
          if (!cancelled) {
            applyReplay(rawReplay);
          }
          return;
        }

        if (!id) {
          throw new Error(tRef.current('roundtable.error_missing_id'));
        }

        const [nextScenario, nextStory, nextAgents] = await Promise.all([
          getScenario(id),
          getStory(id),
          getAgents(id),
        ]);
        const nextStoryData = {
          ...nextStory,
          question: nextStory?.question || nextScenario?.question,
        };

        if (cancelled) return;
        setScenario(nextScenario);
        setStoryData(nextStoryData);
        setAgents(nextAgents);

        if (nextScenario.status !== 'done') {
          throw new Error(tRef.current('roundtable.error_not_done'));
        }
        if ((nextStoryData.branches?.length ?? 0) < 2) {
          throw new Error(tRef.current('roundtable.error_too_few_branches'));
        }

        if (!cancelled) {
          setLoading(false);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      reset();
    };
  }, [id, replayLocalId, replayShareId, reset, searchParams]);

  const branchesById = useMemo(
    () => new Map((storyData?.branches ?? []).map((branch) => [branch.id, branch])),
    [storyData?.branches],
  );
  const branchCandidates = useMemo(
    () => buildBranchEndingRoomCandidates({
      agents,
      branches: storyData?.branches ?? [],
      messages: scenario?.messages ?? [],
      isZh,
    }),
    [agents, isZh, scenario?.messages, storyData?.branches],
  );
  const branchOrder = useMemo(
    () => (storyData?.branches ?? []).map((branch) => branch.id),
    [storyData?.branches],
  );
  const manualShortlistMax = Math.min(MANUAL_SHORTLIST_MAX, branchOrder.length);
  const manualShortlistMin = Math.min(MANUAL_SHORTLIST_MIN, manualShortlistMax);

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    setSelectedRepresentatives((current) => {
      const { next, changed } = chooseRepresentativeDefaults(branchOrder, branchCandidates, current);
      if (!changed && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [branchCandidates, branchOrder, replayPayload]);

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    setManualShortlistBranchIds((current) => {
      const normalized = normalizeManualShortlist(branchOrder, current);
      if (normalized.length > 0) {
        return normalized;
      }
      return buildDefaultManualShortlist(branchOrder);
    });
  }, [branchOrder, replayPayload]);

  const participants = useMemo(
    () => effectiveSnapshot?.participants ?? [],
    [effectiveSnapshot?.participants],
  );
  const representatives = useMemo(
    () => participants.filter((participant) => isRoundtableParticipant(participant)),
    [participants],
  );
  const resolveThreadRepresentativeId = useCallback((thread: EndingRoomThreadSnapshot | null | undefined) => {
    const targetRef = thread?.addressed_agent_ids_json?.[0] ?? null;
    if (!targetRef) {
      return representatives[0]?.id ?? null;
    }
    return representatives.find((participant) => (
      participant.id === targetRef
      || participant.worldline_echo_key === targetRef
      || participant.source_agent_id === targetRef
    ))?.id ?? null;
  }, [representatives]);
  const participantsById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );
  const { enabled: factionsEnabled } = useCapabilityCheck('factions');
  const { enabled: driftWarningEnabled } = useCapabilityCheck('agent_identity');
  // P1-8: faction overlay — hook discovers branches from participants
  const factionMap = useFactionOverlay(scenario?.id, undefined, participantsById, factionsEnabled);
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
  const showRepresentativePicker = !loading && !error && !replayPayload && (!effectiveSnapshot || editingRepresentatives);

  useEffect(() => {
    const currentStillValid = selectedRepresentativeId
      ? representatives.some((participant) => participant.id === selectedRepresentativeId)
      : false;
    if (currentStillValid) return;
    if (representatives.length > 0) {
      setSelectedRepresentativeId(representatives[0].id);
      return;
    }
    if (selectedRepresentativeId !== null) {
      setSelectedRepresentativeId(null);
    }
  }, [representatives, selectedRepresentativeId]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot || representatives.length === 0 || editingRepresentatives) {
      return;
    }
    setSelectedRepresentatives((current) => {
      let changed = false;
      const next = { ...current };
      for (const participant of representatives) {
        if (!participant.source_branch_id || !participant.source_agent_id) continue;
        if (next[participant.source_branch_id] === participant.source_agent_id) continue;
        next[participant.source_branch_id] = participant.source_agent_id;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [editingRepresentatives, effectiveSnapshot, replayPayload, representatives]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot?.id || branchOrder.length === 0 || representatives.length === 0 || editingRepresentatives) {
      return;
    }
    const liveBranchIds = normalizeManualShortlist(
      branchOrder,
      representatives
        .map((participant) => participant.source_branch_id)
        .filter((value): value is string => Boolean(value)),
    );
    if (liveBranchIds.length === 0) {
      return;
    }
    setManualShortlistBranchIds(liveBranchIds);
    setSelectionMode(
      effectiveSnapshot?.selection_recipe
      ?? (liveBranchIds.length < branchOrder.length ? 'manual_shortlist' : 'representative'),
    );
  }, [branchOrder, editingRepresentatives, effectiveSnapshot?.id, effectiveSnapshot?.selection_recipe, replayPayload, representatives]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot || editingRepresentatives) {
      return;
    }
    const witness = participants.find((participant) => participant.role_slot === 'critic');
    if (!witness?.source_branch_id || !witness.source_agent_id) {
      return;
    }
    if (effectiveSnapshot.selection_recipe === 'witness_augmented') {
      setSelectionMode('witness_augmented');
    } else {
      setSelectionMode('expert_witness');
    }
    setSelectedWitness({
      branchId: witness.source_branch_id,
      agentId: witness.source_agent_id,
    });
  }, [editingRepresentatives, effectiveSnapshot, participants, replayPayload]);

  useEffect(() => {
    setReplayActiveThreadId(replayPayload?.activeThreadId ?? null);
  }, [replayPayload?.activeThreadId, replayPayload?.roomSnapshot?.id]);

  useEffect(() => {
    if (!replayPayload) {
      return;
    }
    const replayRepresentativeBranches = normalizeManualShortlist(
      branchOrder,
      replayPayload.roomSnapshot.participants
        .filter((participant) => participant.role_slot === 'representative')
        .map((participant) => participant.source_branch_id)
        .filter((value): value is string => Boolean(value)),
    );
    if (replayRepresentativeBranches.length > 0) {
      setManualShortlistBranchIds(replayRepresentativeBranches);
    }
    if (replayPayload.roomSnapshot.selection_recipe) {
      setSelectionMode(replayPayload.roomSnapshot.selection_recipe);
      return;
    }
    const hasWitness = replayPayload.roomSnapshot.participants.some((participant) => participant.role_slot === 'critic');
    setSelectionMode(
      hasWitness
        ? 'expert_witness'
      : (replayRepresentativeBranches.length > 0 && replayRepresentativeBranches.length < branchOrder.length
          ? 'manual_shortlist'
          : 'representative'),
    );
  }, [branchOrder, replayPayload]);

  useEffect(() => {
    if (!replayPayload) {
      return;
    }
    const nextMode = activeThread?.mode === 'followup'
      ? activeThread.interaction_mode
      : 'archivist_route';
    if (interactionMode !== nextMode) {
      setInteractionMode(nextMode);
    }
    const nextRepresentativeId = resolveThreadRepresentativeId(activeThread);
    if (selectedRepresentativeId !== nextRepresentativeId) {
      setSelectedRepresentativeId(nextRepresentativeId);
    }
  }, [
    activeThread,
    interactionMode,
    replayPayload,
    resolveThreadRepresentativeId,
    selectedRepresentativeId,
    setInteractionMode,
  ]);

  const currentTurns = useMemo(() => {
    const roomTurns = effectiveSnapshot?.turns ?? [];
    const turns = activeThread?.mode === 'followup'
      ? activeThread.turns
      : roomTurns.filter((turn) => {
        if (turn.thread_id && defaultThreadId) {
          return turn.thread_id === defaultThreadId;
        }
        return !turn.thread_id || turn.memory_partition_id === effectiveSnapshot?.memory_partition_id;
      });

    return turns.map((turn) => {
      const participant = participantsById.get(turn.participant_id);
      return {
        key: turn.id,
        content: turn.source === 'user_turn' ? turn.content : stripOracleReasoningText(turn.content),
        phase: getEndingRoomPhaseLabel(turn.phase, t),
        participantId: turn.participant_id,
        roleSlot: participant?.role_slot ?? (turn.source === 'user_turn' ? 'user' : undefined),
        speaker: participant?.display_name
          ?? (turn.source === 'user_turn' ? t('roundtable.speaker_you') : t('roundtable.speaker_unknown')),
      };
    });
  }, [activeThread, defaultThreadId, effectiveSnapshot?.memory_partition_id, effectiveSnapshot?.turns, participantsById, t]);

  const phaseList = useMemo(() => {
    const seen = new Set<string>();
    const phases: string[] = [];
    for (const turn of currentTurns) {
      if (turn.phase && !seen.has(turn.phase)) {
        seen.add(turn.phase);
        phases.push(turn.phase);
      }
    }
    return phases;
  }, [currentTurns]);

  const sortedDrafts = useMemo(
    () => Object.values(pendingDrafts).sort((left, right) => left.sequence - right.sequence),
    [pendingDrafts],
  );
  const visibleDrafts = useMemo(
    () => {
      const targetThreadId = activeThread?.id ?? defaultThreadId;
      if (!targetThreadId) return sortedDrafts;
      if (activeThread?.mode === 'followup') {
        return sortedDrafts.filter((draft) => draft.threadId === activeThread.id);
      }
      return sortedDrafts.filter((draft) => draft.threadId === targetThreadId);
    },
    [activeThread?.id, activeThread?.mode, defaultThreadId, sortedDrafts],
  );

  const composerEnabled = !replayPayload && Boolean(effectiveResult) && Boolean(snapshot?.id);
  const postVerdictEnabled = !replayPayload && Boolean(effectiveResult);
  const selectedRepresentative = representatives.find(
    (participant) => participant.id === selectedRepresentativeId,
  ) ?? null;
  const displayedDrafts = useMemo(
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
                interactionMode === 'hotseat'
                  ? t('roundtable.placeholder_hotseat')
                  : t('roundtable.placeholder_archivist')
              ),
            variant: sanitizedContent.trim() ? ('stream' as const) : ('placeholder' as const),
          };
        });
      }
      if (replayPayload || !sending || !composerEnabled) {
        return [];
      }
      const activeThreadTurns = activeThread?.turns;
      const placeholderParticipantId = interactionMode === 'hotseat'
        ? (selectedRepresentativeId ?? undefined)
        : participants.find((participant) => participant.role_slot === 'archivist')?.id
          ?? representatives[0]?.id
          ?? undefined;
      const placeholderContent = interactionMode === 'hotseat'
        ? t('roundtable.placeholder_hotseat')
        : t('roundtable.placeholder_archivist');
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
          variant: 'placeholder' as const,
        },
      ];
    },
    [
      activeThread?.turns,
      composerEnabled,
      effectiveSnapshot?.current_phase,
      interactionMode,
      participants,
      replayPayload,
      representatives,
      selectedRepresentativeId,
      sending,
      t,
      visibleDrafts,
    ],
  );
  const latestDisplayedDraft = displayedDrafts[displayedDrafts.length - 1];
  const latestCurrentTurn = currentTurns[currentTurns.length - 1];
  const activeSpeakerTurnKey = latestDisplayedDraft?.key ?? latestCurrentTurn?.key ?? null;
  const currentSpeakerParticipantId = latestDisplayedDraft?.participantId
    ?? latestCurrentTurn?.participantId
    ?? null;
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
  const hotseatParticipantId = interactionMode === 'hotseat' ? selectedRepresentativeId : null;
  const transcriptLocale = isZh ? 'zh' : 'en';
  const transcriptBubbleLayouts = useMemo(
    () => buildOracleTranscriptLayoutMap(
      currentTurns.map((turn) => ({ key: turn.key, content: turn.content })),
      'roundtable_turn',
      transcriptLocale,
    ),
    [currentTurns, transcriptLocale],
  );
  const transcriptDraftLayouts = useMemo(
    () => buildOracleTranscriptLayoutMap(
      displayedDrafts.map((draft) => ({ key: draft.key, content: draft.content })),
      'roundtable_draft',
      transcriptLocale,
    ),
    [displayedDrafts, transcriptLocale],
  );
  const collapsedTurnCount = useMemo(
    () => currentTurns.filter((turn) => {
      const layout = transcriptBubbleLayouts[turn.key];
      return (layout?.lineCount ?? 0) > ROUNDTABLE_COLLAPSED_TURN_MAX_LINES
        && !(expandedTurnKeys[turn.key] ?? false);
    }).length,
    [currentTurns, expandedTurnKeys, transcriptBubbleLayouts],
  );
  const transcriptLayoutTelemetry = useMemo(
    () => summarizeOracleTranscriptLayout(
      transcriptBubbleLayouts,
      transcriptDraftLayouts,
      transcriptScrollSnapshotRef.current,
      {
        collapseLineLimit: ROUNDTABLE_COLLAPSED_TURN_MAX_LINES,
        collapsedTurnCount,
      },
    ),
    [collapsedTurnCount, transcriptBubbleLayouts, transcriptDraftLayouts],
  );

  useEffect(() => {
    transcriptHydratedRef.current = false;
    transcriptAutoStickRef.current = false;
    transcriptScrollSnapshotRef.current = null;
    prevTurnCountRef.current = 0;
    setNewMessageCount(0);
    setExpandedTurnKeys({});
  }, [activeThread?.id, effectiveSnapshot?.id]);

  useLayoutEffect(() => {
    const transcriptList = transcriptListRef.current;
    if (!transcriptList) return;
    const visibleTurnCount = currentTurns.length + displayedDrafts.length;
    if (visibleTurnCount === 0) {
      transcriptHydratedRef.current = false;
      transcriptAutoStickRef.current = false;
      transcriptScrollSnapshotRef.current = captureTranscriptScrollSnapshot(transcriptList);
      return;
    }
    if (!transcriptHydratedRef.current) {
      transcriptHydratedRef.current = true;
      transcriptList.scrollTop = 0;
      transcriptScrollSnapshotRef.current = captureTranscriptScrollSnapshot(transcriptList);
      return;
    }
    if (displayedDrafts.length > 0 || transcriptAutoStickRef.current) {
      transcriptList.scrollTop = computeBottomAnchoredScrollTop(
        transcriptList,
        transcriptScrollSnapshotRef.current,
      );
    }
    transcriptScrollSnapshotRef.current = captureTranscriptScrollSnapshot(transcriptList);
  }, [activeThread?.id, currentTurns, displayedDrafts, effectiveSnapshot?.id]);

  // D-13: Track new messages when user has scrolled up
  useEffect(() => {
    const turnCount = currentTurns.length;
    if (prevTurnCountRef.current > 0 && turnCount > prevTurnCountRef.current && !transcriptAutoStickRef.current) {
      setNewMessageCount((prev) => prev + (turnCount - prevTurnCountRef.current));
    }
    prevTurnCountRef.current = turnCount;
  }, [currentTurns.length]);

  const handleScrollToBottom = useCallback(() => {
    const list = transcriptListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
      transcriptAutoStickRef.current = true;
    }
    setNewMessageCount(0);
  }, []);

  const addressedAgentIds = useMemo(
    () => (interactionMode === 'hotseat' && selectedRepresentativeId
      ? [selectedRepresentativeId]
      : []),
    [interactionMode, selectedRepresentativeId],
  );
  const transcriptSubtitle = scopeNotice && activeThread && scopeNotice.threadId === activeThread.id
    ? (
      activeThread.mode === 'followup'
        ? t('roundtable.scope_followup_active')
        : t('roundtable.scope_table_active')
    )
    : (
      activeThread?.mode === 'followup'
        ? t('roundtable.scope_followup_default')
        : t('roundtable.scope_table_default')
    );
  const threadDisplayLabels = useMemo(() => {
    const seen = new Map<string, number>();
    const labels: Record<string, string> = {};
    for (const thread of threadList) {
      const base = getThreadLabel(thread, isZh, t);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      labels[thread.id] = count === 1
        ? base
        : `${base}${t('roundtable.thread_label', { count })}`;
    }
    return labels;
  }, [isZh, t, threadList]);
  const threadAnchorSummaries = useMemo(
    () => threadList.reduce<Record<string, AnchorSummary>>((acc, thread) => {
      const summary = describeRoundtableAnchor(
        thread.question_anchor_ids_json,
        isZh,
        (effectiveResult?.phase_insights ?? []).map((insight) => ({
          phase: insight.phase,
          stakes: insight.stakes,
          commentary: insight.commentary,
        })),
        thread.turns.map((turn) => ({ key: turn.id, content: turn.content })),
        t,
      );
      if (summary) {
        acc[thread.id] = summary;
      }
      return acc;
    }, {}),
    [effectiveResult?.phase_insights, isZh, t, threadList],
  );
  const activeThreadAnchorSummary = useMemo(
    () => (activeThread ? threadAnchorSummaries[activeThread.id] ?? null : null),
    [activeThread, threadAnchorSummaries],
  );
  const interactionModeNote = replayPayload
    ? t('roundtable.replay_readonly')
    : getRoundtableModeNote(interactionMode, isZh, selectedRepresentative?.display_name ?? null, t);
  const verdictPrompt = useMemo(
    () => buildRoundtableVerdictPrompt(effectiveResult?.summary ?? '', isZh, t),
    [effectiveResult?.summary, isZh, t],
  );
  const verdictAnchorAction = useMemo<AnchorAction>(
    () => ({
      anchorIds: [buildRoundtableAnchorId('verdict', effectiveSnapshot?.id ?? 'table')],
      prompt: verdictPrompt,
      threadTitle: t('roundtable.phase_verdict'),
    }),
    [effectiveSnapshot?.id, t, verdictPrompt],
  );
  const hasDistinctArchivistNote = useMemo(() => {
    const summary = String(effectiveResult?.summary ?? '').trim();
    const note = String(effectiveResult?.archivist_note ?? '').trim();
    return Boolean(note) && note !== summary;
  }, [effectiveResult?.archivist_note, effectiveResult?.summary]);
  const phaseActionPrompts = useMemo(
    () => (effectiveResult?.phase_insights ?? []).map((insight, index) => {
      const label = buildPhaseInsightLabel(insight, { isZh, t });
      return {
        key: `${insight.phase}-${index}`,
        label,
        action: {
          anchorIds: [buildRoundtableAnchorId('phase', effectiveSnapshot?.id ?? 'table', `${insight.phase}-${index}`)],
          prompt: buildRoundtablePhasePrompt(label, insight.commentary || insight.stakes, isZh, t),
          threadTitle: label,
        } satisfies AnchorAction,
      };
    }),
    [effectiveResult?.phase_insights, effectiveSnapshot?.id, isZh, t],
  );
  const meetingBrief = useMemo(() => {
    const lines = [
      `# ${t('roundtable.title')}`,
      '',
      `## ${t('roundtable.question_title')}`,
      storyData?.question ?? '—',
      '',
      `## ${t('roundtable.scope_title')}`,
      transcriptSubtitle,
    ];
    if (effectiveResult?.summary) {
      lines.push('', `## ${t('roundtable.verdict_title')}`, effectiveResult.summary);
    }
    if (hasDistinctArchivistNote && effectiveResult?.archivist_note) {
      lines.push('', `## ${t('roundtable.archivist_note_title')}`, effectiveResult.archivist_note);
    }
    if ((effectiveResult?.phase_insights?.length ?? 0) > 0) {
      lines.push('', `## ${t('roundtable.phase_insights_title')}`);
      (effectiveResult?.phase_insights ?? []).slice(0, 3).forEach((insight) => {
        lines.push(`- ${buildPhaseInsightLabel(insight, { isZh, t })}: ${insight.commentary || insight.stakes}`);
      });
    }
    if (representatives.length > 0) {
      lines.push('', `## ${t('roundtable.representatives_title')}`);
      representatives.forEach((participant) => {
        lines.push(`- ${participant.display_name}`);
      });
    }
    return lines.join('\n');
  }, [effectiveResult?.archivist_note, effectiveResult?.phase_insights, effectiveResult?.summary, hasDistinctArchivistNote, isZh, representatives, storyData?.question, t, transcriptSubtitle]);

  const handleCopyBrief = useCallback(async () => {
    if (!meetingBrief) return;
    await copyText(meetingBrief);
    setBriefCopied(true);
    window.setTimeout(() => setBriefCopied(false), 1800);
  }, [meetingBrief]);

  const renderSummaryActions = (className = 'worldline-roundtable-summary__actions') => (
    <div className={className}>
      {!replayPayload && (
        <>
          <button
            type="button"
            className="ending-chat-inline-button ending-chat-summary-continue-btn"
            onClick={() => activateAnchor(verdictAnchorAction)}
            disabled={!composerEnabled}
          >
            {t('roundtable.action_continue')}
          </button>
          <button
            type="button"
            className="ending-chat-inline-button"
            onClick={() => void handleStartAnchoredThread(verdictAnchorAction)}
            disabled={!composerEnabled}
          >
            {t('roundtable.action_new_thread')}
          </button>
        </>
      )}
      <button
        type="button"
        className="ending-chat-inline-button"
        onClick={() => void handleCopyBrief()}
        disabled={!meetingBrief}
      >
        {briefCopied ? t('roundtable.action_brief_copied') : t('roundtable.action_copy_brief')}
      </button>
      {composerEnabled && (
        <button
          type="button"
          className="ending-chat-inline-button ending-chat-epilogue-btn"
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
  );

  const activateAnchor = useCallback((action: AnchorAction) => {
    setComposerDraft(action.prompt);
    setPendingQuestionAnchorIds(action.anchorIds);
    requestAnimationFrame(() => {
      const el = composerTextareaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        el.scrollIntoView?.({ behavior: getPreferredScrollBehavior(), block: 'nearest' });
      }
    });
  }, [setComposerDraft]);

  const handleStartAnchoredThread = useCallback(async (action: AnchorAction) => {
    if (!snapshot?.id || replayPayload) return;
    const thread = await createThread(snapshot.id, {
      title: action.threadTitle ?? null,
      questionAnchorIds: action.anchorIds,
      interactionMode: 'thread_followup',
    });
    setActiveThread(thread.id);
    setInteractionMode('thread_followup');
    await loadThread(thread.id);
    activateAnchor(action);
  }, [activateAnchor, createThread, loadThread, replayPayload, setActiveThread, setInteractionMode, snapshot?.id]);
  const handleFollowQuote = useCallback((anchorId: string, speaker: string, content: string) => {
    activateAnchor({
      anchorIds: [anchorId],
      prompt: buildRoundtableQuotePrompt(speaker, content, isZh, t),
      threadTitle: speaker,
    });
  }, [activateAnchor, isZh, t]);
  const handleQuoteThread = useCallback(async (anchorId: string, speaker: string, content: string) => {
    await handleStartAnchoredThread({
      anchorIds: [anchorId],
      prompt: buildRoundtableQuotePrompt(speaker, content, isZh, t),
      threadTitle: speaker,
    });
  }, [handleStartAnchoredThread, isZh, t]);
  const handleHotseatQuote = useCallback((participantId: string | null, speaker: string, content: string, anchorId: string) => {
    if (!participantId) {
      return;
    }
    setSelectedRepresentativeId(participantId);
    setInteractionMode('hotseat');
    activateAnchor({
      anchorIds: [anchorId],
      prompt: buildRoundtableQuotePrompt(speaker, content, isZh, t),
      threadTitle: speaker,
    });
  }, [activateAnchor, isZh, setInteractionMode, t]);

  const scenarioReplaySnapshot = useMemo(
    () => replayPayload?.scenarioReplay ?? (
      scenario && storyData
        ? {
            scenario,
            storyData,
            agents: scenario.agents ?? [],
            predictions: [],
            scenarioMeta: loadScenarioMeta(scenario.id),
            campaignScenarioSummary: null,
            campaignSummary: null,
            isDailyChallenge: false,
          }
        : null
    ),
    [replayPayload?.scenarioReplay, scenario, storyData],
  );

  const effectiveReplayPayload = useMemo<OracleReplayPayload | null>(
    () => {
      if (!effectiveSnapshot || !scenarioReplaySnapshot || !effectiveResult) return null;
      return replayPayload ?? {
        kind: 'worldline_roundtable_v1',
        scenarioReplay: scenarioReplaySnapshot,
        roomSnapshot: effectiveSnapshot,
        roomResult: effectiveResult,
        activeThreadId: effectiveActiveThreadId ?? defaultThreadId,
        branchId: null,
        selectedAgentIds: representatives.map((participant) => participant.id),
      };
    },
    [
      defaultThreadId,
      effectiveActiveThreadId,
      effectiveResult,
      effectiveSnapshot,
      replayPayload,
      representatives,
      scenarioReplaySnapshot,
    ],
  );

  const handleCopyPermalink = useCallback(async () => {
    const copyWindowMs = 1800;
    const finalizeCopyState = (usedLocalFallback: boolean) => {
      setPermalinkCopied(true);
      window.setTimeout(() => setPermalinkCopied(false), copyWindowMs);
      if (usedLocalFallback) {
        setLocalCopySaved(true);
        window.setTimeout(() => setLocalCopySaved(false), copyWindowMs);
      }
    };

    try {
      if (!effectiveReplayPayload) return;
      const sanitizedReplayPayload = sanitizeOracleReplayPayload(effectiveReplayPayload);
      const artifact = await createReplayArtifact(
        sanitizedReplayPayload.kind,
        buildRoundtableReplayArtifactPayload(sanitizedReplayPayload),
      ).catch(() => null);
      let permalink: string;
      let usedLocalFallback = false;
      if (artifact) {
        permalink = buildOracleReplayShareUrl(window.location.origin, sanitizedReplayPayload, artifact.id);
      } else if (isReplayEnvelopeLikelyTooLarge(sanitizedReplayPayload.kind, sanitizedReplayPayload)) {
        const localId = saveOracleReplayLocalCopy(sanitizedReplayPayload);
        permalink = buildOracleReplayLocalUrl(window.location.origin, sanitizedReplayPayload, localId);
        usedLocalFallback = true;
      } else {
        permalink = await buildOracleReplayUrl(window.location.origin, sanitizedReplayPayload);
      }
      await copyText(permalink);
      finalizeCopyState(usedLocalFallback);
    } catch (error) {
      if (!effectiveReplayPayload) return;
      console.warn('[WorldlineRoundtableView] Falling back to local roundtable replay copy', error);
      const localId = saveOracleReplayLocalCopy(effectiveReplayPayload);
      await copyText(buildOracleReplayLocalUrl(window.location.origin, effectiveReplayPayload, localId));
      finalizeCopyState(true);
    }
  }, [effectiveReplayPayload]);

  const automationInteractionMode = replayPayload
    ? (activeThread?.mode === 'followup'
      ? activeThread.interaction_mode
      : 'archivist_route')
    : interactionMode;

  const handleSaveLocalCopy = useCallback(() => {
    if (!effectiveReplayPayload) return;
    const localId = saveOracleReplayLocalCopy(effectiveReplayPayload);
    navigate(`/roundtable/replay?roomLocal=${localId}`, { replace: true });
    setLocalCopySaved(true);
    window.setTimeout(() => setLocalCopySaved(false), 1800);
  }, [effectiveReplayPayload, navigate]);

  const handleImportReplay = useCallback(async () => {
    if (!replayPayload?.scenarioReplay || importingReplay) return;
    setImportingReplay(true);
    setImportError('');
    try {
      const imported = await importReplayScenario(replayPayload.scenarioReplay.scenario);
      navigate(`/sim/${imported.id}`);
    } catch (nextError) {
      setImportError(
        nextError instanceof Error
          ? nextError.message
          : t('roundtable.import_error'),
      );
    } finally {
      setImportingReplay(false);
    }
  }, [importingReplay, navigate, replayPayload, t]);

  const selectionUsesShortlist = selectionMode === 'manual_shortlist' || selectionMode === 'fault_line_first';
  const selectedBranchIdsForLaunch = useMemo(
    () => (
      selectionUsesShortlist
        ? normalizeManualShortlist(branchOrder, manualShortlistBranchIds)
        : branchOrder
    ),
    [branchOrder, manualShortlistBranchIds, selectionUsesShortlist],
  );
  const witnessCandidates = useMemo<WitnessCandidate[]>(
    () => selectedBranchIdsForLaunch.flatMap((branchId) => {
      const branch = branchesById.get(branchId);
      const representativeAgentId = selectedRepresentatives[branchId];
      return (branchCandidates[branchId] ?? [])
        .filter((candidate) => candidate.id !== representativeAgentId)
        .map((candidate) => ({
          branchId,
          branchTitle: branch?.title ?? branchId,
          agentId: candidate.id,
          name: candidate.name,
          role: candidate.role,
          persona: candidate.persona,
          impactScore: candidate.impactScore,
        }));
    }),
    [branchCandidates, branchesById, selectedBranchIdsForLaunch, selectedRepresentatives],
  );

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    if (selectionMode === 'trait_mix') {
      setSelectedRepresentatives((current) => {
        const { next, changed } = chooseTraitMixRepresentatives(branchOrder, branchCandidates, current);
        return changed ? next : current;
      });
      setSelectedWitness(null);
      return;
    }
    if (selectionMode === 'fault_line_first') {
      setManualShortlistBranchIds((current) => {
        const normalizedCurrent = normalizeManualShortlist(branchOrder, current);
        const next = chooseFaultLineBranchIds(branchOrder, branchesById, branchCandidates);
        const changed = branchListChanged(normalizedCurrent, next);
        return changed ? next : current;
      });
      setSelectedWitness(null);
      return;
    }
    if (selectionMode === 'witness_augmented') {
      setSelectedWitness((current) => {
        const next = current ?? chooseWitnessAugmentedSelection(witnessCandidates);
        const changed = !sameWitnessSelection(current, next);
        return changed ? next : current;
      });
    }
  }, [branchCandidates, branchOrder, branchesById, replayPayload, selectionMode, witnessCandidates]);

  useEffect(() => {
    if (replayPayload || witnessCandidates.length === 0) {
      return;
    }
    setSelectedWitness((current) => {
      if (selectionMode !== 'expert_witness') {
        return current;
      }
      if (current && witnessCandidates.some((candidate) => (
        candidate.branchId === current.branchId && candidate.agentId === current.agentId
      ))) {
        return current;
      }
      return {
        branchId: witnessCandidates[0].branchId,
        agentId: witnessCandidates[0].agentId,
      };
    });
  }, [replayPayload, selectionMode, witnessCandidates]);

  const toggleManualShortlistBranch = useCallback((branchId: string) => {
    if (!branchOrder.includes(branchId)) {
      return;
    }
    const isRemoving = selectedBranchIdsForLaunch.includes(branchId);
    setManualShortlistBranchIds((current) => {
      const normalized = normalizeManualShortlist(branchOrder, current);
      if (normalized.includes(branchId)) {
        if (normalized.length <= manualShortlistMin) {
          return normalized;
        }
        return normalized.filter((item) => item !== branchId);
      }
      if (normalized.length >= manualShortlistMax) {
        return normalized;
      }
      return normalizeManualShortlist(branchOrder, [...normalized, branchId]);
    });
    if (isRemoving) {
      setSelectedRepresentatives((current) => {
        if (!(branchId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[branchId];
        return next;
      });
      setSelectedWitness((current) => (
        current?.branchId === branchId ? null : current
      ));
    }
  }, [branchOrder, manualShortlistMax, manualShortlistMin, selectedBranchIdsForLaunch]);

  const handleSelectionModeChange = useCallback((nextMode: RoundtableSelectionMode) => {
    setSelectionMode(nextMode);
    if (nextMode === 'manual_shortlist') {
      setManualShortlistBranchIds((current) => {
        const normalized = normalizeManualShortlist(branchOrder, current);
        if (normalized.length >= manualShortlistMin && normalized.length <= manualShortlistMax) {
          return normalized;
        }
        return buildDefaultManualShortlist(branchOrder);
      });
    }
    if (nextMode === 'fault_line_first') {
      setManualShortlistBranchIds((current) => {
        const normalizedCurrent = normalizeManualShortlist(branchOrder, current);
        const next = chooseFaultLineBranchIds(branchOrder, branchesById, branchCandidates);
        const changed = branchListChanged(normalizedCurrent, next);
        return changed ? next : current;
      });
      setSelectedWitness(null);
    }
    if (nextMode === 'trait_mix') {
      setSelectedRepresentatives((current) => {
        const { next, changed } = chooseTraitMixRepresentatives(branchOrder, branchCandidates, current);
        return changed ? next : current;
      });
      setSelectedWitness(null);
    }
    if (nextMode === 'expert_witness') {
      setSelectedWitness((current) => current ?? (witnessCandidates[0]
        ? { branchId: witnessCandidates[0].branchId, agentId: witnessCandidates[0].agentId }
        : null));
    }
    if (nextMode === 'witness_augmented') {
      setSelectedWitness((current) => {
        const next = chooseWitnessAugmentedSelection(witnessCandidates);
        const changed = !sameWitnessSelection(current, next);
        return changed ? next : current;
      });
    }
  }, [branchCandidates, branchOrder, branchesById, manualShortlistMax, manualShortlistMin, witnessCandidates]);

  const handleLaunchRoundtable = useCallback(async () => {
    if (!scenario?.id || launchingRoom || selectedBranchIdsForLaunch.length === 0) return;
    setLaunchingRoom(true);
    setError('');
    try {
      reset();
      const roomId = await openRoom(scenario.id, {
        roomType: 'worldline_roundtable',
        selectedBranchIds: selectedBranchIdsForLaunch,
        selectedRepresentatives: selectedBranchIdsForLaunch
          .map((branchId) => {
            const agentId = selectedRepresentatives[branchId];
            return agentId
              ? { branchId, agentId }
              : null;
          })
          .filter((value): value is RoundtableRepresentativeSelection => Boolean(value)),
        selectedWitness: (selectionMode === 'expert_witness' || selectionMode === 'witness_augmented')
          ? (
            selectedWitness
            ?? (witnessCandidates[0]
              ? { branchId: witnessCandidates[0].branchId, agentId: witnessCandidates[0].agentId }
              : null)
          )
          : null,
        selectionRecipe: selectionMode,
        language: uiLanguage,
      });
      await loadRoom(roomId);
      setEditingRepresentatives(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLaunchingRoom(false);
    }
  }, [launchingRoom, loadRoom, openRoom, reset, scenario?.id, selectedBranchIdsForLaunch, selectedRepresentatives, selectedWitness, selectionMode, uiLanguage, witnessCandidates]);

  const handleEditRepresentatives = useCallback(() => {
    setEditingRepresentatives(true);
    if (typeof window.scrollTo === 'function') {
      try {
        window.scrollTo({ top: 0, behavior: getPreferredScrollBehavior() });
      } catch {
        // jsdom does not implement window.scrollTo; ignore in tests.
      }
    }
  }, []);

  const handleSend = useCallback(async () => {
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
    if (interactionMode === 'hotseat' && selectedRepresentativeId && snapshot?.id) {
      const currentTargetRef = activeThread?.addressed_agent_ids_json?.[0] ?? null;
      const currentTarget = representatives.find((participant) => (
        participant.id === currentTargetRef
        || participant.worldline_echo_key === currentTargetRef
        || participant.source_agent_id === currentTargetRef
      ))?.id ?? currentTargetRef;
      const existingHotseatThread = threadList.find((thread) => {
        if (thread.mode !== 'followup' || thread.interaction_mode !== 'hotseat') {
          return false;
        }
        const threadTargetRef = thread.addressed_agent_ids_json?.[0] ?? null;
        const threadTarget = representatives.find((participant) => (
          participant.id === threadTargetRef
          || participant.worldline_echo_key === threadTargetRef
          || participant.source_agent_id === threadTargetRef
        ))?.id ?? threadTargetRef;
        return threadTarget === selectedRepresentativeId;
      });
      const needsThread = !activeThread
        || activeThread.mode !== 'followup'
        || activeThread.interaction_mode !== 'hotseat'
        || currentTarget !== selectedRepresentativeId;
      if (needsThread) {
        if (existingHotseatThread) {
          setActiveThread(existingHotseatThread.id);
          await loadThread(existingHotseatThread.id);
        } else {
          const selectedRepresentative = representatives.find((participant) => participant.id === selectedRepresentativeId);
          const thread = await createThread(snapshot.id, {
            title: selectedRepresentative?.display_name ?? null,
            addressedAgentIds,
            questionAnchorIds: pendingQuestionAnchorIds,
            interactionMode: 'hotseat',
          });
          await loadThread(thread.id);
        }
      }
    }
    try {
      await appendUserTurn({
        content,
        addressedAgentIds,
        questionAnchorIds: pendingQuestionAnchorIds,
        interactionMode,
      });
      setPendingQuestionAnchorIds([]);
    } catch {
      // The store keeps the live room usable and reloads after slow follow-up failures.
    }
  }, [
    activeThread,
    addressedAgentIds,
    appendUserTurn,
    composerDraft,
    createThread,
    interactionMode,
    loadThread,
    pendingQuestionAnchorIds,
    representatives,
    selectedRepresentativeId,
    setActiveThread,
    snapshot?.id,
    threadList,
  ]);

  const handleTranscriptScroll = useCallback(() => {
    if (transcriptListRef.current) {
      transcriptScrollSnapshotRef.current = captureTranscriptScrollSnapshot(transcriptListRef.current);
      const el = transcriptListRef.current;
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      transcriptAutoStickRef.current = isAtBottom;
      if (isAtBottom) {
        setNewMessageCount(0);
      }
    }
  }, []);

  useEffect(() => {
    const win = window as AutomationWindow & {
      advanceTime?: (ms: number) => Promise<void>;
    };
    const render = () => stringifyAutomationPayload(
      {
        question: storyData?.question ?? null,
        status: loading ? 'loading' : error ? 'error' : effectiveSnapshot?.status ?? 'idle',
        currentRound: effectiveSnapshot?.turns.length ?? 0,
        totalRounds: effectiveSnapshot?.turns.length ?? 0,
        viewMode: 'classic',
        visualizationEnabled: true,
        isSimulationComplete: Boolean(effectiveResult),
        messageCount: currentTurns.length + displayedDrafts.length,
        agentCount: participants.length,
        branchCount: storyData?.branches.length ?? 0,
      },
      effectiveSnapshot ? {
        scene: 'WorldlineRoundtable',
        phase: effectiveSnapshot.current_phase,
        room_id: effectiveSnapshot.id,
        visible_turn_count: currentTurns.length + displayedDrafts.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'worldline_roundtable',
        error: error ? { code: 'ROUNDTABLE_ERROR', label: error } : null,
        controls: {
          can_send: composerEnabled,
          is_read_only: Boolean(replayPayload),
          showing_picker: showRepresentativePicker,
          selection_mode: selectionMode,
          selected_branch_count: selectedBranchIdsForLaunch.length,
          has_witness: participants.some((participant) => participant.role_slot === 'critic'),
          active_thread_id: activeThread?.id ?? null,
          thread_count: threadList.length,
          interaction_mode: automationInteractionMode,
          current_speaker_turn_key: activeSpeakerTurnKey,
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
          participant_count: participants.length,
          representative_count: representatives.length,
          has_result: Boolean(effectiveResult),
          can_reseat_representatives: !replayPayload && Boolean(effectiveSnapshot),
        },
      },
    );
    win.render_game_to_text = render;
    win.advanceTime = async (ms: number) => {
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
    };
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
      if (win.advanceTime) {
        delete win.advanceTime;
      }
    };
  }, [
    activeThread?.id,
    composerEnabled,
    currentTurns.length,
    currentSpeakerParticipantId,
    activeSpeakerTurnKey,
    participants,
    effectiveResult,
    effectiveSnapshot,
    error,
    interactionMode,
    automationInteractionMode,
    loading,
    displayedDrafts.length,
    automationPendingDrafts,
    automationStreamState,
    replayPayload,
    representatives.length,
    pendingQuestionAnchorIds,
    selectedBranchIdsForLaunch.length,
    selectionMode,
    showRepresentativePicker,
    transcriptLayoutTelemetry,
    storyData?.branches.length,
    storyData?.question,
    threadList.length,
    activeThread?.question_anchor_ids_json,
    activeThreadAnchorSummary,
  ]);

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(scenario ? `/result/${scenario.id}` : '/');
  }, [navigate, scenario]);

  return (
    <div
      className={`worldline-roundtable-view oracle-skin oracle-skin--${oracleProfile.id} ${isLiveRoom ? 'is-live-room' : ''} ${showRepresentativePicker ? 'is-picker-open' : ''}`}
      data-profile={oracleProfile.id}
      style={{ '--oracle-profile-frame': `url(${oracleProfileFrameSrc})` } as CSSProperties}
    >
      <header className="worldline-roundtable-hero">
        <div className="worldline-roundtable-hero__topline">
          <button type="button" className="btn btn-ghost" onClick={handleBack}>
            {t('roundtable.back_to_results')}
          </button>
          <div
            className="worldline-roundtable-hero__actions"
          >
            <div className="roundtable-hero-action-menu" ref={actionMenuRef}>
              {(effectiveSnapshot || replayPayload) && (
              <button
                type="button"
                className="roundtable-hero-action-menu__trigger"
                onClick={() => setActionMenuOpen((prev) => !prev)}
                aria-expanded={actionMenuOpen}
                aria-label={t('roundtable.more_actions')}
              >
                ···
              </button>
              )}
              {actionMenuOpen && (
                <div className="roundtable-hero-action-menu__dropdown">
                  {!replayPayload && effectiveSnapshot && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionMenuOpen(false);
                        if (editingRepresentatives) {
                          setEditingRepresentatives(false);
                          return;
                        }
                        handleEditRepresentatives();
                      }}
                    >
                      {editingRepresentatives
                        ? t('roundtable.back_to_table')
                        : t('roundtable.reseat_reopen')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setActionMenuOpen(false); void handleCopyPermalink(); }}
                    disabled={!effectiveReplayPayload}
                  >
                    {permalinkCopied
                      ? t('roundtable.replay_copied')
                      : t('roundtable.copy_replay')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionMenuOpen(false); handleSaveLocalCopy(); }}
                    disabled={!effectiveReplayPayload}
                  >
                    {localCopySaved
                      ? t('roundtable.readonly_saved')
                      : t('roundtable.save_readonly')}
                  </button>
                  {replayPayload?.scenarioReplay && (
                    <button
                      type="button"
                      onClick={() => { setActionMenuOpen(false); void handleImportReplay(); }}
                      disabled={importingReplay}
                    >
                      {importingReplay
                        ? t('roundtable.importing')
                        : t('roundtable.import_replay')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="worldline-roundtable-hero__body">
          <div className="worldline-roundtable-hero__copy">
            <p className="worldline-roundtable-hero__kicker">{t('roundtable.entry_cta')}</p>
            <h1>{t('roundtable.title')}</h1>
            <p>{storyData?.question ?? t('roundtable.entry_hint')}</p>
            <div className="worldline-roundtable-hero__meta">
              <span className="archive-chip archive-chip--primary">
                {getEndingRoomStatusLabel(loading ? 'loading' : (effectiveSnapshot?.status ?? 'draft'), t)}
              </span>
              <span className="archive-chip archive-chip--profile">{oracleProfileLabel}</span>
            </div>
            <div className="worldline-roundtable-theme-strip" aria-label={t('roundtable.theme_cues_label')}>
              {oracleProfileHooks.slice(0, 3).map((hook) => (
                <span key={hook} className="worldline-roundtable-theme-chip">{hook}</span>
              ))}
            </div>
          </div>
          <div className="worldline-roundtable-hero__stage">
            <div className="worldline-roundtable-hero__stage-head">
              <img
                className="worldline-roundtable-hero__stage-badge"
                src={ORACLE_UI_ASSETS.badgeWorldlineRoundtable}
                alt=""
                aria-hidden="true"
              />
              <div>
                <p className="worldline-roundtable-hero__stage-kicker">
                  {t('roundtable.table_status')}
                </p>
                <strong>{loading ? t('common.loading') : getEndingRoomStatusLabel(effectiveSnapshot?.status ?? 'draft', t)}</strong>
              </div>
            </div>
            <div className="worldline-roundtable-hero__stage-metrics">
              <span>{t('roundtable.hosted_by_archivist')}</span>
              <span>{`${representatives.length} ${t('roundtable.representatives_title')}`}</span>
              <span>{t('roundtable.scope_this_table')}</span>
            </div>
          </div>
        </div>
      </header>

      {loading && <div className="worldline-roundtable-empty">{t('roundtable.loading')}</div>}
      {!loading && error && <div className="worldline-roundtable-empty worldline-roundtable-empty--error">{error}</div>}
      {!loading && !error && importError && <div className="worldline-roundtable-empty worldline-roundtable-empty--error">{importError}</div>}

      {showRepresentativePicker && (
        <RoundtablePickerPanel
          isZh={isZh}
          selectionMode={selectionMode}
          onSelectionModeChange={handleSelectionModeChange}
          effectiveSnapshot={effectiveSnapshot}
          branches={storyData?.branches ?? []}
          branchOrder={branchOrder}
          branchCandidates={branchCandidates}
          selectedRepresentatives={selectedRepresentatives}
          onSelectRepresentative={(branchId, agentId) => setSelectedRepresentatives((current) => ({ ...current, [branchId]: agentId }))}
          selectedBranchIdsForLaunch={selectedBranchIdsForLaunch}
          selectionUsesShortlist={selectionUsesShortlist}
          manualShortlistMin={manualShortlistMin}
          manualShortlistMax={manualShortlistMax}
          onToggleManualShortlistBranch={toggleManualShortlistBranch}
          witnessCandidates={witnessCandidates}
          selectedWitness={selectedWitness}
          onSelectWitness={setSelectedWitness}
          launchingRoom={launchingRoom}
          onLaunchRoundtable={() => void handleLaunchRoundtable()}
          onCancelEditing={() => setEditingRepresentatives(false)}
        />
      )}

      {!loading && !error && effectiveSnapshot && !showRepresentativePicker && (
        <div className="worldline-roundtable-shell">
          <aside className="worldline-roundtable-sidebar">
            <details
              className="worldline-roundtable-sidebar__collapsible"
              aria-label={t('roundtable.participant_details')}
              open={!isTabletViewport}
            >
              <summary className="worldline-roundtable-sidebar__summary">
                <span>{t('roundtable.reps_summary', { count: representatives.length })}</span>
              </summary>
            {/* Verdict card removed — single verdict display lives in synthesis block */}

            <section className="worldline-roundtable-card">
              <div className="worldline-roundtable-card__heading">
                <h3>{t('roundtable.representatives_title')}</h3>
                <div className="worldline-roundtable-card__heading-actions">
                  <span>{representatives.length}</span>
                </div>
              </div>
              {/* D-11: Collapsed avatar ring row */}
              {!rosterExpanded && (
                <div className="roundtable-avatar-ring-row">
                  {participants.slice(0, 8).map((participant) => (
                    <button
                      key={participant.id}
                      type="button"
                      className="roundtable-avatar-ring-item"
                      onClick={() => setRosterExpanded(true)}
                    >
                      <AvatarRing
                        src={getParticipantSprite(participant)}
                        alt={participant.display_name}
                        size={42}
                        isSpeaking={currentSpeakerParticipantId === participant.id}
                      />
                    </button>
                  ))}
                  {participants.length > 8 && (
                    <button
                      type="button"
                      className="roundtable-avatar-ring-row__more-badge"
                      onClick={() => setRosterExpanded(true)}
                    >
                      {t('common.more_count', { count: participants.length - 8 })}
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                className="roundtable-roster-toggle-btn"
                onClick={() => setRosterExpanded((prev) => !prev)}
              >
                {rosterExpanded ? t('roundtable.collapse_roster') : t('roundtable.expand_roster')}
              </button>
              {/* D-11: Full roster — always in DOM, hidden via CSS when collapsed */}
              <div className={`worldline-roundtable-roster ${!rosterExpanded ? 'roundtable-roster-hidden' : ''}`}>
                {participants.map((participant) => {
                  const branch = participant.source_branch_id
                    ? branchesById.get(participant.source_branch_id)
                    : null;
                  const isHotseatTarget = interactionMode === 'hotseat' && participant.role_slot === 'representative';
                  const selected = selectedRepresentativeId === participant.id;
                  const isCurrentSpeaker = currentSpeakerParticipantId === participant.id;
                  const isHotseatFocus = hotseatParticipantId === participant.id;
                  const impactScore = getParticipantImpactScore(participant);
                  const selectionReason = getSelectionReasonLabel(
                    String(participant.persona_snapshot_json?.selection_reason ?? ''),
                    isZh,
                    t,
                  );
                  return (
                    <button
                      key={participant.id}
                      type="button"
                      className={`worldline-roundtable-seat ${selected ? 'is-selected' : ''} ${participant.role_slot === 'archivist' ? 'is-archivist' : ''} ${participant.role_slot === 'representative' ? 'is-representative' : ''} ${isCurrentSpeaker ? 'is-current-speaker' : ''} ${isHotseatFocus ? 'is-hotseat-target' : ''}`}
                      onClick={() => {
                        if (!isHotseatTarget) return;
                        setSelectedRepresentativeId(participant.id);
                      }}
                      disabled={!isHotseatTarget || Boolean(replayPayload)}
                    >
                      <span className="worldline-roundtable-seat__frame" aria-hidden="true" />
                      <img src={getParticipantSprite(participant)} alt="" aria-hidden="true" />
                      <div className="worldline-roundtable-seat__copy">
                        <div className="worldline-roundtable-seat__title">
                          <strong>{participant.display_name}</strong>
                          {isCurrentSpeaker && (
                            <span className="worldline-roundtable-seat__status">
                              {t('roundtable.speaking_now')}
                            </span>
                          )}
                          {!isCurrentSpeaker && isHotseatFocus && (
                            <span className="worldline-roundtable-seat__status worldline-roundtable-seat__status--hotseat">
                              {t('roundtable.hotseat_target')}
                            </span>
                          )}
                        </div>
                        <span>
                          {participant.role_slot === 'archivist'
                            ? t('roundtable.role_archivist')
                            : participant.role_slot === 'critic'
                              ? t('roundtable.role_witness')
                            : (branch?.title ?? t('roundtable.role_representative'))}
                        </span>
                        {branch && (
                          <small>
                            {Math.round((branch.probability ?? 0) * 100)}%
                            {' · '}
                            {branch.insight}
                          </small>
                        )}
                        <div className="worldline-roundtable-seat__metrics">
                          {impactScore > 0 && (
                            <span>{t('roundtable.impact_score', { score: Math.round(impactScore * 100) })}</span>
                          )}
                          {selectionReason && <span>{selectionReason}</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {effectiveResult?.phase_insights?.length ? (
              <section className="roundtable-phase-section">
                <div className="worldline-roundtable-card__heading">
                  <h3>{t('roundtable.phase_insights_title')}</h3>
                  <span className="roundtable-phase-count">{effectiveResult.phase_insights.length}</span>
                </div>
                <Accordion
                  type="single"
                  collapsible
                  className="roundtable-phase-timeline"
                  aria-label={t('roundtable.phase_insights_label')}
                >
                  {effectiveResult.phase_insights.map((insight, index) => {
                    const phaseTitle = buildPhaseInsightTitle(insight, { isZh })
                      || buildPhaseInsightLabel(insight, { isZh, t });
                    const phaseCommentary = buildPhaseInsightCommentary(insight, { isZh });
                    const phaseClass = isEndingRoomPhase(insight.phase)
                      ? `phase-chip--${insight.phase}`
                      : 'phase-chip--unknown';
                    const chipLabel = isEndingRoomPhase(insight.phase)
                      ? getEndingRoomPhaseLabel(insight.phase, t)
                      : t('roundtable.phase_unknown');
                    return (
                      <AccordionItem key={`${insight.phase}-${index}`} value={`${insight.phase}-${index}`} className="roundtable-phase-timeline__item">
                        <AccordionTrigger className="editorial-chapter-trigger roundtable-phase-timeline__trigger">
                          <span className="roundtable-phase-timeline__dot" aria-hidden="true" />
                          <span className={`phase-chip ${phaseClass}`}>
                            {chipLabel}
                          </span>
                          <span className="phase-insight-body">
                            <span className="phase-insight-title">{phaseTitle}</span>
                            {insight.stakes && (
                              <span className="phase-insight-stakes">{insight.stakes}</span>
                            )}
                          </span>
                        </AccordionTrigger>
                        <AccordionContent className="roundtable-phase-timeline__content">
                          <article className="worldline-roundtable-insight worldline-roundtable-insight__expanded-content phase-insight-expanded">
                            <div className="phase-insight-expanded__meta">
                              {insight.stakes && (
                                <span className="phase-insight-expanded__stakes">{insight.stakes}</span>
                              )}
                              {insight.moderator_focus && (
                                <span className="phase-insight-expanded__focus">
                                  {t('roundtable.insight_focus_label')}: {insight.moderator_focus}
                                </span>
                              )}
                            </div>
                            <p className="phase-insight-expanded__body">{phaseCommentary}</p>
                            {!replayPayload && (
                              <div className="worldline-roundtable-insight__actions phase-insight-expanded__actions">
                                <button
                                  type="button"
                                  className="ending-chat-inline-button"
                                  onClick={() => activateAnchor(phaseActionPrompts[index].action)}
                                  disabled={!composerEnabled}
                                >
                                  {t('roundtable.action_follow_phase')}
                                </button>
                                <button
                                  type="button"
                                  className="ending-chat-inline-button"
                                  onClick={() => void handleStartAnchoredThread(phaseActionPrompts[index].action)}
                                  disabled={!composerEnabled}
                                >
                                  {t('roundtable.action_new_thread')}
                                </button>
                              </div>
                            )}
                          </article>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              </section>
            ) : null}
            </details>
          </aside>

          <section className="worldline-roundtable-main">
            {effectiveResult?.summary && id && (
              <PersonalityDriftWarning scenarioId={id} enabled={driftWarningEnabled} />
            )}
            {effectiveResult?.summary && (
              <section className="worldline-roundtable-synthesis">
                <span className="worldline-roundtable-synthesis__eyebrow">{t('roundtable.phase_verdict')}</span>
                <div className="editorial-report-chapter">
                  <span className="editorial-report-number" aria-hidden="true">01</span>
                  <div>
                    <span className="editorial-report-label">{t('roundtable.report_verdict')}</span>
                    <h2 className="worldline-roundtable-synthesis__title">{effectiveResult.summary}</h2>
                  </div>
                </div>
                {effectiveResult.next_move && (
                  <div className="editorial-report-chapter">
                    <span className="editorial-report-number" aria-hidden="true">02</span>
                    <div>
                      <span className="editorial-report-label">{t('roundtable.report_next_steps')}</span>
                      <p className="worldline-roundtable-synthesis__next-move">{effectiveResult.next_move}</p>
                    </div>
                  </div>
                )}
                {hasDistinctArchivistNote && effectiveResult.archivist_note && (
                  <div className="editorial-report-chapter">
                    <span className="editorial-report-number" aria-hidden="true">03</span>
                    <div>
                      <span className="editorial-report-label">{t('roundtable.report_archivist')}</span>
                      <p className="worldline-roundtable-synthesis__note">{effectiveResult.archivist_note}</p>
                    </div>
                  </div>
                )}
                {isLiveRoom && !replayPayload && (
                  <div className="worldline-roundtable-synthesis__actions">
                    {renderSummaryActions()}
                  </div>
                )}
              </section>
            )}
            <div className="ending-chat-transcript-header worldline-roundtable-transcript-header">
              <div>
                <h3>{t('roundtable.transcript_title')}</h3>
                <p>{transcriptSubtitle}</p>
              </div>
              <div className="ending-chat-transcript-header__meta">
                <span className="ending-chat-note">
                  {activeThread ? (threadDisplayLabels[activeThread.id] ?? getThreadLabel(activeThread, isZh, t)) : t('roundtable.loading')}
                </span>
                {activeThreadAnchorSummary && (
                  <div className="ending-chat-anchor-summary" title={activeThreadAnchorSummary.label}>
                    <span className="ending-chat-anchor-summary__kind">{activeThreadAnchorSummary.kindLabel}</span>
                    <span className="ending-chat-anchor-summary__label">{activeThreadAnchorSummary.label}</span>
                  </div>
                )}
              </div>
            </div>

            {(phaseList.length > 1 || postVerdictEnabled) && (
              <nav className="roundtable-phase-nav" aria-label={t('roundtable.phase_nav_label')}>
                {phaseList.length > 1 && phaseList.map((phase) => (
                  <button
                    key={phase}
                    type="button"
                    className="roundtable-phase-nav__pill"
                    onClick={() => {
                      const slug = phase.replace(/\s+/g, '-').toLowerCase();
                      const target = transcriptListRef.current?.querySelector(`#phase-${CSS.escape(slug)}`);
                      target?.scrollIntoView({ behavior: getPreferredScrollBehavior(), block: 'start' });
                    }}
                  >
                    {phase}
                  </button>
                ))}
                {postVerdictEnabled && (
                  <>
                    {phaseList.length > 1 && <span className="roundtable-phase-nav__divider" aria-hidden="true" />}
                    <button
                      type="button"
                      className={`roundtable-phase-nav__pill is-explore ${showPostVerdict ? 'is-active' : ''}`}
                      onClick={() => setShowPostVerdict((prev) => !prev)}
                    >
                      {t('roundtable.explore_tab')}
                    </button>
                  </>
                )}
              </nav>
            )}

            {threadList.length > 0 && (
              <div className="ending-chat-thread-rail" role="tablist" aria-label={t('roundtable.threads_label')}>
                {threadList.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`ending-chat-thread-chip ${(activeThread?.id ?? defaultThreadId) === thread.id ? 'is-active' : ''} ${thread.mode === 'room' ? 'is-room-thread' : ''} ${thread.interaction_mode === 'hotseat' ? 'is-hotseat-thread' : ''}`}
                    role="tab"
                    aria-selected={(activeThread?.id ?? defaultThreadId) === thread.id}
                    onClick={() => {
                      const nextMode = thread.mode === 'followup' ? thread.interaction_mode : 'archivist_route';
                      if (replayPayload) {
                        setReplayActiveThreadId(thread.id);
                      } else {
                        setActiveThread(thread.id);
                      }
                      setInteractionMode(nextMode);
                      setSelectedRepresentativeId(resolveThreadRepresentativeId(thread));
                      if (!replayPayload && thread.mode === 'followup') {
                        void loadThread(thread.id);
                      }
                    }}
                  >
                    <span className="ending-chat-thread-chip__label">{threadDisplayLabels[thread.id] ?? getThreadLabel(thread, isZh, t)}</span>
                    {threadAnchorSummaries[thread.id] && (
                      <span className="ending-chat-thread-chip__anchor" title={threadAnchorSummaries[thread.id].label}>
                        {threadAnchorSummaries[thread.id].kindLabel}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

              <div className="roundtable-transcript-wrapper">
                <RoundtableTranscriptList
                  listRef={transcriptListRef}
                  onScroll={handleTranscriptScroll}
                  isZh={isZh}
                  currentTurns={currentTurns}
                  transcriptBubbleLayouts={transcriptBubbleLayouts}
                  activeThreadId={activeThread?.id ?? null}
                  activeSpeakerTurnKey={activeSpeakerTurnKey}
                  hotseatParticipantId={hotseatParticipantId}
                  expandedTurnKeys={expandedTurnKeys}
                  onToggleExpand={(turnKey) => setExpandedTurnKeys((current) => ({ ...current, [turnKey]: !(current[turnKey] ?? false) }))}
                  composerEnabled={composerEnabled}
                  isReplay={Boolean(replayPayload)}
                  displayedDrafts={displayedDrafts}
                  transcriptDraftLayouts={transcriptDraftLayouts}
                  participantsById={participantsById}
                  speakerIndexMap={speakerIndexMap}
                  factionMap={factionMap}
                  spotlightTurnKey={activeSpeakerTurnKey ?? undefined}
                  onHotseatQuote={handleHotseatQuote}
                  onFollowQuote={handleFollowQuote}
                  onQuoteThread={handleQuoteThread}
                />
                {newMessageCount > 0 && (
                  <button
                    type="button"
                    className="roundtable-new-message-pill"
                    onClick={handleScrollToBottom}
                  >
                    {t('roundtable.new_messages', { count: newMessageCount })}
                  </button>
                )}
              </div>

            {showPostVerdict && postVerdictEnabled && effectiveResult && (
              <PostVerdictPanel
                key={`post-verdict:${postVerdictContextVersion}`}
                scenarioId={id ?? ''}
                roomId={effectiveSnapshot?.id ?? null}
                participants={participants}
                effectiveResult={effectiveResult}
                isZh={isZh}
                activeTab={postVerdictTab}
                onTabChange={setPostVerdictTab}
                analystCache={analystCache}
                setAnalystCache={setAnalystCache}
                surveyCache={surveyCache}
                setSurveyCache={setSurveyCache}
                contextVersion={postVerdictContextVersion}
              />
            )}

            <button
              ref={mobileRosterTriggerRef}
              type="button"
              className="roundtable-mobile-roster-trigger"
              aria-expanded={showMobileRoster}
              aria-controls="mobile-roster-dialog"
              onClick={() => setShowMobileRoster(true)}
            >
              {t('roundtable.participant_count', { count: participants.length })}
            </button>

            <div className="ending-chat-composer worldline-roundtable-composer">
              <div className="ending-chat-composer__row">
                <div className="ending-chat-mode-switch" role="group" aria-label={t('roundtable.follow_up_mode')}>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'archivist_route' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('archivist_route')}
                    disabled={!composerEnabled}
                  >
                    {getArchivistModeLabel(isZh, t)}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'hotseat' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('hotseat')}
                    disabled={!composerEnabled || representatives.length === 0}
                  >
                    {getRepresentativeHotseatLabel(isZh, t)}
                  </button>
                </div>
                <span className="ending-chat-scope-notice">{transcriptSubtitle}</span>
              </div>
              <span className="ending-chat-mode-note">{interactionModeNote}</span>

              {phaseActionPrompts.length > 0 && (
                <div className="roundtable-anchor-strip">
                  <button
                    type="button"
                    className="roundtable-anchor-strip__chip"
                    onClick={() => activateAnchor(verdictAnchorAction)}
                    disabled={!composerEnabled}
                  >
                    <span className="roundtable-anchor-strip__icon" aria-hidden="true">⊕</span>
                    <span>{t('roundtable.phase_verdict')}</span>
                  </button>
                  {phaseActionPrompts.map((prompt, idx) => {
                    const insight = (effectiveResult?.phase_insights ?? [])[idx];
                    const fullTitle = buildPhaseInsightTitle(
                      insight ?? { phase: 'opening' },
                      { isZh },
                    ) || prompt.label;
                    const fullText = insight?.commentary || fullTitle;
                    return (
                      <button
                        key={prompt.key}
                        type="button"
                        className="roundtable-anchor-strip__chip"
                        onClick={() => activateAnchor(prompt.action)}
                        disabled={!composerEnabled}
                        title={fullText}
                      >
                        <span className="roundtable-anchor-strip__num" aria-hidden="true">{String(idx + 1).padStart(2, '0')}</span>
                        <span className="roundtable-anchor-strip__text">{fullTitle}</span>
                      </button>
                    );
                  })}
                </div>
              )}

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
                    {t('roundtable.action_thread_from_anchor')}
                  </button>
                </div>
              )}

              {interactionMode === 'hotseat' && representatives.length > 0 && (
                <div className="ending-chat-hotseat-row">
                  {representatives.map((participant) => (
                    <button
                      key={participant.id}
                      type="button"
                      className={`ending-chat-hotseat-pill ${selectedRepresentativeId === participant.id ? 'is-active' : ''}`}
                      onClick={() => setSelectedRepresentativeId(participant.id)}
                      disabled={!composerEnabled}
                    >
                      {participant.display_name}
                    </button>
                  ))}
                </div>
              )}

              <div className="ending-chat-composer__row">
                <textarea
                  ref={composerTextareaRef}
                  className="ending-chat-composer__input"
                  value={composerDraft}
                  aria-label={t('roundtable.composer_label')}
                  placeholder={t('roundtable.composer_placeholder')}
                  onChange={(event) => {
                    setComposerDraft(event.target.value);
                    const el = event.target;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  disabled={!composerEnabled || sending}
                  rows={2}
                />
                <button
                  type="button"
                  className="ending-chat-send"
                  onClick={() => void handleSend()}
                  disabled={!composerEnabled || sending || composerDraft.trim().length === 0}
                >
                  {sending ? t('roundtable.sending') : t('roundtable.send')}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {showMobileRoster && (
        <div
          className="roundtable-mobile-roster-overlay"
          onClick={() => setShowMobileRoster(false)}
        >
          <div
            ref={mobileRosterDialogRef}
            id="mobile-roster-dialog"
            className="roundtable-mobile-roster-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-roster-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="roundtable-mobile-roster-modal__header">
              <h3 id="mobile-roster-title">{t('roundtable.participants')}</h3>
              <button type="button" onClick={() => setShowMobileRoster(false)} aria-label={t('common.close')}>✕</button>
            </div>
            <div className="worldline-roundtable-roster">
              {participants.map((participant) => {
                const branch = participant.source_branch_id ? branchesById.get(participant.source_branch_id) : null;
                return (
                  <div key={participant.id} className={`worldline-roundtable-seat ${participant.role_slot === 'archivist' ? 'is-archivist' : ''}`}>
                    <img src={getParticipantSprite(participant)} alt="" aria-hidden="true" />
                    <div className="worldline-roundtable-seat__copy">
                      <strong>{participant.display_name}</strong>
                      <span>
                        {participant.role_slot === 'archivist'
                          ? t('roundtable.role_archivist')
                          : participant.role_slot === 'critic'
                            ? t('roundtable.role_witness')
                          : (branch?.title ?? t('roundtable.role_representative'))}
                      </span>
                      {branch && <small>{Math.round((branch.probability ?? 0) * 100)}%</small>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
