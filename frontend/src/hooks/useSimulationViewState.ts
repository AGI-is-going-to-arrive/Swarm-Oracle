import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getScenarioDirectorState,
  getScenarioGameplayState,
  isApiError,
  upsertScenarioDirectorState,
  upsertScenarioGameplayState,
} from '../api/client';
import {
  captureCompositeElementBlob,
  captureCompositeElementDataUrl,
  captureElementDataUrl,
  isLikelyWebKitCaptureUserAgent,
  type CaptureMode,
  useScreenCapture,
} from '../hooks/useScreenCapture';
import {
  clearBranchCommitment,
  loadScenarioMeta,
  setBranchCommitment,
  subscribeScenarioMeta,
  type ScenarioMeta,
} from '../lib/scenarioMeta';
import {
  hasScenarioDirectorAuthority,
  hasMeaningfulScenarioDirectorState,
  scenarioMetaToDirectorState,
} from '../lib/scenarioDirectorState';
import {
  areScenarioGameplayStatesEquivalent,
  hasScenarioGameplayAuthority,
  hasMeaningfulScenarioGameplayState,
  mergeScenarioMetaWithGameplayState,
  scenarioMetaToGameplayState,
} from '../lib/scenarioGameplayState';
import { mergeScenarioMetaAuthority } from '../lib/scenarioAuthority';
import type {
  AutomationSceneState,
  AutomationWindow,
} from '../game/automation';
import type {
  BranchInfo,
  Scenario,
  ScenarioDirectorState,
  ScenarioGameplayArchiveBranchSnapshot,
  ScenarioGameplayBet,
  ScenarioGameplayCardUsage,
  ScenarioGameplayState,
} from '../types';

const MODAL_CAPTURE_SELECTORS = [
  '.gameplay-modal',
  '.share-modal',
  '.modal-content',
  '.share-overlay',
  '.modal-overlay',
];

function getStateRevision(state: { revision?: number } | null | undefined): number {
  return Number.isFinite(state?.revision) ? Number(state?.revision) : 0;
}

function areScenarioDirectorStatesEquivalent(
  left: ScenarioDirectorState | null | undefined,
  right: ScenarioDirectorState | null | undefined,
): boolean {
  if (!left || !right) return false;
  return JSON.stringify({
    objectives: left.objectives,
    commitment: left.commitment,
  }) === JSON.stringify({
    objectives: right.objectives,
    commitment: right.commitment,
  });
}

function areJsonValuesEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasDirectorObjectivesContent(state: ScenarioDirectorState | null | undefined): boolean {
  return Boolean(
    state?.objectives.goals.length
    || state?.objectives.generated_for_question
    || state?.objectives.generated_for_profile
    || state?.objectives.last_updated_at,
  );
}

function hasDirectorCommitmentContent(state: ScenarioDirectorState | null | undefined): boolean {
  return Boolean(state?.commitment.active || state?.commitment.outcome);
}

function mergeDirectorStateForConflict(
  baseState: ScenarioDirectorState | null | undefined,
  desiredState: ScenarioDirectorState,
  latestState: ScenarioDirectorState,
): ScenarioDirectorState {
  const shouldUseDesiredObjectives = baseState
    ? !areJsonValuesEquivalent(baseState.objectives, desiredState.objectives)
    : !hasDirectorObjectivesContent(latestState) && hasDirectorObjectivesContent(desiredState);
  const shouldUseDesiredCommitment = baseState
    ? !areJsonValuesEquivalent(baseState.commitment, desiredState.commitment)
    : hasDirectorCommitmentContent(desiredState) || !hasDirectorCommitmentContent(latestState);

  return {
    ...latestState,
    objectives: shouldUseDesiredObjectives ? desiredState.objectives : latestState.objectives,
    commitment: shouldUseDesiredCommitment ? desiredState.commitment : latestState.commitment,
    revision: latestState.revision,
  };
}

function cardUsageKey(usage: ScenarioGameplayCardUsage): string {
  return [
    usage.card_id,
    usage.profile_id,
    usage.branch_id,
    usage.round,
    usage.used_at,
  ].join('\u0000');
}

function branchSnapshotKey(snapshot: ScenarioGameplayArchiveBranchSnapshot): string {
  return snapshot.branch_id;
}

function mergeByKey<T>(
  latestItems: T[],
  desiredItems: T[],
  getKey: (item: T) => string,
): T[] {
  const merged = new Map<string, T>();
  latestItems.forEach((item) => {
    merged.set(getKey(item), item);
  });
  desiredItems.forEach((item) => {
    merged.set(getKey(item), item);
  });
  return Array.from(merged.values());
}

function mergeStringUnion(latestItems: string[], desiredItems: string[]): string[] {
  return Array.from(new Set([...latestItems, ...desiredItems]));
}

function mergeGameplayStateForConflict(
  desiredState: ScenarioGameplayState,
  latestState: ScenarioGameplayState,
): ScenarioGameplayState {
  return {
    ...latestState,
    cards: {
      usage_log: mergeByKey(
        latestState.cards.usage_log,
        desiredState.cards.usage_log,
        cardUsageKey,
      ),
    },
    betting: {
      bets: mergeByKey<ScenarioGameplayBet>(
        latestState.betting.bets,
        desiredState.betting.bets,
        (bet) => bet.bet_id,
      ),
    },
    archive: {
      key_moments: mergeStringUnion(
        latestState.archive.key_moments,
        desiredState.archive.key_moments,
      ),
      branch_snapshots: mergeByKey(
        latestState.archive.branch_snapshots,
        desiredState.archive.branch_snapshots,
        branchSnapshotKey,
      ),
    },
    revision: latestState.revision,
  };
}

export function useSimulationCaptureControls({
  id,
  viewMode,
  hasActiveModal,
  t,
}: {
  id: string | undefined;
  viewMode: 'classic' | 'theater';
  hasActiveModal: boolean;
  t: (key: string) => string;
}) {
  const [captureMode, setCaptureMode] = useState<CaptureMode>('panel');
  const [theaterSceneState, setTheaterSceneState] = useState<AutomationSceneState | null>(null);
  const lastTheaterSceneSignature = useRef<string | null>(null);
  const prefersStableScreenCapture = useMemo(
    () => isLikelyWebKitCaptureUserAgent(typeof navigator === 'undefined' ? undefined : navigator.userAgent),
    [],
  );
  const { status: captureStatus, lastCaptureKind, captureScreenshot, captureGIF } = useScreenCapture({
    selector: '.phaser-game-container',
  });

  useEffect(() => {
    if (viewMode !== 'theater') {
      lastTheaterSceneSignature.current = null;
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

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'canvas') {
        return captureElementDataUrl(
          '.phaser-game-container',
          prefersStableScreenCapture ? 'element' : 'canvas',
        );
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
        prefersStableScreenCapture
          ? await captureElementDataUrl('.theater-panel', 'element')
          : await captureCompositeElementDataUrl('.theater-panel', '.phaser-game-container')
      ) ?? (
        prefersStableScreenCapture
          ? await captureCompositeElementDataUrl('.theater-panel', '.phaser-game-container')
          : await captureElementDataUrl('.theater-panel', 'element')
      ) ?? captureElementDataUrl(
        '.phaser-game-container',
        prefersStableScreenCapture ? 'element' : 'canvas',
      );
    };

    win.capture_game_screenshot = capture;
    return () => {
      if (win.capture_game_screenshot === capture) {
        delete win.capture_game_screenshot;
      }
    };
  }, [hasActiveModal, prefersStableScreenCapture]);

  const resolveCaptureOptions = useCallback((mode: CaptureMode = captureMode) => {
    if (mode === 'canvas') {
      return {
        selector: '.phaser-game-container',
        captureTarget: prefersStableScreenCapture ? 'element' as const : 'canvas' as const,
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
      captureBlob: () => (
        prefersStableScreenCapture
          ? captureElementDataUrl('.theater-panel', 'element').then(async (dataUrl) => {
              if (!dataUrl) return null;
              const response = await fetch(dataUrl);
              return await response.blob();
            })
          : captureCompositeElementBlob('.theater-panel', '.phaser-game-container')
      ),
    };
  }, [captureMode, hasActiveModal, prefersStableScreenCapture]);

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

  const isModalCaptureAvailable = captureMode !== 'modal' || hasActiveModal;
  const visibleTheaterSceneState = viewMode === 'theater' ? theaterSceneState : null;
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

  return {
    captureMode,
    setCaptureMode,
    captureStatus,
    lastCaptureKind,
    theaterSceneState: visibleTheaterSceneState,
    isModalCaptureAvailable,
    captureDoneLabel,
    captureModeDescription,
    handleScreenshotCapture,
    handleGifCapture,
  };
}

export function useSimulationDirectorState({
  id,
  isReplayMode,
  replayScenarioMeta,
  scenario,
  activeBranches,
  currentRound,
}: {
  id: string | undefined;
  isReplayMode: boolean;
  replayScenarioMeta: ScenarioMeta | null;
  scenario: Scenario | null;
  activeBranches: BranchInfo[];
  currentRound: number;
}) {
  const [localMetaRevision, setLocalMetaRevision] = useState(0);
  const [commitmentDraftBranchIdOverride, setCommitmentDraftBranchIdOverride] = useState<string | null>(null);
  const [backendDirectorOverrideState, setBackendDirectorOverrideState] = useState<ScenarioDirectorState | null>(
    () => scenario?.director_state ?? null,
  );
  const [backendGameplayOverrideState, setBackendGameplayOverrideState] = useState<ScenarioGameplayState | null>(
    () => scenario?.gameplay_state ?? null,
  );
  const [authorityConflictKind, setAuthorityConflictKind] = useState<'director' | 'gameplay' | null>(null);
  const directorRevisionRef = useRef(getStateRevision(scenario?.director_state));
  const gameplayRevisionRef = useRef(getStateRevision(scenario?.gameplay_state));
  const directorStateRef = useRef<ScenarioDirectorState | null>(scenario?.director_state ?? null);
  const directorPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const gameplayPersistChainRef = useRef<Promise<void>>(Promise.resolve());

  const backendDirectorState = isReplayMode
    ? backendDirectorOverrideState
    : (backendDirectorOverrideState ?? scenario?.director_state ?? null);
  const backendGameplayState = isReplayMode
    ? backendGameplayOverrideState
    : (backendGameplayOverrideState ?? scenario?.gameplay_state ?? null);

  useEffect(() => {
    directorRevisionRef.current = getStateRevision(backendDirectorState);
    directorStateRef.current = backendDirectorState;
  }, [backendDirectorState]);

  useEffect(() => {
    gameplayRevisionRef.current = getStateRevision(backendGameplayState);
  }, [backendGameplayState]);

  const storedScenarioMeta = useMemo(() => {
    void localMetaRevision;
    return replayScenarioMeta ?? (id ? loadScenarioMeta(id) : null);
  }, [id, localMetaRevision, replayScenarioMeta]);

  const scenarioMeta = useMemo(
    () => {
      if (!storedScenarioMeta) return null;
      return mergeScenarioMetaAuthority(
        storedScenarioMeta,
        backendGameplayState,
        backendDirectorState,
      );
    },
    [backendDirectorState, backendGameplayState, storedScenarioMeta],
  );

  const refreshLocalMeta = useCallback(() => {
    setLocalMetaRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!id || isReplayMode) return;
    return subscribeScenarioMeta(id, refreshLocalMeta);
  }, [id, isReplayMode, refreshLocalMeta]);

  const persistDirectorMeta = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const desiredState = scenarioMetaToDirectorState(nextMeta);
    const persistTask = async () => {
      const baseState = directorStateRef.current;
      const nextState = {
        ...desiredState,
        revision: directorRevisionRef.current,
      };
      try {
        const persisted = await upsertScenarioDirectorState(id, nextState);
        directorRevisionRef.current = getStateRevision(persisted);
        directorStateRef.current = persisted;
        setBackendDirectorOverrideState(persisted);
        return;
      } catch (err) {
        if (!(isApiError(err) && err.status === 409)) {
          console.warn('[DirectorState] Failed to persist backend state', err);
          return;
        }

        const latest = await getScenarioDirectorState(id).catch(() => null);
        if (latest) {
          directorRevisionRef.current = getStateRevision(latest);
          directorStateRef.current = latest;
          if (areScenarioDirectorStatesEquivalent(desiredState, latest)) {
            setBackendDirectorOverrideState(latest);
            return;
          }
          const retryState = mergeDirectorStateForConflict(baseState, desiredState, latest);
          try {
            const persisted = await upsertScenarioDirectorState(id, retryState);
            directorRevisionRef.current = getStateRevision(persisted);
            directorStateRef.current = persisted;
            setBackendDirectorOverrideState(persisted);
            return;
          } catch (retryErr) {
            const fallbackLatest = await getScenarioDirectorState(id).catch(() => null);
            if (fallbackLatest) {
              directorRevisionRef.current = getStateRevision(fallbackLatest);
              directorStateRef.current = fallbackLatest;
              setBackendDirectorOverrideState(fallbackLatest);
            }
            setAuthorityConflictKind('director');
            console.warn('[DirectorState] Failed to persist backend state', retryErr);
            return;
          }
        }

        setAuthorityConflictKind('director');
        console.warn('[DirectorState] Failed to persist backend state', err);
      }
    };
    const queued = directorPersistChainRef.current.then(persistTask, persistTask);
    directorPersistChainRef.current = queued.catch(() => undefined).then(() => undefined);
    await queued;
  }, [id, isReplayMode]);

  const persistGameplayState = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const desiredState = scenarioMetaToGameplayState(nextMeta);
    const persistTask = async () => {
      const nextState = {
        ...desiredState,
        revision: gameplayRevisionRef.current,
      };
      try {
        const persisted = await upsertScenarioGameplayState(id, nextState);
        gameplayRevisionRef.current = getStateRevision(persisted);
        setBackendGameplayOverrideState(persisted);
        return;
      } catch (err) {
        if (!(isApiError(err) && err.status === 409)) {
          console.warn('[GameplayState] Failed to persist backend state', err);
          return;
        }

        const latest = await getScenarioGameplayState(id).catch(() => null);
        if (latest) {
          gameplayRevisionRef.current = getStateRevision(latest);
          if (areScenarioGameplayStatesEquivalent(desiredState, latest)) {
            setBackendGameplayOverrideState(latest);
            return;
          }
          const retryState = mergeGameplayStateForConflict(desiredState, latest);
          try {
            const persisted = await upsertScenarioGameplayState(id, retryState);
            gameplayRevisionRef.current = getStateRevision(persisted);
            setBackendGameplayOverrideState(persisted);
            return;
          } catch (retryErr) {
            const fallbackLatest = await getScenarioGameplayState(id).catch(() => null);
            if (fallbackLatest) {
              gameplayRevisionRef.current = getStateRevision(fallbackLatest);
              setBackendGameplayOverrideState(fallbackLatest);
            }
            setAuthorityConflictKind('gameplay');
            console.warn('[GameplayState] Failed to persist backend state', retryErr);
            return;
          }
        }

        setAuthorityConflictKind('gameplay');
        console.warn('[GameplayState] Failed to persist backend state', err);
      }
    };
    const queued = gameplayPersistChainRef.current.then(persistTask, persistTask);
    gameplayPersistChainRef.current = queued.catch(() => undefined).then(() => undefined);
    await queued;
  }, [id, isReplayMode]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    if (!hasMeaningfulScenarioDirectorState(scenarioMetaToDirectorState(storedScenarioMeta))) return;
    if (hasScenarioDirectorAuthority(backendDirectorState)) return;
    const timeoutId = window.setTimeout(() => {
      void persistDirectorMeta(storedScenarioMeta);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [backendDirectorState, id, isReplayMode, persistDirectorMeta, storedScenarioMeta]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    if (hasScenarioGameplayAuthority(backendGameplayState)) return;
    const mergedMeta = mergeScenarioMetaWithGameplayState(storedScenarioMeta, backendGameplayState);
    const mergedState = scenarioMetaToGameplayState(mergedMeta);
    if (!hasMeaningfulScenarioGameplayState(mergedState)) return;
    if (areScenarioGameplayStatesEquivalent(mergedState, backendGameplayState)) return;
    const timeoutId = window.setTimeout(() => {
      void persistGameplayState(mergedMeta);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [backendGameplayState, id, isReplayMode, persistGameplayState, storedScenarioMeta]);

  const commitmentDraftBranchId = useMemo(() => {
    if (scenarioMeta?.commitment.active && scenarioMeta.commitment.branchId) {
      return scenarioMeta.commitment.branchId;
    }
    if (
      commitmentDraftBranchIdOverride
      && activeBranches.some((candidate) => candidate.id === commitmentDraftBranchIdOverride)
    ) {
      return commitmentDraftBranchIdOverride;
    }
    return activeBranches[0]?.id ?? '';
  }, [activeBranches, commitmentDraftBranchIdOverride, scenarioMeta]);

  const handleGameplayApplied = useCallback(async (
    nextMeta: NonNullable<typeof scenarioMeta>,
    persistedState?: ScenarioGameplayState | null,
  ) => {
    refreshLocalMeta();
    if (persistedState) {
      setBackendGameplayOverrideState(persistedState);
      return;
    }
    await persistGameplayState(nextMeta);
  }, [persistGameplayState, refreshLocalMeta]);

  const handlePlacedBet = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    refreshLocalMeta();
    await persistGameplayState(nextMeta);
  }, [persistGameplayState, refreshLocalMeta]);

  const handleCommitBranch = useCallback(() => {
    if (isReplayMode || !id || !commitmentDraftBranchId) return;
    const branch = activeBranches.find((candidate) => candidate.id === commitmentDraftBranchId);
    if (!branch) return;
    const nextMeta = setBranchCommitment(id, {
      branchId: branch.id,
      branchTitle: branch.title,
      currentRound: Math.max(1, currentRound),
    });
    refreshLocalMeta();
    void persistDirectorMeta(nextMeta);
  }, [activeBranches, commitmentDraftBranchId, currentRound, id, isReplayMode, persistDirectorMeta, refreshLocalMeta]);

  const handleClearCommitment = useCallback(() => {
    if (isReplayMode || !id) return;
    const nextMeta = clearBranchCommitment(id);
    refreshLocalMeta();
    void persistDirectorMeta(nextMeta);
  }, [id, isReplayMode, persistDirectorMeta, refreshLocalMeta]);

  return {
    localMetaRevision,
    backendDirectorState,
    setBackendDirectorState: setBackendDirectorOverrideState,
    backendGameplayState,
    setBackendGameplayState: setBackendGameplayOverrideState,
    authorityConflictKind,
    clearAuthorityConflictKind: () => setAuthorityConflictKind(null),
    storedScenarioMeta,
    scenarioMeta,
    refreshLocalMeta,
    persistDirectorMeta,
    commitmentDraftBranchId,
    setCommitmentDraftBranchId: setCommitmentDraftBranchIdOverride,
    handleGameplayApplied,
    handlePlacedBet,
    handleCommitBranch,
    handleClearCommitment,
  };
}
