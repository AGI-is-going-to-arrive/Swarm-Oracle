import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchInfo } from '../types';

const mockStore: {
  messages: unknown[];
  agents: unknown[];
  thinkingAgents: unknown[];
  status: 'idle' | 'parsing' | 'simulating' | 'narrating' | 'done' | 'error' | 'cancelled';
} = {
  messages: [],
  agents: [],
  thinkingAgents: [],
  status: 'done',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: () => mockStore,
}));

import BranchDetailModal from './BranchDetailModal';

const makeBranch = (status: BranchInfo['status']): BranchInfo => ({
  id: 'branch-1',
  parent_branch_id: null,
  fork_round: 0,
  fork_reason: '',
  title: 'Branch 1',
  summary: '',
  story: '',
  insight: '',
  key_moments: [],
  probability: 0.5,
  status,
});

describe('BranchDetailModal', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    mockStore.messages = [];
    mockStore.agents = [];
    mockStore.thinkingAgents = [];
    mockStore.status = 'done';
  });

  it('renders failure-terminal ACTIVE or reconciled PRUNED branches as interrupted', () => {
    mockStore.status = 'error';

    const { rerender } = render(<BranchDetailModal branch={makeBranch('PRUNED')} onClose={vi.fn()} />);

    expect(screen.getByText('sim.tree.status_interrupted')).toBeInTheDocument();
    expect(screen.queryByText('PRUNED')).not.toBeInTheDocument();

    rerender(<BranchDetailModal branch={makeBranch('ACTIVE')} onClose={vi.fn()} />);

    expect(screen.getByText('sim.tree.status_interrupted')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
  });

  it('keeps a normally completed PRUNED branch distinct from interruption', () => {
    mockStore.status = 'done';

    render(<BranchDetailModal branch={makeBranch('PRUNED')} onClose={vi.fn()} />);

    expect(screen.getByText('PRUNED')).toBeInTheDocument();
    expect(screen.queryByText('sim.tree.status_interrupted')).not.toBeInTheDocument();
  });

  it('provides a named modal keyboard contract and restores focus', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();

    const { unmount } = render(<BranchDetailModal branch={makeBranch('ACTIVE')} onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Branch 1' });
    const close = screen.getByRole('button', { name: 'common.close' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(close);

    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
