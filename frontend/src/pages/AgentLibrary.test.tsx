import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AgentLibrary } from './AgentLibrary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string; name?: string }) => {
      if (fallback && typeof fallback === 'object') {
        return (fallback.defaultValue ?? key).replace('{{name}}', String(fallback.name ?? ''));
      }
      return ({
      'agents.library_title': 'Agent 资料库',
      'agents.create_btn': '创建 Agent',
      'agents.empty_state': '还没有自定义 Agent。',
      'agents.empty_hint': '创建你的第一个自定义 Agent 并在推演中使用。',
      }[key] ?? fallback ?? key);
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh' },
  }),
}));

const mockCapability = vi.hoisted(() => ({
  loading: false,
  enabled: true,
  error: null as Error | null,
  reload: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  deleteAgent: vi.fn(),
  getAgentFavorites: vi.fn(async () => []),
  getSessionBoundUserId: vi.fn(() => 'test_user'),
  isApiError: vi.fn(() => false),
  markAgentFavorite: vi.fn(),
  unmarkAgentFavorite: vi.fn(),
}));

vi.mock('../api/client', () => ({
  deleteAgent: mockApi.deleteAgent,
  getAgentFavorites: mockApi.getAgentFavorites,
  getSessionBoundUserId: mockApi.getSessionBoundUserId,
  isApiError: mockApi.isApiError,
  markAgentFavorite: mockApi.markAgentFavorite,
  unmarkAgentFavorite: mockApi.unmarkAgentFavorite,
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    loading: mockCapability.loading,
    enabled: mockCapability.enabled,
    capabilities: null,
    error: mockCapability.error,
    reload: mockCapability.reload,
  }),
}));

const mockAgentStore = vi.hoisted(() => ({
  identities: [] as Array<{
    id: string;
    user_id: string;
    kind: 'generated' | 'custom';
    display_name: string;
    role: string;
    persona: string | null;
    decision_bias: Record<string, unknown> | null;
    decision_bias_json: string | null;
    preferred_tier: 'IMPORTANT' | 'CROWD' | null;
    continuity_key: string;
    created_at: string;
    updated_at: string;
  }>,
  fetchIdentities: vi.fn(),
}));

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    identities: mockAgentStore.identities,
    loading: false,
    error: null,
    fetchIdentities: mockAgentStore.fetchIdentities,
  }),
}));

describe('AgentLibrary', () => {
  beforeEach(() => {
    mockCapability.loading = false;
    mockCapability.enabled = true;
    mockCapability.error = null;
    mockCapability.reload.mockClear();
    mockAgentStore.identities = [];
    mockAgentStore.fetchIdentities.mockClear();
    mockApi.deleteAgent.mockClear();
    mockApi.getAgentFavorites.mockClear();
    mockApi.getAgentFavorites.mockResolvedValue([]);
    mockApi.getSessionBoundUserId.mockClear();
    mockApi.isApiError.mockClear();
    mockApi.isApiError.mockReturnValue(false);
    mockApi.markAgentFavorite.mockClear();
    mockApi.unmarkAgentFavorite.mockClear();
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: vi.fn().mockReturnValue('test_user'), setItem: vi.fn(), removeItem: vi.fn() },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('renders localized empty state copy', () => {
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Agent 资料库' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\+ 创建 Agent/ })).toBeInTheDocument();
    expect(screen.getByText('还没有自定义 Agent。')).toBeInTheDocument();
    expect(screen.getByText('创建你的第一个自定义 Agent 并在推演中使用。')).toBeInTheDocument();
  });

  it('does not fetch identities when capability is disabled', () => {
    mockCapability.enabled = false;
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );
    expect(mockAgentStore.fetchIdentities).not.toHaveBeenCalled();
    expect(screen.getByText('Custom agents feature is not enabled.')).toBeInTheDocument();
  });

  it('shows retryable capability probe errors instead of disabled copy', () => {
    mockCapability.enabled = false;
    mockCapability.error = new Error('capabilities failed');
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(mockAgentStore.fetchIdentities).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not check custom agent availability. Please retry.',
    );
    expect(screen.queryByText('Custom agents feature is not enabled.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockCapability.reload).toHaveBeenCalledTimes(1);
  });

  it('does not expose raw favorites load errors', async () => {
    mockApi.getAgentFavorites.mockRejectedValueOnce(new Error('raw favorites failure'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load favorites. Please retry.',
    );
    expect(screen.queryByText(/raw favorites failure/i)).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('labels custom agent delete buttons with the target agent name', () => {
    mockAgentStore.identities = [{
      id: 'custom-1',
      user_id: 'test_user',
      kind: 'custom',
      display_name: 'Ada',
      role: 'Forecaster',
      persona: 'Careful and concise.',
      decision_bias: null,
      decision_bias_json: null,
      preferred_tier: 'IMPORTANT',
      continuity_key: 'ada',
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
    }];

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Delete Ada' })).toBeInTheDocument();
  });
});
