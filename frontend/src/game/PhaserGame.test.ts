import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationWindow } from './automation';
import { shouldBootstrapWorldScene } from './worldSceneBootstrap';
import { PhaserGame } from './PhaserGame';

interface MockGameConfig {
  width?: number;
  height?: number;
  preserveDrawingBuffer?: boolean;
  pixelArt?: boolean;
  roundPixels?: boolean;
  antialias?: boolean;
  scale?: {
    mode?: unknown;
    autoCenter?: unknown;
  };
  callbacks?: { preBoot?: (game: MockGameInstance) => void };
}

interface MockGameInstance {
  config: MockGameConfig;
  destroy: ReturnType<typeof vi.fn>;
  registry: { set: ReturnType<typeof vi.fn> };
  scene: {
    isActive: ReturnType<typeof vi.fn>;
    getScene: ReturnType<typeof vi.fn>;
  };
  step: ReturnType<typeof vi.fn>;
}

const {
  mockGameInstances,
  mockDispatchVizEvent,
  mockEventBridgeStart,
  mockEventBridgeStop,
  mockEventBridgeOn,
  mockSynthesizeBubbles,
  mockSynthesizeLatestBubbles,
  mockEnsureReplayStartsInWorldScene,
  mockUseSimulationStoreSubscribe,
} = vi.hoisted(() => ({
  mockGameInstances: [] as MockGameInstance[],
  mockDispatchVizEvent: vi.fn(),
  mockEventBridgeStart: vi.fn(),
  mockEventBridgeStop: vi.fn(),
  mockEventBridgeOn: vi.fn(),
  mockSynthesizeBubbles: vi.fn(),
  mockSynthesizeLatestBubbles: vi.fn(),
  mockEnsureReplayStartsInWorldScene: vi.fn(() => false),
  mockUseSimulationStoreSubscribe: vi.fn(),
}));

const replayState = {
  scenario: {
    scene_theme: 'ancient_empire',
    question: '如果罗马帝国从未衰落？',
  },
  agents: [{ id: 'agent-1', name: 'Agent 1' }],
  branches: [{ id: 'branch-1', title: '主线', status: 'ACTIVE', probability: 1 }],
  messages: [{ id: 'msg-1', agent_id: 'agent-1', message: 'hello', branch: 'branch-1', round: 1 }],
  isSimulationComplete: true,
};

const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  });
}

function restoreDevicePixelRatio() {
  if (originalDevicePixelRatio) {
    Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatio);
  }
}

vi.mock('phaser', () => {
  class MockGame {
    config: MockGameConfig;
    destroy = vi.fn();
    registry = { set: vi.fn() };
    scene = {
      isActive: vi.fn((key: string) => key === 'WorldScene'),
      getScene: vi.fn(() => ({})),
    };
    step = vi.fn();

    constructor(config: MockGameConfig) {
      this.config = config;
      mockGameInstances.push(this);
      config.callbacks?.preBoot?.(this);
    }
  }

  return {
    default: {
      AUTO: 'AUTO',
      Scale: {
        FIT: 'FIT',
        CENTER_BOTH: 'CENTER_BOTH',
      },
      Game: MockGame,
    },
  };
});

vi.mock('./scenes/BootScene', () => ({ BootScene: class BootScene {} }));
vi.mock('./scenes/TitleScene', () => ({ TitleScene: class TitleScene {} }));
vi.mock('./scenes/WorldScene', () => ({ WorldScene: class WorldScene {} }));
vi.mock('./scenes/EndingScene', () => ({ EndingScene: class EndingScene {} }));

vi.mock('./managers/EventBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./managers/EventBridge')>();
  return {
    ...actual,
    EventBridge: {
      start: mockEventBridgeStart,
      stop: mockEventBridgeStop,
      on: mockEventBridgeOn,
    },
    dispatchVizEvent: mockDispatchVizEvent,
  };
});

vi.mock('./managers/VizSynthesizer', () => ({
  clipBubbleEventText: (value: string) => value,
  synthesizeSceneInit: vi.fn(() => ({ theme: 'ancient_empire' })),
  synthesizeBubbles: mockSynthesizeBubbles,
  synthesizeLatestBubbles: mockSynthesizeLatestBubbles,
  inferSceneTheme: vi.fn(() => 'ancient_empire'),
  getInitialSpriteKeysForAgents: vi.fn(() => []),
}));

vi.mock('./replaySelection', () => ({
  filterReplayMessages: vi.fn((messages: unknown[]) => messages),
}));

vi.mock('./replaySync', () => ({
  ensureReplayStartsInWorldScene: mockEnsureReplayStartsInWorldScene,
}));

vi.mock('../stores/simulationStore', () => {
  const useSimulationStore = Object.assign(
    <T,>(selector: (state: typeof replayState) => T) => selector(replayState),
    {
      getState: () => replayState,
      subscribe: mockUseSimulationStoreSubscribe,
    },
  );
  return { useSimulationStore };
});

describe('PhaserGame world scene bootstrap guard', () => {
  it('allows bootstrap only when world scene is active and agents are ready', () => {
    expect(shouldBootstrapWorldScene({
      synthDone: false,
      worldSceneActive: true,
      agentCount: 3,
    })).toBe(true);
  });

  it('blocks bootstrap when synth already completed', () => {
    expect(shouldBootstrapWorldScene({
      synthDone: true,
      worldSceneActive: true,
      agentCount: 3,
    })).toBe(false);
  });

  it('blocks bootstrap when world scene is inactive or agents are still missing', () => {
    expect(shouldBootstrapWorldScene({
      synthDone: false,
      worldSceneActive: false,
      agentCount: 3,
    })).toBe(false);

    expect(shouldBootstrapWorldScene({
      synthDone: false,
      worldSceneActive: true,
      agentCount: 0,
    })).toBe(false);
  });
});

describe('PhaserGame replay speed behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restoreDevicePixelRatio();
    mockGameInstances.length = 0;
    mockDispatchVizEvent.mockReset();
    mockEventBridgeStart.mockReset();
    mockEventBridgeStop.mockReset();
    mockEventBridgeOn.mockReset();
    mockSynthesizeBubbles.mockReset();
    mockSynthesizeLatestBubbles.mockReset();
    mockEnsureReplayStartsInWorldScene.mockReset();
    mockEnsureReplayStartsInWorldScene.mockReturnValue(false);
    mockEventBridgeOn.mockReturnValue(() => {});
    mockUseSimulationStoreSubscribe.mockReset();
    mockUseSimulationStoreSubscribe.mockReturnValue(() => {});
    mockSynthesizeBubbles.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    restoreDevicePixelRatio();
  });

  it('uses DPR-scaled backing dimensions while keeping FIT scale mode and automation DPR', () => {
    setDevicePixelRatio(2);

    const view = render(createElement(PhaserGame));

    expect(mockGameInstances[0]?.config).toMatchObject({
      width: 1600,
      height: 900,
      preserveDrawingBuffer: true,
      pixelArt: true,
      roundPixels: true,
      antialias: false,
      scale: {
        mode: 'FIT',
        autoCenter: 'CENTER_BOTH',
      },
    });

    const automationState = (window as AutomationWindow).__swarmGetSceneAutomation?.();
    expect(automationState?.device_pixel_ratio).toBe(2);
    expect(automationState?.dpr).toBe(2);

    view.unmount();
  });

  it('stores the capped device pixel ratio in the game registry during preBoot', () => {
    setDevicePixelRatio(2.5);

    const view = render(createElement(PhaserGame));

    expect(mockGameInstances[0]?.registry.set).toHaveBeenCalledWith('devicePixelRatio', 2.5);

    view.unmount();
  });

  it('defaults DOM bubble rendering off in the game registry', () => {
    const view = render(createElement(PhaserGame));

    expect(mockGameInstances[0]?.registry.set).toHaveBeenCalledWith('useDomBubbles', false);

    view.unmount();
  });

  it('stores the DOM bubble feature flag in the game registry when enabled', () => {
    const view = render(createElement(PhaserGame, { useDomBubbles: true }));

    expect(mockGameInstances[0]?.registry.set).toHaveBeenCalledWith('useDomBubbles', true);

    view.unmount();
  });

  it('keeps unavailable live emotion metadata out of neutral bubble state', () => {
    let sceneReadyHandler: (() => void) | null = null;
    let storeSubscriber: ((state: typeof replayState, prevState: typeof replayState) => void) | null = null;
    mockEventBridgeOn.mockImplementation((eventType: string, handler: () => void) => {
      if (eventType === 'viz:scene_ready') {
        sceneReadyHandler = handler;
      }
      return () => {};
    });
    mockUseSimulationStoreSubscribe.mockImplementation((subscriber) => {
      storeSubscriber = subscriber;
      return () => {};
    });

    const view = render(createElement(PhaserGame));
    act(() => {
      sceneReadyHandler?.();
      vi.advanceTimersByTime(300);
    });
    mockDispatchVizEvent.mockClear();

    const unavailableMessage = {
      id: 'msg-2',
      agent_id: 'agent-1',
      message: 'Speech survives metadata failure.',
      emotion: '',
      emotion_metadata_status: 'unavailable' as const,
      emotion_metadata_failure_code: 'LLM_TIMEOUT',
      branch: 'branch-1',
      round: 2,
    };
    const previousState = { ...replayState, isSimulationComplete: false };
    const nextState = {
      ...previousState,
      messages: [...previousState.messages, unavailableMessage],
    };

    act(() => {
      storeSubscriber?.(nextState, previousState);
      vi.advanceTimersByTime(1);
    });

    const bubbleCall = mockDispatchVizEvent.mock.calls.find(([type]) => type === 'viz:bubble_show');
    expect(bubbleCall?.[1]).toMatchObject({
      sprite_id: 'agent-1',
      emotion_metadata_status: 'unavailable',
      emotion_metadata_failure_code: 'LLM_TIMEOUT',
    });
    expect(bubbleCall?.[1]).not.toHaveProperty('emotion');
    expect(mockDispatchVizEvent).not.toHaveBeenCalledWith(
      'viz:emotion_change',
      expect.anything(),
    );

    view.unmount();
  });

  it('caps the device pixel ratio at 3x to avoid oversized HiDPI canvases', () => {
    setDevicePixelRatio(4);

    const view = render(createElement(PhaserGame));

    expect((window as AutomationWindow).__swarmGetSceneAutomation?.()?.device_pixel_ratio).toBe(3);
    expect((window as AutomationWindow).__swarmGetSceneAutomation?.()?.dpr).toBe(3);

    view.unmount();
  });

  it('keeps the device pixel ratio at least 1x for sub-1 DPR reports', () => {
    setDevicePixelRatio(0.75);

    const view = render(createElement(PhaserGame));

    expect((window as AutomationWindow).__swarmGetSceneAutomation?.()?.device_pixel_ratio).toBe(1);
    expect((window as AutomationWindow).__swarmGetSceneAutomation?.()?.dpr).toBe(1);

    view.unmount();
  });

  it('does not recreate the Phaser instance when replaySpeed changes', () => {
    let sceneReadyHandler: (() => void) | null = null;
    mockEventBridgeOn.mockImplementation((eventType: string, handler: () => void) => {
      if (eventType === 'viz:scene_ready') {
        sceneReadyHandler = handler;
      }
      return () => {};
    });

    const view = render(
      createElement(PhaserGame, {
        replaySpeed: 1,
        playbackMode: 'replay',
        playbackBranchId: 'branch-1',
        playbackRound: 1,
      }),
    );

    expect(mockGameInstances).toHaveLength(1);

    act(() => {
      sceneReadyHandler?.();
      vi.advanceTimersByTime(300);
    });

    expect(mockSynthesizeBubbles).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeBubbles.mock.calls[0]?.[3]).toBe(880);

    view.rerender(
      createElement(PhaserGame, {
        replaySpeed: 4,
        playbackMode: 'replay',
        playbackBranchId: 'branch-1',
        playbackRound: 1,
      }),
    );

    expect(mockGameInstances).toHaveLength(1);
    expect(mockGameInstances[0]?.destroy).not.toHaveBeenCalled();
    expect(mockSynthesizeBubbles).toHaveBeenCalledTimes(2);
    expect(mockSynthesizeBubbles.mock.calls[1]?.[3]).toBe(260);

    view.unmount();
    expect(mockGameInstances[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not recreate the Phaser instance when replay branch, round, or mode changes', () => {
    let sceneReadyHandler: (() => void) | null = null;
    mockEventBridgeOn.mockImplementation((eventType: string, handler: () => void) => {
      if (eventType === 'viz:scene_ready') {
        sceneReadyHandler = handler;
      }
      return () => {};
    });

    const view = render(
      createElement(PhaserGame, {
        playbackMode: 'replay',
        playbackBranchId: 'branch-1',
        playbackRound: 1,
      }),
    );

    act(() => {
      sceneReadyHandler?.();
      vi.advanceTimersByTime(300);
    });

    expect(mockGameInstances).toHaveLength(1);
    expect(mockSynthesizeBubbles).toHaveBeenCalledTimes(1);

    view.rerender(
      createElement(PhaserGame, {
        playbackMode: 'skip',
        playbackBranchId: 'branch-2',
        playbackRound: 2,
      }),
    );

    expect(mockGameInstances).toHaveLength(1);
    expect(mockGameInstances[0]?.destroy).not.toHaveBeenCalled();
    expect(mockSynthesizeLatestBubbles).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(mockGameInstances[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('clears the replay sync timer when TitleScene was already skipped', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    try {
      const view = render(
        createElement(PhaserGame, {
          replaySpeed: 1,
          playbackMode: 'replay',
          playbackBranchId: 'branch-1',
          playbackRound: 1,
        }),
      );

      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(mockEnsureReplayStartsInWorldScene).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(450);
      });

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });
});
