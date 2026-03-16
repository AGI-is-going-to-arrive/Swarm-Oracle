import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import PredictionModal from './PredictionModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../api/client', () => ({
  submitPrediction: vi.fn(),
}));

describe('PredictionModal automation callback', () => {
  it('reports text and confidence changes', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), '预测内容');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('prediction_modal');
    expect(latestState.text_length).toBe(4);
    expect(latestState.can_submit).toBe(true);
  });

  it('falls back to ending tone bets when no branch targets are available', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        branches={[]}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), '预测内容');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.bet_kind).toBe('ending_tone');
    expect(latestState.can_submit).toBe(true);
  });

  it('supports theme resonance bets as a new lightweight gameplay option', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'profile_resonance');
    await user.type(screen.getByLabelText('prediction.text_label'), '我押这局会精准命中题材核心。');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.bet_kind).toBe('profile_resonance');
    expect(latestState.profile_resonance).toBe('aligned');
    expect(latestState.can_submit).toBe(true);
  });
});
