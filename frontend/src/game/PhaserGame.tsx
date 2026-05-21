/**
 * PhaserGame — React ↔ Phaser bridge component.
 *
 * Wraps a Phaser.Game instance inside a React component lifecycle.
 * Starts EventBridge on mount, stops on unmount.
 *
 * V2.1: Integrates VizSynthesizer to bridge REST API data → viz events
 *       for completed simulations (no live WS replay available).
 */
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { TitleScene } from './scenes/TitleScene';
import { WorldScene } from './scenes/WorldScene';
import { EndingScene } from './scenes/EndingScene';
import { EventBridge, dispatchVizEvent } from './managers/EventBridge';
import {
  clipBubbleEventText,
  synthesizeSceneInit,
  synthesizeBubbles,
  synthesizeLatestBubbles,
  inferSceneTheme,
  getInitialSpriteKeysForAgents,
} from './managers/VizSynthesizer';
import { filterReplayMessages } from './replaySelection';
import {
  type AutomationWindow,
  type AutomationReplayState,
  type AutomationSceneState,
} from './automation';
import { ensureReplayStartsInWorldScene } from './replaySync';
import { shouldBootstrapWorldScene } from './worldSceneBootstrap';
import { useSimulationStore } from '../stores/simulationStore';
import { emotionToHaloColor } from './constants/emotionColors';
import './game.css';

interface PhaserGameProps {
  width?: number;
  height?: number;
  className?: string;
  useDomBubbles?: boolean;
  replaySpeed?: number;
  playbackMode?: 'replay' | 'skip';
  playbackBranchId?: string | null;
  playbackRound?: number | null;
}

type AutomationScene = Phaser.Scene & {
  getAutomationState?: () => AutomationSceneState;
};

const REPLAY_BATCH_SIZE = 1;
const REPLAY_BUBBLE_INTERVAL_BASE_MS = 880;
const REPLAY_BUBBLE_INTERVAL_MIN_MS = 260;
const REPLAY_BUBBLE_SETTLE_MS = 2600;
const LIVE_BUBBLE_STAGGER_MS = 180;
const MAX_DEVICE_PIXEL_RATIO = 3;

function getCappedDevicePixelRatio(): number {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DEVICE_PIXEL_RATIO);
}

function getReplayBubbleIntervalMs(replaySpeed: number): number {
  return Math.max(REPLAY_BUBBLE_INTERVAL_MIN_MS, Math.round(REPLAY_BUBBLE_INTERVAL_BASE_MS / replaySpeed));
}

function getActiveSceneAutomationState(game: Phaser.Game | null, dpr: number): AutomationSceneState | null {
  if (!game) return null;

  const sceneKeys = ['EndingScene', 'WorldScene', 'TitleScene', 'BootScene'] as const;
  for (const key of sceneKeys) {
    if (!game.scene.isActive(key)) continue;

    const scene = game.scene.getScene(key) as AutomationScene;
    if (typeof scene.getAutomationState === 'function') {
      return {
        ...scene.getAutomationState(),
        device_pixel_ratio: dpr,
        dpr,
      };
    }
    return { scene: key, device_pixel_ratio: dpr, dpr };
  }

  return null;
}

function resolveSceneTheme(state: ReturnType<typeof useSimulationStore.getState>): string {
  const persistedTheme = state.scenario?.scene_theme;
  if (persistedTheme) {
    return persistedTheme;
  }
  return inferSceneTheme(state.scenario?.question || '');
}

export function PhaserGame({
  width = 800,
  height = 450,
  className,
  useDomBubbles = false,
  replaySpeed = 1,
  playbackMode = 'replay',
  playbackBranchId,
  playbackRound,
}: PhaserGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const synthDone = useRef(false);
  const bubbleCleanup = useRef<(() => void) | null>(null);
  /** Track how many messages we've already dispatched as bubbles. */
  const lastBubbleIdx = useRef(0);
  const titleSkipDone = useRef(false);
  const replaySyncTimer = useRef<number | null>(null);
  const replayDoneTimer = useRef<number | null>(null);
  const replayAutomationState = useRef<AutomationReplayState | null>(null);
  const replaySpeedRef = useRef(replaySpeed);
  const useDomBubblesRef = useRef(useDomBubbles);
  const playbackModeRef = useRef(playbackMode);
  const playbackBranchIdRef = useRef<string | null | undefined>(playbackBranchId);
  const playbackRoundRef = useRef<number | null | undefined>(playbackRound);
  const replayPlaybackSyncRef = useRef<(() => void) | null>(null);
  const liveBubbleTimersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    replaySpeedRef.current = replaySpeed;
    replayPlaybackSyncRef.current?.();
  }, [replaySpeed]);

  useEffect(() => {
    useDomBubblesRef.current = useDomBubbles;
    gameRef.current?.registry.set('useDomBubbles', useDomBubbles);
  }, [useDomBubbles]);

  useEffect(() => {
    playbackModeRef.current = playbackMode;
    playbackBranchIdRef.current = playbackBranchId;
    playbackRoundRef.current = playbackRound;
    replayPlaybackSyncRef.current?.();
  }, [playbackBranchId, playbackMode, playbackRound]);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    // Start EventBridge before Phaser game
    EventBridge.start();
    const dpr = getCappedDevicePixelRatio();
    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: backingWidth,
      height: backingHeight,
      preserveDrawingBuffer: true,
      pixelArt: true,
      roundPixels: true,
      antialias: false,
      backgroundColor: '#1a1a2e',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      callbacks: {
        preBoot: (game) => {
          const state = useSimulationStore.getState();
          game.registry.set('initialSceneTheme', resolveSceneTheme(state));
          game.registry.set('initialSpriteKeys', getInitialSpriteKeysForAgents(state.agents));
          game.registry.set('skipTitleScene', state.agents.length > 0 && !state.isSimulationComplete);
          game.registry.set('devicePixelRatio', dpr);
          game.registry.set('useDomBubbles', useDomBubblesRef.current);
        },
      },
      scene: [BootScene, TitleScene, WorldScene, EndingScene],
    };

    gameRef.current = new Phaser.Game(config);
    console.log('[PhaserGame] Phaser instance created');

    const automationWindow = window as AutomationWindow;
    automationWindow.__swarmGetSceneAutomation = () =>
      getActiveSceneAutomationState(gameRef.current, dpr);
    automationWindow.__swarmGetReplayAutomation = () => replayAutomationState.current;
    automationWindow.advanceTime = async (ms: number) => {
      const game = gameRef.current;
      if (!game || typeof game.step !== 'function') {
        await new Promise((resolve) => window.setTimeout(resolve, ms));
        return;
      }

      const delta = 1000 / 60;
      let currentTime = performance.now();
      const runSteps = (count: number) => {
        for (let i = 0; i < count; i += 1) {
          currentTime += delta;
          game.step(currentTime, delta);
        }
      };

      runSteps(Math.max(1, Math.round(ms / delta)));

      const settleStart = performance.now();
      while (performance.now() - settleStart < 1500) {
        const sceneState = automationWindow.__swarmGetSceneAutomation?.() as { is_transitioning?: boolean } | null;
        if (!sceneState?.is_transitioning) break;
        runSteps(2);
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
      }

      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    };

    const clearReplaySyncTimer = () => {
      if (replaySyncTimer.current) {
        window.clearInterval(replaySyncTimer.current);
        replaySyncTimer.current = null;
      }
    };

    replaySyncTimer.current = window.setInterval(() => {
      const game = gameRef.current;
      if (
        titleSkipDone.current ||
        (game?.scene.isActive('WorldScene') && !game.scene.isActive('TitleScene'))
      ) {
        titleSkipDone.current = true;
        clearReplaySyncTimer();
        return;
      }

      const state = useSimulationStore.getState();
      if (ensureReplayStartsInWorldScene(gameRef.current, state)) {
        titleSkipDone.current = true;
        clearReplaySyncTimer();
        console.log('[PhaserGame] Replay sync timer skipped TitleScene');
      }
    }, 150);

    const clearReplayDoneTimer = () => {
      if (replayDoneTimer.current) {
        window.clearTimeout(replayDoneTimer.current);
        replayDoneTimer.current = null;
      }
    };

    const clearLiveBubbleTimers = () => {
      for (const timer of liveBubbleTimersRef.current) {
        window.clearTimeout(timer);
      }
      liveBubbleTimersRef.current.clear();
    };

    const bootstrapWorldSceneFromStore = (
      state: ReturnType<typeof useSimulationStore.getState>,
      source: string,
    ) => {
      if (!gameRef.current) return false;
      if (!shouldBootstrapWorldScene({
        synthDone: synthDone.current,
        worldSceneActive: gameRef.current.scene.isActive('WorldScene'),
        agentCount: state.agents.length,
      })) {
        return false;
      }

      synthDone.current = true;
      const theme = resolveSceneTheme(state);
      const initData = synthesizeSceneInit(state.agents, theme);
      const replayMessages = state.isSimulationComplete
        ? filterReplayMessages(
          state.messages,
          state.branches,
          playbackBranchIdRef.current,
          playbackRoundRef.current,
        )
        : state.messages;

      syncReplayAutomationState(replayMessages.length);
      dispatchVizEvent('viz:scene_init', initData);
      for (const agent of state.agents) agentIds.add(agent.id);
      lastBubbleIdx.current = 0;

        if (replayMessages.length > 0) {
          dispatchVizEvent('viz:clear_bubbles', {});
          if (playbackModeRef.current === 'skip') {
            synthesizeLatestBubbles(replayMessages, state.agents);
          } else {
            bubbleCleanup.current = synthesizeBubbles(
              replayMessages,
              state.agents,
              REPLAY_BATCH_SIZE,
              getReplayBubbleIntervalMs(replaySpeedRef.current),
            );
          }
          lastBubbleIdx.current = state.messages.length;
        }

      console.log(`[PhaserGame] Bootstrap scene init from ${source} — theme=${theme}, agents=${state.agents.length}`);
      return true;
    };

    const updateReplayAutomationState = (
      next: Partial<AutomationReplayState>,
      messageCount?: number,
    ) => {
      const filteredMessages = messageCount ?? replayAutomationState.current?.filtered_message_count ?? 0;
      replayAutomationState.current = {
        available: next.available ?? replayAutomationState.current?.available ?? false,
        phase: next.phase ?? replayAutomationState.current?.phase ?? 'idle',
        playback_mode: next.playback_mode ?? replayAutomationState.current?.playback_mode ?? playbackModeRef.current,
        replay_speed: next.replay_speed ?? replayAutomationState.current?.replay_speed ?? replaySpeedRef.current,
        selected_branch_id:
          next.selected_branch_id ?? replayAutomationState.current?.selected_branch_id ?? playbackBranchIdRef.current ?? null,
        selected_round:
          next.selected_round ?? replayAutomationState.current?.selected_round ?? playbackRoundRef.current ?? null,
        filtered_message_count: filteredMessages,
        batch_count:
          next.batch_count ??
          replayAutomationState.current?.batch_count ??
          Math.ceil(filteredMessages / REPLAY_BATCH_SIZE),
        displayed_bubble_count: replayAutomationState.current?.displayed_bubble_count,
      };
    };

    const syncReplayAutomationState = (messageCount: number) => {
      clearReplayDoneTimer();
      const batchCount = Math.ceil(messageCount / REPLAY_BATCH_SIZE);
      if (!useSimulationStore.getState().isSimulationComplete) {
        replayAutomationState.current = null;
        return;
      }

      if (playbackModeRef.current === 'skip' || messageCount === 0) {
        updateReplayAutomationState({
          available: true,
          phase: 'settled',
          playback_mode: playbackModeRef.current,
          replay_speed: replaySpeedRef.current,
          selected_branch_id: playbackBranchIdRef.current ?? null,
          selected_round: playbackRoundRef.current ?? null,
          batch_count: batchCount,
        }, messageCount);
        return;
      }

      updateReplayAutomationState({
        available: true,
        phase: 'playing',
        playback_mode: playbackModeRef.current,
        replay_speed: replaySpeedRef.current,
        selected_branch_id: playbackBranchIdRef.current ?? null,
        selected_round: playbackRoundRef.current ?? null,
        batch_count: batchCount,
      }, messageCount);

      const playbackDuration =
        Math.max(0, batchCount - 1) * getReplayBubbleIntervalMs(replaySpeedRef.current)
        + REPLAY_BUBBLE_SETTLE_MS;
      replayDoneTimer.current = window.setTimeout(() => {
        updateReplayAutomationState({ phase: 'complete' }, messageCount);
      }, playbackDuration);
    };

    replayPlaybackSyncRef.current = () => {
      if (!gameRef.current || !synthDone.current) return;

      const state = useSimulationStore.getState();
      if (!state.isSimulationComplete) return;

      const replayMessages = filterReplayMessages(
        state.messages,
        state.branches,
        playbackBranchIdRef.current,
        playbackRoundRef.current,
      );

      if (bubbleCleanup.current) {
        bubbleCleanup.current();
        bubbleCleanup.current = null;
      }

      dispatchVizEvent('viz:clear_bubbles', {});
      syncReplayAutomationState(replayMessages.length);

      if (replayMessages.length > 0) {
        if (playbackModeRef.current === 'skip') {
          synthesizeLatestBubbles(replayMessages, state.agents);
        } else {
          bubbleCleanup.current = synthesizeBubbles(
            replayMessages,
            state.agents,
            REPLAY_BATCH_SIZE,
            getReplayBubbleIntervalMs(replaySpeedRef.current),
          );
        }
      }

      lastBubbleIdx.current = state.messages.length;
    };

    // ── V2.1: Viz Event Synthesis for completed simulations ──
    // Listen for WorldScene 'scene-ready' signal, then synthesize viz events
    // from the Zustand store data if agents are already loaded.
    const sceneReadyUnsub = EventBridge.on('viz:scene_ready', () => {
      if (synthDone.current) return;

      const state = useSimulationStore.getState();
      if (state.agents.length > 0) {
        window.setTimeout(() => {
          bootstrapWorldSceneFromStore(useSimulationStore.getState(), 'scene_ready');
        }, 0);
      }
    });

    // Also subscribe to store changes: if agents load AFTER WorldScene is ready
    // (e.g., slow API response), trigger synthesis when agents arrive.
    // AND: watch for new messages arriving (live simulation rounds 2+).
    const agentIds = new Set<string>();
    const storeUnsub = useSimulationStore.subscribe((state, prevState) => {
      if (!titleSkipDone.current && ensureReplayStartsInWorldScene(gameRef.current, state)) {
        titleSkipDone.current = true;
        clearReplaySyncTimer();
        console.log('[PhaserGame] Skipped TitleScene for completed theater replay');
      }

      // ── Scene init for late-loading agents ──
      if (
        !synthDone.current &&
        state.agents.length > 0 &&
        prevState.agents.length === 0
      ) {
        bootstrapWorldSceneFromStore(state, 'store_agents_loaded');
      }

      // ── Fallback: auto-init if synthDone was never set ──
      // Handles race condition where viz:scene_ready fires before agents load
      // AND agents load before WorldScene is active.
      if (
        !synthDone.current &&
        state.agents.length > 0 &&
        state.messages.length > 0 &&
        gameRef.current?.scene.isActive('WorldScene')
      ) {
        bootstrapWorldSceneFromStore(state, 'store_fallback');
      }

      // ── Incremental bubble dispatch for live simulations (rounds 2+) ──
      // When new messages are appended to state.messages, dispatch viz:bubble_show
      // for each one so bubbles appear in real-time across ALL rounds.
      if (
        synthDone.current &&
        state.messages.length > lastBubbleIdx.current
      ) {
        // Rebuild agentIds set if needed
        if (agentIds.size === 0 && state.agents.length > 0) {
          for (const a of state.agents) agentIds.add(a.id);
        }

        const newMessages = state.messages.slice(lastBubbleIdx.current);
        lastBubbleIdx.current = state.messages.length;

        // Stagger new bubbles slightly so they don't all appear at once
        newMessages.forEach((msg, idx) => {
          if (!agentIds.has(msg.agent_id)) return;
          const timerId = window.setTimeout(() => {
            liveBubbleTimersRef.current.delete(timerId);
            dispatchVizEvent('viz:bubble_show', {
              sprite_id: msg.agent_id,
              bubble_text: clipBubbleEventText(msg.message),
              bubble_mode: 'live',
              emotion: msg.emotion || 'neutral',
            });

            if (msg.emotion && msg.emotion !== 'neutral') {
              dispatchVizEvent('viz:emotion_change', {
                sprite_id: msg.agent_id,
                halo_color: emotionToHaloColor(msg.emotion),
              });
            }
          }, idx * LIVE_BUBBLE_STAGGER_MS);
          liveBubbleTimersRef.current.add(timerId);
        });

        console.log(`[PhaserGame] Dispatched ${newMessages.length} new bubble(s) (incremental, total=${state.messages.length})`);
      }
    });

    return () => {
      sceneReadyUnsub();
      storeUnsub();
      if (bubbleCleanup.current) bubbleCleanup.current();
      clearReplayDoneTimer();
      clearReplaySyncTimer();
      clearLiveBubbleTimers();
      replayPlaybackSyncRef.current = null;
      EventBridge.stop();
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
        console.log('[PhaserGame] Phaser instance destroyed');
      }
      delete automationWindow.__swarmGetSceneAutomation;
      delete automationWindow.__swarmGetReplayAutomation;
      delete automationWindow.advanceTime;
      replayAutomationState.current = null;
    };
  }, [height, width]);

  return (
    <div
      ref={containerRef}
      className={`phaser-game-container ${className || ''}`}
    />
  );
}
