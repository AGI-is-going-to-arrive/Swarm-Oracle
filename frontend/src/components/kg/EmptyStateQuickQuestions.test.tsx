/**
 * FE-3 — EmptyStateQuickQuestions tests.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyStateQuickQuestions } from './EmptyStateQuickQuestions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('EmptyStateQuickQuestions', () => {
  it('renders 3 quick-question pills with testids', () => {
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={() => {}} />);
    expect(getByTestId('conversation-quick-q-1')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-2')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-3')).toBeTruthy();
  });

  it('invokes onSelect with pill text', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={onSelect} />);
    await user.click(getByTestId('conversation-quick-q-1'));
    expect(onSelect).toHaveBeenCalledWith('conversation.empty_state.quick_q_1');
  });
});
