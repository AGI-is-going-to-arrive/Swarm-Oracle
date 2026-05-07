/* ═══════════════════════════════════════════════════════════
   SwarmOracle — SimulationView (Main Simulation Page)
   ═══════════════════════════════════════════════════════════ */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SimWarmupNarrative } from '../components/SimWarmupNarrative';
import { TheaterCurtain } from '../components/TheaterCurtain';
import '../components/SimWarmup.css';
import { useSimulationStore } from '../stores/simulationStore';
import { useSimulationWS } from '../hooks/useSimulationWS';
import { useSimulationReplayState } from '../hooks/useSimulationReplayState';
import {
  useSimulationCaptureControls,
  useSimulationDirectorState,
} from '../hooks/useSimulationViewState';
import {
  createReplayArtifact,
  importReplayScenario,
} from '../api/client';
import { buildAutomationErrorState } from '../lib/apiErrorMessage';
import {
  ensureScenarioObjectives,
  getScenarioArchiveKeyMoments,
} from '../lib/scenarioMeta';
import { copyText } from '../lib/copyText';
import { hasScenarioDirectorAuthority } from '../lib/scenarioDirectorState';
import { hasScenarioGameplayAuthority } from '../lib/scenarioGameplayState';
import {
  getGameplayCardDefinition,
  getGameplaySignatureArcState,
  getScenarioSystemTrackState,
  inferGameplayProfile,
} from '../components/gameplayCards';
import {
  buildDefaultDirectorObjectives,
  countCompletedObjectives,
  evaluateDirectorObjectives,
} from '../lib/directorObjectives';
import { preloadPhaserGame } from '../game/phaserPreload';
const LazyClassicBranchTree = lazy(() =>
  import('../components/ClassicBranchTree').then((mod) => ({ default: mod.ClassicBranchTree }))
);
const LazyAgentPanel = lazy(() =>
  import('../components/AgentPanel').then((mod) => ({ default: mod.AgentPanel }))
);
const LazyTimelineBar = lazy(() =>
  import('../components/TimelineBar').then((mod) => ({ default: mod.TimelineBar }))
);
const LazyInterventionModal = lazy(() => import('../components/InterventionModal'));
const LazyBranchDetailModal = lazy(() => import('../components/BranchDetailModal'));
const LazyPredictionModal = lazy(() => import('../components/PredictionModal'));
const LazyGameplayCardsModal = lazy(() => import('../components/GameplayCardsModal'));
const loadPhaserGameLoaderModule = () => import('../game/PhaserGameLoader');
const LazyPhaserGameLoader = lazy(() =>
  loadPhaserGameLoaderModule().then((mod) => ({ default: mod.PhaserGameLoader }))
);
const loadSimulationReplayHelpers = () => import('../lib/simulationReplay');
const loadScenarioReplayHelpers = () => import('../lib/scenarioReplay');
import {
  filterReplayMessages,
} from '../game/replaySelection';
import {
  stringifyAutomationPayload,
  type AutomationWindow,
} from '../game/automation';
import { HudOverlay } from '../game/HudOverlay';
import { getTheaterThemeLabel } from '../lib/themeLabels';
import {
  getScenarioRuntimePresetConfig,
  loadScenarioRuntimePreset,
  matchScenarioRuntimePreset,
} from '../lib/runtimePreset';
import type {
  BranchInfo,
} from '../types';
import {
  THEATER_SCENE_LABELS,
  THEATER_WEATHER_LABELS,
  THEATER_TIME_LABELS,
  WARMUP_RECOVERY_INTERVAL_MS,
  WARMUP_RECOVERY_MAX_ATTEMPTS,
  TAIL_STATUS_SYNC_INTERVAL_MS,
  formatTheaterLabel,
  shouldWarmTheaterLoaderOnIntent,
} from './simulationHelpers';
import './SimulationView.css';

function SimulationSlotFallback({ label }: { label: string }) {
  return <div className="sim-slot-fallback">{label}</div>;
}

export function SimulationView() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const replayToken = searchParams.get('replay');
  const replayShareId = searchParams.get('share');
  const isZh = i18n.language.startsWith('zh');
  const scenario = useSimulationStore((s) => s.scenario);
  const agents = useSimulationStore((s) => s.agents);
  const branches = useSimulationStore((s) => s.branches);
  const messages = useSimulationStore((s) => s.messages);
  const thinkingAgents = useSimulationStore((s) => s.thinkingAgents);
  const status = useSimulationStore((s) => s.status);
  const error = useSimulationStore((s) => s.error);
  const errorCode = useSimulationStore((s) => s.errorCode);
  const loadScenario = useSimulationStore((s) => s.loadScenario);
  const isSimulationComplete = useSimulationStore((s) => s.isSimulationComplete);
  const visualizationEnabled = useSimulationStore((s) => s.visualizationEnabled);
  const viewMode = useSimulationStore((s) => s.viewMode);
  const currentRound = useSimulationStore((s) => s.currentRound);
  const toggleViewMode = useSimulationStore((s) => s.toggleViewMode);
  const setScenario = useSimulationStore((s) => s.setScenario);
  const fallbackRuntimePreset = useMemo(() => loadScenarioRuntimePreset(), []);
  const scenarioRuntimePreset = useMemo(
    () => matchScenarioRuntimePreset(scenario?.fork_debug?.round_checks ?? null),
    [scenario?.fork_debug?.round_checks],
  );
  const activeRuntimePreset = scenarioRuntimePreset ?? fallbackRuntimePreset;
  const activeRuntimePresetConfig = useMemo(
    () => getScenarioRuntimePresetConfig(activeRuntimePreset),
    [activeRuntimePreset],
  );
  const activeRuntimePresetLabel = t(`home.runtime_preset_${activeRuntimePreset}`);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.add('has-simulation-view');
    if (viewMode === 'theater') {
      document.body.classList.add('has-simulation-theater');
    } else {
      document.body.classList.remove('has-simulation-theater');
    }

    return () => {
      document.body.classList.remove('has-simulation-view');
      document.body.classList.remove('has-simulation-theater');
    };
  }, [viewMode]);

  // Intervention modal state
  const [interventionTarget, setInterventionTarget] = useState<{
    branchId: string;
    branchTitle: string;
  } | null>(null);

  // Detail modal state
  const [detailBranch, setDetailBranch] = useState<BranchInfo | null>(null);

  // Prediction modal state (P5-B)
  const [showPrediction, setShowPrediction] = useState(false);
  const [predictionAutomation, setPredictionAutomation] = useState<Record<string, unknown> | null>(null);
  const [showGameplayCards, setShowGameplayCards] = useState(false);
  const [gameplayAutomation, setGameplayAutomation] = useState<Record<string, unknown> | null>(null);
  const [commitmentFeedback, setCommitmentFeedback] = useState<{
    tone: 'info' | 'success';
    message: string;
  } | null>(null);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [replayLinkUnavailable, setReplayLinkUnavailable] = useState(false);
  const [importingReplay, setImportingReplay] = useState(false);
  const lastCommitmentAction = useRef<'commit' | 'clear' | null>(null);
  const commitmentFeedbackTimer = useRef<number | null>(null);
  const recoveryLogEmitted = useRef(false);
  const warmupRecoveryAttempts = useRef(0);
  const defaultObjectivesSeedKey = useRef<string | null>(null);
  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.status === 'ACTIVE'),
    [branches],
  );
  const branchRoundLimits = useMemo(() => {
    const limits: Record<string, number> = {};

    for (const message of messages) {
      limits[message.branch] = Math.max(limits[message.branch] ?? 0, message.round);
    }

    return limits;
  }, [messages]);
  const hasActiveModal = Boolean(showPrediction || showGameplayCards || interventionTarget || detailBranch);
  const {
    captureMode,
    setCaptureMode,
    captureStatus,
    lastCaptureKind,
    theaterSceneState,
    isModalCaptureAvailable,
    captureDoneLabel,
    captureModeDescription,
    handleScreenshotCapture,
    handleGifCapture,
  } = useSimulationCaptureControls({
    id,
    viewMode,
    hasActiveModal,
    t,
  });
  const {
    cycleReplaySpeed,
    handleReplayBranchChange,
    handleReplayRoundChange,
    isReplayMode,
    panelCollapsed,
    playbackMode,
    replayBranchOptions,
    replayPayload,
    replayRounds,
    replaySpeed,
    restartTheaterPlayback,
    selectedReplayBranchId,
    selectedReplayRound,
    setPanelCollapsed,
    theaterMountKey,
  } = useSimulationReplayState({
    replayToken,
    replayShareId,
    viewMode,
    branches,
    messages,
    isSimulationComplete,
    navigate,
  });
  const {
    backendDirectorState,
    setBackendDirectorState,
    backendGameplayState,
    setBackendGameplayState,
    authorityConflictKind,
    clearAuthorityConflictKind,
    storedScenarioMeta,
    scenarioMeta,
    refreshLocalMeta,
    persistDirectorMeta,
    commitmentDraftBranchId,
    setCommitmentDraftBranchId,
    handleGameplayApplied,
    handlePlacedBet,
    handleCommitBranch,
    handleClearCommitment,
  } = useSimulationDirectorState({
    id,
    isReplayMode,
    replayScenarioMeta: replayPayload?.scenarioMeta ?? null,
    scenario,
    activeBranches,
    currentRound,
  });
  useEffect(() => {
    if (!replayPayload) return;
    setScenario(replayPayload.scenario);
    setBackendDirectorState(replayPayload.scenario.director_state ?? null);
    setBackendGameplayState(replayPayload.scenario.gameplay_state ?? null);
  }, [replayPayload, setBackendDirectorState, setBackendGameplayState, setScenario]);
  const gameplayProfile = useMemo(
    () => (scenario ? inferGameplayProfile(scenario.question, scenario.scene_theme) : null),
    [scenario],
  );
  const archiveKeyMoments = useMemo(
    () => (scenarioMeta ? getScenarioArchiveKeyMoments(scenarioMeta) : []),
    [scenarioMeta],
  );
  const signatureArcState = useMemo(
    () => (
      scenarioMeta && gameplayProfile
        ? getGameplaySignatureArcState(gameplayProfile.id, scenarioMeta.cards.usageLog, isZh)
        : null
    ),
    [gameplayProfile, isZh, scenarioMeta],
  );
  const systemTracks = useMemo(
    () => (
      scenarioMeta && gameplayProfile
        ? getScenarioSystemTrackState(gameplayProfile.id, scenarioMeta.cards.usageLog, scenarioMeta.commitment, isZh)
        : null
    ),
    [gameplayProfile, isZh, scenarioMeta],
  );
  const dominantBranch = useMemo(
    () => [...branches].sort((a, b) => b.probability - a.probability)[0] ?? null,
    [branches],
  );
  const evaluatedObjectives = useMemo(
    () => (
      scenarioMeta
        ? evaluateDirectorObjectives({
          objectives: scenarioMeta.objectives.goals,
          meta: scenarioMeta,
          dominantBranch,
          isZh,
          isFinal: isSimulationComplete,
        })
        : []
    ),
    [dominantBranch, isSimulationComplete, isZh, scenarioMeta],
  );
  const completedObjectiveCount = useMemo(
    () => countCompletedObjectives(evaluatedObjectives),
    [evaluatedObjectives],
  );
  const canCopyReplayLink = Boolean(
    replayUrl || (scenario && storedScenarioMeta && !replayLinkUnavailable),
  );
  const timelineRoundMarkers = useMemo(() => {
    if (!scenario?.total_rounds) return [];

    const cardUsage = scenarioMeta?.cards.usageLog ?? [];
    const bets = scenarioMeta?.betting.bets ?? [];
    const completedEndings = branches.filter((branch) => branch.status === 'COMPLETED');

    return Array.from({ length: scenario.total_rounds }, (_, index) => {
      const round = index + 1;
      const forkedBranches = branches.filter(
        (branch) => Boolean(branch.parent_branch_id) && (branch.fork_round ?? 0) === round,
      );
      const cardEntries = cardUsage.filter((entry) => entry.round === round);
      const betEntries = bets.filter((bet) => bet.placedAtRound === round);
      return {
        round,
        isAvailable: replayRounds.includes(round),
        isSelected: selectedReplayRound === round,
        forkCount: forkedBranches.length,
        forkTitles: forkedBranches.slice(0, 3).map((branch) => branch.title),
        cardCount: cardEntries.length,
        cardSummaries: cardEntries.slice(0, 3).map((entry) => (
          isZh
            ? getGameplayCardDefinition(entry.cardId).labelZh
            : getGameplayCardDefinition(entry.cardId).labelEn
        )),
        betCount: betEntries.length,
        betSummaries: betEntries.slice(0, 3).map((bet) => bet.targetLabel),
        resultCount:
          isSimulationComplete && round === scenario.total_rounds && completedEndings.length > 0
            ? completedEndings.length
            : 0,
        resultSummaries:
          isSimulationComplete && round === scenario.total_rounds
            ? completedEndings.slice(0, 3).map((branch) => branch.title)
            : [],
      };
    });
  }, [branches, isSimulationComplete, isZh, replayRounds, scenario?.total_rounds, scenarioMeta?.betting.bets, scenarioMeta?.cards.usageLog, selectedReplayRound]);
  const hasLiveRoundStarted =
    currentRound > 0
    || thinkingAgents.some((agent) => agent.round >= 1)
    || messages.some((message) => (message.round ?? 0) >= 1);
  const isWarmupPhase =
    !isReplayMode
    && viewMode === 'theater'
    && !isSimulationComplete
    && status === 'simulating'
    && !hasLiveRoundStarted;
  const canPreviewGameplayCards =
    !isReplayMode
    && viewMode === 'theater'
    && !isSimulationComplete
    && branches.length > 0
    && !isWarmupPhase;
  const canUseGameplayCards = !isReplayMode && !isSimulationComplete && activeBranches.length > 0 && agents.length > 0;
  const warmupNarrativePhase: 1 | 2 | 3 = agents.length === 0
    ? (branches.length > 0 ? 2 : 1)
    : 3;
  const isTailStatusSyncPhase =
    !isReplayMode
    && !isSimulationComplete
    && Boolean(id)
    && (status === 'narrating' || (
      status === 'simulating'
      && currentRound >= (scenario?.total_rounds ?? 0)
      && (scenario?.total_rounds ?? 0) > 0
      && thinkingAgents.length === 0
      && messages.length > 0
    ));
  const canToggleViewMode = viewMode === 'theater' || visualizationEnabled;
  const theaterToggleHint = !canToggleViewMode && viewMode === 'classic'
    ? t('sim.theater_unavailable_hint')
    : undefined;
  const preloadTheaterLoader = useCallback(() => {
    if (!canToggleViewMode || viewMode === 'theater') return;
    if (!shouldWarmTheaterLoaderOnIntent()) return;
    void loadPhaserGameLoaderModule();
  }, [canToggleViewMode, viewMode]);

  useEffect(() => {
    setReplayUrl(isReplayMode ? window.location.href : null);
  }, [isReplayMode]);

  useEffect(() => {
    setReplayLinkUnavailable(false);
  }, [replayShareId, replayToken, scenario?.id]);

  useEffect(() => {
    if (viewMode !== 'theater' || !visualizationEnabled) return;

    const preload = () => {
      preloadPhaserGame();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(preload, { timeout: 1000 });
      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(preload, 0);
    return () => window.clearTimeout(timeoutId);
  }, [viewMode, visualizationEnabled]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !scenario || !gameplayProfile || !scenarioMeta || !signatureArcState) return;
    if (scenario.director_state?.objectives?.goals?.length) return;
    if (scenarioMeta.objectives.goals.length > 0) return;
    const signatureCardId = signatureArcState.nextCardId ?? signatureArcState.sequence[0] ?? null;
    const seedKey = [
      id,
      scenario.question,
      gameplayProfile.id,
      signatureCardId ?? '',
    ].join('\u0000');
    if (defaultObjectivesSeedKey.current === seedKey) return;
    defaultObjectivesSeedKey.current = seedKey;

    const nextMeta = ensureScenarioObjectives(id, {
      question: scenario.question,
      profileId: gameplayProfile.id,
      goals: buildDefaultDirectorObjectives({
        profileId: gameplayProfile.id,
        signatureCardId,
      }),
    });
    refreshLocalMeta();
    void persistDirectorMeta(nextMeta);
  }, [gameplayProfile, id, isReplayMode, persistDirectorMeta, refreshLocalMeta, scenario, scenarioMeta, signatureArcState]);

  // Load scenario data if navigated directly
  useEffect(() => {
    if (isReplayMode) return;
    if (id && !scenario) {
      loadScenario(id);
    }
  }, [id, isReplayMode, scenario, loadScenario]);

  // Connect WebSocket only after scenario data is loaded
  useSimulationWS(id, !!scenario && !isReplayMode);

  // ── Warmup recovery: hydrate missing agents / branches while live WS catches up ──
  const hydrationInFlight = useRef(false);
  useEffect(() => {
    warmupRecoveryAttempts.current = 0;
    recoveryLogEmitted.current = false;
  }, [id, isReplayMode]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || status === 'idle' || status === 'error' || status === 'parsing') return;
    if (branches.length > 0 && agents.length > 0) return;

    let cancelled = false;
    const hydrateMissingScenarioData = async () => {
      if (cancelled || hydrationInFlight.current) return;
      if (warmupRecoveryAttempts.current >= WARMUP_RECOVERY_MAX_ATTEMPTS) return;

      const state = useSimulationStore.getState();
      if (state.branches.length > 0 && state.agents.length > 0) return;

      hydrationInFlight.current = true;
      warmupRecoveryAttempts.current += 1;
      try {
        if (!recoveryLogEmitted.current) {
          console.info('[Recovery] Warmup missing agents/branches — hydrating from API...');
          recoveryLogEmitted.current = true;
        }
        await loadScenario(id);
      } finally {
        hydrationInFlight.current = false;
      }
    };

    const timer = window.setInterval(() => {
      if (warmupRecoveryAttempts.current >= WARMUP_RECOVERY_MAX_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      void hydrateMissingScenarioData();
    }, WARMUP_RECOVERY_INTERVAL_MS);

    void hydrateMissingScenarioData();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, isReplayMode, status, branches.length, agents.length, loadScenario]);

  useEffect(() => {
    if (branches.length > 0 && agents.length > 0) {
      warmupRecoveryAttempts.current = 0;
      recoveryLogEmitted.current = false;
    }
  }, [agents.length, branches.length]);

  const tailSyncInFlight = useRef(false);
  useEffect(() => {
    if (!isTailStatusSyncPhase || !id) return;

    let cancelled = false;

    const syncTailStatus = async () => {
      if (cancelled || tailSyncInFlight.current) {
        return;
      }
      tailSyncInFlight.current = true;
      try {
        await loadScenario(id);
      } finally {
        tailSyncInFlight.current = false;
      }
    };

    const timer = window.setInterval(() => {
      void syncTailStatus();
    }, TAIL_STATUS_SYNC_INTERVAL_MS);

    void syncTailStatus();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, isTailStatusSyncPhase, loadScenario]);

  const handleIntervene = useCallback((branchId: string, branchTitle: string) => {
    if (isReplayMode) return;
    setInterventionTarget({ branchId, branchTitle });
  }, [isReplayMode]);

  const handleDetail = useCallback((branchId: string) => {
    const branch = branches.find((b) => b.id === branchId);
    if (branch) setDetailBranch(branch);
  }, [branches]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const canOpenGameplayCards = canUseGameplayCards;
    const canPreviewGameplayCardsNow = canPreviewGameplayCards;
    const render = () => stringifyAutomationPayload(
      {
        question: scenario?.question ?? null,
        status,
        currentRound,
        totalRounds: scenario?.total_rounds ?? null,
        viewMode,
        visualizationEnabled,
        isSimulationComplete,
        messageCount: messages.length,
        agentCount: agents.length,
        branchCount: branches.length,
        thinkingAgentCount: thinkingAgents.length,
        thinkingAgents: thinkingAgents.map((agent) => ({
          agent: agent.agent,
          agent_id: agent.agent_id,
          branch: agent.branch,
          round: agent.round,
        })),
      },
      win.__swarmGetSceneAutomation?.() ?? null,
      {
        route: window.location.pathname,
        kind: 'simulation',
        replay_source: isReplayMode ? 'token' : 'api',
        error: buildAutomationErrorState(errorCode, error),
        director: scenarioMeta && systemTracks
          ? {
            completed_objectives: completedObjectiveCount,
            objective_count: evaluatedObjectives.length,
            objectives: evaluatedObjectives.map((objective) => ({
              kind: objective.kind,
              status: objective.status,
              title: objective.title,
              progress: objective.progress,
            })),
            system_tracks: {
              risk_value: systemTracks.riskValue,
              resource_value: systemTracks.resourceValue,
              pressure: systemTracks.pressure,
            },
            commitment: scenarioMeta.commitment.active
              ? {
                active: true,
                branch_id: scenarioMeta.commitment.branchId,
                branch_title: scenarioMeta.commitment.branchTitle,
                outcome: scenarioMeta.commitment.outcome,
              }
              : { active: false },
          }
          : null,
        betting: scenarioMeta
          ? {
            bet_count: scenarioMeta.betting.bets.length,
            bets: scenarioMeta.betting.bets.slice(0, 5).map((bet) => ({
              bet_id: bet.betId,
              kind: bet.kind,
              target_label: bet.targetLabel,
              placed_at_round: bet.placedAtRound,
              confidence: bet.confidence,
              resolved: bet.resolved,
            })),
            key_moment_count: archiveKeyMoments.length,
          }
          : null,
        runtime_preset: {
          id: activeRuntimePreset,
          label: activeRuntimePresetLabel,
          source: scenarioRuntimePreset ? 'scenario' : 'session',
          branch_sensitivity: activeRuntimePresetConfig.branchSensitivity,
          fork_prompt_variant: activeRuntimePresetConfig.forkPromptVariant,
          fork_detector_active_branch_limit: activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
        },
        fork_debug: scenario?.fork_debug ?? null,
        controls: {
          can_go_back: true,
          can_toggle_view_mode: canToggleViewMode,
          can_open_gameplay_cards: canOpenGameplayCards,
          can_preview_gameplay_cards: canPreviewGameplayCardsNow,
          can_open_prediction: !isReplayMode && !isSimulationComplete,
          can_view_results: !isReplayMode && isSimulationComplete,
          can_copy_replay_link: canCopyReplayLink,
          can_capture_screenshot: viewMode === 'theater' && captureStatus === 'idle',
          can_capture_gif: viewMode === 'theater' && captureStatus === 'idle',
          capture_mode: captureMode,
          can_capture_modal: hasActiveModal,
          can_toggle_sidebar: true,
          panel_collapsed: panelCollapsed,
          capture_status: captureStatus,
          capture_result_kind: lastCaptureKind,
          active_modal:
            showPrediction ? 'prediction'
            : showGameplayCards ? 'gameplay_cards'
            : interventionTarget ? 'intervention'
            : detailBranch ? 'branch_detail'
            : null,
          modal_state: showPrediction
            ? predictionAutomation
            : showGameplayCards
              ? gameplayAutomation
              : null,
        },
        replay_state: null,
        warmup: isWarmupPhase
          ? {
              active: true,
              worldline_ready: branches.length > 0,
              agents_ready: agents.length > 0,
              director_ready: canOpenGameplayCards,
              preview_enabled: canPreviewGameplayCardsNow,
            }
          : null,
        branches: branches.slice(0, 8).map((branch) => ({
          id: branch.id,
          title: branch.title,
          status: branch.status,
          probability: branch.probability,
          can_view_detail: true,
          can_intervene: !isReplayMode && !isSimulationComplete && branch.status === 'ACTIVE',
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [
    activeBranches.length,
    archiveKeyMoments.length,
    branches,
    canCopyReplayLink,
    captureStatus,
    captureMode,
    completedObjectiveCount,
    currentRound,
    evaluatedObjectives,
    detailBranch,
    error,
    errorCode,
    scenarioMeta,
    systemTracks,
    interventionTarget,
    isSimulationComplete,
    lastCaptureKind,
    agents.length,
    messages.length,
    thinkingAgents,
    canPreviewGameplayCards,
    canUseGameplayCards,
    panelCollapsed,
    gameplayAutomation,
    predictionAutomation,
    playbackMode,
    replayBranchOptions,
    replayRounds,
    replaySpeed,
    activeRuntimePreset,
    activeRuntimePresetConfig.branchSensitivity,
    activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
    activeRuntimePresetConfig.forkPromptVariant,
    activeRuntimePresetLabel,
    selectedReplayBranchId,
    selectedReplayRound,
    scenarioRuntimePreset,
    theaterSceneState,
    scenario,
    replayUrl,
    isReplayMode,
    showGameplayCards,
    showPrediction,
    status,
    hasActiveModal,
    isWarmupPhase,
    canToggleViewMode,
    viewMode,
    visualizationEnabled,
  ]);

  const handleCopyReplayLink = useCallback(async () => {
    if (replayUrl) {
      await copyText(replayUrl);
      return;
    }
    const replayScenarioMeta = scenarioMeta ?? storedScenarioMeta;
    if (!scenario || !replayScenarioMeta) return;
    const { buildSimulationReplayUrl } = await loadSimulationReplayHelpers();
    const { compactScenarioMetaForReplay } = await loadScenarioReplayHelpers();
    const snapshot = {
      ...scenario,
      agents,
      branches,
      messages,
      director_state: backendDirectorState ?? scenario.director_state ?? null,
      gameplay_state: backendGameplayState ?? scenario.gameplay_state ?? null,
    };
    const compactReplayMeta = compactScenarioMetaForReplay(replayScenarioMeta, {
      stripDirectorAuthority: hasScenarioDirectorAuthority(snapshot.director_state ?? null),
      stripGameplayAuthority: hasScenarioGameplayAuthority(snapshot.gameplay_state ?? null),
    });
    const uiState = {
      selectedReplayBranchId,
      selectedReplayRound,
      playbackMode,
      replaySpeed,
      panelCollapsed,
    };
    const artifact = await Promise.resolve()
      .then(() => createReplayArtifact('simulation_view_v1', {
        scenario: snapshot,
        scenarioMeta: compactReplayMeta,
        uiState,
      }))
      .catch(() => null);
    try {
      const url = artifact
        ? `${window.location.origin.replace(/\/$/, '')}/sim/replay?share=${artifact.id}`
        : await buildSimulationReplayUrl(window.location.origin, {
          scenario: snapshot,
          scenarioMeta: compactReplayMeta,
          uiState,
        });
      setReplayUrl(url);
      setReplayLinkUnavailable(false);
      await copyText(url);
    } catch (error) {
      console.warn('[SimulationView] Failed to build replay URL', error);
      const fallbackUrl = `${window.location.origin.replace(/\/$/, '')}/sim/${scenario.id}`;
      setReplayUrl(fallbackUrl);
      setReplayLinkUnavailable(false);
      await copyText(fallbackUrl);
    }
  }, [agents, backendDirectorState, backendGameplayState, branches, messages, panelCollapsed, playbackMode, replaySpeed, replayUrl, scenario, scenarioMeta, selectedReplayBranchId, selectedReplayRound, storedScenarioMeta]);

  const handleImportReplay = useCallback(async () => {
    if (!replayPayload || importingReplay) return;
    setImportingReplay(true);
    try {
      const imported = await importReplayScenario(replayPayload.scenario);
      navigate(`/sim/${imported.id}`);
    } finally {
      setImportingReplay(false);
    }
  }, [importingReplay, navigate, replayPayload]);
  const theaterSceneLabel = theaterSceneState?.scene
    ? formatTheaterLabel(theaterSceneState.scene, THEATER_SCENE_LABELS, t)
    : null;
  const theaterThemeLabel = getTheaterThemeLabel(
    typeof theaterSceneState?.theme === 'string' ? theaterSceneState.theme : scenario?.scene_theme,
    isZh,
  );
  const theaterWeatherLabel = formatTheaterLabel(
    typeof theaterSceneState?.weather === 'string' ? theaterSceneState.weather : null,
    THEATER_WEATHER_LABELS,
    t,
  );
  const theaterTimeLabel = formatTheaterLabel(
    typeof theaterSceneState?.time_of_day === 'string' ? theaterSceneState.time_of_day : null,
    THEATER_TIME_LABELS,
    t,
  );
  const theaterAgentCount =
    typeof theaterSceneState?.agent_count === 'number'
      ? theaterSceneState.agent_count
      : agents.length;
  const theaterBubbleCount = Array.isArray(theaterSceneState?.bubbles)
    ? theaterSceneState.bubbles.filter((bubble) => bubble && typeof bubble === 'object').length
    : 0;
  const canUseReplayControls = viewMode === 'theater' && isSimulationComplete && messages.length > 0;
  const isReplayTheaterReady = Boolean(
    canUseReplayControls
    && theaterSceneState?.scene
    && theaterSceneState.scene !== 'BootScene'
    && theaterSceneState.scene !== 'TitleScene',
  );
  const displayedReplayRound = canUseReplayControls
    ? (selectedReplayRound ?? currentRound)
    : currentRound;
  const showCommitmentFeedback = useCallback((tone: 'info' | 'success', message: string) => {
    if (commitmentFeedbackTimer.current) {
      window.clearTimeout(commitmentFeedbackTimer.current);
    }
    setCommitmentFeedback({ tone, message });
    commitmentFeedbackTimer.current = window.setTimeout(() => {
      setCommitmentFeedback(null);
      commitmentFeedbackTimer.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (commitmentFeedbackTimer.current) {
        window.clearTimeout(commitmentFeedbackTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scenarioMeta) return;
    if (lastCommitmentAction.current === 'commit' && scenarioMeta.commitment.active) {
      lastCommitmentAction.current = null;
      showCommitmentFeedback('success', t('sim.director.commit_saved'));
      return;
    }
    if (lastCommitmentAction.current === 'clear' && !scenarioMeta.commitment.active) {
      lastCommitmentAction.current = null;
      showCommitmentFeedback('success', t('sim.director.commit_cleared'));
    }
  }, [scenarioMeta, scenarioMeta?.commitment.active, scenarioMeta?.commitment.branchId, showCommitmentFeedback, t]);

  useEffect(() => {
    if (!authorityConflictKind) return;
    showCommitmentFeedback(
      'info',
      authorityConflictKind === 'director'
        ? t('sim.director.commit_conflict_reloaded')
        : t('sim.director.gameplay_conflict_reloaded'),
    );
    clearAuthorityConflictKind();
  }, [authorityConflictKind, clearAuthorityConflictKind, showCommitmentFeedback, t]);

  const handleCommitBranchAction = useCallback(() => {
    if (!commitmentDraftBranchId) return;
    lastCommitmentAction.current = 'commit';
    showCommitmentFeedback('info', t('sim.director.commit_saving'));
    handleCommitBranch();
  }, [commitmentDraftBranchId, handleCommitBranch, showCommitmentFeedback, t]);

  const handleClearCommitmentAction = useCallback(() => {
    lastCommitmentAction.current = 'clear';
    showCommitmentFeedback('info', t('sim.director.commit_saving'));
    handleClearCommitment();
  }, [handleClearCommitment, showCommitmentFeedback, t]);

  const handlePredictionClose = useCallback(() => {
    setShowPrediction(false);
    setPredictionAutomation(null);
    refreshLocalMeta();
  }, [refreshLocalMeta]);
  const handleGameplayCardsClose = useCallback(() => {
    setShowGameplayCards(false);
    setGameplayAutomation(null);
    refreshLocalMeta();
  }, [refreshLocalMeta]);
  const filteredReplayMessages = useMemo(
    () => (
      canUseReplayControls
        ? filterReplayMessages(messages, branches, selectedReplayBranchId, selectedReplayRound)
        : []
    ),
    [branches, canUseReplayControls, messages, selectedReplayBranchId, selectedReplayRound],
  );
  const replayAutomationState = useMemo(() => {
    if (!canUseReplayControls) return null;

    const win = window as AutomationWindow;
    const runtimeReplayState = win.__swarmGetReplayAutomation?.() ?? null;
    return {
      available: true,
      phase: runtimeReplayState?.phase ?? (playbackMode === 'skip' ? 'settled' : 'idle'),
      enabled: canUseReplayControls,
      theater_ready: isReplayTheaterReady,
      playback_mode: playbackMode,
      replay_speed: replaySpeed,
      selected_branch_id: selectedReplayBranchId,
      selected_branch_title:
        replayBranchOptions.find((branch) => branch.id === selectedReplayBranchId)?.title ?? null,
      selected_round: selectedReplayRound,
      available_rounds: replayRounds,
      filtered_message_count: filteredReplayMessages.length,
      batch_count: runtimeReplayState?.batch_count ?? Math.ceil(filteredReplayMessages.length / 3),
      displayed_bubble_count:
        typeof theaterSceneState?.displayed_bubble_count === 'number'
          ? theaterSceneState.displayed_bubble_count
          : theaterBubbleCount,
    };
  }, [
    canUseReplayControls,
    filteredReplayMessages.length,
    playbackMode,
    replayBranchOptions,
    replayRounds,
    replaySpeed,
    selectedReplayBranchId,
    selectedReplayRound,
    isReplayTheaterReady,
    theaterBubbleCount,
    theaterSceneState,
  ]);

  useEffect(() => {
    if (!replayAutomationState) return;

    const win = window as AutomationWindow;
    const render = () => stringifyAutomationPayload(
      {
        question: scenario?.question ?? null,
        status,
        currentRound,
        totalRounds: scenario?.total_rounds ?? null,
        viewMode,
        visualizationEnabled,
        isSimulationComplete,
        messageCount: messages.length,
        agentCount: agents.length,
        branchCount: branches.length,
      },
      win.__swarmGetSceneAutomation?.() ?? null,
      {
        route: window.location.pathname,
        kind: 'simulation',
        replay_source: isReplayMode ? 'token' : 'api',
        error: buildAutomationErrorState(errorCode, error),
        director: scenarioMeta && systemTracks
          ? {
            completed_objectives: completedObjectiveCount,
            objective_count: evaluatedObjectives.length,
            objectives: evaluatedObjectives.map((objective) => ({
              kind: objective.kind,
              status: objective.status,
              title: objective.title,
              progress: objective.progress,
            })),
            system_tracks: {
              risk_value: systemTracks.riskValue,
              resource_value: systemTracks.resourceValue,
              pressure: systemTracks.pressure,
            },
            commitment: scenarioMeta.commitment.active
              ? {
                active: true,
                branch_id: scenarioMeta.commitment.branchId,
                branch_title: scenarioMeta.commitment.branchTitle,
                outcome: scenarioMeta.commitment.outcome,
              }
              : { active: false },
          }
          : null,
        betting: scenarioMeta
          ? {
            bet_count: scenarioMeta.betting.bets.length,
            bets: scenarioMeta.betting.bets.slice(0, 5).map((bet) => ({
              bet_id: bet.betId,
              kind: bet.kind,
              target_label: bet.targetLabel,
              placed_at_round: bet.placedAtRound,
              confidence: bet.confidence,
              resolved: bet.resolved,
            })),
            key_moment_count: archiveKeyMoments.length,
          }
          : null,
        runtime_preset: {
          id: activeRuntimePreset,
          label: activeRuntimePresetLabel,
          source: scenarioRuntimePreset ? 'scenario' : 'session',
          branch_sensitivity: activeRuntimePresetConfig.branchSensitivity,
          fork_prompt_variant: activeRuntimePresetConfig.forkPromptVariant,
          fork_detector_active_branch_limit: activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
        },
        fork_debug: scenario?.fork_debug ?? null,
        controls: {
          can_go_back: true,
          can_toggle_view_mode: canToggleViewMode,
          can_open_gameplay_cards: canUseGameplayCards,
          can_preview_gameplay_cards: canPreviewGameplayCards,
          can_open_prediction: !isReplayMode && !isSimulationComplete,
          can_view_results: !isReplayMode && isSimulationComplete,
          can_copy_replay_link: canCopyReplayLink,
          can_capture_screenshot: viewMode === 'theater' && captureStatus === 'idle',
          can_capture_gif: viewMode === 'theater' && captureStatus === 'idle',
          capture_mode: captureMode,
          can_capture_modal: hasActiveModal,
          can_toggle_sidebar: true,
          panel_collapsed: panelCollapsed,
          capture_status: captureStatus,
          capture_result_kind: lastCaptureKind,
          active_modal:
            showPrediction ? 'prediction'
            : showGameplayCards ? 'gameplay_cards'
            : interventionTarget ? 'intervention'
            : detailBranch ? 'branch_detail'
            : null,
          modal_state: showPrediction
            ? predictionAutomation
            : showGameplayCards
              ? gameplayAutomation
              : null,
        },
        replay_state: replayAutomationState,
        branches: branches.slice(0, 8).map((branch) => ({
          id: branch.id,
          title: branch.title,
          status: branch.status,
          probability: branch.probability,
          can_view_detail: true,
          can_intervene: !isReplayMode && !isSimulationComplete && branch.status === 'ACTIVE',
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [
    archiveKeyMoments.length,
    branches,
    captureStatus,
    captureMode,
    completedObjectiveCount,
    currentRound,
    detailBranch,
    error,
    errorCode,
    evaluatedObjectives,
    hasActiveModal,
    interventionTarget,
    isSimulationComplete,
    agents.length,
    messages.length,
    panelCollapsed,
    canPreviewGameplayCards,
    canUseGameplayCards,
    canCopyReplayLink,
    gameplayAutomation,
    predictionAutomation,
    replayAutomationState,
    activeRuntimePreset,
    activeRuntimePresetConfig.branchSensitivity,
    activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
    activeRuntimePresetConfig.forkPromptVariant,
    activeRuntimePresetLabel,
    scenarioMeta,
    scenario,
    replayUrl,
    isReplayMode,
    scenarioRuntimePreset,
    showGameplayCards,
    showPrediction,
    status,
    systemTracks,
    canToggleViewMode,
    lastCaptureKind,
    viewMode,
    visualizationEnabled,
  ]);

  return (
    <div className={`simulation-view ${viewMode === 'theater' ? 'simulation-view--theater' : ''} ${canUseReplayControls ? 'simulation-view--replay-ready' : ''}`}>
      {/* Header */}
      <header className="sim-header">
        <button className="btn btn-ghost btn--back" onClick={() => navigate('/')}>
          {t('sim.status.back')}
        </button>
        <div className="sim-header__info">
          <h2 className="sim-header__question">
            {scenario?.question || t('sim.status.loading')}
          </h2>
          <span className={`badge badge-${status === 'error' ? 'pruned' : 'active'}`}>
            {status === 'error'
              ? t('sim.status.error')
              : status === 'done'
                ? t('sim.status.completed')
                : t('sim.status.running')}
          </span>
          <span
            className="badge badge-active"
            title={[
              t('common.runtime_preset_scope_main'),
              `${t('common.runtime_preset_prompt_variant')}: ${activeRuntimePresetConfig.forkPromptVariant.toUpperCase()}`,
              `${t('common.runtime_preset_branch_sensitivity')}: ${activeRuntimePresetConfig.branchSensitivity}`,
              `${t('common.runtime_preset_branch_budget')}: ${
                activeRuntimePresetConfig.forkDetectorActiveBranchLimit === 0
                  ? t('common.runtime_preset_budget_disabled')
                  : activeRuntimePresetConfig.forkDetectorActiveBranchLimit
              }`,
            ].join(' · ')}
          >
            {t('sim.runtime_preset_title')}: {activeRuntimePresetLabel}
          </span>
        </div>
        <div className="sim-header__actions">
          {canPreviewGameplayCards && (
            <button
              className="btn btn-ghost"
              onClick={() => setShowGameplayCards(true)}
              title={!canUseGameplayCards ? t('sim.warmup.cards_preview') : undefined}
            >
              {t('gameplay.open_btn')}
            </button>
          )}
          {!isSimulationComplete && (
            <button
              className="btn btn-ghost"
              onClick={() => setShowPrediction(true)}
              disabled={isReplayMode}
            >
              {t('sim.predict_btn')}
            </button>
          )}
          {isSimulationComplete && !isReplayMode && (
            <button
              className="btn btn-primary btn--results"
              onClick={() => navigate(`/result/${id}`)}
            >
              {t('sim.status.view_results')}
            </button>
          )}
          {canCopyReplayLink && (
            <button
              className="btn btn-ghost"
              onClick={() => void handleCopyReplayLink()}
            >
              {t('share.copy_permalink_btn')}
            </button>
          )}
          {isReplayMode && (
          <button
            className="btn btn-primary"
            onClick={() => void handleImportReplay()}
            disabled={importingReplay}
          >
            {importingReplay ? t('sim.replay.importing') : t('sim.replay.import_local')}
          </button>
          )}
          {/* V2: Theater mode toggle — only enabled when the scenario has visualization data */}
          <button
            className={`view-mode-toggle ${viewMode === 'theater' ? 'view-mode-toggle--active' : ''}`}
            onClick={toggleViewMode}
            onMouseEnter={preloadTheaterLoader}
            onFocus={preloadTheaterLoader}
            aria-label={viewMode === 'classic' ? t('sim.switch_to_theater_aria') : t('sim.switch_to_classic_aria')}
            disabled={!canToggleViewMode}
            title={theaterToggleHint}
          >
            <span className="view-mode-toggle__icon">
              {viewMode === 'classic' ? '🎮' : '📊'}
            </span>
            <span className="view-mode-toggle__label">
              {viewMode === 'classic' ? t('home.viz_theater') : t('home.viz_classic')}
            </span>
          </button>
          <span className="sim-header__logo">{t('app_title')}</span>
        </div>
      </header>

      {/* Error state */}
      {error && (
        <div className="sim-error">
          <p>⚠️ {error}</p>
          <button className="btn btn-ghost" onClick={() => navigate('/')}>
            {t('sim.status.back')}
          </button>
        </div>
      )}

      {isReplayMode && (
        <div className="sim-error">
          <p>🔒 {t('sim.replay.read_only')}</p>
        </div>
      )}

      {/* Main content */}
      <div className="sim-content">
        {/* V2: Pixel Theater — takes over tree area when active */}
        {viewMode === 'theater' ? (
          <div className="sim-content__tree">
            <div className="theater-panel">
              <div className="theater-panel__header">
                <div className="theater-panel__capture">
                  {canUseReplayControls && (
                    <>
                      <button
                        className="btn btn-ghost btn--capture"
                        onClick={() => restartTheaterPlayback('replay')}
                        title={t('game.replay_btn')}
                      >
                        🔁 {t('game.replay_btn')}
                      </button>
                      <button
                        className="btn btn-ghost btn--capture"
                        onClick={() => restartTheaterPlayback('skip')}
                        title={t('game.skip_btn')}
                      >
                        ⏭ {t('game.skip_btn')}
                      </button>
                      <button
                        className="btn btn-ghost btn--capture"
                        onClick={cycleReplaySpeed}
                        title={t('game.speed_btn')}
                      >
                        ⚡ {replaySpeed}x
                      </button>
                    </>
                  )}
                  <div className="capture-mode-toggle" aria-label={t('game.capture_mode_label')}>
                    <button
                      type="button"
                      className={`capture-mode-toggle__btn ${captureMode === 'panel' ? 'capture-mode-toggle__btn--active' : ''}`}
                      onClick={() => setCaptureMode('panel')}
                      title={t('game.capture_mode_panel_desc')}
                    >
                      {t('game.capture_mode_panel')}
                    </button>
                    <button
                      type="button"
                      className={`capture-mode-toggle__btn ${captureMode === 'canvas' ? 'capture-mode-toggle__btn--active' : ''}`}
                      onClick={() => setCaptureMode('canvas')}
                      title={t('game.capture_mode_canvas_desc')}
                    >
                      {t('game.capture_mode_canvas')}
                    </button>
                    <button
                      type="button"
                      className={`capture-mode-toggle__btn ${captureMode === 'modal' ? 'capture-mode-toggle__btn--active' : ''}`}
                      onClick={() => setCaptureMode('modal')}
                      title={hasActiveModal ? t('game.capture_mode_modal_desc') : t('game.capture_mode_modal_unavailable')}
                      disabled={!hasActiveModal}
                    >
                      {t('game.capture_mode_modal')}
                    </button>
                  </div>
                  <span className="capture-mode-feedback" aria-live="polite">
                    {t('game.capture_mode_current')}
                    {' '}
                    {captureModeDescription}
                  </span>
                  <button
                    className="btn btn-ghost btn--capture"
                    onClick={handleScreenshotCapture}
                    disabled={captureStatus !== 'idle' || !isModalCaptureAvailable}
                    title={isModalCaptureAvailable ? t('game.screenshot_btn') : t('game.capture_mode_modal_unavailable')}
                  >
                    📸 {captureStatus === 'capturing' ? '...' : t('game.screenshot_btn')}
                  </button>
                  <button
                    className="btn btn-ghost btn--capture"
                    onClick={handleGifCapture}
                    disabled={captureStatus !== 'idle' || captureMode === 'modal'}
                    title={captureMode === 'modal' ? t('game.capture_mode_gif_canvas_only') : t('game.gif_btn')}
                  >
                    🎬 {captureStatus === 'recording' ? t('game.gif_recording') : t('game.gif_btn')}
                  </button>
                  {captureStatus === 'done' && (
                    <span
                      className={`capture-status ${lastCaptureKind === 'gif_fallback_png' ? 'capture-status--fallback' : 'capture-status--done'}`}
                    >
                      {lastCaptureKind === 'gif_fallback_png' ? '⚠️' : '✅'} {captureDoneLabel}
                    </span>
                  )}
                </div>
                <span className="theater-panel__power-led" />
              </div>
              <div className="theater-panel__status" aria-label={t('sim.theater_status_aria')}>
                {theaterSceneLabel && (
                  <span className="theater-chip theater-chip--primary">
                    🎬 {theaterSceneLabel}
                  </span>
                )}
                {theaterThemeLabel && (
                  <span className="theater-chip">
                    🗺 {theaterThemeLabel}
                  </span>
                )}
                <span className="theater-chip">
                  🔁 R{displayedReplayRound}/{scenario?.total_rounds ?? '--'}
                </span>
                <span className="theater-chip">
                  👥 {theaterAgentCount}
                </span>
                <span className="theater-chip">
                  💬 {theaterBubbleCount}
                </span>
                {theaterWeatherLabel && (
                  <span className="theater-chip">
                    🌦 {theaterWeatherLabel}
                  </span>
                )}
                {theaterTimeLabel && (
                  <span className="theater-chip">
                    🕒 {theaterTimeLabel}
                  </span>
                )}
                <span className="theater-chip">
                  ✉ {messages.length}
                </span>
              </div>
              {scenarioMeta && systemTracks && evaluatedObjectives.length > 0 && (
                <div className="theater-panel__director">
                  <div className="theater-panel__director-top">
                    <strong>{t('sim.director.title')}</strong>
                    <span className="theater-chip">
                      {systemTracks.riskLabel} {systemTracks.riskValue}/6 · {systemTracks.resourceLabel} {systemTracks.resourceValue}/6
                    </span>
                    <span className="theater-chip">
                      {t('sim.director.done', {
                        completed: completedObjectiveCount,
                        total: evaluatedObjectives.length,
                      })}
                    </span>
                    {scenarioMeta.commitment.active && scenarioMeta.commitment.branchTitle && (
                      <span className="theater-chip theater-chip--primary">
                        🎯 {scenarioMeta.commitment.branchTitle}
                      </span>
                    )}
                  </div>
                  <div className="theater-panel__director-goals">
                    {evaluatedObjectives.map((objective) => (
                      <div
                        key={objective.id}
                        className={`director-goal director-goal--${objective.status}`}
                      >
                        <strong>{objective.title}</strong>
                        <span className="director-goal__detail">{objective.detail}</span>
                        <small>{objective.progress}</small>
                      </div>
                    ))}
                  </div>
                  {!isSimulationComplete && activeBranches.length > 0 && (
                    <div className="theater-panel__commitment">
                      <label className="theater-select">
                        <span>{t('sim.director.commitment_label')}</span>
                        <select
                          value={commitmentDraftBranchId}
                          onChange={(event) => setCommitmentDraftBranchId(event.target.value)}
                        >
                          {activeBranches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              {branch.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="btn btn-ghost btn--capture" onClick={handleCommitBranchAction}>
                        {t('sim.director.commit')}
                      </button>
                      {scenarioMeta.commitment.active && (
                        <button className="btn btn-ghost btn--capture" onClick={handleClearCommitmentAction}>
                          {t('sim.director.clear')}
                        </button>
                      )}
                      {commitmentFeedback && (
                        <span
                          className={`theater-commitment-feedback theater-commitment-feedback--${commitmentFeedback.tone}`}
                          aria-live="polite"
                        >
                          {commitmentFeedback.message}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {isWarmupPhase && !isReplayMode && viewMode === 'theater' && (
                <>
                  <TheaterCurtain isVisible={isWarmupPhase} />
                  <SimWarmupNarrative phase={warmupNarrativePhase} />
                </>
              )}
              {isWarmupPhase && (
                <div className="theater-panel__warmup" aria-label={t('sim.warmup.title')}>
                  <div className="theater-panel__warmup-copy">
                    <strong>{t('sim.warmup.title')}</strong>
                    <span>{t(canUseGameplayCards ? 'sim.warmup.cards_ready' : 'sim.warmup.cards_preview')}</span>
                  </div>
                  <div className="theater-panel__warmup-checks">
                    <span className={`theater-warmup-pill ${branches.length > 0 ? 'theater-warmup-pill--ready' : ''}`}>
                      🧭 {t(branches.length > 0 ? 'sim.warmup.worldline_ready' : 'sim.warmup.worldline_syncing')}
                    </span>
                    <span className={`theater-warmup-pill ${agents.length > 0 ? 'theater-warmup-pill--ready' : ''}`}>
                      👥 {t(agents.length > 0 ? 'sim.warmup.agents_ready' : 'sim.warmup.agents_syncing')}
                    </span>
                    <span className={`theater-warmup-pill ${canUseGameplayCards ? 'theater-warmup-pill--ready' : ''}`}>
                      🃏 {t(canUseGameplayCards ? 'sim.warmup.director_ready' : 'sim.warmup.director_locked')}
                    </span>
                  </div>
                </div>
              )}
              <div className="theater-panel__game-wrapper">
                <HudOverlay
                    canPredict={!isReplayMode && !isSimulationComplete}
                    onOpenPrediction={!isReplayMode && !isSimulationComplete ? () => setShowPrediction(true) : undefined}
                >
                  <LazyPhaserGameLoader
                    key={`${id ?? 'simulation'}-${theaterMountKey}-${playbackMode}`}
                    replaySpeed={replaySpeed}
                    playbackMode={playbackMode}
                    playbackBranchId={selectedReplayBranchId}
                    playbackRound={selectedReplayRound}
                  />
                </HudOverlay>
              </div>
              {canUseReplayControls && replayBranchOptions.length > 0 && (
                <div className="theater-panel__filters">
                  <label className="theater-select">
                    <span>{t('game.worldline_label')}</span>
                    <select
                      value={selectedReplayBranchId ?? ''}
                      onChange={(event) => handleReplayBranchChange(event.target.value)}
                    >
                      {replayBranchOptions.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="theater-select">
                    <span>{t('game.round_label')}</span>
                    <select
                      value={selectedReplayRound ?? ''}
                      onChange={(event) => handleReplayRoundChange(Number(event.target.value))}
                    >
                      {replayRounds.map((round) => (
                        <option key={round} value={round}>
                          R{round}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {canUseReplayControls && (
                <div className="theater-panel__timeline">
                  <Suspense fallback={<SimulationSlotFallback label={t('sim.timeline.preparing')} />}>
                    <LazyTimelineBar
                      interactive
                      compact
                      selectedRound={selectedReplayRound}
                      roundMarkers={timelineRoundMarkers}
                      onRoundSelect={handleReplayRoundChange}
                    />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Classic BranchTree view */
          <div className="sim-content__tree">
            <Suspense fallback={<SimulationSlotFallback label={t('sim.tree.waiting')} />}>
              <LazyClassicBranchTree onIntervene={handleIntervene} onDetail={handleDetail} />
            </Suspense>
          </div>
        )}

        {/* Sidebar toggle pill — always points outward */}
        <button
          className={`sim-sidebar-toggle ${panelCollapsed ? 'sim-sidebar-toggle--collapsed' : ''}`}
          onClick={() => setPanelCollapsed((prev) => !prev)}
          title={panelCollapsed ? t('sim.panel_expand') : t('sim.panel_collapse')}
          aria-label={panelCollapsed ? t('sim.panel_expand') : t('sim.panel_collapse')}
        >
          <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
            {panelCollapsed
              ? <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              : <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            }
          </svg>
        </button>

        {/* Agent Panel */}
        <div className={`sim-content__panel ${panelCollapsed ? 'sim-content__panel--collapsed' : ''}`}>
          <Suspense fallback={<SimulationSlotFallback label={t('sim.panel.waiting')} />}>
            <LazyAgentPanel onBranchDetail={handleDetail} />
          </Suspense>
        </div>
      </div>

      {/* Timeline Bar */}
      {!(viewMode === 'theater' && canUseReplayControls) && (
      <Suspense fallback={<SimulationSlotFallback label={t('sim.timeline.preparing')} />}>
        <LazyTimelineBar
          interactive={canUseReplayControls}
          compact={canUseReplayControls}
          selectedRound={selectedReplayRound}
          roundMarkers={timelineRoundMarkers}
          onRoundSelect={handleReplayRoundChange}
        />
      </Suspense>
      )}

      {/* Intervention Modal */}
      {interventionTarget && id && !isReplayMode && (
        <Suspense fallback={null}>
          <LazyInterventionModal
            scenarioId={id}
            branchId={interventionTarget.branchId}
            branchTitle={interventionTarget.branchTitle}
            activeBranches={activeBranches}
            branchRoundLimits={branchRoundLimits}
            currentRound={Math.max(currentRound, 1)}
            onClose={() => setInterventionTarget(null)}
          />
        </Suspense>
      )}

      {/* Branch Detail Modal */}
      {detailBranch && (
        <Suspense fallback={null}>
          <LazyBranchDetailModal
            branch={detailBranch}
            onClose={() => setDetailBranch(null)}
          />
        </Suspense>
      )}

      {/* Prediction Modal (P5-B) */}
      {showPrediction && id && !isReplayMode && (
        <Suspense fallback={null}>
          <LazyPredictionModal
            scenarioId={id}
            initialMeta={scenarioMeta}
            branches={branches}
            question={scenario?.question}
            sceneTheme={scenario?.scene_theme}
            currentRound={Math.max(currentRound, 1)}
            onAutomationStateChange={setPredictionAutomation}
            onPlacedBet={handlePlacedBet}
            onClose={handlePredictionClose}
          />
        </Suspense>
      )}

      {showGameplayCards && id && !isReplayMode && (
        <Suspense fallback={null}>
          <LazyGameplayCardsModal
            scenarioId={id}
            initialMeta={scenarioMeta}
            branches={branches}
            agents={agents}
            question={scenario?.question ?? ''}
            sceneTheme={scenario?.scene_theme}
            currentRound={Math.max(currentRound, 1)}
            readOnly={!canUseGameplayCards}
            disabledReason={!canUseGameplayCards ? t('sim.warmup.cards_preview') : null}
            onApplied={handleGameplayApplied}
            onAutomationStateChange={setGameplayAutomation}
            onClose={handleGameplayCardsClose}
          />
        </Suspense>
      )}
    </div>
  );
}
