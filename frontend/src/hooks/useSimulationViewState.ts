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
  ScenarioGameplayState,
} from '../types';

const MODAL_CAPTURE_SELECTORS = [
  '.gameplay-modal',
  '.share-modal',
  '.modal-content',
  '.share-overlay',
  '.modal-overlay',
];

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
    theaterSceneState,
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
  const [commitmentDraftBranchId, setCommitmentDraftBranchId] = useState('');
  const [backendDirectorState, setBackendDirectorState] = useState<ScenarioDirectorState | null>(
    () => scenario?.director_state ?? null,
  );
  const [backendGameplayState, setBackendGameplayState] = useState<ScenarioGameplayState | null>(
    () => scenario?.gameplay_state ?? null,
  );
  const [authorityConflictKind, setAuthorityConflictKind] = useState<'director' | 'gameplay' | null>(null);

  const storedScenarioMeta = useMemo(
    () => (replayScenarioMeta ?? (id ? loadScenarioMeta(id) : null)),
    [id, localMetaRevision, replayScenarioMeta],
  );

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

  useEffect(() => {
    if (isReplayMode) return;
    setBackendDirectorState(scenario?.director_state ?? null);
  }, [isReplayMode, scenario?.director_state]);

  useEffect(() => {
    if (isReplayMode) return;
    setBackendGameplayState(scenario?.gameplay_state ?? null);
  }, [isReplayMode, scenario?.gameplay_state]);

  const persistDirectorMeta = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const nextState = {
      ...scenarioMetaToDirectorState(nextMeta),
      revision: backendDirectorState?.revision ?? scenario?.director_state?.revision ?? 0,
    };
    setBackendDirectorState(nextState);
    try {
      const persisted = await upsertScenarioDirectorState(id, nextState);
      setBackendDirectorState(persisted);
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        const latest = await getScenarioDirectorState(id).catch(() => null);
        if (latest) {
          setBackendDirectorState(latest);
        }
        setAuthorityConflictKind('director');
      }
      console.warn('[DirectorState] Failed to persist backend state', err);
    }
  }, [backendDirectorState?.revision, id, isReplayMode, scenario?.director_state?.revision, scenarioMeta]);

  const persistGameplayState = useCallback(async (nextMeta: NonNullable<typeof scenarioMeta>) => {
    if (!id || isReplayMode) return;
    const nextState = {
      ...scenarioMetaToGameplayState(nextMeta),
      revision: backendGameplayState?.revision ?? scenario?.gameplay_state?.revision ?? 0,
    };
    setBackendGameplayState(nextState);
    try {
      const persisted = await upsertScenarioGameplayState(id, nextState);
      setBackendGameplayState(persisted);
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        const latest = await getScenarioGameplayState(id).catch(() => null);
        if (latest) {
          setBackendGameplayState(latest);
        }
        setAuthorityConflictKind('gameplay');
      }
      console.warn('[GameplayState] Failed to persist backend state', err);
    }
  }, [backendGameplayState?.revision, id, isReplayMode, scenario?.gameplay_state?.revision, scenarioMeta]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    if (!hasMeaningfulScenarioDirectorState(scenarioMetaToDirectorState(storedScenarioMeta))) return;
    if (hasScenarioDirectorAuthority(backendDirectorState)) return;
    void persistDirectorMeta(storedScenarioMeta);
  }, [backendDirectorState, id, isReplayMode, persistDirectorMeta, storedScenarioMeta]);

  useEffect(() => {
    if (isReplayMode) return;
    if (!id || !storedScenarioMeta) return;
    if (hasScenarioGameplayAuthority(backendGameplayState)) return;
    const mergedMeta = mergeScenarioMetaWithGameplayState(storedScenarioMeta, backendGameplayState);
    const mergedState = scenarioMetaToGameplayState(mergedMeta);
    if (!hasMeaningfulScenarioGameplayState(mergedState)) return;
    if (areScenarioGameplayStatesEquivalent(mergedState, backendGameplayState)) return;
    void persistGameplayState(mergedMeta);
  }, [backendGameplayState, id, isReplayMode, persistGameplayState, storedScenarioMeta]);

  useEffect(() => {
    if (scenarioMeta?.commitment.active && scenarioMeta.commitment.branchId) {
      setCommitmentDraftBranchId(scenarioMeta.commitment.branchId);
      return;
    }
    setCommitmentDraftBranchId(activeBranches[0]?.id ?? '');
  }, [activeBranches, scenarioMeta?.commitment.active, scenarioMeta?.commitment.branchId]);

  const handleGameplayApplied = useCallback(async (
    nextMeta: NonNullable<typeof scenarioMeta>,
    persistedState?: ScenarioGameplayState | null,
  ) => {
    refreshLocalMeta();
    if (persistedState) {
      setBackendGameplayState(persistedState);
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
    setBackendDirectorState,
    backendGameplayState,
    setBackendGameplayState,
    authorityConflictKind,
    clearAuthorityConflictKind: () => setAuthorityConflictKind(null),
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
  };
}
