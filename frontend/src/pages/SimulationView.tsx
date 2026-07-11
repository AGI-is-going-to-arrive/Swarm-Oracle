/* ═══════════════════════════════════════════════════════════
   SwarmOracle — SimulationView (Main Simulation Page)
   ═══════════════════════════════════════════════════════════ */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SimWarmupNarrative } from '../components/SimWarmupNarrative';
import { TheaterCurtain } from '../components/TheaterCurtain';
import '../components/SimWarmup.css';
import { useSimulationStore } from '../stores/simulationStore';
import { useSimulationWS } from '../hooks/useSimulationWS';
import { useSimulationReplayState } from '../hooks/useSimulationReplayState';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import {
  useSimulationCaptureControls,
  useSimulationDirectorState,
} from '../hooks/useSimulationViewState';
import {
  cancelScenario,
  createReplayArtifact,
  getSessionBoundUserId,
  importReplayScenario,
} from '../api/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { buildAutomationErrorState, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
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
const LazyAgentProfileSheet = lazy(() =>
  import('../components/result/AgentProfileSheet').then((mod) => ({ default: mod.AgentProfileSheet }))
);
const LazyTimelineBar = lazy(() =>
  import('../components/TimelineBar').then((mod) => ({ default: mod.TimelineBar }))
);
const LazyInterventionModal = lazy(() => import('../components/InterventionModal'));
const LazyInterventionReceiptCard = lazy(() =>
  import('../components/InterventionReceiptCard').then((mod) => ({
    default: mod.InterventionReceiptCard,
  })),
);
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
import { BubbleOverlay } from '../game/BubbleOverlay';
import { getTheaterThemeLabel } from '../lib/themeLabels';
import {
  getScenarioRuntimePresetConfig,
  loadScenarioRuntimePreset,
  matchScenarioRuntimePreset,
} from '../lib/runtimePreset';
import {
  buildAgentProfileObservation,
} from '../lib/agentProfileObservation';
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
  STUCK_HARD_CAP_MS,
  STUCK_STATUS_REPOLL_INTERVAL_MS,
  formatTheaterLabel,
  shouldWarmTheaterLoaderOnIntent,
} from './simulationHelpers';
import { TheaterFloatingToolbar } from './sim/TheaterFloatingToolbar';
import './SimulationView.css';

function SimulationSlotFallback({ label }: { label: string }) {
  return <div className="sim-slot-fallback">{label}</div>;
}

interface SimulationAutomationRouteIntent {
  scenarioId: string | null;
  replayIntent: boolean;
}

interface SimulationAutomationRouteIntentRef {
  current: SimulationAutomationRouteIntent;
}

interface SimulationSceneAutomationSourceIntent {
  routeIntent: SimulationAutomationRouteIntent;
  renderedScenarioId: string | null;
  replayApplied: boolean;
}

function readBrowserAutomationRouteIntent(): SimulationAutomationRouteIntent | null {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(window.location.search);
  if (search.get('replay') || search.get('share')) {
    return { scenarioId: null, replayIntent: true };
  }
  const match = window.location.pathname.match(/^\/sim\/([^/]+)\/?$/);
  if (!match || match[1] === 'replay') return null;
  try {
    return { scenarioId: decodeURIComponent(match[1]), replayIntent: false };
  } catch {
    return { scenarioId: match[1], replayIntent: false };
  }
}

function getAutomationRouteIntents(
  routeIntent: SimulationAutomationRouteIntent,
): SimulationAutomationRouteIntent[] {
  const browserIntent = readBrowserAutomationRouteIntent();
  return browserIntent ? [routeIntent, browserIntent] : [routeIntent];
}

function shouldIsolateAutomationAtCall(
  routeIntent: SimulationAutomationRouteIntent,
  renderedScenarioId: string | null,
  replayApplied: boolean,
): boolean {
  return getAutomationRouteIntents(routeIntent).some(
    (intent) => intent.replayIntent
      ? !replayApplied
      : Boolean(
          intent.scenarioId
          && renderedScenarioId !== intent.scenarioId
        ),
  );
}

function renderIsolatedReplayAutomation(): string {
  return stringifyAutomationPayload(
    {
      question: null,
      status: 'loading',
      currentRound: 0,
      totalRounds: null,
      viewMode: 'classic',
      visualizationEnabled: false,
      isSimulationComplete: false,
      messageCount: 0,
      agentCount: 0,
      branchCount: 0,
      thinkingAgentCount: 0,
      thinkingAgents: [],
    },
    null,
    {
      route: window.location.pathname,
      kind: 'simulation',
      replay_source: 'token',
      controls: {
        can_go_back: false,
        can_toggle_view_mode: false,
        can_open_gameplay_cards: false,
        can_preview_gameplay_cards: false,
        can_open_prediction: false,
        can_view_results: false,
        can_copy_replay_link: false,
        can_capture_screenshot: false,
        can_capture_gif: false,
        can_capture_modal: false,
        can_toggle_sidebar: false,
        active_modal: null,
        modal_state: null,
      },
      branches: [],
    },
  );
}

export function SimulationView() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const replayIntent = Boolean(
    new URLSearchParams(location.search).get('replay')
    || new URLSearchParams(location.search).get('share'),
  );
  const routeIntentRef = useRef<SimulationAutomationRouteIntent>({
    scenarioId: id ?? null,
    replayIntent,
  });
  useLayoutEffect(() => {
    routeIntentRef.current = {
      scenarioId: id ?? null,
      replayIntent,
    };
  }, [id, replayIntent]);
  return (
    <SimulationViewContent
      key={`${id ?? 'replay'}:${location.search}`}
      routeIntentRef={routeIntentRef}
    />
  );
}

function SimulationViewContent({
  routeIntentRef,
}: {
  routeIntentRef: SimulationAutomationRouteIntentRef;
}) {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const replayToken = searchParams.get('replay');
  const replayShareId = searchParams.get('share');
  const hasReplayIntent = Boolean(replayToken || replayShareId);
  const [replayApplied, setReplayApplied] = useState(false);
  const replayAppliedRef = useRef(replayApplied);
  replayAppliedRef.current = replayApplied;
  const replayScenarioIdRef = useRef<string | null>(null);
  const replaySceneSourceRef = useRef<AutomationWindow['__swarmGetSceneAutomation']>(undefined);
  const replaySceneSourceIntentRef = useRef<SimulationSceneAutomationSourceIntent | null>(null);
  const replaySceneGuardRef = useRef<AutomationWindow['__swarmGetSceneAutomation']>(undefined);
  const replaySceneGuardInstallerRef = useRef<(() => void) | null>(null);
  const shouldIsolateReplayIntent = hasReplayIntent && !replayApplied;
  const [useDomBubbles] = useState(() => (
    searchParams.get('domBubbles') !== '0' && searchParams.get('useDomBubbles') !== 'false'
  ));
  const isZh = i18n.language.startsWith('zh');
  const activeScenarioId = useSimulationStore((s) => s.activeScenarioId);
  const storeScenario = useSimulationStore((s) => s.scenario);
  const storeAgents = useSimulationStore((s) => s.agents);
  const storeBranches = useSimulationStore((s) => s.branches);
  const storeMessages = useSimulationStore((s) => s.messages);
  const storeThinkingAgents = useSimulationStore((s) => s.thinkingAgents);
  const storeStatus = useSimulationStore((s) => s.status);
  const storeError = useSimulationStore((s) => s.error);
  const storeErrorCode = useSimulationStore((s) => s.errorCode);
  const loadScenario = useSimulationStore((s) => s.loadScenario);
  const storeIsSimulationComplete = useSimulationStore((s) => s.isSimulationComplete);
  const storeVisualizationEnabled = useSimulationStore((s) => s.visualizationEnabled);
  const storeViewMode = useSimulationStore((s) => s.viewMode);
  const storeCurrentRound = useSimulationStore((s) => s.currentRound);
  const storeInterventionLifecycle = useSimulationStore((s) => s.interventionLifecycle);
  const toggleViewMode = useSimulationStore((s) => s.toggleViewMode);
  const setScenario = useSimulationStore((s) => s.setScenario);
  const { enabled: youVsOracleEnabled } = useCapabilityCheck('you_vs_oracle');
  const storeLastContentEventAt = useSimulationStore((s) => s.lastContentEventAt);
  const routeStateMatches = !shouldIsolateReplayIntent && (
    !id || (
      activeScenarioId === id
      && (!storeScenario || storeScenario.id === id)
    )
  );
  const scenario = routeStateMatches ? storeScenario : null;
  replayScenarioIdRef.current = scenario?.id ?? null;
  const agents = useMemo(
    () => (routeStateMatches ? storeAgents : []),
    [routeStateMatches, storeAgents],
  );
  const branches = useMemo(
    () => (routeStateMatches ? storeBranches : []),
    [routeStateMatches, storeBranches],
  );
  const messages = useMemo(
    () => (routeStateMatches ? storeMessages : []),
    [routeStateMatches, storeMessages],
  );
  const thinkingAgents = useMemo(
    () => (routeStateMatches ? storeThinkingAgents : []),
    [routeStateMatches, storeThinkingAgents],
  );
  const status = routeStateMatches ? storeStatus : 'idle';
  const error = routeStateMatches ? storeError : null;
  const errorCode = routeStateMatches ? storeErrorCode : null;
  const isSimulationComplete = routeStateMatches ? storeIsSimulationComplete : false;
  const visualizationEnabled = routeStateMatches ? storeVisualizationEnabled : false;
  const viewMode = routeStateMatches ? storeViewMode : 'classic';
  const currentRound = routeStateMatches ? storeCurrentRound : 0;
  const interventionLifecycle = useMemo(
    () => (routeStateMatches ? storeInterventionLifecycle : new Map()),
    [routeStateMatches, storeInterventionLifecycle],
  );
  const lastContentEventAt = routeStateMatches ? storeLastContentEventAt : 0;

  useLayoutEffect(() => {
    const win = window as AutomationWindow;
    const captureSource = (source: AutomationWindow['__swarmGetSceneAutomation']) => {
      if (!source || source === replaySceneGuardRef.current) return;
      replaySceneSourceRef.current = source;
      replaySceneSourceIntentRef.current = {
        routeIntent: { ...routeIntentRef.current },
        renderedScenarioId: replayScenarioIdRef.current,
        replayApplied: replayAppliedRef.current,
      };
    };
    const guard: NonNullable<AutomationWindow['__swarmGetSceneAutomation']> = () => {
      if (shouldIsolateAutomationAtCall(
        routeIntentRef.current,
        replayScenarioIdRef.current,
        replayAppliedRef.current,
      )) return null;
      const sourceIntent = replaySceneSourceIntentRef.current;
      const currentIntent = routeIntentRef.current;
      if (
        !sourceIntent
        || sourceIntent.routeIntent.replayIntent !== currentIntent.replayIntent
        || sourceIntent.replayApplied !== replayAppliedRef.current
        || (
          currentIntent.replayIntent
            ? sourceIntent.renderedScenarioId !== replayScenarioIdRef.current
            : sourceIntent.routeIntent.scenarioId !== currentIntent.scenarioId
        )
      ) {
        return null;
      }
      const routeIntents = getAutomationRouteIntents(routeIntentRef.current);
      const sceneState = replaySceneSourceRef.current?.() ?? null;
      if (!sceneState) return null;
      const sourceScenarioId = sceneState.scenario_id;
      const expectedScenarioIds = routeIntents.flatMap((intent) => {
        const expectedScenarioId = intent.replayIntent
          ? replayScenarioIdRef.current
          : intent.scenarioId;
        return expectedScenarioId ? [expectedScenarioId] : [];
      });
      if (
        typeof sourceScenarioId === 'string'
        && expectedScenarioIds.some((expected) => sourceScenarioId !== expected)
      ) {
        return null;
      }
      return sceneState;
    };
    replaySceneGuardRef.current = guard;
    const guardGetter = () => guard;
    const installGuard = () => {
      const descriptor = Object.getOwnPropertyDescriptor(win, '__swarmGetSceneAutomation');
      const current = win.__swarmGetSceneAutomation;
      if (current !== guard) captureSource(current);
      Object.defineProperty(win, '__swarmGetSceneAutomation', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: guardGetter,
        set: captureSource,
      });
    };
    replaySceneGuardInstallerRef.current = installGuard;
    installGuard();
    return () => {
      const descriptor = Object.getOwnPropertyDescriptor(win, '__swarmGetSceneAutomation');
      if (descriptor?.get === guardGetter) {
        delete win.__swarmGetSceneAutomation;
      }
      replaySceneGuardInstallerRef.current = null;
      replaySceneGuardRef.current = undefined;
      replaySceneSourceRef.current = undefined;
      replaySceneSourceIntentRef.current = null;
    };
  }, [routeIntentRef]);

  useEffect(() => {
    replaySceneGuardInstallerRef.current?.();
  }, [replayApplied, viewMode]);
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
  const completedRouteEntryCheckedRef = useRef(false);
  const forceClassicForDoneOnEntry = Boolean(
    (location.state as { forceClassicForDone?: unknown } | null)?.forceClassicForDone,
  );

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
  const [profileTargetId, setProfileTargetId] = useState<string | null>(null);

  // Prediction modal state (P5-B)
  const [showPrediction, setShowPrediction] = useState(false);
  const [predictionAutomation, setPredictionAutomation] = useState<Record<string, unknown> | null>(null);
  const [showGameplayCards, setShowGameplayCards] = useState(false);
  const [gameplayAutomation, setGameplayAutomation] = useState<Record<string, unknown> | null>(null);
  const [gameplayToast, setGameplayToast] = useState<string | null>(null);
  const [gameplayActiveMarker, setGameplayActiveMarker] = useState<{
    cardLabel: string;
    round: number;
  } | null>(null);
  const gameplayToastTimerRef = useRef<number | null>(null);
  const [commitmentFeedback, setCommitmentFeedback] = useState<{
    tone: 'info' | 'success';
    message: string;
  } | null>(null);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [replayLinkUnavailable, setReplayLinkUnavailable] = useState(false);
  const [importingReplay, setImportingReplay] = useState(false);
  // S1-1: cancellation UI state
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelInFlight, setCancelInFlight] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const lastCommitmentAction = useRef<'commit' | 'clear' | null>(null);
  const commitmentFeedbackTimer = useRef<number | null>(null);
  const theaterGameWrapperRef = useRef<HTMLDivElement>(null);
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
    replayLoadStatus,
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
  const profileTargetAgent = agents.find((agent) => agent.id === profileTargetId) ?? null;
  const profileObservation = profileTargetAgent
    ? buildAgentProfileObservation({
        agent: profileTargetAgent,
        messages,
        branches,
        selection: isSimulationComplete || isReplayMode
          ? {
              kind: 'replay',
              branchId: selectedReplayBranchId,
              branchTitle: replayBranchOptions.find(
                (branch) => branch.id === selectedReplayBranchId,
              )?.title ?? null,
              round: selectedReplayRound,
            }
          : { kind: 'live' },
      })
    : null;
  const isTerminal = status === 'error' || status === 'cancelled' || status === 'done';
  // Interventions are live-only actions: replay, terminal, parsing, and narrating views are read-only.
  const canIntervene = status === 'simulating' && !isReplayMode && !isSimulationComplete;
  const canOpenPrediction = youVsOracleEnabled
    && !isReplayMode
    && (status === 'parsing' || status === 'simulating');
  useEffect(() => {
    if (canOpenPrediction) return;
    setShowPrediction(false);
    setPredictionAutomation(null);
  }, [canOpenPrediction]);
  const canInterveneOnBranch = useCallback(
    (branch: BranchInfo) => canIntervene && branch.status === 'ACTIVE',
    [canIntervene],
  );
  const totalRounds = useMemo(() => {
    const value = scenario?.total_rounds;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
  }, [scenario?.total_rounds]);
  const displayStatus = useMemo(() => {
    if (isTerminal) return status;
    if (
      status === 'simulating'
      && totalRounds !== null
      && currentRound >= totalRounds
      && messages.length > 0
    ) {
      return 'narrating';
    }
    return status;
  }, [currentRound, messages.length, status, totalRounds, isTerminal]);
  const isSimulatingOrNarrating = displayStatus === 'simulating' || displayStatus === 'narrating';
  const cancelledStatus = status === 'cancelled';
  const canCancelSimulation =
    !isReplayMode
    && !cancelledStatus
    && !isSimulationComplete
    && status !== 'error'
    && (status === 'parsing' || status === 'simulating' || status === 'narrating');
  const handleCancelRequest = useCallback(() => {
    if (!canCancelSimulation) return;
    setCancelError(null);
    setShowCancelConfirm(true);
  }, [canCancelSimulation]);
  const handleCancelDismiss = useCallback(() => {
    if (cancelInFlight) return;
    setShowCancelConfirm(false);
  }, [cancelInFlight]);
  const handleCancelConfirm = useCallback(async () => {
    if (!id || cancelInFlight) return;
    setCancelInFlight(true);
    setCancelError(null);
    try {
      await cancelScenario(id);
      setShowCancelConfirm(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'cancel_failed';
      setCancelError(message);
    } finally {
      setCancelInFlight(false);
    }
  }, [cancelInFlight, id]);
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
    if (!replayPayload) {
      setReplayApplied(false);
      return;
    }
    setScenario(replayPayload.scenario, { replayMode: true });
    setBackendDirectorState(replayPayload.scenario.director_state ?? null);
    setBackendGameplayState(replayPayload.scenario.gameplay_state ?? null);
    setReplayApplied(true);
  }, [replayPayload, setBackendDirectorState, setBackendGameplayState, setScenario]);
  const gameplayProfile = useMemo(
    () => (scenario ? inferGameplayProfile(scenario.question, scenario.scene_theme) : null),
    [scenario],
  );
  const archiveKeyMoments = useMemo(
    () => (scenarioMeta ? getScenarioArchiveKeyMoments(scenarioMeta) : []),
    [scenarioMeta],
  );
  const liveInterventionCount = useMemo(
    () => Array.from(interventionLifecycle.values()).filter((state) => (
      state === 'queued' || state === 'injected'
    )).length,
    [interventionLifecycle],
  );
  const interventionReceiptRefreshKey = useMemo(
    () => Array.from(interventionLifecycle.entries())
      .map(([id, state]) => `${id}:${state}`)
      .sort()
      .join('|'),
    [interventionLifecycle],
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
          t,
        })
        : []
    ),
    [dominantBranch, isSimulationComplete, isZh, scenarioMeta, t],
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
    && branches.length > 0
    && !isWarmupPhase;
  const canUseGameplayCards = !isReplayMode && !isSimulationComplete && activeBranches.length > 0 && agents.length > 0;
  const gameplayCardsPreviewReason = isSimulationComplete
    ? t('gameplay.preview_completed_note')
    : t('sim.warmup.cards_preview');
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
    completedRouteEntryCheckedRef.current = false;
  }, [forceClassicForDoneOnEntry, id, isReplayMode]);

  useEffect(() => {
    if (!forceClassicForDoneOnEntry) return;
    if (completedRouteEntryCheckedRef.current) return;
    if (isReplayMode) {
      completedRouteEntryCheckedRef.current = true;
      return;
    }
    if (!id || !scenario || scenario.id !== id) return;

    completedRouteEntryCheckedRef.current = true;
    if (scenario.status === 'done' && viewMode !== 'classic') {
      setScenario(scenario, { forceClassicForDone: true });
    }
  }, [forceClassicForDoneOnEntry, id, isReplayMode, scenario, setScenario, viewMode]);

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
    if (
      !hasScenarioDirectorAuthority(backendDirectorState ?? scenario.director_state ?? null)
      && (scenarioMeta.commitment.active || scenarioMeta.commitment.outcome)
    ) {
      return;
    }
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
    void persistDirectorMeta(nextMeta, { objectives: true, commitment: false });
  }, [backendDirectorState, gameplayProfile, id, isReplayMode, persistDirectorMeta, refreshLocalMeta, scenario, scenarioMeta, signatureArcState]);

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

  // ── Staleness watchdog ──
  // The backend can orphan a run (a process restart drops the in-process state-machine
  // task) so the scenario sits in SIMULATING forever with no terminal event. We treat a
  // run as "stuck" purely by how long `currentRound` has stopped advancing, and reset the
  // clock every time it advances — a genuinely slow-but-progressing run is never flagged.
  // While stuck we also re-poll the snapshot so that once the backend marks the run ERROR
  // the UI flips to the terminal panel without a manual refresh. (The softer warmup
  // "running for a while" reassurance lives in the shared progress banner, TimelineBar.)
  const [simulationStuck, setSimulationStuck] = useState(false);
  const lastProgressRoundRef = useRef(currentRound);
  const lastProgressAtRef = useRef<number>(Date.now());
  const stuckRepollInFlight = useRef(false);
  const isLiveActivePhase =
    !isReplayMode
    && !isSimulationComplete
    && !cancelledStatus
    && status !== 'error'
    && (status === 'parsing' || status === 'simulating' || status === 'narrating');

  // Reset the progress clock whenever the round advances, the content event signal changes, or the scenario changes.
  useEffect(() => {
    lastProgressRoundRef.current = currentRound;
    lastProgressAtRef.current = Date.now();
    setSimulationStuck(false);
  }, [currentRound, lastContentEventAt, id]);

  // Any terminal/non-live state clears the watchdog flag immediately.
  useEffect(() => {
    if (!isLiveActivePhase) {
      setSimulationStuck(false);
    }
  }, [isLiveActivePhase]);

  useEffect(() => {
    if (!isLiveActivePhase || !id) return;

    // Entering an active phase (or remounting) restarts the clock so a fresh run is
    // judged from now, not from a stale timestamp left over by a previous scenario.
    lastProgressRoundRef.current = currentRound;
    lastProgressAtRef.current = Date.now();
    setSimulationStuck(false);

    let cancelled = false;
    const repollStuckScenario = async () => {
      if (cancelled || stuckRepollInFlight.current) return;
      stuckRepollInFlight.current = true;
      try {
        await loadScenario(id);
      } catch (err) {
        console.warn('[Watchdog] Stuck re-poll failed:', err);
      } finally {
        stuckRepollInFlight.current = false;
      }
    };

    const timer = window.setInterval(() => {
      const elapsed = Date.now() - lastProgressAtRef.current;
      if (elapsed >= STUCK_HARD_CAP_MS) {
        setSimulationStuck(true);
        // Probe the backend in case it has already reconciled the orphan to ERROR.
        if (elapsed % STUCK_STATUS_REPOLL_INTERVAL_MS < 1000) {
          void repollStuckScenario();
        }
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // currentRound is intentionally omitted: the round-change reset effect above owns
    // restarting the clock, so we must not tear down/recreate the timer on every round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLiveActivePhase, id, loadScenario]);

  const handleStuckRetry = useCallback(() => {
    navigate('/', { state: { prefillQuestion: scenario?.question ?? '' } });
  }, [navigate, scenario?.question]);

  const handleIntervene = useCallback((branchId: string, branchTitle: string) => {
    const branch = branches.find((candidate) => candidate.id === branchId);
    if (!branch || !canInterveneOnBranch(branch)) return;
    setInterventionTarget({ branchId, branchTitle });
  }, [branches, canInterveneOnBranch]);

  useEffect(() => {
    if (!interventionTarget) return;
    if (!canIntervene) {
      setInterventionTarget(null);
      return;
    }
    const branch = branches.find((candidate) => candidate.id === interventionTarget.branchId);
    if (branch && !canInterveneOnBranch(branch)) {
      setInterventionTarget(null);
    }
  }, [branches, canIntervene, canInterveneOnBranch, interventionTarget]);

  const handleDetail = useCallback((branchId: string) => {
    const branch = branches.find((b) => b.id === branchId);
    if (branch) setDetailBranch(branch);
  }, [branches]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const canOpenGameplayCards = canUseGameplayCards;
    const canPreviewGameplayCardsNow = canPreviewGameplayCards;
    const render = () => {
      if (shouldIsolateAutomationAtCall(
        routeIntentRef.current,
        scenario?.id ?? null,
        replayApplied,
      )) {
        return renderIsolatedReplayAutomation();
      }
      return stringifyAutomationPayload(
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
      shouldIsolateReplayIntent ? null : (win.__swarmGetSceneAutomation?.() ?? null),
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
          can_open_prediction: canOpenPrediction,
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
          use_dom_bubbles: useDomBubbles,
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
          can_intervene: canInterveneOnBranch(branch),
        })),
        },
      );
    };

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
    canOpenPrediction,
    canInterveneOnBranch,
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
    replayApplied,
    routeIntentRef,
    activeRuntimePreset,
    activeRuntimePresetConfig.branchSensitivity,
    activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
    activeRuntimePresetConfig.forkPromptVariant,
    activeRuntimePresetLabel,
    selectedReplayBranchId,
    selectedReplayRound,
    scenarioRuntimePreset,
    theaterSceneState,
    useDomBubbles,
    scenario,
    replayUrl,
    isReplayMode,
    showGameplayCards,
    showPrediction,
    shouldIsolateReplayIntent,
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
    const {
      buildSimulationReplayUrl,
      sanitizeSimulationReplayPayload,
    } = await loadSimulationReplayHelpers();
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
    const publicReplayPayload = sanitizeSimulationReplayPayload({
      scenario: snapshot,
      scenarioMeta: compactReplayMeta,
      uiState,
    });
    const artifact = await Promise.resolve()
      .then(() => createReplayArtifact('simulation_view_v1', { ...publicReplayPayload }))
      .catch(() => null);
    try {
      const url = artifact
        ? `${window.location.origin.replace(/\/$/, '')}/sim/replay?share=${artifact.id}`
        : await buildSimulationReplayUrl(window.location.origin, publicReplayPayload);
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

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const timelineClass = 'has-visible-theater-timeline';

    if (canUseReplayControls) {
      document.body.classList.add(timelineClass);
    } else {
      document.body.classList.remove(timelineClass);
    }

    return () => {
      document.body.classList.remove(timelineClass);
    };
  }, [canUseReplayControls]);

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
  const handleGameplayAppliedWithFeedback = useCallback(
    async (...args: Parameters<typeof handleGameplayApplied>) => {
      const result = await handleGameplayApplied(...args);
      const [nextMeta] = args;
      const usageList = nextMeta?.cards?.usageLog ?? [];
      const latestUsage = usageList.length > 0 ? usageList[usageList.length - 1] : null;
      if (latestUsage) {
        const cardDef = getGameplayCardDefinition(latestUsage.cardId);
        const cardLabel = isZh ? cardDef.labelZh : cardDef.labelEn;
        setGameplayActiveMarker({ cardLabel, round: latestUsage.round });
      }
      setGameplayToast(t('gameplay.toast_applied'));
      if (gameplayToastTimerRef.current) {
        window.clearTimeout(gameplayToastTimerRef.current);
      }
      gameplayToastTimerRef.current = window.setTimeout(() => {
        setGameplayToast(null);
        gameplayToastTimerRef.current = null;
      }, 3200);
      return result;
    },
    [handleGameplayApplied, isZh, t],
  );
  useEffect(() => {
    return () => {
      if (gameplayToastTimerRef.current) {
        window.clearTimeout(gameplayToastTimerRef.current);
        gameplayToastTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!gameplayActiveMarker) return;
    if (currentRound > gameplayActiveMarker.round) {
      setGameplayActiveMarker(null);
    }
  }, [currentRound, gameplayActiveMarker]);
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
    const render = () => {
      if (shouldIsolateAutomationAtCall(
        routeIntentRef.current,
        scenario?.id ?? null,
        replayApplied,
      )) {
        return renderIsolatedReplayAutomation();
      }
      return stringifyAutomationPayload(
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
      shouldIsolateReplayIntent ? null : (win.__swarmGetSceneAutomation?.() ?? null),
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
          can_open_prediction: canOpenPrediction,
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
          use_dom_bubbles: useDomBubbles,
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
          can_intervene: canInterveneOnBranch(branch),
        })),
        },
      );
    };

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
    canInterveneOnBranch,
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
    canOpenPrediction,
    gameplayAutomation,
    predictionAutomation,
    replayAutomationState,
    replayApplied,
    routeIntentRef,
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
    shouldIsolateReplayIntent,
    status,
    systemTracks,
    canToggleViewMode,
    lastCaptureKind,
    useDomBubbles,
    viewMode,
    visualizationEnabled,
  ]);

  // Back target: prefer an explicit origin passed via navigation state (e.g. the
  // multi-run waiting panel sends backTo=/result/<firstRunId> when you click
  // "watch this worldline"), then fall back to the run-group result page when the
  // scenario belongs to a multi-run (survives a hard refresh — state is gone but
  // scenario.run_group_id is loaded), and finally to home for plain single runs.
  const backTo =
    (location.state as { backTo?: string } | null)?.backTo ??
    (scenario?.run_group_id ? `/result/${scenario.id ?? id ?? ''}` : '/');

  if (
    isReplayMode
    && (
      replayLoadStatus === 'idle'
      || replayLoadStatus === 'loading'
      || (replayLoadStatus === 'ready' && !replayApplied)
    )
  ) {
    return (
      <div className="simulation-view" aria-busy="true">
        <p role="status">{t('sim.status.loading')}</p>
      </div>
    );
  }

  if (isReplayMode && replayLoadStatus === 'error') {
    return (
      <div className="simulation-view">
        <div className="sim-error" role="alert">
          <p>⚠️ {t('sim.status.error')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`simulation-view ${viewMode === 'theater' ? 'simulation-view--theater' : ''} ${canUseReplayControls ? 'simulation-view--replay-ready' : ''}`}>
      {/* Header */}
      <header className="sim-header">
        <button className="btn btn-ghost btn--back" onClick={() => navigate(backTo)}>
          {t('sim.status.back')}
        </button>
        <div className="sim-header__info">
          <div className="sim-header__question-row">
            <h2 className="sim-header__question">
              {scenario?.question || t('sim.status.loading')}
            </h2>
            <span
              className={`badge badge-${
                status === 'error' || cancelledStatus ? 'pruned' : 'active'
              }`}
            >
              {status === 'error'
                ? t('sim.status.error')
                : cancelledStatus
                  ? t('simulation.cancelled_title')
                  : status === 'done'
                    ? t('sim.status.completed')
                    : t('sim.status.running')}
            </span>
          </div>
          <div className="sim-header__meta-row">
            <span
              className="badge badge-active"
              role="note"
              tabIndex={0}
              aria-describedby="sim-runtime-preset-details"
              aria-label={`${t('sim.runtime_preset_title')}: ${activeRuntimePresetLabel}. ${t('common.runtime_preset_scope_main')}`}
            >
              {t('sim.runtime_preset_title')}: {activeRuntimePresetLabel}
            </span>
            <span id="sim-runtime-preset-details" className="sr-only">
              {t('common.runtime_preset_scope_main')}
            </span>
          </div>
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
          {canCancelSimulation && (
            <button
              type="button"
              className="btn btn-danger sim-cancel-btn"
              onClick={handleCancelRequest}
              disabled={cancelInFlight}
              data-testid="simulation-cancel-button"
            >
              {t('simulation.cancel_button')}
            </button>
          )}
          {canOpenPrediction && !cancelledStatus && (
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

      {isSimulatingOrNarrating && !isTerminal && (
        <Suspense fallback={null}>
          <LazyTimelineBar key={scenario?.id ?? id ?? 'live'} stickyBanner />
        </Suspense>
      )}

      {/* Error state. The generic runtime fallback (errorCode RUNTIME_ERROR, set by the
          snapshot reducer when a failed run carries no specific message) is rendered via
          i18n so it follows live language switches; concrete API errors keep their
          already-localized message. */}
      {error && (
        <div className="sim-error">
          <p>⚠️ {errorCode ? getLocalizedApiErrorMessage({ code: errorCode }, t, error || t('simulation.runtime_failed')) : error}</p>
          <button className="btn btn-ghost" onClick={() => navigate(backTo)}>
            {t('sim.status.back')}
          </button>
        </div>
      )}

      {/* Interrupted / stuck state — an orphaned run reconciled to ERROR by the backend
          surfaces as status='error' with no error string on a polled snapshot; the
          client-side watchdog also flips this on when progress stalls past the hard cap.
          Gated on !error so it never double-renders with the error-string panel above. */}
      {!error && !isReplayMode && status === 'error' && !isSimulatingOrNarrating && (
        <div className="sim-error" role="alert" data-testid="simulation-stuck-banner-error">
          <p>⚠️ {t('simulation.stuck_title')} {t('simulation.stuck_desc')}</p>
          <button className="btn" onClick={handleStuckRetry}>
            {t('simulation.stuck_retry')}
          </button>
          <button className="btn btn-ghost" onClick={() => navigate(backTo)}>
            {t('simulation.stuck_back')}
          </button>
        </div>
      )}

      {!error && !isReplayMode && simulationStuck && status !== 'error' && (
        <div className="sim-error sim-error--soft" role="status" aria-live="polite" data-testid="simulation-stuck-banner-soft">
          <p>⚠️ {t('simulation.stuck_title_soft')} {t('simulation.stuck_desc_soft')}</p>
          <button className="btn" onClick={handleStuckRetry}>
            {t('simulation.stuck_retry')}
          </button>
          <button className="btn btn-ghost" onClick={() => navigate(backTo)}>
            {t('simulation.stuck_back')}
          </button>
        </div>
      )}

      {isReplayMode && (
        <div className="sim-error">
          <p>🔒 {t('sim.replay.read_only')}</p>
        </div>
      )}

      {cancelledStatus && (
        <div className="sim-cancelled" role="status" aria-live="polite" data-testid="simulation-cancelled-banner">
          <div className="sim-cancelled__copy">
            <strong>{t('simulation.cancelled_title')}</strong>
            <span>{t('simulation.cancelled_desc')}</span>
          </div>
          <button className="btn btn-ghost" onClick={() => navigate(backTo)}>
            {t('sim.status.back')}
          </button>
        </div>
      )}

      <AlertDialog
        open={showCancelConfirm}
        onOpenChange={(open) => {
          if (!open) handleCancelDismiss();
        }}
      >
        <AlertDialogContent
          className="sim-cancel-dialog"
          overlayClassName="sim-cancel-dialog-backdrop"
          aria-label={t('simulation.cancel_confirm_title')}
          aria-busy={cancelInFlight}
          data-testid="simulation-cancel-confirm"
        >
          <AlertDialogHeader className="sim-cancel-dialog__header">
            <AlertDialogTitle asChild>
              <h3>{t('simulation.cancel_confirm_title')}</h3>
            </AlertDialogTitle>
            <AlertDialogDescription className="sim-cancel-dialog__desc">
              {t('simulation.cancel_confirm_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelError && (
            <p className="sim-cancel-error" role="alert">
              {cancelError}
            </p>
          )}
          {cancelInFlight && (
            <p className="sim-cancel-dialog__busy" role="status" aria-live="polite">
              {t('simulation.cancel_confirm_in_progress')}
            </p>
          )}
          <AlertDialogFooter className="sim-cancel-dialog__footer">
            <AlertDialogCancel
              className="btn btn-ghost"
              onClick={(event) => {
                if (cancelInFlight) {
                  event.preventDefault();
                }
              }}
              disabled={cancelInFlight}
            >
              {t('simulation.cancel_confirm_dismiss')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="btn sim-cancel-dialog__action"
              onClick={(event) => {
                event.preventDefault();
                void handleCancelConfirm();
              }}
              disabled={cancelInFlight}
              data-testid="simulation-cancel-confirm-action"
            >
              {t('simulation.cancel_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Main content */}
      <div className="sim-content">
        {/* V2: Pixel Theater — takes over tree area when active */}
        {viewMode === 'theater' ? (
          <div className="sim-content__tree">
            <div className="theater-panel">
              <TheaterFloatingToolbar
                captureControls={{
                  canUseReplayControls,
                  restartTheaterPlayback,
                  cycleReplaySpeed,
                  replaySpeed,
                  captureMode,
                  setCaptureMode,
                  hasActiveModal,
                  captureModeDescription,
                  handleScreenshotCapture,
                  captureStatus,
                  isModalCaptureAvailable,
                  handleGifCapture,
                  lastCaptureKind,
                  captureDoneLabel,
                }}
                statusChips={{
                  theaterSceneLabel,
                  theaterThemeLabel,
                  displayedReplayRound,
                  totalRounds: scenario?.total_rounds ?? null,
                  theaterAgentCount,
                  theaterBubbleCount,
                  theaterWeatherLabel,
                  theaterTimeLabel,
                  messageCount: messages.length,
                }}
                director={{
                  scenarioMeta,
                  systemTracks,
                  evaluatedObjectives,
                  completedObjectiveCount,
                  isSimulationComplete,
                  activeBranches,
                  commitmentDraftBranchId,
                  setCommitmentDraftBranchId,
                  handleCommitBranchAction,
                  handleClearCommitmentAction,
                  commitmentFeedback,
                }}
                gameplayCards={{
                  canPreview: canPreviewGameplayCards,
                  canUse: canUseGameplayCards,
                  previewReason: gameplayCardsPreviewReason,
                  onOpen: () => setShowGameplayCards(true),
                }}
              />
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
              <div className="theater-panel__game-wrapper" ref={theaterGameWrapperRef}>
                <LazyPhaserGameLoader
                  key={`${id ?? 'simulation'}-${theaterMountKey}`}
                  useDomBubbles={useDomBubbles}
                  replaySpeed={replaySpeed}
                  playbackMode={playbackMode}
                  playbackBranchId={selectedReplayBranchId}
                  playbackRound={selectedReplayRound}
                />
                {useDomBubbles && (
                  <BubbleOverlay containerRef={theaterGameWrapperRef} />
                )}
              </div>
              {canUseReplayControls && replayBranchOptions.length > 0 && (
                <div className="theater-panel__filters">
                  {replayBranchOptions.length > 1 ? (
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
                  ) : (
                    <div className="theater-select theater-select--static">
                      <span>{t('game.worldline_label')}</span>
                      <span className="theater-select__static-value">
                        {replayBranchOptions[0]?.title ?? ''}
                      </span>
                    </div>
                  )}
                  {replayRounds.length > 1 ? (
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
                  ) : replayRounds.length === 1 ? (
                    <div className="theater-select theater-select--static">
                      <span>{t('game.round_label')}</span>
                      <span className="theater-select__static-value">
                        {t('game.round_value', { round: replayRounds[0] })}
                      </span>
                    </div>
                  ) : null}
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
              <LazyClassicBranchTree onIntervene={handleIntervene} onDetail={handleDetail} canIntervene={canIntervene} />
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
            <LazyAgentPanel onBranchDetail={handleDetail} onViewProfile={setProfileTargetId} />
          </Suspense>
        </div>
      </div>

      {/* Timeline Bar */}
      {!(viewMode === 'theater' && canUseReplayControls) && !isSimulatingOrNarrating && (
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

      {/* Phase 4: Intervention Effect Receipts — only when simulation has produced receipts.
         Component returns null when there are no persisted effects, so legacy scenarios
         that never used interventions stay visually unchanged. */}
      {id && (isSimulationComplete || liveInterventionCount > 0) && (
        <Suspense fallback={null}>
          <LazyInterventionReceiptCard
            scenarioId={id}
            enabled={isSimulationComplete}
            refreshKey={interventionReceiptRefreshKey}
            interventionLifecycle={interventionLifecycle}
          />
        </Suspense>
      )}

      {/* Intervention Modal */}
      {interventionTarget && id && canIntervene && (
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
      {showPrediction && id && canOpenPrediction && (
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
            disabledReason={!canUseGameplayCards ? gameplayCardsPreviewReason : null}
            onApplied={handleGameplayAppliedWithFeedback}
            onAutomationStateChange={setGameplayAutomation}
            onClose={handleGameplayCardsClose}
          />
        </Suspense>
      )}

      {profileTargetAgent && profileObservation ? (
        <Suspense fallback={null}>
          <LazyAgentProfileSheet
            agent={profileTargetAgent}
            observation={profileObservation}
            userId={getSessionBoundUserId()}
            onClose={() => setProfileTargetId(null)}
          />
        </Suspense>
      ) : null}

      {gameplayActiveMarker && !isReplayMode && (
        <div
          className="sim-gameplay-active-marker"
          role="status"
          aria-label={t('gameplay.active_marker_aria')}
        >
          {t('gameplay.active_marker', { label: gameplayActiveMarker.cardLabel })}
        </div>
      )}

      {gameplayToast && (
        <div className="sim-gameplay-toast" role="status" aria-live="polite">
          {gameplayToast}
        </div>
      )}
    </div>
  );
}
