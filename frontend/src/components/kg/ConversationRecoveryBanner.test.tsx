/**
 * FE-3 — ConversationRecoveryBanner tests.
 *
 * Covers all 6 recovery codes + retry/discard wiring.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConversationRecoveryBanner } from './ConversationRecoveryBanner';
import type { RecoveryCode } from '../../lib/conversationStateMachine';

// Minimal i18n mock — returns the key as the translation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const ALL_CODES: RecoveryCode[] = [
  'rate_limit',
  'quota_exceeded',
  'network',
  'ws_lost',
  'byok_invalid',
  'server_error',
];

describe('ConversationRecoveryBanner', () => {
  for (const code of ALL_CODES) {
    it(`renders for ${code}`, () => {
      const { getByTestId } = render(<ConversationRecoveryBanner code={code} />);
      const banner = getByTestId('conversation-recovery-banner');
      expect(banner).toBeTruthy();
      expect(banner.getAttribute('data-code')).toBe(code);
      expect(banner.textContent).toContain(`conversation.error.${code}`);
    });
  }

  it('hides retry button when onRetry is omitted', () => {
    const { queryByTestId } = render(<ConversationRecoveryBanner code="network" />);
    expect(queryByTestId('conversation-retry')).toBeNull();
    expect(queryByTestId('conversation-discard')).toBeNull();
  });

  it('invokes onRetry when retry button clicked', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = render(<ConversationRecoveryBanner code="network" onRetry={onRetry} />);
    await user.click(getByTestId('conversation-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('invokes onDiscard when discard button clicked', async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = render(<ConversationRecoveryBanner code="ws_lost" onDiscard={onDiscard} />);
    await user.click(getByTestId('conversation-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('renders custom message override when provided', () => {
    const { getByTestId } = render(
      <ConversationRecoveryBanner code="network" message="Manual override" />,
    );
    expect(getByTestId('conversation-recovery-banner').textContent).toContain('Manual override');
  });

  it('has role=alert + aria-live=assertive', () => {
    const { getByTestId } = render(<ConversationRecoveryBanner code="server_error" />);
    const banner = getByTestId('conversation-recovery-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
  });
});
