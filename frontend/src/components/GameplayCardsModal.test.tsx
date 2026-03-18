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

    const applyButton = screen.getByRole('button', { name: '导演准备中' });
    expect(applyButton).toBeDisabled();

    await user.click(applyButton);
    expect(screen.getByText('sim.warmup.cards_preview')).toBeInTheDocument();
  });
});
