import { describe, expect, it } from 'vitest';

import { shouldBootstrapWorldScene } from './worldSceneBootstrap';

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
