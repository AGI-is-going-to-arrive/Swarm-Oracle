import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { buildStructuredPredictionText } from '../../lib/predictionBetting';
import type { PredictionInfo } from '../../types';
import PredictionsSection from './PredictionsSection';
import {
  ResultContextProvider,
  type ResultViewContextValue,
} from './ResultContext';

function makeT(): TFunction {
  const translations: Record<string, string> = {
    'result.predictions_title': 'Predictions',
    'prediction.bet_kind_ending_tone': 'Ending tone',
    'prediction.reason.ending_hit': 'Ending tone matches "{{targetTone}}".',
    'prediction.outcome_hit': 'Hit',
  };
  return ((key: string, params?: Record<string, string>) => {
    let value = translations[key] ?? key;
    for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
      value = value.replaceAll(`{{${paramKey}}}`, paramValue);
    }
    return value;
  }) as TFunction;
}

function renderSection(predictions: PredictionInfo[]) {
  const value = {
    t: makeT(),
    isZh: false,
    predictions,
    hasUnscored: false,
    isReplayMode: false,
    handleScore: vi.fn(),
    scoring: false,
    scoreError: '',
  } as unknown as ResultViewContextValue;

  render(
    <ResultContextProvider value={value}>
      <PredictionsSection
        betOutcomeContext={{ dominantTone: 'order' }}
      />
    </ResultContextProvider>,
  );
}

describe('PredictionsSection', () => {
  it('renders settlement reasons with current locale labels from stable target ids', () => {
    renderSection([
      {
        id: 'pred-1',
        scenario_id: 'scenario-1',
        user_name: 'Director',
        prediction_text: buildStructuredPredictionText({
          kind: 'ending_tone',
          targetId: 'order',
          targetLabel: '秩序收束',
          rationale: 'Order will consolidate.',
          confidence: 0.8,
        }),
        confidence: 0.8,
        score: null,
        score_reason: null,
        created_at: '2026-05-17T00:00:00Z',
      },
    ]);

    expect(screen.getByText('Ending tone · Order Consolidation')).toBeInTheDocument();
    expect(screen.getByTestId('prediction-settlement-reason')).toHaveTextContent(
      'Ending tone matches "Order Consolidation".',
    );
  });
});
