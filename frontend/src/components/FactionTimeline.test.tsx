/**
 * Phase 3 F5 — FactionTimeline tests
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import { FactionTimeline } from './FactionTimeline';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FactionTimeline', () => {
  it('returns null when not visible', () => {
    const { container } = render(
      <FactionTimeline scenarioId="sc1" branchId="b1" visible={false} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows loading state while fetching', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(() => {}));
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when API returns empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);
    const msg = await screen.findByText(/No faction data/);
    expect(msg).toBeInTheDocument();
  });

  it('shows empty state when API returns 501', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 501,
      json: async () => ({}),
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);
    const msg = await screen.findByText(/No faction data/);
    expect(msg).toBeInTheDocument();
  });

  it('shows empty state on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failed'));
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);
    const msg = await screen.findByText(/No faction data/);
    expect(msg).toBeInTheDocument();
  });

  it('renders faction badges per round', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'hawks', label: 'War Hawks', members: ['a1', 'a2'], stance_center: 0.8, confidence: 0.9 },
            { key: 'doves', label: 'Peace Doves', members: ['a3'], stance_center: -0.6, confidence: 0.7 },
          ],
          events: [],
        },
        {
          round: 2,
          factions: [
            { key: 'hawks', label: 'War Hawks', members: ['a1', 'a2', 'a3'], stance_center: 0.5, confidence: 0.6 },
          ],
          events: [],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    // Wait for data to render
    await screen.findByText('Faction Timeline');

    // Round labels
    expect(screen.getByText('Round 1')).toBeInTheDocument();
    expect(screen.getByText('Round 2')).toBeInTheDocument();

    // Faction badges with member counts
    expect(screen.getByText('War Hawks (2)')).toBeInTheDocument();
    expect(screen.getByText('Peace Doves (1)')).toBeInTheDocument();
    expect(screen.getByText('War Hawks (3)')).toBeInTheDocument();

    // List structure
    const list = screen.getByRole('list', { name: 'Faction evolution timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
  });

  it('renders faction badge title with stance and member count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'moderates', label: 'Moderates', members: ['a1', 'a2'], stance_center: 0.123, confidence: 0.5 },
          ],
          events: [],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    const badge = await screen.findByTitle(/Moderates: 2 members, stance 0.12/);
    expect(badge).toBeInTheDocument();
  });

  it('shows betrayal event indicators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'f1', label: 'F1', members: ['a1'], stance_center: 0, confidence: 0.5 },
          ],
          events: [
            { event_type: 'betrayal', actor_agent_id: 'a1', faction_key: 'f1' },
          ],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    await screen.findByText('Faction Timeline');
    expect(screen.getByText(/betrayal/)).toBeInTheDocument();
  });

  it('shows alliance_formed event indicators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'f1', label: 'F1', members: ['a1', 'a2'], stance_center: 0.5, confidence: 0.8 },
          ],
          events: [
            { event_type: 'alliance_formed', actor_agent_id: 'a1', faction_key: 'f1' },
          ],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    await screen.findByText('Faction Timeline');
    expect(screen.getByText(/alliance formed/)).toBeInTheDocument();
  });

  it('shows multiple events separated by middle dot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'f1', label: 'F1', members: ['a1'], stance_center: 0, confidence: 0.5 },
          ],
          events: [
            { event_type: 'betrayal', actor_agent_id: 'a1', faction_key: 'f1' },
            { event_type: 'alliance_formed', actor_agent_id: 'a2', faction_key: 'f1' },
          ],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    await screen.findByText('Faction Timeline');
    // Both events visible
    expect(screen.getByText(/betrayal/)).toBeInTheDocument();
    expect(screen.getByText(/alliance formed/)).toBeInTheDocument();
  });

  it('uses null label fallback to faction key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          round: 1,
          factions: [
            { key: 'unlabeled_faction', label: null, members: ['a1'], stance_center: 0, confidence: 0.5 },
          ],
          events: [],
        },
      ],
    } as Response);
    render(<FactionTimeline scenarioId="sc1" branchId="b1" visible={true} />);

    // Falls back to key when label is null
    const badge = await screen.findByText('unlabeled_faction (1)');
    expect(badge).toBeInTheDocument();
  });

  it('passes correct URL with scenarioId and branchId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);
    render(<FactionTimeline scenarioId="sc-123" branchId="br-456" visible={true} />);

    await screen.findByText(/No faction data/);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/scenario/sc-123/faction-timeline?branch_id=br-456',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });
});
