import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const mockT = vi.fn((key: string, fallback?: string) => fallback ?? key);
  const mockUseReducedMotion = vi.fn(() => false);
  return { mockT, mockUseReducedMotion };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => hoisted.mockT(...(args as [string, string?])),
    i18n: { changeLanguage: () => {}, language: 'en' },
  }),
}));

vi.mock('../../hooks/useReducedMotion', () => ({
  default: () => hoisted.mockUseReducedMotion(),
}));

import { NodeQuickCard, type NodeQuickCardProps } from './NodeQuickCard';

function makeProps(overrides?: Partial<NodeQuickCardProps>): NodeQuickCardProps {
  return {
    node: { id: 'n1', label: 'Test Node', type: 'event', round: 5 },
    position: { x: 100, y: 100 },
    onOpenDetail: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NodeQuickCard', () => {
  it('renders label, type badge, and round', () => {
    render(<NodeQuickCard {...makeProps()} />);
    expect(screen.getByText('Test Node')).toBeTruthy();
    expect(screen.getByTestId('type-badge').textContent).toBe('event');
    expect(screen.getByTestId('round-info').textContent).toContain('5');
  });

  it('does not render round when round is null', () => {
    render(<NodeQuickCard {...makeProps({ node: { id: 'n2', label: 'X', type: 'claim', round: null } })} />);
    expect(screen.queryByTestId('round-info')).toBeNull();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    render(<NodeQuickCard {...makeProps({ onClose })} />);
    const closeBtn = screen.getByLabelText('Close');
    await userEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onOpenDetail when detail button is clicked', async () => {
    const onOpenDetail = vi.fn();
    render(<NodeQuickCard {...makeProps({ onOpenDetail })} />);
    const detailBtn = screen.getByText('View details');
    await userEvent.click(detailBtn);
    expect(onOpenDetail).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape key', async () => {
    const onClose = vi.fn();
    render(<NodeQuickCard {...makeProps({ onClose })} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('clamps to the left when position exceeds viewport right edge', () => {
    render(
      <NodeQuickCard
        {...makeProps({
          position: { x: 500, y: 100 },
          viewportSize: { width: 600, height: 800 },
        })}
      />,
    );
    const card = screen.getByTestId('node-quick-card');
    const left = parseInt(card.style.left, 10);
    expect(left).toBe(500 - 240 - 12);
  });

  it('clamps upward when position exceeds viewport bottom edge', () => {
    render(
      <NodeQuickCard
        {...makeProps({
          position: { x: 100, y: 750 },
          viewportSize: { width: 1000, height: 800 },
        })}
      />,
    );
    const card = screen.getByTestId('node-quick-card');
    const top = parseInt(card.style.top, 10);
    expect(top).toBe(750 - 120 - 12);
  });

  it('has role="dialog", aria-labelledby, and aria-modal="false"', () => {
    render(<NodeQuickCard {...makeProps()} />);
    const card = screen.getByTestId('node-quick-card');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('false');
    const labelId = card.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId!);
    expect(label?.textContent).toBe('Test Node');
  });

  it('auto-focuses the close button on mount', () => {
    render(<NodeQuickCard {...makeProps()} />);
    const closeBtn = screen.getByLabelText('Close');
    expect(document.activeElement).toBe(closeBtn);
  });

  it('uses NODE_TYPE_COLORS_HEX for the type badge background', () => {
    render(<NodeQuickCard {...makeProps()} />);
    const badge = screen.getByTestId('type-badge');
    expect(badge.dataset.color).toBe('#4a90d9');
  });

  it('uses fallback color for unknown node type', () => {
    render(
      <NodeQuickCard
        {...makeProps({ node: { id: 'n3', label: 'Unknown', type: 'mystery', round: null } })}
      />,
    );
    const badge = screen.getByTestId('type-badge');
    expect(badge.dataset.color).toBe('#888');
  });

  it('clamps left/top to >= CLAMP_GAP when position is negative', () => {
    render(
      <NodeQuickCard
        {...makeProps({
          position: { x: -50, y: -30 },
          viewportSize: { width: 1000, height: 800 },
        })}
      />,
    );
    const card = screen.getByTestId('node-quick-card');
    const left = parseInt(card.style.left, 10);
    const top = parseInt(card.style.top, 10);
    expect(left).toBe(12);
    expect(top).toBe(12);
  });

  it('uses kg-quickcard class so editorial token styles apply', () => {
    render(
      <NodeQuickCard
        node={{ id: 'n1', label: 'X', type: 'event', round: 1 }}
        position={{ x: 50, y: 50 }}
        viewportSize={{ width: 600, height: 400 }}
        onOpenDetail={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const card = screen.getByTestId('node-quick-card');
    expect(card.className).toContain('kg-quickcard');
  });

  it('type badge uses kg-quickcard-type class', () => {
    render(
      <NodeQuickCard
        node={{ id: 'n1', label: 'X', type: 'event', round: 1 }}
        position={{ x: 50, y: 50 }}
        viewportSize={{ width: 600, height: 400 }}
        onOpenDetail={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('type-badge');
    expect(badge.className).toContain('kg-quickcard-type');
  });

  it('detail button uses kg-quickcard-detail-btn class', () => {
    render(
      <NodeQuickCard
        node={{ id: 'n1', label: 'X', type: 'event', round: 1 }}
        position={{ x: 50, y: 50 }}
        viewportSize={{ width: 600, height: 400 }}
        onOpenDetail={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const detailBtn = screen.getByText(/View details/);
    expect(detailBtn.className).toContain('kg-quickcard-detail-btn');
  });

  it('close button uses kg-quickcard-close class', () => {
    render(
      <NodeQuickCard
        node={{ id: 'n1', label: 'X', type: 'event', round: 1 }}
        position={{ x: 50, y: 50 }}
        viewportSize={{ width: 600, height: 400 }}
        onOpenDetail={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const closeBtn = screen.getByLabelText('Close');
    expect(closeBtn.className).toContain('kg-quickcard-close');
  });

  it('clamps left to >= CLAMP_GAP after right-edge flip yields negative left', () => {
    render(
      <NodeQuickCard
        {...makeProps({
          position: { x: 100, y: 100 },
          viewportSize: { width: 200, height: 800 },
        })}
      />,
    );
    const card = screen.getByTestId('node-quick-card');
    const left = parseInt(card.style.left, 10);
    expect(left).toBe(12);
  });

  it('disables entry animation when prefers-reduced-motion is true', () => {
    hoisted.mockUseReducedMotion.mockReturnValueOnce(true);
    render(<NodeQuickCard {...makeProps()} />);
    const card = screen.getByTestId('node-quick-card');
    expect(card.style.animation).toBe('none');
  });

  it('leaves animation default (CSS-driven) when reduced motion is disabled', () => {
    hoisted.mockUseReducedMotion.mockReturnValueOnce(false);
    render(<NodeQuickCard {...makeProps()} />);
    const card = screen.getByTestId('node-quick-card');
    // No inline animation override; CSS @keyframes / @media (prefers-reduced-motion)
    // gate handles the actual animation.
    expect(card.style.animation).toBe('');
  });

  it('localizes the round label via i18n (node_detail.round)', () => {
    render(<NodeQuickCard {...makeProps()} />);
    expect(hoisted.mockT).toHaveBeenCalledWith('node_detail.round', 'Round');
  });
});
