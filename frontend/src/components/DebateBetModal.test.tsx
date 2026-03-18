import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DebateBetModal } from './DebateBetModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('DebateBetModal automation callback', () => {
  it('reports selected kind, target, and confidence changes', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <DebateBetModal
        onClose={() => {}}
        onSubmit={vi.fn(async () => undefined)}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'debate.bet_kind_tone' }));
    await user.click(screen.getByRole('button', { name: 'debate.tone_balance' }));
    fireEvent.change(screen.getByLabelText('debate.bet_confidence'), { target: { value: '0.9' } });

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('debate_bet_modal');
    expect(latestState.selected_kind).toBe('verdict_tone');
    expect(latestState.selected_target).toBe('balance');
    expect(latestState.confidence_percent).toBeGreaterThan(0);
    expect(screen.getByText('debate.bet_kind_tone_hint')).toBeInTheDocument();
  });

  it('applies an incoming preset selection and exposes it in automation state', async () => {
    const onAutomationStateChange = vi.fn();

    render(
      <DebateBetModal
        initialSelection={{
          kind: 'verdict_tone',
          targetValue: 'balance',
          confidence: 0.6,
        }}
        strategyHint="counterplay hint"
        onClose={() => {}}
        onSubmit={vi.fn(async () => undefined)}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    expect(screen.getByText('counterplay hint')).toBeInTheDocument();

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.selected_kind).toBe('verdict_tone');
    expect(latestState.selected_target).toBe('balance');
    expect(latestState.preset_kind).toBe('verdict_tone');
    expect(latestState.preset_target).toBe('balance');
  });
});
