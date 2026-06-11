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
