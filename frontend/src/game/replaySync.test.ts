import { describe, expect, it, vi } from 'vitest';

import { ensureReplayStartsInWorldScene } from './replaySync';

describe('replay scene sync', () => {
  it('skips TitleScene for completed theater replays with messages', () => {
    const stop = vi.fn();
    const start = vi.fn();
    const game = {
      scene: {
        isActive: (key: string) => key === 'TitleScene',
        stop,
        start,
      },
    };

    const didSkip = ensureReplayStartsInWorldScene(game, {
      visualizationEnabled: true,
      isSimulationComplete: true,
      messages: [{ id: 'm1' }],
    });

    expect(didSkip).toBe(true);
    expect(stop).toHaveBeenCalledWith('TitleScene');
    expect(start).toHaveBeenCalledWith('WorldScene');
  });

  it('skips TitleScene for completed theater replays before messages hydrate', () => {
    const stop = vi.fn();
    const start = vi.fn();
    const game = {
      scene: {
        isActive: (key: string) => key === 'TitleScene',
        stop,
        start,
      },
    };

    const didSkip = ensureReplayStartsInWorldScene(game, {
      visualizationEnabled: true,
      isSimulationComplete: true,
      messages: [],
    });

    expect(didSkip).toBe(true);
    expect(stop).toHaveBeenCalledWith('TitleScene');
    expect(start).toHaveBeenCalledWith('WorldScene');
  });

  it('skips TitleScene for live theater simulations to reduce idle wait', () => {
    const stop = vi.fn();
    const start = vi.fn();
    const game = {
      scene: {
        isActive: () => true,
        stop,
        start,
      },
    };

    const didSkip = ensureReplayStartsInWorldScene(game, {
      visualizationEnabled: true,
      isSimulationComplete: false,
      messages: [],
    });

    expect(didSkip).toBe(true);
    expect(stop).toHaveBeenCalledWith('TitleScene');
    expect(start).toHaveBeenCalledWith('WorldScene');
  });
});
