import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AgentCard from '../AgentCard';
import type { AgentIdentityInfo } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) => (
      typeof fallback === 'string' ? fallback : _key
    ),
  }),
}));

const identity = {
  id: 'agent-1',
  user_id: 'user-1',
  kind: 'custom',
  display_name: 'Aria',
  role: 'Strategist',
  persona: 'A careful planner.',
  decision_bias: { caution: 0.7 },
  decision_bias_json: null,
  knowledge_domains: [],
  knowledge_domain_json: null,
  continuity_key: 'aria-strategist',
  preferred_tier: 'IMPORTANT',
  is_favorite: false,
  created_at: '2026-05-11T00:00:00Z',
  updated_at: '2026-05-11T00:00:00Z',
} as unknown as AgentIdentityInfo;

describe('AgentCard', () => {
  it('uses explicit buttons instead of making the whole card interactive', () => {
    render(
      <AgentCard
        identity={identity}
        isFavorite={false}
        onToggleFavorite={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /aria strategist/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view details/i })).toBeInTheDocument();
  });

  it('does not select the card when toggling favorite', () => {
    const onToggleFavorite = vi.fn();
    const onSelect = vi.fn();
    render(
      <AgentCard
        identity={identity}
        isFavorite={false}
        onToggleFavorite={onToggleFavorite}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add to favorites/i }));

    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
