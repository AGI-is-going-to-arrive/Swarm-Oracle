import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { getReplayArtifact, importReplayScenario } from '../api/client';
import type { SimulationReplayPayload } from '../lib/simulationReplay';
import type { AgentMessage, BranchInfo } from '../types';
import {
  buildReplayBranchOptions,
  getLatestReplayRound,
  getReplayRounds,
} from '../game/replaySelection';

const loadSimulationReplayHelpers = () => import('../lib/simulationReplay');

export function useSimulationReplayState(params: {
  replayToken: string | null;
  replayShareId: string | null;
  viewMode: 'classic' | 'theater';
  branches: BranchInfo[];
  messages: AgentMessage[];
  isSimulationComplete: boolean;
  navigate: NavigateFunction;
}) {
  const {
    replayToken,
    replayShareId,
    viewMode,
    branches,
    messages,
    isSimulationComplete,
    navigate,
  } = params;
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [playbackMode, setPlaybackMode] = useState<'replay' | 'skip'>('replay');
  const [theaterMountKey, setTheaterMountKey] = useState(0);
  const [selectedReplayBranchId, setSelectedReplayBranchId] = useState<string | null>(null);
  const [selectedReplayRound, setSelectedReplayRound] = useState<number | null>(null);
  const [replayPayload, setReplayPayload] = useState<SimulationReplayPayload | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(viewMode === 'theater');

  useEffect(() => {
    setPanelCollapsed(viewMode === 'theater');
  }, [viewMode]);

  useEffect(() => {
    let cancelled = false;

    const hydrateReplay = async () => {
      if (replayShareId) {
        const artifact = await getReplayArtifact(replayShareId).catch(() => null);
        if (cancelled || !artifact || artifact.kind !== 'simulation_view_v1' || !artifact.payload) return;
        const { coerceSimulationReplayPayload } = await loadSimulationReplayHelpers();
        const replay = coerceSimulationReplayPayload(artifact.payload);
        if (!replay) {
          console.warn('[SimulationView] Ignoring invalid replay artifact payload');
          return;
        }
        setReplayPayload(replay);
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
      const { readSimulationReplayPayload } = await loadSimulationReplayHelpers();
      const replay = await readSimulationReplayPayload(params);
      if (cancelled || !replay) return;
      setReplayPayload(replay);
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
  }, [replayShareId, replayToken]);

  const isReplayMode = Boolean(replayPayload);
  const replayBranchOptions = useMemo(
    () => buildReplayBranchOptions(branches, messages),
    [branches, messages],
  );
  const replayRounds = useMemo(
    () => getReplayRounds(messages, branches, selectedReplayBranchId),
    [branches, messages, selectedReplayBranchId],
  );

  useEffect(() => {
    if (!isSimulationComplete) {
      setSelectedReplayBranchId(null);
      setSelectedReplayRound(null);
      return;
    }

    const defaultBranchId = replayBranchOptions[0]?.id ?? null;
    if (
      !selectedReplayBranchId
      || !replayBranchOptions.some((branch) => branch.id === selectedReplayBranchId)
    ) {
      setSelectedReplayBranchId(defaultBranchId);
      setSelectedReplayRound(getLatestReplayRound(messages, branches, defaultBranchId));
      return;
    }

    const latestRound = getLatestReplayRound(messages, branches, selectedReplayBranchId);
    if (selectedReplayRound == null || (latestRound != null && selectedReplayRound > latestRound)) {
      setSelectedReplayRound(latestRound);
    }
  }, [
    branches,
    isSimulationComplete,
    messages,
    replayBranchOptions,
    selectedReplayBranchId,
    selectedReplayRound,
  ]);

  const cycleReplaySpeed = useCallback(() => {
    setReplaySpeed((current) => {
      if (current === 1) return 2;
      if (current === 2) return 4;
      return 1;
    });
  }, []);

  const restartTheaterPlayback = useCallback((mode: 'replay' | 'skip') => {
    setPlaybackMode(mode);
    setTheaterMountKey((value) => value + 1);
  }, []);

  const handleReplayBranchChange = useCallback((branchId: string) => {
    setSelectedReplayBranchId(branchId);
    setSelectedReplayRound(getLatestReplayRound(messages, branches, branchId));
    setPlaybackMode('replay');
    setTheaterMountKey((value) => value + 1);
  }, [branches, messages]);

  const handleReplayRoundChange = useCallback((round: number) => {
    setSelectedReplayRound(round);
    setPlaybackMode('replay');
    setTheaterMountKey((value) => value + 1);
  }, []);

  const handleImportReplay = useCallback(async () => {
    if (!replayPayload || importingReplay) return;
    setImportingReplay(true);
    setImportError(null);
    try {
      const imported = await importReplayScenario(replayPayload.scenario);
      navigate(`/sim/${imported.id}`);
    } catch (err) {
      console.error("Failed to import replay:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingReplay(false);
    }
  }, [importingReplay, navigate, replayPayload]);

  return {
    cycleReplaySpeed,
    handleImportReplay,
    handleReplayBranchChange,
    handleReplayRoundChange,
    importError,
    importingReplay,
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
  };
}
