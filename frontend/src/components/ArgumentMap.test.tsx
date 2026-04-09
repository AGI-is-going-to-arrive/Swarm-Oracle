/**
 * Phase C2 — ArgumentMap tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import { ArgumentMap } from './ArgumentMap';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ArgumentMap', () => {
  it('returns null when not visible', () => {
    const { container } = render(<ArgumentMap debateId="d1" visible={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows empty state when API returns no units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot_id: null, nodes: [], edges: [], units: [] }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('renders argument units grouped by type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'The economy will grow', turn_id: 't1' },
          { id: 'u2', type: 'rebuttal', status: 'rebutted', text: 'However inflation may rise', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const tree = await screen.findByRole('tree');
    expect(tree).toBeInTheDocument();
    expect(screen.getByText(/Claim/)).toBeInTheDocument();
    expect(screen.getByText(/Rebuttal/)).toBeInTheDocument();
    expect(screen.getByText(/standing/)).toBeInTheDocument();
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
});
