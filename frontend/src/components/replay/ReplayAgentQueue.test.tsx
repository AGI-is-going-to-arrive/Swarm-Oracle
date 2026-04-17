/**
 * FE-4 — ReplayAgentQueue tests
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayAgentQueue } from './ReplayAgentQueue';

afterEach(() => cleanup());

describe('ReplayAgentQueue', () => {
  const agents = [
    { id: 'a1', name: 'Alice' },
    { id: 'a2', name: 'Bob Williams' },
    { id: 'a3', name: 'Carol' },
  ];

  it('renders a queue item per agent with stable data-testid', () => {
    render(<ReplayAgentQueue agents={agents} />);
    expect(screen.getByTestId('replay-agent-queue-a1')).toBeInTheDocument();
    expect(screen.getByTestId('replay-agent-queue-a2')).toBeInTheDocument();
    expect(screen.getByTestId('replay-agent-queue-a3')).toBeInTheDocument();
  });

  it('marks the active agent with data-active="true" and aria-current', () => {
    render(<ReplayAgentQueue agents={agents} activeAgentId="a2" />);
    const active = screen.getByTestId('replay-agent-queue-a2');
    expect(active).toHaveAttribute('data-active', 'true');
    expect(active).toHaveAttribute('aria-current', 'true');
  });

  it('leaves non-active agents without aria-current', () => {
    render(<ReplayAgentQueue agents={agents} activeAgentId="a2" />);
    const other = screen.getByTestId('replay-agent-queue-a1');
    expect(other).toHaveAttribute('data-active', 'false');
    expect(other).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(<ReplayAgentQueue agents={agents} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('replay-agent-queue-a1'));
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('renders empty-state fallback text when agents list is empty', () => {
    render(<ReplayAgentQueue agents={[]} />);
    expect(screen.getByText('No agents recorded')).toBeInTheDocument();
  });

  it('derives initials for multi-word names', () => {
    render(<ReplayAgentQueue agents={[{ id: 'a', name: 'Jane Doe' }]} />);
    expect(screen.getByText('JD')).toBeInTheDocument();
  });
});
