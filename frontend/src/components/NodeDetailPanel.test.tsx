/**
 * P1-4 — NodeDetailPanel unit tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockT = vi.fn((key: string, fallback?: string) => fallback ?? key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => mockT(...(args as [string, string?])),
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import { NodeDetailPanel, type NodeDetail } from './NodeDetailPanel';

afterEach(() => { cleanup(); mockT.mockClear(); });

describe('NodeDetailPanel', () => {
  it('returns null when node is null', () => {
    const { container } = render(<NodeDetailPanel node={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders node label and type badge', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Trade shock announced',
      type: 'event',
      round: 1,
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Trade shock announced')).toBeInTheDocument();
    // i18n mock returns fallback (raw type string)
    expect(screen.getByText('event')).toBeInTheDocument();
    expect(screen.getByText(/Round.*1/)).toBeInTheDocument();
  });

  it('renders argument unit details when provided', () => {
    const node: NodeDetail = {
      id: 'u1',
      label: 'Economy will grow',
      type: 'claim',
      unitText: 'The economy will grow due to fiscal stimulus and consumer spending recovery.',
      unitStatus: 'standing',
      unitTurnId: 'turn-3',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // i18n mock returns fallback (raw type string)
    expect(screen.getByText('claim')).toBeInTheDocument();
    expect(screen.getByText('standing')).toBeInTheDocument();
    expect(screen.getByText(/fiscal stimulus/)).toBeInTheDocument();
    expect(screen.getByText(/Turn.*turn-3/)).toBeInTheDocument();
  });

  it('uses dark text on bright type badges for readability', () => {
    const node: NodeDetail = {
      id: 'n-bright',
      label: 'Verdict',
      type: 'verdict',
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('verdict')).toHaveStyle({ color: '#111' });
  });

  it('renders payload as JSON when present', () => {
    const node: NodeDetail = {
      id: 'n2',
      label: 'Policy change',
      type: 'intervention',
      payload: { action: 'rate_cut', magnitude: 0.25 },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // i18n mock returns 'Payload' fallback
    expect(screen.getByText('Payload')).toBeInTheDocument();
    expect(screen.getByText(/rate_cut/)).toBeInTheDocument();
  });

  it('does not render payload section when payload is null', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Test',
      type: 'event',
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText('Payload')).not.toBeInTheDocument();
  });

  it('does not render round when not provided', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Test',
      type: 'claim',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText(/Round/)).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const node: NodeDetail = { id: 'n1', label: 'Test', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={onClose} />);
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('turn label uses i18n key node_detail.turn (not hardcoded)', () => {
    const node: NodeDetail = {
      id: 'u1',
      label: 'Test',
      type: 'claim',
      unitTurnId: 'T-42',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // Verify t() was called with the i18n key for Turn
    expect(mockT).toHaveBeenCalledWith('node_detail.turn', 'Turn');
  });

  it('has node-detail-panel test id', () => {
    const node: NodeDetail = { id: 'n1', label: 'Test', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
  });
});
