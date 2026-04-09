/**
 * P1-8 — FactionBadge tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ParticipantFaction } from '../hooks/useFactionOverlay';
import { FactionBadge } from './FactionBadge';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FactionBadge', () => {
  it('renders nothing when faction is undefined', () => {
    const { container } = render(<FactionBadge faction={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders colored pill with faction label', () => {
    const faction: ParticipantFaction = {
      factionKey: 'hawks',
      factionLabel: 'War Hawks',
      color: '#e74c3c',
    };
    render(<FactionBadge faction={faction} />);
    const badge = screen.getByText('War Hawks');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('faction-badge');
  });

  it('renders correct color and title attribute', () => {
    const faction: ParticipantFaction = {
      factionKey: 'doves',
      factionLabel: 'Peace Doves',
      color: '#2ecc71',
    };
    render(<FactionBadge faction={faction} />);
    const badge = screen.getByTitle('Peace Doves');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveStyle({ color: '#2ecc71' });
    expect(badge).toHaveStyle({ borderRadius: '9px' });
  });

  it('renders dot indicator with faction color', () => {
    const faction: ParticipantFaction = {
      factionKey: 'neutrals',
      factionLabel: 'Neutral Zone',
      color: '#9b59b6',
    };
    const { container } = render(<FactionBadge faction={faction} />);
    // The inner dot is aria-hidden
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveStyle({ background: '#9b59b6', borderRadius: '50%' });
  });

  it('displays faction label text content', () => {
    const faction: ParticipantFaction = {
      factionKey: 'tech',
      factionLabel: 'Technologists',
      color: '#4a90d9',
    };
    render(<FactionBadge faction={faction} />);
    expect(screen.getByText('Technologists')).toBeInTheDocument();
  });
});
