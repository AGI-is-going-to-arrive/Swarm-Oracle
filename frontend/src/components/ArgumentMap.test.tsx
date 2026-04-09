/**
 * Phase C2 — ArgumentMap tests (upgraded for @xyflow/react DAG)
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => (
    <div
      data-testid="reactflow"
      data-nodes={(props.nodes as unknown[])?.length}
      data-edges={(props.edges as unknown[])?.length}
    />
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

import { ArgumentMap, ArgumentStrengthMeter, type ArgumentUnit } from './ArgumentMap';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── ArgumentMap main component ──────────────────────────────

describe('ArgumentMap', () => {
  it('returns null when not visible', () => {
    const { container } = render(<ArgumentMap debateId="d1" visible={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows loading state while fetching', () => {
    // Never resolve the fetch to keep loading state
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(() => {}));
    render(<ArgumentMap debateId="d1" visible={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when API returns no units and no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot_id: null, nodes: [], edges: [], units: [] }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('renders ReactFlow component when data has units (fallback layout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Economy grows', turn_id: 't1' },
          { id: 'u2', type: 'rebuttal', status: 'rebutted', text: 'Inflation rises', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toBeInTheDocument();
    // Fallback layout: 2 units → 2 nodes, 0 edges
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('0');
  });

  it('renders ReactFlow with graph nodes and edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's2',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Supporting data', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Supporting data', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('1');
  });

  it('handles 501 gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 501,
      json: async () => ({}),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('handles network error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failed'));
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('renders legend with all type labels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    expect(screen.getByText('Claim')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('Rebuttal')).toBeInTheDocument();
    expect(screen.getByText('Counter')).toBeInTheDocument();
    expect(screen.getByText(/1 units/)).toBeInTheDocument();
  });

  it('renders screen reader fallback list with all units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Proof', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const srList = screen.getByRole('list', { name: 'Argument units list' });
    const items = within(srList).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('claim');
    expect(items[0].textContent).toContain('A claim');
    expect(items[0].textContent).toContain('standing');
  });

  it('renders aria-label on map container', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'X', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByLabelText('Debate argument map')).toBeInTheDocument();
  });
});

// ── ArgumentStrengthMeter ───────────────────────────────────

describe('ArgumentStrengthMeter', () => {
  it('returns null when units are empty', () => {
    const { container } = render(<ArgumentStrengthMeter units={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders correct color segments based on unit statuses', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
      { id: 'u2', type: 'claim', status: 'standing', text: '', turn_id: 't2' },
      { id: 'u3', type: 'rebuttal', status: 'rebutted', text: '', turn_id: 't3' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const meter = screen.getByRole('meter');
    expect(meter).toBeInTheDocument();
    expect(meter.getAttribute('aria-valuemax')).toBe('3');

    // Check segments are rendered via title attributes
    const standingSegment = screen.getByTitle(/Standing: 2\/3/);
    expect(standingSegment).toBeInTheDocument();
    expect(standingSegment).toHaveStyle({ background: '#2ecc71' });

    const rebuttedSegment = screen.getByTitle(/Rebutted: 1\/3/);
    expect(rebuttedSegment).toBeInTheDocument();
    expect(rebuttedSegment).toHaveStyle({ background: '#e74c3c' });
  });

  it('skips zero-count statuses', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'accepted', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const meter = screen.getByRole('meter');
    // Only 1 child segment (accepted)
    const segments = meter.children;
    expect(segments.length).toBe(1);
    expect(screen.getByTitle(/Accepted: 1\/1/)).toBeInTheDocument();
  });

  it('renders compact height when compact prop is true', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} compact />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveStyle({ height: '4px' });
  });
});
