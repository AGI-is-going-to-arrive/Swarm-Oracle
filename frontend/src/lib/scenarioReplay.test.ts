import { describe, expect, it } from 'vitest';

import type { ScenarioMeta } from './scenarioMeta';
import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  PredictionInfo,
  Scenario,
  StoryData,
} from '../types';
import {
  buildScenarioReplayUrl,
  compactScenarioMetaForReplay,
  decodeScenarioReplayToken,
  encodeScenarioReplayToken,
  normalizeScenarioResultReplayPayload,
  sanitizeScenarioResultReplayPayload,
  type ScenarioResultReplayPayload,
} from './scenarioReplay';
import { decodeReplayEnvelope, encodeReplayEnvelope, ReplayTokenTooLargeError } from './replayCodec';

const scenario: Scenario = {
  id: 'scenario-1',
  question: 'What if the archive had to sync?',
  status: 'done',
  created_at: '2026-03-19T00:00:00Z',
  total_rounds: 5,
  mode: 'blackboard',
  visualization_enabled: true,
  scene_theme: 'law_court',
  agents: [],
  branches: [],
  groups: [],
  hierarchical: false,
  director_state: null,
  gameplay_state: null,
};

const storyData: StoryData = {
  scenario_id: 'scenario-1',
  question: 'What if the archive had to sync?',
  status: 'done',
  branches: [
    {
      id: 'branch-1',
      title: 'Archive Branch',
      probability: 1,
      status: 'COMPLETED',
      story: 'A complete branch story.',
      insight: 'A durable insight.',
      key_moments: ['Moment 1'],
      parent_branch_id: null,
      fork_reason: '',
      replay_kind: null,
      replay_source_branch_id: null,
    },
  ],
};

const agents: AgentInfo[] = [
  { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
];

const predictions: PredictionInfo[] = [];

const scenarioMeta: ScenarioMeta = {
  director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
  cooldowns: {
    public_hearing: {
      lastUsedRound: 2,
      cooldownRounds: 2,
    },
  },
  cards: { usageLog: [{
    cardId: 'public_hearing',
    profileId: 'law',
    branchId: 'branch-1',
    branchTitle: 'Archive Branch',
    round: 2,
    cost: 1,
    directive: 'Open the public hearing ledger.',
    usedAt: '2026-03-19T00:02:00Z',
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
    branchSnapshots: [
      {
        branchId: 'branch-1',
        title: 'Archive Branch',
        probability: 1,
      },
    ],
    keyMoments: ['Moment 1'],
    profileId: 'law',
    dominantBranchTitle: 'Archive Branch',
    dominantTone: 'order',
    mostUsedCard: null,
    bettingHit: null,
    archiveGrade: 'A',
    directorStyleTag: 'quiet_observer',
    profileResonance: 'aligned',
  },
};

const campaignScenarioSummary: CampaignScenarioSummary = {
  scenario_id: 'scenario-1',
  profile_id: 'law',
  archive_grade: 'A',
  profile_resonance: 'aligned',
  betting_hit: null,
  most_used_card: null,
  completed_daily_challenge: false,
  campaign_score_delta: 5,
  finalized_at: null,
};

const campaignSummary: CampaignFinalizeResult = {
  scenario_id: 'scenario-1',
  already_finalized: false,
  campaign_score_delta: 5,
  profile: {
    user_id: 'director-1',
    user_name: 'Local Director',
    total_runs: 1,
    completed_challenges: 0,
    total_bets: 0,
    hit_bets: 0,
    highest_archive_grade: 'A',
    created_at: '2026-03-19T00:00:00Z',
    updated_at: '2026-03-19T00:00:00Z',
  },
  mastery: {
    profile_id: 'law',
    runs: 1,
    challenge_completions: 0,
    signature_hits: 0,
    aligned_hits: 1,
    campaign_score: 5,
    level: 2,
    best_archive_grade: 'A',
    favorite_card_id: null,
    next_level_score: 10,
    score_to_next_level: 5,
  },
  newly_unlocked_badges: [],
  badges: [],
};

const replayPayload: ScenarioResultReplayPayload = {
  scenario,
  storyData,
  agents,
  predictions,
  scenarioMeta,
  campaignScenarioSummary,
  campaignSummary,
  isDailyChallenge: false,
};

describe('scenarioReplay helpers', () => {
  it('compacts scenario meta for replay by trimming archive summary duplicates', () => {
    expect(compactScenarioMetaForReplay(scenarioMeta)).toEqual({
      ...scenarioMeta,
      director: {
        maxPoints: 3,
        remainingPoints: 3,
        spentPoints: 0,
      },
      cooldowns: {},
      archive: {
        branchSnapshots: [],
        keyMoments: ['Moment 1', 'event:card:2:public_hearing'],
      },
    });
  });

  it('round-trips a scenario result replay token', async () => {
    const token = await encodeScenarioReplayToken(replayPayload);
    const decoded = await decodeScenarioReplayToken(token);

    expect(decoded?.scenario.id).toBe(replayPayload.scenario.id);
    expect(decoded?.storyData.scenario_id).toBe(replayPayload.storyData.scenario_id);
    expect(decoded?.agents).toHaveLength(replayPayload.agents.length);
    expect(decoded?.predictions).toHaveLength(replayPayload.predictions.length);
    expect(decoded?.scenarioMeta.director.remainingPoints).toBe(2);
    expect(decoded?.scenarioMeta.archive.profileId).toBe('law');
  });

  it('removes identity-only agent fields from replay payloads before encoding', async () => {
    const sensitiveAgent: AgentInfo = {
      id: 'agent-secret',
      name: 'Sensitive Agent',
      role: 'Private strategist',
      persona: 'Do not publish this persona baseline',
      tier: 'IMPORTANT',
      emotion: 'focused',
      agent_identity_id: 'identity-secret',
      stance: 'cautious',
      group_id: 'group-1',
      group_name: 'Advisors',
      source_type: 'custom',
      is_returning: true,
    };
    const sensitivePayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      scenario: {
        ...scenario,
        agents: [sensitiveAgent],
      },
      agents: [sensitiveAgent],
    };

    const sanitized = sanitizeScenarioResultReplayPayload(sensitivePayload);
    expect(sanitized.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(sanitized.scenario.agents[0]).not.toHaveProperty('persona');
    expect(sanitized.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(sanitized.agents[0]).not.toHaveProperty('persona');

    const token = await encodeScenarioReplayToken(sensitivePayload);
    const raw = await decodeReplayEnvelope<ScenarioResultReplayPayload>(
      token,
      'scenario_result_v1',
    );
    expect(raw?.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(raw?.scenario.agents[0]).not.toHaveProperty('persona');
    expect(raw?.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(raw?.agents[0]).not.toHaveProperty('persona');
  });

  it('removes local identity fields while preserving public prediction and campaign data', async () => {
    const privatePrediction = {
      id: 'prediction-1',
      scenario_id: scenario.id,
      user_name: 'Local Director',
      prediction_text: 'The archive remains stable.',
      confidence: 0.72,
      score: 0.64,
      score_reason: 'Close to the terminal branch.',
      created_at: '2026-03-19T00:01:00Z',
    } satisfies PredictionInfo;
    Object.assign(privatePrediction, {
      user_id: 'local-user-1',
      owner_id: 'local-owner-1',
    });
    const privateScenario = { ...scenario };
    Object.assign(privateScenario, {
      user_id: 'local-user-1',
      ownerId: 'local-owner-1',
    });
    const privateCampaignSummary = {
      ...campaignSummary,
      profile: { ...campaignSummary.profile },
    };
    Object.assign(privateCampaignSummary.profile, {
      owner_user_id: 'local-owner-1',
    });
    const privatePayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      scenario: privateScenario,
      predictions: [privatePrediction],
      campaignSummary: privateCampaignSummary,
    };
    const expectedPrediction = {
      id: 'prediction-1',
      scenario_id: scenario.id,
      prediction_text: 'The archive remains stable.',
      confidence: 0.72,
      score: 0.64,
      score_reason: 'Close to the terminal branch.',
      created_at: '2026-03-19T00:01:00Z',
    };

    const sanitized = sanitizeScenarioResultReplayPayload(privatePayload);
    expect(sanitized.predictions[0]).toEqual(expectedPrediction);
    expect(sanitized.scenario).not.toHaveProperty('user_id');
    expect(sanitized.scenario).not.toHaveProperty('ownerId');
    expect(sanitized.campaignSummary?.profile).toMatchObject({
      total_runs: 1,
      total_bets: 0,
      hit_bets: 0,
      highest_archive_grade: 'A',
    });
    expect(sanitized.campaignSummary?.profile).not.toHaveProperty('user_id');
    expect(sanitized.campaignSummary?.profile).not.toHaveProperty('user_name');
    expect(sanitized.campaignSummary?.profile).not.toHaveProperty('owner_user_id');

    const token = await encodeScenarioReplayToken(privatePayload);
    const raw = await decodeReplayEnvelope<ScenarioResultReplayPayload>(token, 'scenario_result_v1');
    expect(raw?.predictions[0]).toEqual(expectedPrediction);
    expect(raw?.campaignSummary?.profile).not.toHaveProperty('user_id');
    expect(raw?.campaignSummary?.profile).not.toHaveProperty('user_name');

    const decoded = await decodeScenarioReplayToken(token);
    expect(decoded?.predictions[0]).toEqual(expectedPrediction);

    const normalized = normalizeScenarioResultReplayPayload(privatePayload);
    expect(normalized?.predictions[0]).toEqual(expectedPrediction);
  });

  it('removes gameplay bet identities while preserving public gameplay details', async () => {
    const backendBet = {
      bet_id: 'backend-bet-1',
      kind: 'branch_winner' as const,
      target_id: 'branch-1',
      target_label: 'Archive Branch',
      confidence: 0.81,
      user_name: 'Remote Director',
      placed_at_round: 2,
      placed_at: '2026-03-19T00:02:00Z',
      resolved: true,
    };
    Object.assign(backendBet, {
      user_id: 'remote-user-1',
      owner_user_id: 'remote-owner-1',
    });
    const localBet = {
      betId: 'local-bet-1',
      kind: 'ending_tone' as const,
      targetId: 'order',
      targetLabel: 'Order',
      confidence: 0.67,
      userName: 'Local Director',
      placedAtRound: 2,
      placedAt: '2026-03-19T00:02:01Z',
      resolved: false,
    };
    Object.assign(localBet, {
      userId: 'local-user-1',
      ownerId: 'local-owner-1',
    });
    const privatePayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      scenario: {
        ...scenario,
        gameplay_state: {
          revision: 4,
          cards: { usage_log: [] },
          betting: { bets: [backendBet] },
          archive: {
            key_moments: ['Visible backend moment'],
            branch_snapshots: [{
              branch_id: 'branch-1',
              title: 'Archive Branch',
              probability: 1,
            }],
          },
        },
      },
      scenarioMeta: {
        ...scenarioMeta,
        betting: { bets: [localBet] },
      },
      campaignScenarioSummary: null,
      campaignSummary: null,
    };
    const expectedBackendBet = {
      bet_id: 'backend-bet-1',
      kind: 'branch_winner',
      target_id: 'branch-1',
      target_label: 'Archive Branch',
      confidence: 0.81,
      placed_at_round: 2,
      placed_at: '2026-03-19T00:02:00Z',
      resolved: true,
    };
    const expectedLocalBet = {
      betId: 'local-bet-1',
      kind: 'ending_tone',
      targetId: 'order',
      targetLabel: 'Order',
      confidence: 0.67,
      placedAtRound: 2,
      placedAt: '2026-03-19T00:02:01Z',
      resolved: false,
    };

    const sanitized = sanitizeScenarioResultReplayPayload(privatePayload);
    expect(sanitized.scenario.gameplay_state?.betting.bets[0]).toEqual(expectedBackendBet);
    expect(sanitized.scenario.gameplay_state?.revision).toBe(4);
    expect(sanitized.scenario.gameplay_state?.archive.key_moments).toEqual(['Visible backend moment']);
    expect(sanitized.scenarioMeta.betting.bets[0]).toEqual(expectedLocalBet);
    expect(sanitized.scenarioMeta.cards).toEqual(scenarioMeta.cards);

    const token = await encodeScenarioReplayToken(privatePayload);
    const raw = await decodeReplayEnvelope<ScenarioResultReplayPayload>(token, 'scenario_result_v1');
    expect(raw?.scenario.gameplay_state?.betting.bets[0]).toEqual(expectedBackendBet);
    expect(raw?.scenarioMeta.betting.bets[0]).toEqual(expectedLocalBet);
  });

  it('strips live-only graph and checkpoint metadata from public replay payloads', async () => {
    const liveScenario: Scenario = {
      ...scenario,
      causal_graph_id: 'owner-only-graph',
      faction_timeline_id: 'owner-only-faction-timeline',
      checkpoints: Array.from({ length: 200 }, (_, index) => ({
        id: `checkpoint-${index}`,
        scenario_id: scenario.id,
        branch_id: 'branch-1',
        round_number: index + 1,
        created_at: '2026-03-19T00:00:00Z',
      })),
    };
    const livePayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      scenario: liveScenario,
    };

    const sanitized = sanitizeScenarioResultReplayPayload(livePayload);
    expect(sanitized.scenario).not.toHaveProperty('causal_graph_id');
    expect(sanitized.scenario).not.toHaveProperty('checkpoints');
    expect(sanitized.scenario).not.toHaveProperty('faction_timeline_id');

    const token = await encodeScenarioReplayToken(livePayload);
    const raw = await decodeReplayEnvelope<ScenarioResultReplayPayload>(token, 'scenario_result_v1');
    expect(raw?.scenario).not.toHaveProperty('causal_graph_id');
    expect(raw?.scenario).not.toHaveProperty('checkpoints');
    expect(raw?.scenario).not.toHaveProperty('faction_timeline_id');

    const normalized = normalizeScenarioResultReplayPayload(livePayload);
    expect(normalized?.scenario).not.toHaveProperty('causal_graph_id');
    expect(normalized?.scenario).not.toHaveProperty('checkpoints');
    expect(normalized?.scenario).not.toHaveProperty('faction_timeline_id');
  });

  it('strips full_report from the sanitized story data and replay token', async () => {
    const fullReport = {
      version: '1',
      status: 'complete',
      title: 'Full Report',
      sections: [{ id: 's1', title: 'Section', body_md_i18n: { zh: '正文', en: 'Body' } }],
      evidence: [{ id: 'e1', quote: 'A long quote that bloats the replay token' }],
      indicators_to_watch: [],
    };
    const reportPayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      storyData: {
        ...replayPayload.storyData,
        // Cast: the test deliberately attaches a report-shaped object to assert it is dropped.
        full_report: fullReport as unknown as StoryData['full_report'],
      },
    };

    // Encode/sanitize path must drop it.
    const sanitized = sanitizeScenarioResultReplayPayload(reportPayload);
    expect(sanitized.storyData).not.toHaveProperty('full_report');
    expect(sanitized.storyData.branches).toHaveLength(replayPayload.storyData.branches.length);

    const token = await encodeScenarioReplayToken(reportPayload);
    const raw = await decodeReplayEnvelope<ScenarioResultReplayPayload>(token, 'scenario_result_v1');
    expect(raw?.storyData).not.toHaveProperty('full_report');

    // Decode/normalize path must also drop it (defense-in-depth for already-embedded artifacts).
    const reEmbedded = await encodeReplayEnvelope('scenario_result_v1', reportPayload);
    const normalized = await decodeScenarioReplayToken(reEmbedded);
    expect(normalized?.storyData).not.toHaveProperty('full_report');
  });

  it('drops authority-backed runtime state when replay snapshot already carries authority', () => {
    expect(compactScenarioMetaForReplay(scenarioMeta, {
      stripDirectorAuthority: true,
      stripGameplayAuthority: true,
    })).toEqual({
      ...scenarioMeta,
      director: {
        maxPoints: 3,
        remainingPoints: 3,
        spentPoints: 0,
      },
      cooldowns: {},
      cards: {
        usageLog: [],
      },
      betting: {
        bets: [],
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [],
        keyMoments: ['Moment 1', 'event:card:2:public_hearing'],
      },
    });
  });

  it('builds a replay route url', async () => {
    const url = await buildScenarioReplayUrl('https://example.com/', replayPayload);
    expect(url).toContain('/result/replay?replay=');
  });

  it('rejects oversized scenario replay payloads before building a URL', async () => {
    const oversizedPayload: ScenarioResultReplayPayload = {
      ...replayPayload,
      storyData: {
        ...replayPayload.storyData,
        branches: Array.from({ length: 260 }, (_, index) => ({
          id: `branch-${index}`,
          title: `Branch ${index}`,
          probability: 1,
          status: 'COMPLETED',
          story: `story-${index}-${index.toString(36).repeat(4)}-${'abcdefghij'.repeat(4)}`,
          insight: `insight-${index}-${'klmnopqrst'.repeat(3)}`,
          key_moments: [`Moment ${index}`],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        })),
      },
    };

    await expect(
      buildScenarioReplayUrl('https://example.com/', oversizedPayload),
    ).rejects.toBeInstanceOf(ReplayTokenTooLargeError);
  });

  it('rejects malformed scenario replay payloads', async () => {
    const token = await encodeReplayEnvelope('scenario_result_v1', {
      ...replayPayload,
      storyData: {
        ...replayPayload.storyData,
        branches: [42],
      },
    });

    await expect(decodeScenarioReplayToken(token)).resolves.toBeNull();
  });

  it('normalizes replay artifacts whose embedded scenario branches miss result-only fields', () => {
    const normalized = normalizeScenarioResultReplayPayload({
      ...replayPayload,
      scenario: {
        ...replayPayload.scenario,
        branches: [{
          id: 'branch-1',
          parent_branch_id: null,
          fork_round: 0,
          fork_reason: '',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
        }],
      },
    });

    expect(normalized?.scenario.branches[0]).toMatchObject({
      summary: 'A durable insight.',
      story: 'A complete branch story.',
      insight: 'A durable insight.',
      key_moments: ['Moment 1'],
    });
  });

  it('accepts replay payloads whose embedded scenarios store total_rounds as null', () => {
    const normalized = normalizeScenarioResultReplayPayload({
      ...replayPayload,
      scenario: {
        ...replayPayload.scenario,
        total_rounds: null,
      },
    });

    expect(normalized?.scenario.total_rounds).toBeNull();
    expect(normalized?.storyData.branches).toHaveLength(1);
  });
});
