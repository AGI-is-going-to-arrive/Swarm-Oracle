
import { describe, expect, it } from 'vitest';

import { buildAutomationPayload, stringifyAutomationPayload } from './automation';

describe('automation payload helpers', () => {
  it('builds a stable payload shape with coordinate metadata', () => {
    const payload = buildAutomationPayload(
      {
        question: '如果罗马帝国从未衰落？',
        status: 'simulating',
        currentRound: 2,
        totalRounds: 3,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: false,
        messageCount: 5,
        agentCount: 3,
        branchCount: 1,
      },
      {
        scene: 'WorldScene',
        theme: 'ancient_empire',
      },
      {
        route: '/sim/abc',
        kind: 'simulation',
        replay_state: {
          available: true,
          phase: 'playing',
          enabled: true,
          playback_mode: 'replay',
          replay_speed: 2,
          selected_branch_id: 'branch-1',
          selected_branch_title: '中央路线',
          selected_round: 2,
          available_rounds: [1, 2, 3],
          filtered_message_count: 6,
          batch_count: 2,
          displayed_bubble_count: 4,
        },
      },
    );

    expect(payload.coordinate_system.origin).toBe('top-left');
    expect(payload.page?.kind).toBe('simulation');
    expect(payload.page?.replay_state?.selected_round).toBe(2);
    expect(payload.simulation.viewMode).toBe('theater');
    expect(payload.scene?.scene).toBe('WorldScene');
  });

  it('stringifies null scene state without dropping simulation data', () => {
    const json = stringifyAutomationPayload(
      {
        question: null,
        status: 'idle',
        currentRound: 0,
        totalRounds: null,
        viewMode: 'classic',
        visualizationEnabled: false,
        isSimulationComplete: false,
        messageCount: 0,
        agentCount: 0,
        branchCount: 0,
      },
      null,
    );

    const parsed = JSON.parse(json);
    expect(parsed.scene).toBeNull();
    expect(parsed.simulation.status).toBe('idle');
  });
});
