import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyStateQuickQuestions } from './EmptyStateQuickQuestions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('EmptyStateQuickQuestions', () => {
  it('renders 3 quick-question cards with testids', () => {
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={() => {}} />);
    expect(getByTestId('conversation-quick-q-1')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-2')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-3')).toBeTruthy();
  });

  it('invokes onSelect with card text', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={onSelect} />);
    await user.click(getByTestId('conversation-quick-q-1'));
    expect(onSelect).toHaveBeenCalledWith('conversation.empty_state.quick_q_1');
  });

  it('accepts agentName prop without changing visual behavior', () => {
    const { getByTestId } = render(
      <EmptyStateQuickQuestions onSelect={() => {}} agentName="Agent Alpha" />,
    );
    expect(getByTestId('conversation-quick-q-1')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-2')).toBeTruthy();
    expect(getByTestId('conversation-quick-q-3')).toBeTruthy();
  });

  it('each card has quick-question-card class hook', () => {
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={() => {}} />);
    for (let i = 1; i <= 3; i++) {
      expect(getByTestId(`conversation-quick-q-${i}`).classList.contains('quick-question-card')).toBe(true);
    }
  });

  it('each card contains an ArrowRight icon', () => {
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={() => {}} />);
    for (let i = 1; i <= 3; i++) {
      const svg = getByTestId(`conversation-quick-q-${i}`).querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('cards have conv-quick-q class for full-width + 44px min-height styling', () => {
    const { getByTestId } = render(<EmptyStateQuickQuestions onSelect={() => {}} />);
    const card = getByTestId('conversation-quick-q-1');
    expect(card.classList.contains('conv-quick-q')).toBe(true);
  });

  it('variant="result" renders result keys', () => {
    const { getByTestId } = render(
      <EmptyStateQuickQuestions onSelect={() => {}} variant="result" />,
    );
    expect(getByTestId('conversation-quick-q-1').textContent).toContain('conversation.empty_state.result_quick_q_1');
  });
});
