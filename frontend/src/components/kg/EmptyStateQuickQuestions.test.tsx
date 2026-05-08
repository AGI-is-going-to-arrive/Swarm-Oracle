import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyStateQuickQuestions } from './EmptyStateQuickQuestions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, options?: Record<string, unknown>) => {
      const template = typeof options?.defaultValue === 'string' ? options.defaultValue : k;
      return template.replace(/\{\{(\w+)\}\}/g, (_match: string, token: string) => (
        options?.[token] == null ? `{{${token}}}` : String(options[token])
      ));
    },
    i18n: { resolvedLanguage: 'en', language: 'en' },
  }),
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
    expect(onSelect).toHaveBeenCalledWith('Why did this happen?');
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
    expect(getByTestId('conversation-quick-q-1').textContent).toContain('What drove this ending?');
  });

  it('builds result questions from the selected ending context', () => {
    const { getByTestId, getByText } = render(
      <EmptyStateQuickQuestions
        onSelect={() => {}}
        variant="result"
        origin={{
          surface: 'result',
          nodeType: 'outcome',
          nodeLabel: 'Archive Branch',
          causeContext: ['The archive branch avoided a late fork'],
          relatedContext: ['Counter Branch'],
        }}
      />,
    );

    expect(getByText('Ask about "Archive Branch"')).toBeInTheDocument();
    expect(getByTestId('conversation-quick-q-1')).toHaveTextContent(
      'Why did "Archive Branch" become the landing point?',
    );
    expect(getByTestId('conversation-quick-q-2')).toHaveTextContent(
      'Which earlier turn pushed the story this way?',
    );
    expect(getByTestId('conversation-quick-q-3')).toHaveTextContent(
      'What really separates it from "Counter Branch"?',
    );
  });

  it('builds causal event questions from speaker, cause, and effect context', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = render(
      <EmptyStateQuickQuestions
        onSelect={onSelect}
        origin={{
          surface: 'causal',
          nodeType: 'event',
          nodeLabel: 'Zhuge Liang: Hanzhong grain road slows',
          agentName: 'Zhuge Liang',
          causeContext: ['Liu Shan delays the transfer'],
          effectContext: ['The northern campaign stalls'],
        }}
      />,
    );

    expect(getByTestId('conversation-quick-q-1').textContent).toContain(
      'What is Zhuge Liang really worried about here?',
    );
    expect(getByTestId('conversation-quick-q-2').textContent).toContain(
      'Which earlier move pushed this moment into place?',
    );
    expect(getByTestId('conversation-quick-q-3').textContent).toContain(
      'Where does this moment push the story next?',
    );

    await user.click(getByTestId('conversation-quick-q-1'));
    expect(onSelect).toHaveBeenCalledWith(
      'What is Zhuge Liang really worried about here?',
    );
  });

  it('builds knowledge graph questions instead of causal templates', () => {
    const { getByTestId } = render(
      <EmptyStateQuickQuestions
        onSelect={() => {}}
        origin={{
          surface: 'knowledge',
          nodeType: 'event',
          nodeLabel: 'Hanzhong supply line',
        }}
      />,
    );

    expect(getByTestId('conversation-quick-q-1').textContent).toContain(
      'Which nodes are closest to "Hanzhong supply line"?',
    );
    expect(getByTestId('conversation-quick-q-3').textContent).toContain(
      'If I follow "Hanzhong supply line", what should I read next?',
    );
  });

  it('builds verdict graph questions for argument nodes', () => {
    const { getByTestId } = render(
      <EmptyStateQuickQuestions
        onSelect={() => {}}
        origin={{
          surface: 'argument',
          nodeType: 'verdict',
          nodeLabel: 'Judge accepts the supply claim',
        }}
      />,
    );

    expect(getByTestId('conversation-quick-q-1').textContent).toContain(
      'Why did the verdict land on "Judge accepts the supply claim"?',
    );
    expect(getByTestId('conversation-quick-q-2').textContent).toContain(
      'Which claim or evidence carried the most weight?',
    );
  });
});
