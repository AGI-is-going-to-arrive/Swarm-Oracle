import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { intervene } from '../api/client';
import GameplayCardsModal from './GameplayCardsModal';
import type { AgentInfo, BranchInfo } from '../types';

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

const interveneMock = vi.mocked(intervene);

async function flushGameplayDerivedState(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const baseBranches: BranchInfo[] = [
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
];

const baseAgents: AgentInfo[] = [
  { id: 'a1', name: '顾星河', role: '算法治理理事会主席', tier: 'CORE', emotion: 'neutral' },
  { id: 'a2', name: '周凌云', role: '基层联盟代表', tier: 'CORE', emotion: 'neutral' },
];

function renderGameplayCardsModal(
  overrides: Partial<ComponentProps<typeof GameplayCardsModal>> = {},
) {
  const onClose = vi.fn();
  render(
    <GameplayCardsModal
      scenarioId="scenario-1"
      branches={baseBranches}
      agents={baseAgents}
      question="如果人工智能统治世界？"
      sceneTheme="scifi_base"
      {...overrides}
      onClose={onClose}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  interveneMock.mockReset();
});

describe('GameplayCardsModal preview mode', () => {
  it('shows warmup note and keeps apply action disabled in read-only preview', async () => {
    const user = userEvent.setup();

    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={baseBranches}
        agents={[]}
        question="如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？"
        sceneTheme="scifi_base"
        readOnly
        disabledReason="sim.warmup.cards_preview"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('sim.warmup.cards_preview')).toBeInTheDocument();

    const applyButton = screen.getByRole('button', { name: /gameplay\.preview_only_cta/ });
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
          branches={baseBranches}
          agents={[]}
          question="如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？"
          sceneTheme="scifi_base"
          onClose={() => {}}
        />,
      );

      const textarea = screen.getByRole('textbox', { name: 'gameplay.card_directive_aria' });
      expect(textarea).not.toHaveFocus();
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

describe('GameplayCardsModal dialog accessibility', () => {
  it('exposes modal dialog semantics and moves initial focus inside', async () => {
    renderGameplayCardsModal();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('associates rendered control labels with their selects', () => {
    renderGameplayCardsModal();

    const controls = document.querySelector<HTMLElement>('.gameplay-modal-v2__controls');
    expect(controls).not.toBeNull();
    const labels = Array.from((controls as HTMLElement).querySelectorAll('label'));
    expect(labels.map((label) => label.textContent)).toContain('gameplay.target_branch');

    labels.forEach((label) => {
      expect(label.htmlFor).not.toBe('');
      const control = document.getElementById(label.htmlFor);
      expect(control).toBeInstanceOf(HTMLSelectElement);
      expect(screen.getByLabelText(label.textContent ?? '')).toBe(control);
    });
  });

  it('keeps empty branch and agent control states accessible without submitting', async () => {
    const user = userEvent.setup();
    renderGameplayCardsModal({ branches: [], agents: [] });

    expect(screen.getByLabelText('gameplay.target_branch')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByText('gameplay.waiting_branches')).toBeInTheDocument();

    const submit = document.querySelector<HTMLButtonElement>('.gameplay-modal-v2__submit');
    expect(submit).not.toBeNull();
    await user.click(submit as HTMLButtonElement);

    expect(interveneMock).not.toHaveBeenCalled();
    expect(screen.getByText('gameplay.error_no_active_branch')).toBeInTheDocument();
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderGameplayCardsModal();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GameplayCardsModal Phase 2 redesign', () => {
  it('renders a Recommended section and groups for the remaining cards', () => {
    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={baseBranches}
        agents={baseAgents}
        question="如果人工智能统治世界？"
        sceneTheme="scifi_base"
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: 'gameplay.recommended_section_title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'gameplay.more_options_title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gameplay\.group_role_play_title/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gameplay\.group_worldline_distort_title/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gameplay\.group_crisis_dispatch_title/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gameplay\.group_counter_cool_title/ })).toBeInTheDocument();
  });

  it('expands a group when its toggle is pressed', async () => {
    const user = userEvent.setup();
    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={baseBranches}
        agents={baseAgents}
        question="如果人工智能统治世界？"
        sceneTheme="scifi_base"
        onClose={() => {}}
      />,
    );

    const counterToggle = screen.getByRole('button', { name: /gameplay\.group_counter_cool_title/ });
    expect(counterToggle).toHaveAttribute('aria-expanded', 'false');
    expect(counterToggle).not.toHaveAttribute('aria-controls');
    await user.click(counterToggle);
    expect(counterToggle).toHaveAttribute('aria-expanded', 'true');
    const controlsId = counterToggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId as string)).toBeInTheDocument();
  });

  it('renders the four card questions for each card in the recommended grid', () => {
    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={baseBranches}
        agents={baseAgents}
        question="如果人工智能统治世界？"
        sceneTheme="scifi_base"
        onClose={() => {}}
      />,
    );

    const heading = screen.getByRole('heading', { name: 'gameplay.recommended_section_title' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    const utils = within(section as HTMLElement);
    expect(utils.getAllByText('gameplay.card_question_action').length).toBeGreaterThan(0);
    expect(utils.getAllByText('gameplay.card_question_affected').length).toBeGreaterThan(0);
    expect(utils.getAllByText('gameplay.card_question_next_round').length).toBeGreaterThan(0);
    expect(utils.getAllByText('gameplay.card_question_why_now').length).toBeGreaterThan(0);
  });

  it('shows the preview line above the submit button', () => {
    render(
      <GameplayCardsModal
        scenarioId="scenario-1"
        branches={baseBranches}
        agents={baseAgents}
        question="如果人工智能统治世界？"
        sceneTheme="scifi_base"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('gameplay.card_preview_label')).toBeInTheDocument();
  });

  it('submits only the visible directive text to the intervention API', async () => {
    const user = userEvent.setup();
    interveneMock.mockResolvedValueOnce({
      status: 'queued',
      intervention_id: 'i1',
      branch_id: 'b1',
      round: 2,
      pending_count: 1,
      queued_ahead: 0,
      gameplay_state: null,
    });

    renderGameplayCardsModal({ currentRound: 2 });

    const textarea = screen.getByRole('textbox', { name: 'gameplay.card_directive_aria' });
    await flushGameplayDerivedState();
    fireEvent.change(textarea, { target: { value: '请召开公开问责听证' } });
    const submit = document.querySelector<HTMLButtonElement>('.gameplay-modal-v2__submit');
    expect(submit).not.toBeNull();
    await user.click(submit as HTMLButtonElement);

    await waitFor(() => expect(interveneMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('gameplay.toast_queued')).toBeInTheDocument();
    expect(screen.queryByText('gameplay.toast_applied')).not.toBeInTheDocument();
    expect(screen.getByText('intervention.queue_note_next')).toBeInTheDocument();
    const payload = interveneMock.mock.calls[0][1];
    expect(payload).toMatchObject({
      branch_id: 'b1',
      text: '请召开公开问责听证',
      directive: '请召开公开问责听证',
    });
    expect(payload.text).not.toContain('Director Override');
    expect(payload.text).not.toContain('prompt_lines');
  });
});
