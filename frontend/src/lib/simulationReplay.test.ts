import { describe, expect, it } from 'vitest';

import type { Scenario } from '../types';
import type { ScenarioMeta } from './scenarioMeta';
import {
  buildSimulationReplayUrl,
  coerceSimulationReplayPayload,
  decodeSimulationReplayToken,
  encodeSimulationReplayToken,
  normalizeSimulationReplayPayload,
  readSimulationReplayPayload,
  sanitizeSimulationReplayPayload,
  type SimulationReplayPayload,
} from './simulationReplay';
import { decodeReplayEnvelope, encodeReplayEnvelope, ReplayTokenTooLargeError } from './replayCodec';

const scenario: Scenario = {
  id: 'scenario-1',
  question: '如果罗马帝国从未衰落？',
  status: 'done',
  created_at: '2026-03-19T00:00:00Z',
  total_rounds: 3,
  mode: 'blackboard',
  visualization_enabled: true,
  scene_theme: 'ancient_empire',
  agents: [
    { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE', emotion: 'neutral' },
  ],
  branches: [
    {
      id: 'b1',
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: '',
      title: '永世帝国',
      summary: '',
      story: '',
      insight: '',
      key_moments: [],
      probability: 1,
      status: 'COMPLETED',
    },
  ],
  groups: [],
  hierarchical: false,
  messages: [
    { agent: '奥勒留斯', agent_id: 'a1', message: '稳定秩序。', emotion: 'calm', branch: 'b1', round: 1 },
  ],
  director_state: null,
  gameplay_state: null,
};

const scenarioMeta: ScenarioMeta = {
  director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
  cooldowns: {
    public_hearing: {
      lastUsedRound: 1,
      cooldownRounds: 2,
    },
  },
  cards: { usageLog: [{
    cardId: 'public_hearing',
    profileId: 'empire',
    branchId: 'b1',
    branchTitle: '永世帝国',
    round: 1,
    cost: 1,
    directive: '召开公开听证，重申帝国秩序。',
    usedAt: '2026-03-19T00:00:00Z',
  }] },
  betting: { bets: [] },
  commitment: {
    active: false,
    branchId: null,
    branchTitle: null,
    committedAtRound: null,
    committedAt: null,
    outcome: null,
  },
  objectives: {
    generatedForQuestion: null,
    generatedForProfile: null,
    goals: [],
  },
  archive: {
    branchSnapshots: [],
    keyMoments: [],
  },
};

const payload: SimulationReplayPayload = {
  scenario,
  scenarioMeta,
  uiState: {
    selectedReplayBranchId: 'b1',
    selectedReplayRound: 1,
    playbackMode: 'replay',
    replaySpeed: 2,
    panelCollapsed: true,
  },
};

describe('simulationReplay helpers', () => {
  it('round-trips a simulation replay token', async () => {
    const token = await encodeSimulationReplayToken(payload);
    const decoded = await decodeSimulationReplayToken(token);

    expect(decoded?.scenario.id).toBe(payload.scenario.id);
    expect(decoded?.uiState?.replaySpeed).toBe(2);
    expect(decoded?.scenarioMeta.director.remainingPoints).toBe(2);
    expect(decoded?.scenarioMeta.archive.profileId).toBe('empire');
  });

  it('accepts cancelled scenarios in public replay artifacts and tokens', async () => {
    const cancelledPayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        status: 'cancelled',
      },
    };

    expect(coerceSimulationReplayPayload(cancelledPayload)?.scenario.status).toBe('cancelled');
    const token = await encodeSimulationReplayToken(cancelledPayload);
    expect((await decodeSimulationReplayToken(token))?.scenario.status).toBe('cancelled');
  });

  it('strips live-only graph and checkpoint metadata from simulation replay payloads', async () => {
    const livePayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        causal_graph_id: 'owner-only-graph',
        faction_timeline_id: 'owner-only-faction-timeline',
        checkpoints: Array.from({ length: 200 }, (_, index) => ({
          id: `checkpoint-${index}`,
          scenario_id: scenario.id,
          branch_id: 'b1',
          round_number: index + 1,
          created_at: '2026-03-19T00:00:00Z',
        })),
      },
    };

    const normalized = normalizeSimulationReplayPayload(livePayload);
    expect(normalized.scenario).not.toHaveProperty('causal_graph_id');
    expect(normalized.scenario).not.toHaveProperty('checkpoints');
    expect(normalized.scenario).not.toHaveProperty('faction_timeline_id');

    const token = await encodeSimulationReplayToken(livePayload);
    const raw = await decodeReplayEnvelope<SimulationReplayPayload>(token, 'simulation_view_v1');
    expect(raw?.scenario).not.toHaveProperty('causal_graph_id');
    expect(raw?.scenario).not.toHaveProperty('checkpoints');
    expect(raw?.scenario).not.toHaveProperty('faction_timeline_id');
  });

  it('strips private agent fields while preserving the public replay profile', async () => {
    const livePayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        agents: [{
          id: 'private-agent',
          name: 'Returning analyst',
          role: 'Analyst',
          persona: 'Private user-authored persona',
          tier: 'CORE',
          stance: 'Cautious',
          emotion: 'focused',
          group_id: 'group-1',
          group_name: 'Reviewers',
          agent_identity_id: 'owner-identity-id',
          source_type: 'custom',
          is_returning: true,
        }],
      },
    };
    const publicAgent = {
      id: 'private-agent',
      name: 'Returning analyst',
      role: 'Analyst',
      tier: 'CORE',
      stance: 'Cautious',
      emotion: 'focused',
      group_id: 'group-1',
      group_name: 'Reviewers',
      source_type: 'custom',
      is_returning: true,
    };

    const normalized = normalizeSimulationReplayPayload(livePayload);
    expect(normalized.scenario.agents).toEqual([publicAgent]);

    const token = await encodeSimulationReplayToken(livePayload);
    const raw = await decodeReplayEnvelope<SimulationReplayPayload>(token, 'simulation_view_v1');
    expect(raw?.scenario.agents).toEqual([publicAgent]);
  });

  it('redacts signed source query credentials while preserving localhost and public params', async () => {
    const privatePayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        web_search_context: {
          query: 'local model research',
          snippets: [{
            text: 'Local source',
            source_url: 'http://localhost:11434/v1?key=local-secret&model=local',
          }],
          provider: 'native',
          timestamp: '2026-03-19T00:00:00Z',
          cached: false,
          family_context: {
            polymarket: {
              items: [],
              configured_host: 'localhost:11434?secret=host789&mode=read',
            },
            finance: {
              items: [{
                id: 'finance-1',
                title: 'Visible finance source',
                url: 'https://finance.example.test/data?sig=tiny456&symbol=SWARM',
              }],
            },
          },
          native_citations: [{
            text: 'Visible citation',
            source_url: 'https://cdn.example.test/object?X-Amz-Signature=abc123&X-Amz-Security-Token=session-token-987&download=1',
          }],
        },
      },
    };

    const sanitized = sanitizeSimulationReplayPayload(privatePayload);
    expect(sanitized.scenario.web_search_context?.snippets[0]?.source_url).toBe(
      'http://localhost:11434/v1?key=[redacted]&model=local',
    );
    expect(
      sanitized.scenario.web_search_context?.family_context?.polymarket?.configured_host,
    ).toBe('localhost:11434?secret=[redacted]&mode=read');
    expect(
      sanitized.scenario.web_search_context?.family_context?.finance?.items[0]?.url,
    ).toBe('https://finance.example.test/data?sig=[redacted]&symbol=SWARM');
    expect(sanitized.scenario.web_search_context?.native_citations?.[0]?.source_url).toBe(
      'https://cdn.example.test/object?X-Amz-Signature=[redacted]&X-Amz-Security-Token=[redacted]&download=1',
    );

    const token = await encodeSimulationReplayToken(privatePayload);
    const raw = await decodeReplayEnvelope<SimulationReplayPayload>(token, 'simulation_view_v1');
    const serialized = JSON.stringify(raw);
    for (const credential of ['local-secret', 'host789', 'tiny456', 'abc123', 'session-token-987']) {
      expect(serialized).not.toContain(credential);
    }
    const decoded = await decodeSimulationReplayToken(token);
    expect(decoded?.scenario.web_search_context?.snippets[0]?.source_url).toBe(
      'http://localhost:11434/v1?key=[redacted]&model=local',
    );
    for (const credential of ['local-secret', 'host789', 'tiny456', 'abc123', 'session-token-987']) {
      expect(JSON.stringify(decoded)).not.toContain(credential);
    }
  });

  it('removes gameplay bet identities while preserving public simulation replay data', async () => {
    const backendBet = {
      bet_id: 'backend-bet-1',
      kind: 'profile_resonance' as const,
      target_id: 'aligned',
      target_label: 'Aligned',
      confidence: 0.76,
      user_name: 'Remote Director',
      placed_at_round: 2,
      placed_at: '2026-03-19T00:02:00Z',
      resolved: true,
    };
    Object.assign(backendBet, {
      user_id: 'remote-user-1',
      owner_id: 'remote-owner-1',
    });
    const localBet = {
      betId: 'local-bet-1',
      kind: 'ending_tone' as const,
      targetId: 'order',
      targetLabel: 'Order',
      confidence: 0.63,
      userName: 'Local Director',
      placedAtRound: 2,
      placedAt: '2026-03-19T00:02:01Z',
      resolved: false,
    };
    Object.assign(localBet, {
      userId: 'local-user-1',
      ownerUserId: 'local-owner-1',
    });
    const privatePayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        gameplay_state: {
          revision: 9,
          cards: { usage_log: [] },
          betting: { bets: [backendBet] },
          archive: {
            key_moments: ['Visible simulation moment'],
            branch_snapshots: [{
              branch_id: 'b1',
              title: '永世帝国',
              probability: 1,
            }],
          },
        },
      },
      scenarioMeta: {
        ...payload.scenarioMeta,
        betting: { bets: [localBet] },
      },
    };
    const expectedBackendBet = {
      bet_id: 'backend-bet-1',
      kind: 'profile_resonance',
      target_id: 'aligned',
      target_label: 'Aligned',
      confidence: 0.76,
      placed_at_round: 2,
      placed_at: '2026-03-19T00:02:00Z',
      resolved: true,
    };
    const expectedLocalBet = {
      betId: 'local-bet-1',
      kind: 'ending_tone',
      targetId: 'order',
      targetLabel: 'Order',
      confidence: 0.63,
      placedAtRound: 2,
      placedAt: '2026-03-19T00:02:01Z',
      resolved: false,
    };

    const sanitized = sanitizeSimulationReplayPayload(privatePayload);
    expect(sanitized.scenario.gameplay_state?.betting.bets[0]).toEqual(expectedBackendBet);
    expect(sanitized.scenario.gameplay_state?.archive.key_moments).toEqual(['Visible simulation moment']);
    expect(sanitized.scenarioMeta.betting.bets[0]).toEqual(expectedLocalBet);
    expect(sanitized.scenarioMeta.cards).toEqual(payload.scenarioMeta.cards);

    const normalized = normalizeSimulationReplayPayload(privatePayload);
    expect(normalized.scenario.gameplay_state?.betting.bets[0]).toEqual(expectedBackendBet);
    expect(normalized.scenarioMeta.betting.bets[0]).toEqual(expectedLocalBet);

    const token = await encodeSimulationReplayToken(privatePayload);
    const raw = await decodeReplayEnvelope<SimulationReplayPayload>(token, 'simulation_view_v1');
    expect(raw?.scenario.gameplay_state?.betting.bets[0]).toEqual(expectedBackendBet);
    expect(raw?.scenarioMeta.betting.bets[0]).toEqual(expectedLocalBet);
  });

  it('backfills missing gameplay partitions before sanitizing a legacy partial state', async () => {
    const legacyPayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        gameplay_state: {
          archive: {
            key_moments: ['Legacy remote moment'],
          },
        } as unknown as Scenario['gameplay_state'],
      },
    };

    const sanitized = sanitizeSimulationReplayPayload(legacyPayload);
    expect(sanitized.scenario.gameplay_state).toEqual({
      cards: { usage_log: [] },
      betting: { bets: [] },
      archive: {
        key_moments: ['Legacy remote moment'],
        branch_snapshots: [],
      },
    });

    const coerced = coerceSimulationReplayPayload(legacyPayload);
    expect(coerced?.scenario.gameplay_state).toEqual(sanitized.scenario.gameplay_state);

    const legacyToken = await encodeReplayEnvelope('simulation_view_v1', legacyPayload);
    const decoded = await decodeSimulationReplayToken(legacyToken);
    expect(decoded?.scenario.gameplay_state).toEqual(sanitized.scenario.gameplay_state);
  });

  it('rehydrates compact replay meta back into usage-derived runtime state', () => {
    const normalized = normalizeSimulationReplayPayload({
      ...payload,
      scenarioMeta: {
        ...payload.scenarioMeta,
        director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
        cooldowns: {},
        archive: {
          branchSnapshots: [],
          keyMoments: [],
        },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.scenarioMeta.director.remainingPoints).toBe(2);
    expect(normalized!.scenarioMeta.director.spentPoints).toBe(1);
    expect(normalized!.scenarioMeta.cooldowns.public_hearing?.lastUsedRound).toBe(1);
    expect(normalized!.scenarioMeta.archive.profileId).toBe('empire');
  });

  it('rejects replay payloads with invalid branch/message shapes', async () => {
    const token = await encodeSimulationReplayToken({
      ...payload,
      scenario: {
        ...payload.scenario,
        branches: [123],
      },
    } as unknown as SimulationReplayPayload);

    await expect(decodeSimulationReplayToken(token)).resolves.toBeNull();
  });

  it('ignores invalid replay ui state in query payloads', async () => {
    const token = await encodeSimulationReplayToken({
      ...payload,
      uiState: {
        ...payload.uiState,
        replaySpeed: 3,
      },
    } as unknown as SimulationReplayPayload);
    const params = new URLSearchParams({ replay: token });

    await expect(readSimulationReplayPayload(params)).resolves.toBeNull();
  });

  it('builds a simulation replay url', async () => {
    const url = await buildSimulationReplayUrl('https://example.com/', payload);
    expect(url).toContain('/sim/replay?replay=');
  });

  it('rejects oversized simulation replay payloads before building a URL', async () => {
    const oversizedPayload: SimulationReplayPayload = {
      ...payload,
      scenario: {
        ...payload.scenario,
        messages: Array.from({ length: 220 }, (_, index) => ({
          agent: `Agent ${index}`,
          agent_id: `agent-${index}`,
          message: `message-${index}-${`${index}`.padStart(4, '0')}-${'abcdefghijklmnopqrstuvwxyz'.slice(index % 10)}-${index.toString(36).repeat(3)}`,
          emotion: 'calm',
          branch: 'b1',
          round: index + 1,
        })),
      },
    };

    await expect(
      buildSimulationReplayUrl('https://example.com/', oversizedPayload),
    ).rejects.toBeInstanceOf(ReplayTokenTooLargeError);
  });

  it('rejects replay payloads with an invalid scenario shape', () => {
    expect(coerceSimulationReplayPayload({
      ...payload,
      scenario: {
        ...payload.scenario,
        agents: 'invalid',
      },
    } as unknown as SimulationReplayPayload)).toBeNull();
  });

  it('returns null for replay tokens with invalid uiState data', async () => {
    const token = await encodeReplayEnvelope('simulation_view_v1', {
      ...payload,
      uiState: {
        ...payload.uiState,
        replaySpeed: 3,
      },
    });

    await expect(
      readSimulationReplayPayload(new URLSearchParams(`replay=${token}`)),
    ).resolves.toBeNull();
  });
});
