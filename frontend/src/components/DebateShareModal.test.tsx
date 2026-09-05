import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DebateShareModal } from './DebateShareModal';
import type { DebateShareContext } from '../lib/debateShare';

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn() }));
const shareContext: DebateShareContext = {
  motion: 'Motion',
  winnerLabel: 'Proposition',
  toneLabel: 'Order',
  bestArgument: 'Best argument',
  bestRebuttal: 'Best rebuttal',
  judgeSummary: 'Judge summary',
  propositionScore: 80,
  oppositionScore: 72,
};

vi.mock('../lib/copyText', () => ({ copyText: copyTextMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('DebateShareModal automation callback', () => {
  beforeEach(() => {
    copyTextMock.mockReset().mockResolvedValue(undefined);
  });

  it('reports platform and copy metadata and tracks copy state', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <DebateShareModal
        context={{
          motion: 'Motion',
          winnerLabel: 'Proposition',
          toneLabel: 'Order',
          counterplaySummary: 'Quick hedge on Opposition at 60%',
          counterplayOutcomeLabel: 'Counterplay missed',
          bestArgument: 'Best argument',
          bestRebuttal: 'Best rebuttal',
          judgeSummary: 'Judge summary',
          propositionScore: 80,
          oppositionScore: 72,
          supportingTurns: ['Crossfire · Proposition: The hinge landed here. This is why the verdict stopped feeling abstract.'],
          permalinkUrl: 'https://example.com/debate/replay/result?local=debate-local-1',
        }}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    expect(screen.getByRole('button', { name: /📕\s*share\.platform_xiaohongshu/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'debate.copy_local_copy_btn' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /🔴\s*share\.platform_weibo/ }));
    expect(screen.getByText(/🔴 share\.platform_weibo · debate\.share_title/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'share.copy_btn' }));

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('debate_share_modal');
    expect(latestState.active_platform).toBe('weibo');
    expect(latestState.has_copy).toBe(true);
    expect(latestState.copy_length).toBeGreaterThan(0);
    expect(latestState.copied).toBe(true);
    expect(latestState.permalink_url).toBe('https://example.com/debate/replay/result?local=debate-local-1');
    expect(screen.getByText(/Quick hedge on Opposition at 60%/)).toBeInTheDocument();
    expect(screen.getByText(/Counterplay missed/)).toBeInTheDocument();
    expect(screen.getByText(/Crossfire · Proposition: The hinge landed here/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.com\/debate\/replay\/result\?local=debate-local-1/)).toBeInTheDocument();
  });

  it('names the share dialog, contains focus, and restores the opener on Escape', async () => {
    const user = userEvent.setup();
    function ShareDialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open share</button>
          {open && <DebateShareModal context={shareContext} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<ShareDialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open share' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'debate.share_title' });
    const close = within(dialog).getAllByRole('button', { name: 'common.close' })[0];
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'share.copy_btn' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(opener).not.toHaveAttribute('inert');
  });

  it('serializes pending clipboard writes and shows a retryable copy failure', async () => {
    const user = userEvent.setup();
    let rejectCopy!: (reason: unknown) => void;
    copyTextMock.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectCopy = reject; }));
    const onClose = vi.fn();
    render(<DebateShareModal context={{ ...shareContext, permalinkUrl: 'https://example.com/debate/one' }} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    await user.dblClick(screen.getByRole('button', { name: 'share.copy_btn' }));
    expect(copyTextMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'share.copy_permalink_btn' })).toBeDisabled();
    expect(within(dialog).getAllByRole('button', { name: 'common.close' }).every((button) => button.hasAttribute('disabled'))).toBe(true);
    await user.keyboard('{Escape}');
    fireEvent.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => rejectCopy(new Error('clipboard unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('share.copy_error');
    await user.click(screen.getByRole('button', { name: 'share.copy_permalink_btn' }));
    expect(copyTextMock).toHaveBeenLastCalledWith('https://example.com/debate/one');
    expect(screen.getByRole('button', { name: 'share.permalink_copied' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not restore stale copy feedback after unmounting during a clipboard write', async () => {
    const user = userEvent.setup();
    let resolveCopy!: () => void;
    copyTextMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    const onAutomationStateChange = vi.fn();
    const view = render(<DebateShareModal context={shareContext} onClose={() => {}} onAutomationStateChange={onAutomationStateChange} />);
    await user.click(screen.getByRole('button', { name: 'share.copy_btn' }));
    view.unmount();
    const callsAfterUnmount = onAutomationStateChange.mock.calls.length;
    await act(async () => resolveCopy());
    expect(onAutomationStateChange).toHaveBeenCalledTimes(callsAfterUnmount);
    expect(onAutomationStateChange).toHaveBeenLastCalledWith(null);
  });
});
