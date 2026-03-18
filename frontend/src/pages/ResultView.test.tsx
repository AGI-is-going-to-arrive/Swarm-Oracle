import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ScenarioMeta } from '../lib/scenarioMeta';
import ResultView from './ResultView';

const {
  finalizeCampaignMock,
  findChallengeProgressByScenarioIdMock,
  upsertScenarioDirectorStateMock,
  upsertScenarioGameplayStateMock,
} = vi.hoisted(() => ({
  finalizeCampaignMock: vi.fn(),
  findChallengeProgressByScenarioIdMock: vi.fn(),
  upsertScenarioDirectorStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
  upsertScenarioGameplayStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'home.campaign_mastery_level') {
        return `Lv.${options?.level}`;
      }
      if (key === 'home.campaign_next_unlock') {
        return `${options?.count} points to next unlock`;
      }
      if (key === 'result.archive_bet_miss') {
        return 'Bet Missed';
      }
      if (key === 'result.archive_resonance_aligned') {
        return 'Direction aligned';
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  getStory: vi.fn(async () => ({
    scenario_id: 'scenario-1',
    question: 'What if the archive had to sync?',
    status: 'done',
    branches: [{
      id: 'branch-1',
      title: 'Archive Branch',
      probability: 1,
      status: 'COMPLETED',
      story: 'A complete branch story.',
      insight: 'A durable insight.',
      key_moments: ['Moment 1'],
      parent_branch_id: null,
      fork_reason: '',
    }],
  })),
  getAgents: vi.fn(async () => [
    { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
  ]),
  getScenario: vi.fn(async () => ({
    id: 'scenario-1',
    question: 'What if the archive had to sync?',
    status: 'done',
    created_at: '2026-03-17T00:00:00Z',
    scene_theme: 'law_court',
    agents: [],
    branches: [],
    groups: [],
    hierarchical: false,
    director_state: {
      objectives: {
        generated_for_question: null,
        generated_for_profile: null,
        goals: [],
        last_updated_at: null,
      },
      commitment: {
        active: false,
        branch_id: null,
        branch_title: null,
        committed_at_round: null,
        committed_at: null,
        outcome: null,
      },
    },
  })),
  listPredictions: vi.fn(async () => []),
  exportScenario: vi.fn(async () => '# export'),
  scorePredictions: vi.fn(async () => ({ scored: 0 })),
  finalizeCampaign: finalizeCampaignMock,
  getCampaignScenarioSummary: vi.fn(async () => null),
  upsertScenarioDirectorState: upsertScenarioDirectorStateMock,
  upsertScenarioGameplayState: upsertScenarioGameplayStateMock,
}));

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({
    userId: 'director-1',
    userName: 'Local Director',
  }),
}));

vi.mock('../lib/dailyChallenge', () => ({
  findChallengeProgressByScenarioId: findChallengeProgressByScenarioIdMock,
  getTodayChallenge: () => ({ id: 'challenge-1' }),
  isChallengeScenario: () => false,
  getChallengeProgress: () => null,
  markChallengeCompleted: vi.fn(),
}));

vi.mock('../lib/scenarioMeta', () => {
  const meta: ScenarioMeta = {
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
      keyMoments: [],
      profileId: 'law',
      dominantBranchTitle: 'Archive Branch',
      dominantTone: 'order',
      mostUsedCard: null,
      bettingHit: null,
      archiveGrade: 'A',
      directorStyleTag: 'quiet_observer',
      profileResonance: 'aligned',
      counterplayCardCount: 0,
      lastCounterplayCard: null,
    },
  };
  return {
    loadScenarioMeta: vi.fn(() => meta),
    ensureScenarioObjectives: vi.fn(() => meta),
    updateArchive: vi.fn(() => meta),
    updateScenarioMeta: vi.fn((_scenarioId: string, updater: (current: ScenarioMeta) => ScenarioMeta) => updater(meta)),
  };
});

vi.mock('../lib/archiveSummary', () => ({
  buildArchiveSummary: vi.fn(() => ({
    dominantBranchTitle: 'Archive Branch',
    dominantTone: 'order',
    mostUsedCard: null,
    bettingHit: null,
    archiveGrade: 'A',
    directorStyleTag: 'quiet_observer',
    profileResonance: 'aligned',
    objectiveCompletedCount: 0,
    objectiveTotalCount: 0,
    commitmentOutcome: null,
    counterplayCardCount: 0,
    lastCounterplayCard: null,
  })),
  getDirectorStyleLabel: vi.fn(() => 'Quiet Observer'),
}));

vi.mock('../components/gameplayCards', () => ({
  getGameplayBadgeSrc: vi.fn(() => '/badge.png'),
  getGameplayCardDefinition: vi.fn((cardId: string) => (
    cardId === 'public_hearing'
      ? { labelZh: '公开听证', labelEn: 'Public Hearing' }
      : { labelZh: '卡牌', labelEn: 'Card' }
  )),
  getGameplayProfileLabel: vi.fn(() => 'Law'),
  getGameplayProfileSignatureHooks: vi.fn(() => ['Judicial review']),
  getGameplaySignatureArcState: vi.fn(() => null),
  getScenarioSystemTrackState: vi.fn(() => null),
  inferGameplayProfile: vi.fn(() => ({ id: 'law' })),
}));

vi.mock('../components/ShareModal', () => ({
  default: () => null,
}));

describe('ResultView campaign summary', () => {
  it('finalizes campaign progress and renders the summary block', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 5,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
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
      badges: [{
        id: 'badge-1',
        badge_id: 'archive_record',
        unlocked_at: '2026-03-17T00:00:00Z',
        source_profile_id: 'law',
        source_scenario_id: 'scenario-1',
      }],
      newly_unlocked_badges: [{
        id: 'badge-1',
        badge_id: 'archive_record',
        unlocked_at: '2026-03-17T00:00:00Z',
        source_profile_id: 'law',
        source_scenario_id: 'scenario-1',
      }],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(finalizeCampaignMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
        user_id: 'director-1',
        profile_id: 'law',
        archive_grade: 'A',
      }));
    });

    expect(await screen.findByText('result.campaign_title')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('Lv.2')).toBeInTheDocument();
    expect(screen.getByText('5 points to next unlock')).toBeInTheDocument();
    expect(screen.getByText('Archive Record')).toBeInTheDocument();
  });

  it('marks finalize requests as daily challenge runs when the scenario came from a stored challenge', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue({
      challengeDay: '2026-03-17',
      challengeId: 'challenge-1',
      progress: {
        challengeId: 'challenge-1',
        scenarioId: 'scenario-1',
        startedAt: '2026-03-17T00:00:00Z',
        completed: false,
        usedCards: [],
        betPlaced: false,
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 6,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 1,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 1,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 6,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 4,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(finalizeCampaignMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
        completed_daily_challenge: true,
      }));
    });
  });

  it('falls back to backend campaign scenario summary when local archive data is empty', async () => {
    const emptyMeta: ScenarioMeta = {
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
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
        keyMoments: [],
        profileId: undefined,
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'C',
        directorStyleTag: null,
        profileResonance: null,
      },
    };

    const { getCampaignScenarioSummary } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue(emptyMeta);
    vi.mocked(getCampaignScenarioSummary).mockResolvedValue({
      scenario_id: 'scenario-1',
      profile_id: 'law',
      archive_grade: 'A',
      profile_resonance: 'aligned',
      betting_hit: false,
      most_used_card: 'public_hearing',
        completed_daily_challenge: true,
        objective_completed_count: 1,
        objective_total_count: 2,
        commitment_outcome: 'miss',
        campaign_score_delta: 4,
        finalized_at: '2026-03-18T00:00:00Z',
      });
    finalizeCampaignMock.mockRejectedValue(new Error('API 409: already finalized elsewhere'));
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Public Hearing')).toBeInTheDocument();
    expect(screen.getByText('Bet Missed')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Direction aligned')).toBeInTheDocument();
    expect(screen.getByText('result.archive_daily_challenge')).toBeInTheDocument();
    expect(screen.getByText('Law · result.archive_completed')).toBeInTheDocument();
    expect(screen.queryByText('result.archive_director_points')).not.toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.archive_summary).toMatchObject({
        archive_grade: 'A',
        profile_id: 'law',
        profile_resonance: 'aligned',
        completed_daily_challenge: true,
        objective_completed_count: 1,
        objective_total_count: 2,
        commitment_outcome: 'miss',
      });
    });
  });

  it('prefers backend director state when local commitment is empty', async () => {
    const { getScenario } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue({
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
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
        keyMoments: [],
        profileId: 'law',
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'A',
        directorStyleTag: 'quiet_observer',
        profileResonance: 'aligned',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    });
    vi.mocked(getScenario).mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: {
        objectives: {
          generated_for_question: 'What if the archive had to sync?',
          generated_for_profile: 'law',
          goals: [
            {
              id: 'goal-1',
              kind: 'branch_commitment',
              target_card_id: null,
              reward_label: 'archive_grade',
              created_at: '2026-03-18T00:00:00Z',
            },
          ],
          last_updated_at: '2026-03-18T00:00:00Z',
        },
        commitment: {
          active: true,
          branch_id: 'branch-1',
          branch_title: 'Archive Branch',
          committed_at_round: 2,
          committed_at: '2026-03-18T00:02:00Z',
          outcome: 'pending',
        },
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 4,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 4,
        level: 1,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 5,
        score_to_next_level: 1,
      },
      badges: [],
      newly_unlocked_badges: [],
    });
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.archive_summary?.dominant_branch_title).toBe('Archive Branch');
    });

    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('Worldline Commitment')).toBeInTheDocument();
    expect(screen.getByText('No commitment')).toBeInTheDocument();
    expect(screen.getAllByText('Archive Branch').length).toBeGreaterThan(1);
  });
});
