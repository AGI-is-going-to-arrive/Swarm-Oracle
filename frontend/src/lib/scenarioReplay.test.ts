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
  decodeScenarioReplayToken,
  encodeScenarioReplayToken,
  type ScenarioResultReplayPayload,
} from './scenarioReplay';

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
    },
  ],
};

const agents: AgentInfo[] = [
  { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
];

const predictions: PredictionInfo[] = [];

const scenarioMeta: ScenarioMeta = {
  director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
  cooldowns: {},
  cards: { usageLog: [] },
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
  it('round-trips a scenario result replay token', async () => {
    const token = await encodeScenarioReplayToken(replayPayload);
    await expect(decodeScenarioReplayToken(token)).resolves.toEqual(replayPayload);
  });

  it('builds a replay route url', async () => {
    const url = await buildScenarioReplayUrl('https://example.com/', replayPayload);
    expect(url).toContain('/result/replay?replay=');
  });
});
