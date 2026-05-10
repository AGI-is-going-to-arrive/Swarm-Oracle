import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { AgentIdentityInfo } from '../types';
import { useAgentStore } from '../stores/agentStore';
import { AgentAttachPanel } from './AgentAttachPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'en' },
  }),
}));

const { listAgentIdentitiesMock } = vi.hoisted(() => ({
  listAgentIdentitiesMock: vi.fn(),
}));

vi.mock('../api/client', async (importActual) => {
  const actual = await importActual<typeof import('../api/client')>();
  return {
    ...actual,
    listAgentIdentities: listAgentIdentitiesMock,
  };
});

const customAgent: AgentIdentityInfo = {
  id: 'agent-1',
  user_id: 'user-1',
  kind: 'custom',
  display_name: 'Recovered Agent',
  role: 'Risk analyst with a very long role label that should not overflow the card shell',
  persona: 'Looks for tail risk.',
  decision_bias_json: null,
  decision_bias: { caution: 0.8 },
  knowledge_domain_json: JSON.stringify(['economics']),
  knowledge_domains: ['economics'],
  preferred_tier: null,
  continuity_key: 'agent-1',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('AgentAttachPanel', () => {
  beforeEach(() => {
    useAgentStore.setState({
      identities: [],
      loading: false,
      error: null,
      selectedIds: new Set(),
      loadedUserId: null,
      requestSeq: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the store error and retries loading agents instead of falling through to the empty CTA', async () => {
    // After S1-3 C2, agentStore calls api/client.listAgentIdentities (which
    // routes through safeGet with retry). Mock the higher-level helper to keep
    // the test deterministic and avoid the 5xx retry backoff.
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce([customAgent]);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load agents.');
    expect(screen.queryByText('Create your first agent')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(listAgentIdentitiesMock).toHaveBeenCalledWith('user-1');
    });
    expect(await screen.findByText('Recovered Agent')).toBeInTheDocument();
  });
});
