import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import EndingCardsGrid from './EndingCardsGrid';
import {
  ResultContextProvider,
  type ResultViewContextValue,
} from './ResultContext';

function makeT(): TFunction {
  const translations: Record<string, string> = {
    'result.ending_card': 'Ending',
    'result.probability': 'Probability',
    'result.branch_answer_label': 'Answer to Your Question',
    'ending_room.entry_cta': 'Enter chamber',
    'ending_room.one_move_cta': 'Change one move',
    'roundtable.gallery_title': 'Gallery',
  };
  return ((key: string, options?: Record<string, unknown>) => {
    const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    return translations[key] ?? fallback;
  }) as TFunction;
}

function renderGrid(branchQuestionAnswer: string | null, narrative?: string) {
  const value = {
    t: makeT(),
    branches: [
      {
        id: 'branch-a',
        title: 'Supply Chain Holds',
        probability: 0.72,
        insight: narrative ?? 'Ports stabilized before credit broke.',
        story: narrative ?? '',
        fork_reason: null,
        key_moments: narrative ? [narrative] : [],
        question_answer: branchQuestionAnswer,
      },
    ],
    expandedBranch: narrative ? 'branch-a' : null,
    setExpandedBranch: vi.fn(),
    handleOpenEndingRoom: vi.fn(),
    isReplayMode: false,
    scenario: { status: 'done' },
  } as unknown as ResultViewContextValue;

  render(
    <ResultContextProvider value={value}>
      <EndingCardsGrid />
    </ResultContextProvider>,
  );
}

describe('EndingCardsGrid', () => {
  it.each([
    ['**Evidence-limited hypothesis:**\nPreserved **wording**', 'Evidence-limited narrative hypothesis: Preserved **wording**'],
    ['**Unverified attribution:** Original words', 'Evidence-limited narrative hypothesis (unverified attribution): Original words'],
    ['**证据有限的假设：**\n保留原文', '证据有限的叙事假设：保留原文'],
    ['**归因未经验证：** 原文', '证据有限的叙事假设（归因未经验证）：原文'],
  ])('keeps a saved narrative notice readable in all plain-text fields: %s', (source, expected) => {
    renderGrid(source, source);
    expect(screen.getAllByText(expected)).toHaveLength(4);
    expect(screen.queryByText(source)).not.toBeInTheDocument();
  });
  it('renders the branch answer before the probability bar', () => {
    renderGrid('The ports carry the first visible pressure.');

    const answer = screen.getByTestId('ending-card-answer-branch-a');
    const card = answer.closest('.ending-card');
    const probability = card?.querySelector('.probability-section');

    expect(card).toBeInstanceOf(HTMLElement);
    expect(probability).toBeInstanceOf(HTMLElement);
    const childOrder = Array.from((card as HTMLElement).children);
    expect(childOrder.indexOf(answer)).toBeLessThan(
      childOrder.indexOf(probability as Element),
    );
  });

  it('does not render a focal answer block when the branch answer is blank', () => {
    renderGrid('   ');

    expect(screen.queryByTestId('ending-card-answer-branch-a')).not.toBeInTheDocument();
    expect(screen.getByText('Ports stabilized before credit broke.')).toBeInTheDocument();
  });
});
