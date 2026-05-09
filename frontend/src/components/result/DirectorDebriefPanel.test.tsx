import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../i18n/locales/en.json';
import { DirectorDebriefPanel, type DirectorDebriefPanelProps } from './DirectorDebriefPanel';

function renderPanel(overrides: Partial<DirectorDebriefPanelProps> = {}) {
  const i18n = createInstance();
  i18n.init({
    lng: 'en',
    initImmediate: false,
    resources: { en },
    interpolation: { escapeValue: false },
  });

  const props: DirectorDebriefPanelProps = {
    campaignSummary: {
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 7,
      score_breakdown: [
        { id: 'completed_run', label_key: 'result.director_score_completed_run', points: 1, applied: true },
        { id: 'daily_challenge', label_key: 'result.director_score_daily_challenge', points: 1, applied: true },
        { id: 'profile_signature', label_key: 'result.director_score_profile_signature', points: 2, applied: true },
        { id: 'bet_placed', label_key: 'result.director_score_bet_placed', points: 1, applied: true },
        { id: 'bet_hit', label_key: 'result.director_score_bet_hit', points: 2, applied: true },
        { id: 'commitment_hit', label_key: 'result.director_score_commitment_hit', points: 1, applied: true },
      ],
      profile: {
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 4,
        completed_challenges: 1,
        total_bets: 3,
        hit_bets: 2,
        highest_archive_grade: 'S',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-02T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 2,
        challenge_completions: 1,
        signature_hits: 1,
        aligned_hits: 1,
        campaign_score: 17,
        level: 2,
        best_archive_grade: 'S',
        favorite_card_id: 'public_hearing',
        next_level_score: 20,
        score_to_next_level: 3,
      },
      badges: [],
      newly_unlocked_badges: [],
    },
    profileLabel: 'Law',
    scenarioQuestion: 'What if every treaty had to survive a public court review?',
    worldlineSummary: {
      title: 'Archive Branch',
      insight: 'The court review exposed the weak treaty before escalation.',
      comparisonTitles: ['Closed Door Branch'],
    },
    commitmentSummary: {
      active: true,
      branchTitle: 'Archive Branch',
      committedAtRound: 2,
      outcome: 'hit',
    },
    betHighlights: [{
      targetLabel: 'Archive Branch wins',
      confidence: 0.72,
      placedAtRound: 2,
      outcome: 'hit',
    }],
    momentHighlights: [
      {
        id: 'card-2-public_hearing',
        kind: 'card',
        label: 'Public Hearing',
        round: 2,
        detail: 'This intervention changed the branch trajectory.',
      },
      {
        id: 'bet-2-archive',
        kind: 'bet',
        label: 'Archive Branch wins',
        round: 2,
      },
    ],
    interventionSummary: {
      cardLabel: 'Public Hearing',
      branchTitle: 'Archive Branch',
      round: 2,
      directive: 'Force the treaty dispute into public evidence.',
    },
    profileHooks: ['Judicial review'],
    archiveGrade: 'S',
    profileResonance: 'signature',
    profileResonanceLabel: 'Signature hit',
    directorStyleLabel: 'Quiet Observer',
    objectiveCompletedCount: 2,
    objectiveTotalCount: 2,
    commitmentOutcome: 'hit',
    commitmentOutcomeLabel: 'Commitment hit',
    commitmentBranchTitle: 'Archive Branch',
    isDailyChallenge: true,
    betCount: 1,
    bettingHit: true,
    signatureArc: {
      label: 'Judicial Arc',
      completedSteps: 1,
      totalSteps: 3,
      completed: false,
      nextCardId: 'public_hearing',
      sequenceLabels: ['Public Hearing'],
    },
    systemTracks: {
      riskLabel: 'Risk',
      riskValue: 5,
      resourceLabel: 'Resources',
      resourceValue: 2,
      pressure: 'Critical',
      counterplayRecommended: true,
    },
    tacticalState: {
      label: 'Audit Pullback',
      note: 'Expose the record before pushing the next branch.',
      focusCards: ['public_hearing'],
    },
    newlyUnlockedBadges: [],
    dominantBranchTitle: 'Archive Branch',
    keyMoments: ['Agent conceded the hinge.'],
    notebookHref: '#result-director-notebook',
    analysisHref: '#result-bridge',
    conversationHref: '#result-conversation',
    ...overrides,
  };

  return render(
    <I18nextProvider i18n={i18n}>
      <DirectorDebriefPanel {...props} />
    </I18nextProvider>,
  );
}

describe('DirectorDebriefPanel', () => {
  it('turns campaign numbers into a score breakdown and next action', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Director Debrief' })).toBeInTheDocument();
    expect(screen.getByText('What if every treaty had to survive a public court review?')).toBeInTheDocument();
    expect(screen.getByText('The court review exposed the weak treaty before escalation.')).toBeInTheDocument();
    expect(screen.getByText('Backed Archive Branch wins')).toBeInTheDocument();
    expect(screen.getByText('Hit · 72% confidence · placed at R2.')).toBeInTheDocument();
    expect(screen.getByText('Force the treaty dispute into public evidence.')).toBeInTheDocument();
    expect(screen.getByText('This intervention changed the branch trajectory.')).toBeInTheDocument();
    expect(screen.getByText('+7')).toBeInTheDocument();
    expect(screen.getAllByText('Audit Pullback').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Recheck Archive Branch/ })).toHaveAttribute(
      'href',
      '#result-director-notebook',
    );
    expect(screen.getByText('Start with Intervention: Public Hearing.')).toBeInTheDocument();
    expect(screen.getByText('Next arc card: Public Hearing')).toBeInTheDocument();
    expect(screen.getByText('Worldline commitment held')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Risk reading 5 out of 6' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
    expect(screen.getByRole('meter', { name: 'Resources reading 2 out of 6' })).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
    expect(screen.getByText('Pressure is high or resources are low; inspect the hinge, then spend the next move on a counter card.')).toBeInTheDocument();
  });

  it('shows the defensive fallback when there is no tactical recommendation', () => {
    renderPanel({
      tacticalState: null,
      signatureArc: null,
      conversationHref: null,
      systemTracks: {
        riskLabel: 'Risk',
        riskValue: 1,
        resourceLabel: 'Resources',
        resourceValue: 4,
        pressure: 'Stable',
        counterplayRecommended: false,
      },
    });

    expect(screen.getByText('Use the branch tools first, then run another scenario in this profile with one explicit commitment.')).toBeInTheDocument();
    expect(screen.getByText('Live conversation is unavailable here; use the saved debrief and analysis links.')).toBeInTheDocument();
    expect(screen.getByText('Pressure is under control; inspect the hinge, then push the signature arc instead of defending first.')).toBeInTheDocument();
  });
});
