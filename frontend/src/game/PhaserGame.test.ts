import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shouldBootstrapWorldScene } from './worldSceneBootstrap';
import { PhaserGame } from './PhaserGame';

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
  mockGameInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    registry: { set: ReturnType<typeof vi.fn> };
    scene: {
      isActive: ReturnType<typeof vi.fn>;
      getScene: ReturnType<typeof vi.fn>;
    };
    step: ReturnType<typeof vi.fn>;
  }>,
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

vi.mock('phaser', () => {
  class MockGame {
    destroy = vi.fn();
    registry = { set: vi.fn() };
    scene = {
      isActive: vi.fn((key: string) => key === 'WorldScene'),
      getScene: vi.fn(() => ({})),
    };
    step = vi.fn();

    constructor(config: { callbacks?: { preBoot?: (game: MockGame) => void } }) {
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

vi.mock('./managers/EventBridge', () => ({
  EventBridge: {
    start: mockEventBridgeStart,
    stop: mockEventBridgeStop,
    on: mockEventBridgeOn,
  },
  dispatchVizEvent: mockDispatchVizEvent,
}));

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
