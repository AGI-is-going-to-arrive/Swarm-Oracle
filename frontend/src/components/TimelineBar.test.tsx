import { render, screen } from '@testing-library/react';
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
});
