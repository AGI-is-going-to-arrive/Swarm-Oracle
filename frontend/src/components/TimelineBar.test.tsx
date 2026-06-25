import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage, BranchInfo, Scenario } from '../types';
import { TimelineBar } from './TimelineBar';

const mockState = {
  status: 'done',
  thinkingAgents: [] as Array<{ agent_id: string; branch: string; round: number; agent: string }>,
  branches: [] as BranchInfo[],
  scenario: {
    id: 'scenario-1',
    question: 'Test question',
    status: 'done',
    created_at: '2026-03-15T00:00:00Z',
    total_rounds: 3,
    mode: 'blackboard' as const,
    agents: [],
    branches: [],
    groups: [],
    hierarchical: false,
  } as Scenario,
  currentRound: 3,
  simStartTime: 0,
  roundCompleteTimes: [] as number[],
  messages: [] as AgentMessage[],
  turnProgress: null as {
    branch_id: string;
    round: number;
    completed: number;
    total: number;
  } | null,
  activeRoundProgress: null as {
    round: number;
    active_branches: number;
  } | null,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

describe('TimelineBar replay controls', () => {
  beforeEach(() => {
    mockState.status = 'done';
    mockState.thinkingAgents = [];
    mockState.scenario = {
      ...mockState.scenario,
      status: 'done',
      total_rounds: 3,
      mode: 'blackboard',
    };
    mockState.currentRound = 3;
    mockState.turnProgress = null;
    mockState.activeRoundProgress = null;
    mockState.branches = [
      {
        id: 'root',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: 'Root',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'COMPLETED',
      },
      {
        id: 'b2',
        parent_branch_id: 'root',
        fork_round: 2,
        fork_reason: 'fork',
        title: 'Fork A',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.6,
        status: 'ACTIVE',
      },
      {
        id: 'b3',
        parent_branch_id: 'root',
        fork_round: 2,
        fork_reason: 'fork',
        title: 'Fork B',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.4,
        status: 'ACTIVE',
      },
    ];
    mockState.messages = [
      { agent: 'A', agent_id: 'a', message: 'm1', emotion: 'neutral', branch: 'root', round: 1 },
      { agent: 'A', agent_id: 'a', message: 'm2', emotion: 'neutral', branch: 'b2', round: 2 },
      { agent: 'B', agent_id: 'b', message: 'm3', emotion: 'neutral', branch: 'b3', round: 3 },
    ];
  });

  it('does not synthesize a 10-round ledger when total rounds are unknown', () => {
    mockState.status = 'simulating';
    mockState.scenario = {
      ...mockState.scenario,
      status: 'simulating',
      total_rounds: undefined,
    };
    mockState.currentRound = 1;

    const { container } = render(<TimelineBar stickyBanner />);

    expect(container.querySelector('.sim-progress-ledger__round')).toHaveTextContent('R1');
    expect(screen.queryByText('R1/10')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.sim-progress-ledger__tick')).toHaveLength(0);
  });

  it('keeps simulating status active when total rounds are unknown', () => {
    mockState.status = 'simulating';
    mockState.scenario = {
      ...mockState.scenario,
      status: 'simulating',
      total_rounds: undefined,
    };
    mockState.currentRound = 10;
    mockState.messages = [
      { agent: 'A', agent_id: 'a', message: 'm10', emotion: 'neutral', branch: 'root', round: 10 },
    ];

    const { container } = render(<TimelineBar />);
    const activeStage = container.querySelector('.stage--active');

    expect(activeStage).not.toBeNull();
    expect(activeStage?.textContent).toContain('sim.timeline.simulating');
    expect(activeStage?.textContent).not.toContain('sim.timeline.narrating');
    expect(screen.queryByText('R10/10')).not.toBeInTheDocument();
  });

  it('summarizes replay rounds with fork, result, and message metadata', () => {
    const { container } = render(
      <TimelineBar
        interactive
        selectedRound={2}
        roundMarkers={[
          { round: 1, isAvailable: true },
          {
            round: 2,
            isAvailable: true,
            forkCount: 2,
            cardCount: 1,
            betCount: 1,
            resultCount: 2,
            forkTitles: ['Fork A', 'Fork B'],
            cardSummaries: ['文明辩论'],
            betSummaries: ['押注主线'],
            resultSummaries: ['帝国长夜', '议会妥协'],
          },
          { round: 3, isAvailable: true },
        ]}
      />,
    );

    expect(screen.getByTitle('R2 · fork 2 · cards 1 · bets 1 · results 2')).toBeInTheDocument();
    expect(screen.getByText('R2')).toBeInTheDocument();
    expect(screen.getByText('sim.timeline.tooltip_forks：Fork A / Fork B')).toBeInTheDocument();
    expect(screen.getByText('sim.timeline.tooltip_cards：文明辩论')).toBeInTheDocument();
    expect(screen.getByText('sim.timeline.tooltip_bets：押注主线')).toBeInTheDocument();
    expect(screen.getByText('sim.timeline.tooltip_results：帝国长夜 / 议会妥协')).toBeInTheDocument();
    expect(container.querySelector('[data-marker-type="fork"]')).not.toBeNull();
    expect(container.querySelector('[data-marker-type="card"]')).not.toBeNull();
    expect(container.querySelector('[data-marker-type="bet"]')).not.toBeNull();
    expect(container.querySelector('[data-marker-type="result"]')).not.toBeNull();
  });

  it('renders interactive replay chips and reports round selection', async () => {
    const user = userEvent.setup();
    const onRoundSelect = vi.fn();

    render(
      <TimelineBar
        interactive
        selectedRound={2}
        roundMarkers={[
          { round: 1, isAvailable: true },
          { round: 2, isAvailable: true, forkCount: 2 },
          { round: 3, isAvailable: true },
        ]}
        onRoundSelect={onRoundSelect}
      />,
    );

    const round2 = screen.getByRole('button', { name: 'Jump to replay round 2' });
    const round3 = screen.getByRole('button', { name: 'Jump to replay round 3' });

    expect(round2).toHaveAttribute('aria-pressed', 'true');
    expect(round2).toHaveAttribute('title', 'R2 · fork 2');

    await user.click(round3);
    expect(onRoundSelect).toHaveBeenCalledWith(3);
  });

  it('promotes the active stage to narrating once the final round speech is finished', () => {
    mockState.status = 'simulating';
    mockState.currentRound = 3;
    mockState.thinkingAgents = [];

    const { container } = render(<TimelineBar />);
    const activeStage = container.querySelector('.stage--active');

    expect(activeStage).not.toBeNull();
    expect(activeStage?.textContent).toContain('sim.timeline.narrating');
    expect(screen.getByText('R3/3')).toBeInTheDocument();
    expect(screen.getAllByText('sim.timeline.narrating_progress')).toHaveLength(2);
  });

  it('does not fabricate ten replay round chips when total_rounds is unknown', () => {
    mockState.status = 'simulating';
    mockState.currentRound = 0;
    mockState.scenario = {
      ...mockState.scenario,
      total_rounds: undefined,
    };
    mockState.messages = [];

    render(<TimelineBar interactive />);

    expect(screen.queryByText('R10')).not.toBeInTheDocument();
    expect(screen.queryByText('R0/10')).not.toBeInTheDocument();
    expect(screen.getAllByText('sim.timeline.preparing').length).toBeGreaterThan(0);
  });

  it('renders slow simulating hint and turn progress details when slow or progress event arrives', () => {
    vi.useFakeTimers();
    try {
      mockState.status = 'simulating';
      mockState.currentRound = 1;
      mockState.activeRoundProgress = {
        round: 1,
        active_branches: 1,
      };
      mockState.scenario = {
        ...mockState.scenario,
        status: 'simulating',
        total_rounds: 3,
      };
      mockState.simStartTime = Date.now();
      mockState.roundCompleteTimes = [];
      mockState.turnProgress = {
        branch_id: 'root',
        round: 1,
        completed: 2,
        total: 5,
      };

      const { container, rerender } = render(<TimelineBar stickyBanner />);

      // At start, not slow, so no simulating_slow hint, but should show turn progress
      expect(container.querySelector('.sim-progress-ledger__turn-progress')).toHaveTextContent('sim.timeline.turn_progress_msg');
      expect(container.querySelector('.sim-progress-ledger__slow')).toBeNull();

      // Fast forward by 30 seconds to make it slow
      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      rerender(<TimelineBar stickyBanner />);

      expect(container.querySelector('.sim-progress-ledger__slow')).toHaveTextContent('sim.timeline.simulating_slow');
      expect(container.querySelector('.sim-progress-ledger__turn-progress')).toHaveTextContent('sim.timeline.turn_progress_msg');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows active turn progress before round_summary advances currentRound', () => {
    mockState.status = 'simulating';
    mockState.currentRound = 0;
    mockState.activeRoundProgress = {
      round: 1,
      active_branches: 1,
    };
    mockState.scenario = {
      ...mockState.scenario,
      status: 'simulating',
      total_rounds: 3,
    };
    mockState.turnProgress = {
      branch_id: 'root',
      round: 1,
      completed: 1,
      total: 5,
    };

    const { container } = render(<TimelineBar stickyBanner />);

    expect(container.querySelector('.sim-progress-ledger__round')).toHaveTextContent('R1/3');
    expect(container.querySelector('.sim-progress-ledger__turn-progress')).toHaveTextContent('sim.timeline.turn_progress_msg');
  });

  it('uses branch-scoped turn progress copy when multiple branches are active', () => {
    mockState.status = 'simulating';
    mockState.currentRound = 1;
    mockState.activeRoundProgress = {
      round: 2,
      active_branches: 2,
    };
    mockState.scenario = {
      ...mockState.scenario,
      status: 'simulating',
      total_rounds: 3,
    };
    mockState.turnProgress = {
      branch_id: 'b2',
      round: 2,
      completed: 1,
      total: 4,
    };

    const { container } = render(<TimelineBar stickyBanner />);

    expect(container.querySelector('.sim-progress-ledger__round')).toHaveTextContent('R2/3');
    expect(container.querySelector('.sim-progress-ledger__turn-progress')).toHaveTextContent('sim.timeline.turn_progress_branch_msg');
  });

  it('keeps theater soft stuck banners neutral after theater error overrides', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/SimulationView.css'), 'utf8');
    const theaterHardRule = css.indexOf('.simulation-view--theater .sim-error {');
    const theaterSoftRule = css.indexOf('.simulation-view--theater .sim-error--soft {');

    expect(theaterHardRule).toBeGreaterThanOrEqual(0);
    expect(theaterSoftRule).toBeGreaterThan(theaterHardRule);
    expect(css).toMatch(/\.simulation-view--theater \.sim-error--soft\s*\{[\s\S]*?background:\s*rgba\(88, 85, 79, 0\.07\);/);
    expect(css).toMatch(/\.simulation-view--theater \.sim-error--soft p\s*\{[\s\S]*?color:\s*#58554f;/);
  });
});
