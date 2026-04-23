/**
 * X-4 — Replay Import Empty State Verification
 *
 * Verifies that pre-Phase-3 replays (no graph/faction/argument data)
 * render correct empty states and do not crash.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

// ── ArgumentMap (DebateResultView renders this without replay gate) ──

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => (
    <div data-testid="reactflow" data-nodes={String((props.nodes as unknown[])?.length ?? 0)} />
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
}));

vi.mock('dagre', () => {
  const g = {
    setDefaultEdgeLabel: vi.fn(),
    setGraph: vi.fn(),
    setNode: vi.fn(),
    setEdge: vi.fn(),
    node: () => ({ x: 0, y: 0 }),
  };
  return {
    default: {
      graphlib: { Graph: vi.fn(() => g) },
      layout: vi.fn(),
    },
  };
});

import { ArgumentMap } from '../components/ArgumentMap';
import { FactionTimeline } from '../components/FactionTimeline';
import { FactionBadge } from '../components/FactionBadge';
import { MemoryTimeline } from '../components/MemoryTimeline';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('X-4: Phase 3 components with missing/empty data', () => {
  // ── ArgumentMap: simulates debate replay where API returns 404 ──
  describe('ArgumentMap (debate replay context)', () => {
    it('shows error tier when fetch returns 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ detail: 'Not found' }),
      } as Response);

      render(<ArgumentMap debateId="replay-id-123" visible={true} />);

      expect(
        await screen.findByText(/Data not found|not found/i),
      ).toBeInTheDocument();
    });

    it('shows error tier when fetch returns 501 (feature disabled)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 501,
        json: async () => ({}),
      } as Response);

      render(<ArgumentMap debateId="replay-id-456" visible={true} />);

      expect(
        await screen.findByText(/Feature not enabled|not enabled/i),
      ).toBeInTheDocument();
    });

    it('shows empty state when API returns empty units and nodes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snapshot_id: null,
          nodes: [],
          edges: [],
          units: [],
        }),
      } as Response);

      render(<ArgumentMap debateId="replay-id-789" visible={true} />);

      expect(
        await screen.findByText('No argument map available.'),
      ).toBeInTheDocument();
    });
  });

  // ── FactionTimeline: simulates result view with old scenario ──
  describe('FactionTimeline (pre-Phase3 scenario)', () => {
    it('shows empty state when API returns empty array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));

      render(
        <FactionTimeline scenarioId="old-scenario" branchId="b1" visible={true} />,
      );

      expect(
        await screen.findByText('Factions need a longer run to form alliances and splits. Try a deeper simulation to reveal their evolution.'),
      ).toBeInTheDocument();
    });

    it('shows a retryable error state when API returns 501', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ detail: 'Not enabled' }, 501));

      render(
        <FactionTimeline scenarioId="old-scenario" branchId="b1" visible={true} />,
      );

      expect(
        await screen.findByText('Unable to load the faction timeline right now. Please retry.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  // ── FactionBadge: no faction data for participant ──
  describe('FactionBadge (no faction assignment)', () => {
    it('renders nothing when faction is undefined', () => {
      const { container } = render(<FactionBadge faction={undefined} />);
      expect(container.innerHTML).toBe('');
    });
  });

  // ── MemoryTimeline: agent with no cross-scenario history ──
  describe('MemoryTimeline (empty history)', () => {
    it('shows empty state with no events or memories', () => {
      render(<MemoryTimeline events={[]} memories={[]} />);
      expect(screen.getByText('No history yet.')).toBeInTheDocument();
    });
  });

});
