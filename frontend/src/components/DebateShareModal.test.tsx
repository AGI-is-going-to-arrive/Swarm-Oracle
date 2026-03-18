import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebateShareModal } from './DebateShareModal';

let writeTextMock: ReturnType<typeof vi.fn>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('DebateShareModal automation callback', () => {
  beforeEach(() => {
    writeTextMock = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
        }}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    expect(screen.getByRole('button', { name: /📕\s*share\.platform_xiaohongshu/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /🔴\s*share\.platform_weibo/ }));
    expect(screen.getByText(/🔴 share\.platform_weibo · debate\.share_title/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'share.copy_btn' }));

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('debate_share_modal');
    expect(latestState.active_platform).toBe('weibo');
    expect(latestState.has_copy).toBe(true);
    expect(latestState.copy_length).toBeGreaterThan(0);
    expect(latestState.copied).toBe(true);
    expect(screen.getByText(/Quick hedge on Opposition at 60%/)).toBeInTheDocument();
    expect(screen.getByText(/Counterplay missed/)).toBeInTheDocument();
  });
});
