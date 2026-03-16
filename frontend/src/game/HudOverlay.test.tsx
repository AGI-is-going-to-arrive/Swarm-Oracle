import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HudOverlay } from './HudOverlay';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('HudOverlay betting action', () => {
  it('opens prediction when the CTA is enabled', async () => {
    const user = userEvent.setup();
    const onOpenPrediction = vi.fn();

    render(
      <HudOverlay canPredict onOpenPrediction={onOpenPrediction}>
        <div>canvas</div>
      </HudOverlay>,
    );

    await user.click(screen.getByRole('button', { name: 'game.bet_action' }));
    expect(onOpenPrediction).toHaveBeenCalledTimes(1);
  });

  it('disables the CTA when prediction is locked', () => {
    render(
      <HudOverlay canPredict={false}>
        <div>canvas</div>
      </HudOverlay>,
    );

    expect(screen.getByRole('button', { name: 'game.bet_locked' })).toBeDisabled();
  });
});
