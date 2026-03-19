/* ═══════════════════════════════════════════════════════════
   SwarmOracle — SimulationView (Main Simulation Page)
   ═══════════════════════════════════════════════════════════ */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useSimulationStore } from '../stores/simulationStore';
import { useSimulationWS } from '../hooks/useSimulationWS';
import {
  createReplayArtifact,
  getReplayArtifact,
  importReplayScenario,
  upsertScenarioDirectorState,
  upsertScenarioGameplayState,
} from '../api/client';
import {
  captureCompositeElementDataUrl,
  captureElementDataUrl,
  type CaptureMode,
  useScreenCapture,
} from '../hooks/useScreenCapture';
import {
  clearBranchCommitment,
  ensureScenarioObjectives,
  loadScenarioMeta,
  setBranchCommitment,
} from '../lib/scenarioMeta';
import { copyText } from '../lib/copyText';
import {
  hasMeaningfulScenarioDirectorState,
  mergeScenarioMetaWithDirectorState,
  scenarioMetaToDirectorState,
} from '../lib/scenarioDirectorState';
import {
  areScenarioGameplayStatesEquivalent,
  hasMeaningfulScenarioGameplayState,
  mergeScenarioMetaWithGameplayState,
  scenarioMetaToGameplayState,
} from '../lib/scenarioGameplayState';
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
import {
  buildReplayBranchOptions,
  filterReplayMessages,
  getLatestReplayRound,
  getReplayRounds,
} from '../game/replaySelection';
import {
  stringifyAutomationPayload,
  type AutomationSceneState,
  type AutomationWindow,
} from '../game/automation';
import { HudOverlay } from '../game/HudOverlay';
import { getTheaterThemeLabel } from '../lib/themeLabels';
import type {
  BranchInfo,
  ScenarioDirectorState,
  ScenarioGameplayState,
} from '../types';
import {
  buildSimulationReplayUrl,
  readSimulationReplayPayload,
  type SimulationReplayPayload,
} from '../lib/simulationReplay';
import './SimulationView.css';

const THEATER_SCENE_LABELS = {
  BootScene: { zh: '启动场景', en: 'Boot Scene' },
  TitleScene: { zh: '标题场景', en: 'Title Scene' },
  WorldScene: { zh: '世界场景', en: 'World Scene' },
  EndingScene: { zh: '结局演出', en: 'Ending Scene' },
} as const;

const THEATER_WEATHER_LABELS: Record<string, { zh: string; en: string }> = {
  clear: { zh: '晴朗', en: 'Clear' },
  rain: { zh: '降雨', en: 'Rain' },
  snow: { zh: '降雪', en: 'Snow' },
  storm: { zh: '雷暴', en: 'Storm' },
  sandstorm: { zh: '沙尘', en: 'Sandstorm' },
};

const THEATER_TIME_LABELS: Record<string, { zh: string; en: string }> = {
  dawn: { zh: '黎明', en: 'Dawn' },
  noon: { zh: '正午', en: 'Noon' },
  dusk: { zh: '黄昏', en: 'Dusk' },
  night: { zh: '夜晚', en: 'Night' },
};

const MODAL_CAPTURE_SELECTORS = [
  '.gameplay-modal',
  '.share-modal',
  '.modal-content',
  '.share-overlay',
  '.modal-overlay',
];

function buildSimulationSnapshot(
  scenario: NonNullable<ReturnType<typeof useSimulationStore.getState>['scenario']>,
  agents: ReturnType<typeof useSimulationStore.getState>['agents'],
  branches: ReturnType<typeof useSimulationStore.getState>['branches'],
  messages: ReturnType<typeof useSimulationStore.getState>['messages'],
  directorState: ScenarioDirectorState | null,
  gameplayState: ScenarioGameplayState | null,
): typeof scenario {
  return {
    ...scenario,
    agents,
    branches,
    messages,
    director_state: directorState ?? scenario.director_state ?? null,
    gameplay_state: gameplayState ?? scenario.gameplay_state ?? null,
  };
}

function formatTheaterLabel(
  key: string | null | undefined,
  labels: Record<string, { zh: string; en: string }>,
  isZh: boolean,
): string | null {
  if (!key) return null;
  const match = labels[key];
  if (match) return isZh ? match.zh : match.en;
  return key.replace(/_/g, ' ');
}

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
  const status = useSimulationStore((s) => s.status);
  const error = useSimulationStore((s) => s.error);
  const loadScenario = useSimulationStore((s) => s.loadScenario);
  const isSimulationComplete = useSimulationStore((s) => s.isSimulationComplete);
  const visualizationEnabled = useSimulationStore((s) => s.visualizationEnabled);
  const viewMode = useSimulationStore((s) => s.viewMode);
  const currentRound = useSimulationStore((s) => s.currentRound);
  const toggleViewMode = useSimulationStore((s) => s.toggleViewMode);
  const setScenario = useSimulationStore((s) => s.setScenario);

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
  const [captureMode, setCaptureMode] = useState<CaptureMode>('panel');
  const [theaterSceneState, setTheaterSceneState] = useState<AutomationSceneState | null>(null);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [playbackMode, setPlaybackMode] = useState<'replay' | 'skip'>('replay');
  const [theaterMountKey, setTheaterMountKey] = useState(0);
  const [selectedReplayBranchId, setSelectedReplayBranchId] = useState<string | null>(null);
  const [selectedReplayRound, setSelectedReplayRound] = useState<number | null>(null);
  const [localMetaRevision, setLocalMetaRevision] = useState(0);
  const [commitmentDraftBranchId, setCommitmentDraftBranchId] = useState('');
  const [backendDirectorState, setBackendDirectorState] = useState<ScenarioDirectorState | null>(null);
  const [backendGameplayState, setBackendGameplayState] = useState<ScenarioGameplayState | null>(null);
  const [replayPayload, setReplayPayload] = useState<SimulationReplayPayload | null>(null);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);

  // Sidebar collapse state (default: open in classic, collapsed in theater)
  const [panelCollapsed, setPanelCollapsed] = useState(viewMode === 'theater');

  // Phase 3 Batch 3: Screen capture
  const { status: captureStatus, lastCaptureKind, captureScreenshot, captureGIF } = useScreenCapture({
    selector: '.phaser-game-container',
  });
  const lastTheaterSceneSignature = useRef<string | null>(null);
  const recoveryLogEmitted = useRef(false);
  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.status === 'ACTIVE'),
    [branches],
  );
  const isReplayMode = Boolean(replayPayload);
  const storedScenarioMeta = useMemo(
    () => (replayPayload?.scenarioMeta ?? (id ? loadScenarioMeta(id) : null)),
    [id, localMetaRevision, replayPayload?.scenarioMeta],
  );
  const scenarioMeta = useMemo(
    () => {
      if (!storedScenarioMeta) return null;
      const gameplayMerged = mergeScenarioMetaWithGameplayState(storedScenarioMeta, backendGameplayState);
      return mergeScenarioMetaWithDirectorState(gameplayMerged, backendDirectorState);
    },
    [backendDirectorState, backendGameplayState, storedScenarioMeta],
  );
  const gameplayProfile = useMemo(
    () => (scenario ? inferGameplayProfile(scenario.question, scenario.scene_theme) : null),
    [scenario],
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
  const canPreviewGameplayCards = !isReplayMode && viewMode === 'theater' && !isSimulationComplete && branches.length > 0;
  const canUseGameplayCards = !isReplayMode && !isSimulationComplete && activeBranches.length > 0 && agents.length > 0;
  const isWarmupPhase =
    !isReplayMode
    && viewMode === 'theater'
    && !isSimulationComplete
    && status === 'simulating'
    && currentRound === 0;
  const canToggleViewMode = viewMode === 'theater' || visualizationEnabled;
  const theaterToggleHint = !canToggleViewMode && viewMode === 'classic'
    ? t('sim.theater_unavailable_hint')
    : undefined;
  const hasActiveModal = Boolean(showPrediction || showGameplayCards || interventionTarget || detailBranch);
  const replayBranchOptions = useMemo(
    () => buildReplayBranchOptions(branches, messages),
    [branches, messages],
  );

  useEffect(() => {
    let cancelled = false;

    const hydrateReplay = async () => {
      if (replayShareId) {
        const artifact = await getReplayArtifact(replayShareId).catch(() => null);
        if (cancelled || !artifact || artifact.kind !== 'simulation_view_v1' || !artifact.payload) return;
        const replay = artifact.payload as unknown as SimulationReplayPayload;
        setReplayPayload(replay);
        setScenario(replay.scenario);
        setBackendDirectorState(replay.scenario.director_state ?? null);
        setBackendGameplayState(replay.scenario.gameplay_state ?? null);
        setSelectedReplayBranchId(replay.uiState?.selectedReplayBranchId ?? null);
        setSelectedReplayRound(replay.uiState?.selectedReplayRound ?? null);
        setPlaybackMode(replay.uiState?.playbackMode ?? 'replay');
        setReplaySpeed(replay.uiState?.replaySpeed ?? 1);
        setPanelCollapsed(replay.uiState?.panelCollapsed ?? true);
        return;
      }
      if (!replayToken) {
        setReplayPayload(null);
        return;
      }
      const params = new URLSearchParams();
      params.set('replay', replayToken);
      const replay = await readSimulationReplayPayload(params);
      if (cancelled) return;
      if (!replay) {
        return;
      }
      setReplayPayload(replay);
      setScenario(replay.scenario);
      setBackendDirectorState(replay.scenario.director_state ?? null);
      setBackendGameplayState(replay.scenario.gameplay_state ?? null);
      setSelectedReplayBranchId(replay.uiState?.selectedReplayBranchId ?? null);
      setSelectedReplayRound(replay.uiState?.selectedReplayRound ?? null);
      setPlaybackMode(replay.uiState?.playbackMode ?? 'replay');
      setReplaySpeed(replay.uiState?.replaySpeed ?? 1);
      setPanelCollapsed(replay.uiState?.panelCollapsed ?? true);
    };

    void hydrateReplay();
    return () => {
      cancelled = true;
    };
  }, [replayShareId, replayToken, setScenario]);

  useEffect(() => {
    setReplayUrl(isReplayMode ? window.location.href : null);
  }, [isReplayMode]);

  useEffect(() => {
    if (viewMode !== 'theater' || !visualizationEnabled) return;

    const preload = () => {
      void loadPhaserGameLoaderModule().then((mod) => {
        mod.preloadPhaserGame();
      });
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

  const refreshLocalMeta = useCallback(() => {
    setLocalMetaRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (isReplayMode) return;
    setBackendDirectorState(scenario?.director_state ?? null);
  }, [isReplayMode, scenario?.director_state]);

  useEffect(() => {
    if (isReplayMode) return;
    setBackendGameplayState(scenario?.gameplay_state ?? null);
  }, [isReplayMode, scenario?.gameplay_state]);

  const persistDirectorState = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const nextState = scenarioMetaToDirectorState(nextMeta);
    setBackendDirectorState(nextState);
    try {
      await upsertScenarioDirectorState(id, nextState);
    } catch (err) {
      console.warn('[DirectorState] Failed to persist backend state', err);
    }
  }, [id, isReplayMode]);

  const persistGameplayState = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const nextState = scenarioMetaToGameplayState(nextMeta);
    setBackendGameplayState(nextState);
    try {
      await upsertScenarioGameplayState(id, nextState);
    } catch (err) {
      console.warn('[GameplayState] Failed to persist backend state', err);
    }
  }, [id, isReplayMode]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    if (!hasMeaningfulScenarioDirectorState(scenarioMetaToDirectorState(storedScenarioMeta))) return;
    if (hasMeaningfulScenarioDirectorState(backendDirectorState)) return;
    void persistDirectorState(storedScenarioMeta);
  }, [backendDirectorState, id, isReplayMode, persistDirectorState, storedScenarioMeta]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    const mergedMeta = mergeScenarioMetaWithGameplayState(storedScenarioMeta, backendGameplayState);
    const mergedState = scenarioMetaToGameplayState(mergedMeta);
    if (!hasMeaningfulScenarioGameplayState(mergedState)) return;
    if (areScenarioGameplayStatesEquivalent(mergedState, backendGameplayState)) return;
    void persistGameplayState(mergedMeta);
  }, [backendGameplayState, id, isReplayMode, persistGameplayState, storedScenarioMeta]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !scenario || !gameplayProfile || !scenarioMeta || !signatureArcState) return;
    if (hasMeaningfulScenarioDirectorState(backendDirectorState ?? scenario.director_state ?? null)) return;
    if (scenarioMeta.objectives.goals.length > 0) return;

    const nextMeta = ensureScenarioObjectives(id, {
      question: scenario.question,
      profileId: gameplayProfile.id,
      goals: buildDefaultDirectorObjectives({
        profileId: gameplayProfile.id,
        signatureCardId: signatureArcState.nextCardId ?? signatureArcState.sequence[0] ?? null,
      }),
    });
    refreshLocalMeta();
    void persistDirectorState(nextMeta);
  }, [backendDirectorState, gameplayProfile, id, isReplayMode, persistDirectorState, refreshLocalMeta, scenario, scenarioMeta, signatureArcState]);

  useEffect(() => {
    if (scenarioMeta?.commitment.active && scenarioMeta.commitment.branchId) {
      setCommitmentDraftBranchId(scenarioMeta.commitment.branchId);
      return;
    }
    setCommitmentDraftBranchId(activeBranches[0]?.id ?? '');
  }, [activeBranches, scenarioMeta?.commitment.active, scenarioMeta?.commitment.branchId]);

  const replayRounds = useMemo(
    () => getReplayRounds(messages, branches, selectedReplayBranchId),
    [branches, messages, selectedReplayBranchId],
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
    if (isReplayMode) return;
    if (!id || status === 'idle' || status === 'error' || status === 'parsing') return;
    if (branches.length > 0 && agents.length > 0) return;

    let cancelled = false;
    const hydrateMissingScenarioData = async () => {
      if (cancelled || hydrationInFlight.current) return;

      const state = useSimulationStore.getState();
      if (state.branches.length > 0 && state.agents.length > 0) return;

      hydrationInFlight.current = true;
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
      void hydrateMissingScenarioData();
    }, 1500);

    void hydrateMissingScenarioData();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, isReplayMode, status, branches.length, agents.length, loadScenario]);

  useEffect(() => {
    if (branches.length > 0 && agents.length > 0) {
      recoveryLogEmitted.current = false;
    }
  }, [agents.length, branches.length]);

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
    const canOpenGameplayCards = !isSimulationComplete && activeBranches.length > 0 && agents.length > 0;
    const canPreviewGameplayCardsNow = viewMode === 'theater' && !isSimulationComplete && branches.length > 0;
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
        error: error || null,
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
            key_moment_count: scenarioMeta.archive.keyMoments.length,
          }
          : null,
        controls: {
          can_go_back: true,
          can_toggle_view_mode: canToggleViewMode,
          can_open_gameplay_cards: canOpenGameplayCards,
          can_preview_gameplay_cards: canPreviewGameplayCardsNow,
          can_open_prediction: !isReplayMode && !isSimulationComplete,
          can_view_results: !isReplayMode && isSimulationComplete,
          can_copy_replay_link: Boolean(replayUrl || (scenario && storedScenarioMeta)),
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
    branches,
    captureStatus,
    captureMode,
    completedObjectiveCount,
    currentRound,
    evaluatedObjectives,
    detailBranch,
    error,
    scenarioMeta,
    systemTracks,
    interventionTarget,
    isSimulationComplete,
    agents.length,
    messages.length,
    panelCollapsed,
    gameplayAutomation,
    predictionAutomation,
    playbackMode,
    replayBranchOptions,
    replayRounds,
    replaySpeed,
    selectedReplayBranchId,
    selectedReplayRound,
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

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'canvas') {
        return captureElementDataUrl('.phaser-game-container', 'canvas');
      }
      if (mode === 'modal') {
        if (!hasActiveModal) return null;
        for (const selector of MODAL_CAPTURE_SELECTORS) {
          const shot = await captureElementDataUrl(selector, 'element');
          if (shot) return shot;
        }
        return null;
      }

      return (
        await captureCompositeElementDataUrl('.theater-panel', '.phaser-game-container')
      ) ?? (
        await captureElementDataUrl('.theater-panel', 'element')
      ) ?? captureElementDataUrl('.phaser-game-container', 'canvas');
    };

    win.capture_game_screenshot = capture;
    return () => {
      if (win.capture_game_screenshot === capture) {
        delete win.capture_game_screenshot;
      }
    };
  }, [hasActiveModal]);

  const resolveCaptureOptions = useCallback((mode: CaptureMode = captureMode) => {
    if (mode === 'canvas') {
      return {
        selector: '.phaser-game-container',
        captureTarget: 'canvas' as const,
      };
    }
    if (mode === 'modal') {
      if (!hasActiveModal) return null;
      return {
        selectors: MODAL_CAPTURE_SELECTORS,
        captureTarget: 'element' as const,
      };
    }
    return {
      selector: '.theater-panel',
      captureTarget: 'element' as const,
      captureBlob: async () => {
        const dataUrl = await captureCompositeElementDataUrl('.theater-panel', '.phaser-game-container');
        if (!dataUrl) return null;
        const response = await fetch(dataUrl);
        return await response.blob();
      },
    };
  }, [captureMode, hasActiveModal]);

  const handleScreenshotCapture = useCallback(() => {
    const options = resolveCaptureOptions();
    if (!options) return;
    void captureScreenshot(options);
  }, [captureScreenshot, resolveCaptureOptions]);

  const handleGifCapture = useCallback(() => {
    const gifMode = captureMode === 'canvas' ? 'canvas' : 'panel';
    const options = resolveCaptureOptions(gifMode);
    if (!options) return;
    void captureGIF(options);
  }, [captureGIF, captureMode, resolveCaptureOptions]);

  const handleCopyReplayLink = useCallback(async () => {
    if (replayUrl) {
      await copyText(replayUrl);
      return;
    }
    const replayScenarioMeta = scenarioMeta ?? storedScenarioMeta;
    if (!scenario || !replayScenarioMeta) return;
    const snapshot = buildSimulationSnapshot(
      scenario,
      agents,
      branches,
      messages,
      backendDirectorState,
      backendGameplayState,
    );
    const artifact = await createReplayArtifact('simulation_view_v1', {
      scenario: snapshot,
      scenarioMeta: replayScenarioMeta,
      uiState: {
        selectedReplayBranchId,
        selectedReplayRound,
        playbackMode,
        replaySpeed,
        panelCollapsed,
      },
    }).catch(() => null);
    const url = artifact
      ? `${window.location.origin.replace(/\/$/, '')}/sim/replay?share=${artifact.id}`
      : await buildSimulationReplayUrl(window.location.origin, {
        scenario: snapshot,
        scenarioMeta: replayScenarioMeta,
        uiState: {
          selectedReplayBranchId,
          selectedReplayRound,
          playbackMode,
          replaySpeed,
          panelCollapsed,
        },
      });
    setReplayUrl(url);
    await copyText(url);
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

  useEffect(() => {
    if (!isSimulationComplete) {
      setSelectedReplayBranchId(null);
      setSelectedReplayRound(null);
      return;
    }

    const defaultBranchId = replayBranchOptions[0]?.id ?? null;
    if (!selectedReplayBranchId || !replayBranchOptions.some((branch) => branch.id === selectedReplayBranchId)) {
      setSelectedReplayBranchId(defaultBranchId);
      setSelectedReplayRound(getLatestReplayRound(messages, branches, defaultBranchId));
      return;
    }

    const latestRound = getLatestReplayRound(messages, branches, selectedReplayBranchId);
    if (selectedReplayRound == null || (latestRound != null && selectedReplayRound > latestRound)) {
      setSelectedReplayRound(latestRound);
    }
  }, [branches, isSimulationComplete, messages, replayBranchOptions, selectedReplayBranchId, selectedReplayRound]);

  const theaterSceneLabel = theaterSceneState?.scene
    ? formatTheaterLabel(theaterSceneState.scene, THEATER_SCENE_LABELS, isZh)
    : null;
  const theaterThemeLabel = getTheaterThemeLabel(
    typeof theaterSceneState?.theme === 'string' ? theaterSceneState.theme : scenario?.scene_theme,
    isZh,
  );
  const theaterWeatherLabel = formatTheaterLabel(
    typeof theaterSceneState?.weather === 'string' ? theaterSceneState.weather : null,
    THEATER_WEATHER_LABELS,
    isZh,
  );
  const theaterTimeLabel = formatTheaterLabel(
    typeof theaterSceneState?.time_of_day === 'string' ? theaterSceneState.time_of_day : null,
    THEATER_TIME_LABELS,
    isZh,
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
  const handleGameplayApplied = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    refreshLocalMeta();
    await persistGameplayState(nextMeta);
  }, [persistGameplayState, refreshLocalMeta]);
  const handlePlacedBet = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    refreshLocalMeta();
    await persistGameplayState(nextMeta);
  }, [persistGameplayState, refreshLocalMeta]);
  const handleCommitBranch = useCallback(() => {
    if (isReplayMode) return;
    if (!id || !commitmentDraftBranchId) return;
    const branch = activeBranches.find((candidate) => candidate.id === commitmentDraftBranchId);
    if (!branch) return;
    const nextMeta = setBranchCommitment(id, {
      branchId: branch.id,
      branchTitle: branch.title,
      currentRound: Math.max(1, currentRound),
    });
    refreshLocalMeta();
    void persistDirectorState(nextMeta);
  }, [activeBranches, commitmentDraftBranchId, currentRound, id, isReplayMode, persistDirectorState, refreshLocalMeta]);
  const handleClearCommitment = useCallback(() => {
    if (isReplayMode) return;
    if (!id) return;
    const nextMeta = clearBranchCommitment(id);
    refreshLocalMeta();
    void persistDirectorState(nextMeta);
  }, [id, isReplayMode, persistDirectorState, refreshLocalMeta]);
  const isModalCaptureAvailable = captureMode !== 'modal' || hasActiveModal;
  const captureDoneLabel = lastCaptureKind === 'gif'
    ? t('game.gif_saved')
    : lastCaptureKind === 'gif_fallback_png'
      ? t('game.gif_fallback_saved')
      : t('game.screenshot_saved');
  const captureModeDescription = captureMode === 'panel'
    ? t('game.capture_mode_panel_desc')
    : captureMode === 'canvas'
      ? t('game.capture_mode_canvas_desc')
      : hasActiveModal
        ? t('game.capture_mode_modal_desc')
        : t('game.capture_mode_modal_unavailable');
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
        error: error || null,
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
            key_moment_count: scenarioMeta.archive.keyMoments.length,
          }
          : null,
        controls: {
          can_go_back: true,
          can_toggle_view_mode: canToggleViewMode,
          can_open_gameplay_cards: canUseGameplayCards,
          can_preview_gameplay_cards: canPreviewGameplayCards,
          can_open_prediction: !isReplayMode && !isSimulationComplete,
          can_view_results: !isReplayMode && isSimulationComplete,
          can_copy_replay_link: Boolean(replayUrl || (scenario && storedScenarioMeta)),
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
    branches,
    captureStatus,
    captureMode,
    completedObjectiveCount,
    currentRound,
    detailBranch,
    error,
    evaluatedObjectives,
    hasActiveModal,
    interventionTarget,
    isSimulationComplete,
    agents.length,
    messages.length,
    panelCollapsed,
    canPreviewGameplayCards,
    canUseGameplayCards,
    gameplayAutomation,
    predictionAutomation,
    replayAutomationState,
    scenarioMeta,
    scenario,
    replayUrl,
    isReplayMode,
    showGameplayCards,
    showPrediction,
    status,
    systemTracks,
    canToggleViewMode,
    viewMode,
    visualizationEnabled,
  ]);

  useEffect(() => {
    if (viewMode !== 'theater') {
      lastTheaterSceneSignature.current = null;
      setTheaterSceneState(null);
      return;
    }

    const readSceneState = () => {
      const next = (window as AutomationWindow).__swarmGetSceneAutomation?.() ?? null;
      const signature = JSON.stringify(next);
      if (signature === lastTheaterSceneSignature.current) return;
      lastTheaterSceneSignature.current = signature;
      setTheaterSceneState(next);
    };

    readSceneState();
    const timer = window.setInterval(readSceneState, 250);
    return () => window.clearInterval(timer);
  }, [id, viewMode]);

  const cycleReplaySpeed = () => {
    setReplaySpeed((current) => {
      if (current === 1) return 2;
      if (current === 2) return 4;
      return 1;
    });
  };

  const restartTheaterPlayback = (mode: 'replay' | 'skip') => {
    setPlaybackMode(mode);
    setTheaterMountKey((value) => value + 1);
  };

  const handleReplayBranchChange = (branchId: string) => {
    setSelectedReplayBranchId(branchId);
    setSelectedReplayRound(getLatestReplayRound(messages, branches, branchId));
    setPlaybackMode('replay');
    setTheaterMountKey((value) => value + 1);
  };

  const handleReplayRoundChange = (round: number) => {
    setSelectedReplayRound(round);
    setPlaybackMode('replay');
    setTheaterMountKey((value) => value + 1);
  };

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
          {(replayUrl || (scenario && storedScenarioMeta)) && (
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
              {importingReplay
                ? (isZh ? '导入中...' : 'Importing...')
                : (isZh ? '导入为本地运行' : 'Import as Local Run')}
            </button>
          )}
          {/* V2: Theater mode toggle — only enabled when the scenario has visualization data */}
          <button
            className={`view-mode-toggle ${viewMode === 'theater' ? 'view-mode-toggle--active' : ''}`}
            onClick={toggleViewMode}
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
          <p>🔒 {isZh ? '只读回放模式：已关闭实时写操作。' : 'Read-only replay mode: live write actions are disabled.'}</p>
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
                    <strong>{isZh ? '导演目标' : 'Director Goals'}</strong>
                    <span className="theater-chip">
                      {systemTracks.riskLabel} {systemTracks.riskValue}/6 · {systemTracks.resourceLabel} {systemTracks.resourceValue}/6
                    </span>
                    <span className="theater-chip">
                      {isZh ? '完成' : 'Done'} {completedObjectiveCount}/{evaluatedObjectives.length}
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
                        <span>{isZh ? '承诺世界线' : 'Committed worldline'}</span>
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
                      <button className="btn btn-ghost btn--capture" onClick={handleCommitBranch}>
                        {isZh ? '锁定承诺' : 'Commit'}
                      </button>
                      {scenarioMeta.commitment.active && (
                        <button className="btn btn-ghost btn--capture" onClick={handleClearCommitment}>
                          {isZh ? '取消承诺' : 'Clear'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
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
