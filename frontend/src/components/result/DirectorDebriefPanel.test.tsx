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
    expect(screen.getByText('+7')).toBeInTheDocument();
    expect(screen.getByText('Audit Pullback')).toBeInTheDocument();
    expect(screen.getByText('Next arc card: Public Hearing')).toBeInTheDocument();
    expect(screen.getByText('Worldline commitment hit')).toBeInTheDocument();
    expect(screen.getByText('Pressure is high or resources are low; use a counter card before pushing the next branch harder.')).toBeInTheDocument();
  });

  it('shows the defensive fallback when there is no tactical recommendation', () => {
    renderPanel({
      tacticalState: null,
      signatureArc: null,
      systemTracks: {
        riskLabel: 'Risk',
        riskValue: 1,
        resourceLabel: 'Resources',
        resourceValue: 4,
        pressure: 'Stable',
        counterplayRecommended: false,
      },
    });

    expect(screen.getByText('Run another scenario in this profile to reveal a sharper tactical recommendation.')).toBeInTheDocument();
    expect(screen.getByText('Pressure is under control; push the signature arc instead of spending the next move on defense.')).toBeInTheDocument();
  });
});
