/**
 * FE-3 — DraftRestoredBanner tests.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DraftRestoredBanner } from './DraftRestoredBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('DraftRestoredBanner', () => {
  it('renders blue (restored) variant with discard CTA', () => {
    const { getByTestId, queryByRole } = render(
      <DraftRestoredBanner variant="restored" onDiscard={() => {}} />,
    );
    const banner = getByTestId('conversation-draft-restored');
    expect(banner.getAttribute('data-variant')).toBe('restored');
    expect(banner.textContent).toContain('conversation.draft.restored');
    expect(queryByRole('button')).not.toBeNull();
  });

  it('renders amber (unavailable) variant WITHOUT discard CTA', () => {
    const { getByTestId, queryByRole } = render(
      <DraftRestoredBanner variant="unavailable" />,
    );
    const banner = getByTestId('conversation-draft-unavailable');
    expect(banner.getAttribute('data-variant')).toBe('unavailable');
    expect(banner.textContent).toContain('conversation.draft.unavailable_safari');
    expect(queryByRole('button')).toBeNull();
  });

  it('invokes onDiscard on click', async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    const { getByRole } = render(<DraftRestoredBanner variant="restored" onDiscard={onDiscard} />);
    await user.click(getByRole('button'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('has role=status + aria-live=polite', () => {
    const { getByTestId } = render(<DraftRestoredBanner variant="restored" />);
    const banner = getByTestId('conversation-draft-restored');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });
});
