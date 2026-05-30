import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AgentRosterPanel from '../Journal/AgentRosterPanel';
import WorldlineMapMini from '../Journal/WorldlineMapMini';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'en' },
  }),
}));

describe('Journal side panels', () => {
  it('does not render mock roster entries when no data is provided', () => {
    render(<AgentRosterPanel />);

    expect(screen.getByRole('status')).toHaveTextContent(/No agent interactions yet/i);
    expect(screen.queryByText('Vega')).not.toBeInTheDocument();
    expect(screen.queryByText('Hesperus')).not.toBeInTheDocument();
    expect(screen.queryByText('Lyra')).not.toBeInTheDocument();
  });

  it('shows an empty worldline state instead of demo branches', () => {
    render(<WorldlineMapMini />);

    expect(screen.getByRole('status')).toHaveTextContent(/No explored worldlines yet/i);
    expect(screen.queryByText('Origin')).not.toBeInTheDocument();
    expect(screen.queryByText('Optimistic')).not.toBeInTheDocument();
  });

  it('keeps worldline retry controls out of image semantics', () => {
    const onRetry = vi.fn();
    const { container } = render(<WorldlineMapMini error onRetry={onRetry} />);

    expect(container.querySelector('.journal-worldline-mini')).toHaveAttribute('role', 'figure');
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load the worldline map/i);
    expect(screen.getByRole('button', { name: /Reload map/i })).toBeInTheDocument();
  });
});
