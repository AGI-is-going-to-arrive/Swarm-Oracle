import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { AgentIdentityInfo } from '../types';
import { useAgentStore } from '../stores/agentStore';
import { AgentAttachPanel } from './AgentAttachPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'object' && fallbackOrOptions !== null) {
        const opts = fallbackOrOptions as Record<string, unknown>;
        if (key === 'agents.attach_counter') {
          return `${opts.selected}/${opts.maxAllowed}`;
        }
        return typeof opts.defaultValue === 'string' ? opts.defaultValue : key;
      }
      return fallbackOrOptions ?? key;
    },
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

function makeAgent(idx: number): AgentIdentityInfo {
  return {
    ...customAgent,
    id: `agent-${idx}`,
    display_name: `Agent ${idx}`,
    continuity_key: `agent-${idx}`,
  };
}

describe('AgentAttachPanel', () => {
  beforeEach(() => {
    useAgentStore.setState({
      identities: [],
      loading: false,
      error: null,
      selectedIds: new Set(),
      loadedUserId: null,
      loadingUserId: null,
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

  it('shows counter using effective maxSelected=3 instead of the default 5', async () => {
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2), makeAgent(3), makeAgent(4)]);

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} maxSelected={3} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('0/3')).toBeInTheDocument();
  });

  it('disables non-selected checkboxes once the selection reaches maxSelected', async () => {
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2), makeAgent(3)]);
    useAgentStore.setState({ selectedIds: new Set(['agent-1', 'agent-2']) });

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} maxSelected={2} />
      </MemoryRouter>,
    );

    await screen.findByText('Agent 1');
    const agent3 = screen.getByRole('checkbox', { name: 'Agent 3' });
    const agent1 = screen.getByRole('checkbox', { name: 'Agent 1' });
    expect(agent3).toBeDisabled();
    expect(agent1).not.toBeDisabled();
  });

  it('disables every checkbox when maxSelected=0', async () => {
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2)]);

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} maxSelected={0} />
      </MemoryRouter>,
    );

    await screen.findByText('Agent 1');
    expect(screen.getByRole('checkbox', { name: 'Agent 1' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Agent 2' })).toBeDisabled();
    expect(screen.getByText('0/0')).toBeInTheDocument();
  });

  it('falls back to default cap of 1 when maxSelected is not provided', async () => {
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1)]);

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('0/1')).toBeInTheDocument();
  });

  it('auto-prunes existing selections when maxSelected shrinks', async () => {
    listAgentIdentitiesMock.mockReset();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2), makeAgent(3)]);
    useAgentStore.setState({ selectedIds: new Set(['agent-1', 'agent-2', 'agent-3']) });

    render(
      <MemoryRouter>
        <AgentAttachPanel userId="user-1" visible={true} maxSelected={2} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['agent-1', 'agent-2']);
    });
    expect(await screen.findByText('2/2')).toBeInTheDocument();
  });
});
