import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('clamps an unsupported preset target to the backend-supported options', async () => {
    const onAutomationStateChange = vi.fn();

    render(
      <DebateBetModal
        availableOptions={{
          winner: ['proposition'],
          verdict_tone: ['order'],
        }}
        initialSelection={{
          kind: 'winner',
          targetValue: 'opposition',
          confidence: 0.6,
        }}
        onClose={() => {}}
        onSubmit={vi.fn(async () => undefined)}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.selected_kind).toBe('winner');
    expect(latestState.selected_target).toBe('proposition');
    expect(latestState.target_options).toEqual(['proposition']);
    expect(screen.queryByRole('button', { name: 'debate.side_opposition' })).not.toBeInTheDocument();
  });

  it('maps structured API errors to localized debate bet messages', async () => {
    const user = userEvent.setup();

    render(
      <DebateBetModal
        onClose={() => {}}
        onSubmit={vi.fn(async () => {
          throw { status: 400, code: 'DEBATE_PREDICTIONS_LOCKED' };
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'debate.bet_submit' }));

    expect(await screen.findByText('debate.bet_error_locked')).toBeInTheDocument();
  });

  it('names the dialog, traps keyboard focus, and restores the opener on Escape', async () => {
    const user = userEvent.setup();
    function BetDialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open bet</button>
          {open && <DebateBetModal onClose={() => setOpen(false)} onSubmit={async () => undefined} />}
        </>
      );
    }
    render(<BetDialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open bet' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'debate.bet_title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'common.close' })).toHaveFocus();
    expect(opener).toHaveAttribute('inert');
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'debate.bet_submit' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'common.close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(opener).not.toHaveAttribute('inert');
  });

  it('prevents duplicate submissions and all close paths until the write settles', async () => {
    const user = userEvent.setup();
    let rejectSubmission!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectSubmission = reject; });
    const onSubmit = vi.fn(() => pending);
    const onClose = vi.fn();
    render(<DebateBetModal onClose={onClose} onSubmit={onSubmit} />);
    const dialog = screen.getByRole('dialog');
    await user.dblClick(screen.getByRole('button', { name: 'debate.bet_submit' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'common.close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
    expect(screen.getByLabelText('debate.bet_confidence')).toBeDisabled();
    await user.keyboard('{Escape}');
    fireEvent.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => rejectSubmission({ status: 400, code: 'DEBATE_PREDICTIONS_LOCKED' }));
    expect(screen.getByRole('alert')).toHaveTextContent('debate.bet_error_locked');
    expect(screen.getByRole('button', { name: 'debate.bet_submit' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves a draft when live snapshots refresh supported option objects', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const props = { onClose: () => {}, onSubmit };
    const view = render(<DebateBetModal {...props} availableOptions={{ winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance'] }} />);
    await user.click(screen.getByRole('button', { name: 'debate.bet_kind_tone' }));
    await user.click(screen.getByRole('button', { name: 'debate.tone_balance' }));
    fireEvent.change(screen.getByLabelText('debate.bet_confidence'), { target: { value: '0.9' } });

    view.rerender(<DebateBetModal {...props} availableOptions={{ winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance'] }} />);
    await user.click(screen.getByRole('button', { name: 'debate.bet_submit' }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'verdict_tone', targetValue: 'balance', confidence: 0.9 });
  });
});
