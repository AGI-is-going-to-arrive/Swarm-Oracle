/**
 * Phase C — GraphNodeCard unit tests
 * Tests custom ReactFlow node rendering: icons, OKLCH cards,
 * tooltips, and dimmed state for neighbor highlight.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <div data-testid={`handle-${type}`} data-position={position} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

import * as Tooltip from '@radix-ui/react-tooltip';
import GraphNodeCard from './GraphNodeCard';

afterEach(cleanup);

function Wrapper({ children }: { children: React.ReactNode }) {
  return <Tooltip.Provider>{children}</Tooltip.Provider>;
}

const baseData = {
  label: 'Short label',
  fullLabel: 'Short label',
  iconName: 'Flag',
  bgColor: 'oklch(0.65 0.15 250)',
  borderColor: '#2ecc71',
  dimmed: false,
  tooltipDisabled: false,
  sourcePos: 'bottom',
  targetPos: 'top',
};

const makeProps = (overrides = {}) => ({
  id: 'n1',
  type: 'graphCard',
  data: { ...baseData, ...overrides },
  dragging: false,
  draggable: true,
  selectable: true,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  selected: false,
  deletable: false,
  parentId: undefined,
  sourcePosition: undefined,
  targetPosition: undefined,
});

describe('GraphNodeCard', () => {
  it('renders label text', () => {
    render(<GraphNodeCard {...makeProps()} />, { wrapper: Wrapper });
    expect(screen.getByText('Short label')).toBeInTheDocument();
  });

  it('renders lucide icon for known iconName', () => {
    render(<GraphNodeCard {...makeProps({ iconName: 'Flag' })} />, { wrapper: Wrapper });
    const svgs = document.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('does not render icon for unknown iconName', () => {
    render(<GraphNodeCard {...makeProps({ iconName: 'NonExistentIcon' })} />, { wrapper: Wrapper });
    expect(screen.getByText('Short label')).toBeInTheDocument();
  });

  it('applies OKLCH background color', () => {
    render(<GraphNodeCard {...makeProps()} />, { wrapper: Wrapper });
    const card = screen.getByRole('button', { name: 'Short label' });
    expect(card).toHaveStyle({ background: 'oklch(0.65 0.15 250)' });
  });

  it('applies border color from status on all four sides (longhand-only, no shorthand)', () => {
    // Longhands only: mixing the `border` shorthand with per-side longhands trips
    // React's dev-mode style conflict warning (see GraphNodeCard style comment).
    render(<GraphNodeCard {...makeProps({ borderColor: '#e74c3c' })} />, { wrapper: Wrapper });
    const card = screen.getByRole('button', { name: 'Short label' });
    expect(card).toHaveStyle({
      borderTop: '2px solid #e74c3c',
      borderRight: '2px solid #e74c3c',
      borderBottom: '2px solid #e74c3c',
      borderLeft: '2px solid #e74c3c',
    });
  });

  it('applies dimmed state (opacity + grayscale)', () => {
    render(<GraphNodeCard {...makeProps({ dimmed: true })} />, { wrapper: Wrapper });
    const card = screen.getByRole('button', { name: 'Short label' });
    expect(card).toHaveStyle({ opacity: '0.45', filter: 'saturate(0.72)' });
  });

  it('does not dim when dimmed=false', () => {
    render(<GraphNodeCard {...makeProps({ dimmed: false })} />, { wrapper: Wrapper });
    const card = screen.getByRole('button', { name: 'Short label' });
    expect(card).toHaveStyle({ opacity: '1' });
  });

  it('wraps truncated label in tooltip trigger', () => {
    const longLabel = 'A very long argument claim that gets truncated in the node card display...';
    render(
      <GraphNodeCard
        {...makeProps({
          label: longLabel.slice(0, 50) + '\u2026',
          fullLabel: longLabel,
          tooltipDisabled: false,
        })}
      />,
      { wrapper: Wrapper },
    );
    const trigger = screen.getByText(longLabel.slice(0, 50) + '\u2026');
    expect(trigger).toBeInTheDocument();
    // Radix Tooltip.Trigger adds data-state attribute
    expect(trigger.closest('[data-state]')).not.toBeNull();
  });

  it('does NOT wrap in tooltip when tooltipDisabled=true', () => {
    const longLabel = 'A very long argument claim that gets truncated in the node card display...';
    render(
      <GraphNodeCard
        {...makeProps({
          label: longLabel.slice(0, 50) + '\u2026',
          fullLabel: longLabel,
          tooltipDisabled: true,
        })}
      />,
      { wrapper: Wrapper },
    );
    const cardEl = screen.getByText(longLabel.slice(0, 50) + '\u2026');
    expect(cardEl.closest('[data-state]')).toBeNull();
  });

  it('does NOT wrap in tooltip when label is not truncated', () => {
    render(<GraphNodeCard {...makeProps({ label: 'Same', fullLabel: 'Same' })} />, { wrapper: Wrapper });
    const el = screen.getByText('Same');
    expect(el.closest('[data-state]')).toBeNull();
  });

  it('renders a focusable button for keyboard users', async () => {
    const user = userEvent.setup();
    render(<GraphNodeCard {...makeProps()} />, { wrapper: Wrapper });
    await user.tab();
    const button = screen.getByRole('button', { name: 'Short label' });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('type', 'button');
  });

  it('exposes stable data attributes for graph export serializers', () => {
    render(<GraphNodeCard {...makeProps()} />, { wrapper: Wrapper });
    const button = screen.getByRole('button', { name: 'Short label' });
    expect(button).toHaveAttribute('data-graph-node-card', 'true');
    expect(button).toHaveAttribute('data-graph-label', 'Short label');
    expect(button).toHaveAttribute('data-graph-full-label', 'Short label');
  });

  it('removes card transitions when reduced motion is requested', () => {
    render(<GraphNodeCard {...makeProps({ reduceMotion: true })} />, { wrapper: Wrapper });
    const card = screen.getByRole('button', { name: 'Short label' });
    expect(card).toHaveStyle({ transition: 'none' });
  });

  it('renders source and target handles', () => {
    render(<GraphNodeCard {...makeProps()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('handle-target')).toBeInTheDocument();
    expect(screen.getByTestId('handle-source')).toBeInTheDocument();
  });

  it('resolves handle positions from string data', () => {
    render(<GraphNodeCard {...makeProps({ sourcePos: 'right', targetPos: 'left' })} />, { wrapper: Wrapper });
    expect(screen.getByTestId('handle-target').dataset.position).toBe('left');
    expect(screen.getByTestId('handle-source').dataset.position).toBe('right');
  });
});
