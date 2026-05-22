import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentIdentityInfo } from '../types';
import { useAgentStore } from '../stores/agentStore';
import AgentSelectionStrip from './AgentSelectionStrip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'object' && fallbackOrOptions !== null) {
        const opts = fallbackOrOptions as Record<string, unknown>;
        if (key === 'agents.more_count') {
          return `+${opts.count} more`;
        }
        return typeof opts.defaultValue === 'string' ? opts.defaultValue : key;
      }
      const labels: Record<string, string> = {
        'agents.quick_select': 'Quick agent selector',
        'agents.quick_select_loading': 'Loading agents…',
        'agents.quick_select_error': 'Could not load agents.',
        'agents.manage_all': 'Manage all',
        'agents.empty_cta': 'No custom agents yet.',
      };
      return labels[key] ?? fallbackOrOptions ?? key;
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

function makeAgent(idx: number, kind: 'generated' | 'custom' = 'custom'): AgentIdentityInfo {
  return {
    id: `agent-${idx}`,
    user_id: 'user-1',
    kind,
    display_name: `Agent ${idx}`,
    role: 'Analyst',
    persona: 'Persona text.',
    decision_bias_json: null,
    decision_bias: { caution: 0.5 },
    knowledge_domain_json: null,
    knowledge_domains: [],
    preferred_tier: null,
    continuity_key: `agent-${idx}`,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  };
}

const originalFetchIdentities = useAgentStore.getState().fetchIdentities;

function resetStore() {
  useAgentStore.setState({
    identities: [],
    loading: false,
    error: null,
    selectedIds: new Set(),
    loadedUserId: null,
    loadingUserId: null,
    requestSeq: 0,
    fetchIdentities: originalFetchIdentities,
  });
}

describe('AgentSelectionStrip', () => {
  beforeEach(() => {
    resetStore();
    listAgentIdentitiesMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when visible=false', () => {
    useAgentStore.setState({ identities: [makeAgent(1)] });
    const { container } = render(
      <AgentSelectionStrip
        userId="user-1"
        visible={false}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    // Should not have triggered fetch
    expect(listAgentIdentitiesMock).not.toHaveBeenCalled();
  });

  it('keeps the manage entry visible when there are no custom agents', async () => {
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1, 'generated')]);
    useAgentStore.setState({
      identities: [makeAgent(1, 'generated')],
      loadedUserId: 'user-1',
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    expect(await screen.findByText('No custom agents yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage all' })).toBeInTheDocument();
  });

  it('shows loading state with role="status"', () => {
    // Pre-set loading + stub fetchIdentities so the effect doesn't overwrite it
    useAgentStore.setState({
      loading: true,
      fetchIdentities: vi.fn(async () => {}),
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading agents…');
  });

  it('shows error state with role="alert"', () => {
    // Stub fetchIdentities so the effect doesn't clear the error
    useAgentStore.setState({
      error: 'boom',
      loading: false,
      fetchIdentities: vi.fn(async () => {}),
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load agents.');
  });

  it('renders up to 3 agent pills', async () => {
    listAgentIdentitiesMock.mockResolvedValue([
      makeAgent(1),
      makeAgent(2),
      makeAgent(3),
    ]);
    useAgentStore.setState({
      identities: [makeAgent(1), makeAgent(2), makeAgent(3)],
      loadedUserId: 'user-1',
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    expect(await screen.findByText('Agent 1')).toBeInTheDocument();
    expect(screen.getByText('Agent 2')).toBeInTheDocument();
    expect(screen.getByText('Agent 3')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });

  it('shows "+N more" indicator when more than 3 agents', async () => {
    const agents = [makeAgent(1), makeAgent(2), makeAgent(3), makeAgent(4), makeAgent(5)];
    listAgentIdentitiesMock.mockResolvedValue(agents);
    useAgentStore.setState({
      identities: agents,
      loadedUserId: 'user-1',
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    expect(await screen.findByText('Agent 1')).toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    expect(screen.queryByText('Agent 4')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent 5')).not.toBeInTheDocument();
  });

  it('toggles selection when a pill is clicked', async () => {
    const user = userEvent.setup();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2)]);
    useAgentStore.setState({
      identities: [makeAgent(1), makeAgent(2)],
      loadedUserId: 'user-1',
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    const agent1Box = await screen.findByRole('checkbox', { name: 'Agent 1' });
    expect(agent1Box).not.toBeChecked();

    await user.click(agent1Box);

    await waitFor(() => {
      expect(useAgentStore.getState().selectedIds.has('agent-1')).toBe(true);
    });

    await user.click(agent1Box);

    await waitFor(() => {
      expect(useAgentStore.getState().selectedIds.has('agent-1')).toBe(false);
    });
  });

  it('disables unselected pills once the selection is full', async () => {
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1), makeAgent(2), makeAgent(3)]);
    useAgentStore.setState({
      identities: [makeAgent(1), makeAgent(2), makeAgent(3)],
      loadedUserId: 'user-1',
      selectedIds: new Set(['agent-1', 'agent-2']),
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={2}
        onManageClick={vi.fn()}
      />,
    );

    const agent3 = await screen.findByRole('checkbox', { name: 'Agent 3' });
    const agent1 = screen.getByRole('checkbox', { name: 'Agent 1' });
    expect(agent3).toBeDisabled();
    expect(agent1).not.toBeDisabled();
  });

  it('calls onManageClick when the Manage button is clicked', async () => {
    const user = userEvent.setup();
    const onManageClick = vi.fn();
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1)]);
    useAgentStore.setState({
      identities: [makeAgent(1)],
      loadedUserId: 'user-1',
    });

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={onManageClick}
      />,
    );

    await screen.findByText('Agent 1');
    await user.click(screen.getByRole('button', { name: 'Manage all' }));
    expect(onManageClick).toHaveBeenCalledTimes(1);
  });

  it('has fieldset + legend for accessibility', async () => {
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1)]);
    useAgentStore.setState({
      identities: [makeAgent(1)],
      loadedUserId: 'user-1',
    });

    const { container } = render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    await screen.findByText('Agent 1');
    expect(container.querySelector('fieldset.agent-strip')).not.toBeNull();
    const legend = container.querySelector('legend');
    expect(legend).not.toBeNull();
    expect(legend?.textContent).toBe('Quick agent selector');
  });

  it('triggers fetchIdentities once when becoming visible with a userId', async () => {
    listAgentIdentitiesMock.mockResolvedValue([makeAgent(1)]);

    render(
      <AgentSelectionStrip
        userId="user-1"
        visible={true}
        maxSelected={3}
        onManageClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listAgentIdentitiesMock).toHaveBeenCalledWith('user-1');
    });
  });

  it('deduplicates simultaneous fetches for the same user', async () => {
    let resolveAgents: ((agents: AgentIdentityInfo[]) => void) | undefined;
    listAgentIdentitiesMock.mockImplementation(
      () => new Promise<AgentIdentityInfo[]>((resolve) => {
        resolveAgents = resolve;
      }),
    );

    render(
      <>
        <AgentSelectionStrip
          userId="user-1"
          visible={true}
          maxSelected={3}
          onManageClick={vi.fn()}
        />
        <AgentSelectionStrip
          userId="user-1"
          visible={true}
          maxSelected={3}
          onManageClick={vi.fn()}
        />
      </>,
    );

    await waitFor(() => {
      expect(listAgentIdentitiesMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveAgents?.([makeAgent(1)]);
    });

    expect(await screen.findAllByText('Agent 1')).toHaveLength(2);
  });
});
