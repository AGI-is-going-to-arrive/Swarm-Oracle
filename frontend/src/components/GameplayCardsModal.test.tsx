import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import GameplayCardsModal from './GameplayCardsModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../api/client', () => ({
  intervene: vi.fn(),
  upsertScenarioGameplayState: vi.fn(),
}));

vi.mock('../game', () => ({
  dispatchVizEvent: vi.fn(),
}));

describe('GameplayCardsModal preview mode', () => {
  it('shows warmup note and keeps apply action disabled in read-only preview', async () => {
    const user = userEvent.setup();

    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={[
          {
            id: 'b1',
            parent_branch_id: null,
            fork_round: 0,
            fork_reason: '',
            title: '主权否决优先',
            summary: '',
            story: '',
            insight: '',
            key_moments: [],
            probability: 1,
            status: 'ACTIVE',
          },
        ]}
        agents={[]}
        question="如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？"
        sceneTheme="scifi_base"
        readOnly
        disabledReason="sim.warmup.cards_preview"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('sim.warmup.cards_preview')).toBeInTheDocument();

    const applyButton = screen.getByRole('button', { name: 'gameplay.preview_only_cta' });
    expect(applyButton).toBeDisabled();

    await user.click(applyButton);
    expect(screen.getByText('sim.warmup.cards_preview')).toBeInTheDocument();
  });

  it('does not autofocus the directive textarea on mobile or coarse pointer devices', () => {
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalMatchMedia = window.matchMedia;

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: fine)' ? false : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    try {
      render(
        <GameplayCardsModal
          scenarioId="scenario-1"
          branches={[
            {
              id: 'b1',
              parent_branch_id: null,
              fork_round: 0,
              fork_reason: '',
              title: '主权否决优先',
              summary: '',
              story: '',
              insight: '',
              key_moments: [],
              probability: 1,
              status: 'ACTIVE',
            },
          ]}
          agents={[]}
          question="如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？"
          sceneTheme="scifi_base"
          onClose={() => {}}
        />,
      );

      expect(screen.getByRole('textbox', { name: '玩法卡指令' })).not.toHaveFocus();
    } finally {
      if (innerWidthDescriptor) {
        Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
      }
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
