import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AgentLibrary } from './AgentLibrary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => ({
      'agents.library_title': 'Agent 资料库',
      'agents.create_btn': '创建 Agent',
      'agents.empty_state': '还没有自定义 Agent。',
      'agents.empty_hint': '创建你的第一个自定义 Agent 并在推演中使用。',
    }[key] ?? fallback ?? key),
    i18n: { changeLanguage: vi.fn(), language: 'zh' },
  }),
}));

let mockCapEnabled = true;
vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: mockCapEnabled, capabilities: null }),
}));

const mockFetchIdentities = vi.fn();
vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    identities: [],
    loading: false,
    error: null,
    fetchIdentities: mockFetchIdentities,
  }),
}));

describe('AgentLibrary', () => {
  beforeEach(() => {
    mockCapEnabled = true;
    mockFetchIdentities.mockClear();
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
    mockCapEnabled = false;
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );
    expect(mockFetchIdentities).not.toHaveBeenCalled();
    expect(screen.getByText('Custom agents feature is not enabled.')).toBeInTheDocument();
  });
});
