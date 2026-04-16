import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PredictionModal from './PredictionModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  submitPrediction: vi.fn(),
  getSessionPrincipalSubject: vi.fn(() => null),
}));

describe('PredictionModal automation callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

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
    expect(screen.getByLabelText('prediction.bet_kind_label')).toHaveValue('ending_tone');
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

  it('renders english labels for structured bet targets when the UI language is english', async () => {
    const user = userEvent.setup();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'ending_tone');
    expect(screen.getByRole('option', { name: 'Order Consolidation' })).toBeInTheDocument();
    expect(
      screen.getByText((content) => (
        content.includes('prediction.bet_preview_prefix')
        && content.includes('Order Consolidation')
      )),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'profile_resonance');
    expect(screen.getByRole('option', { name: 'Direction Aligned' })).toBeInTheDocument();
    expect(
      screen.getByText((content) => (
        content.includes('prediction.bet_preview_prefix')
        && content.includes('Direction Aligned')
      )),
    ).toBeInTheDocument();
  });

  it('calls onPlacedBet with the updated gameplay meta after a successful submission', async () => {
    const user = userEvent.setup();
    const onPlacedBet = vi.fn();
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-1',
      scenario_id: 'scenario-1',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onPlacedBet={onPlacedBet}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), 'I think this branch will hold.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(onPlacedBet).toHaveBeenCalledTimes(1);
    expect(onPlacedBet.mock.calls[0][0].betting.bets).toHaveLength(1);
    expect(onPlacedBet.mock.calls[0][0].betting.bets[0].targetLabel).toBeTruthy();
  });

  it('releases the scenario meta lock after a successful submission', async () => {
    const user = userEvent.setup();
    const scenarioId = 'scenario-lock-cleanup';
    const lockKey = `swarmoracle:scenario-meta:v1:lock:${scenarioId}`;
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-2',
      scenario_id: scenarioId,
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId={scenarioId}
        onClose={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), 'I think this branch will hold.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalled();
    expect(window.localStorage.getItem(lockKey)).toBeNull();
  });
});
