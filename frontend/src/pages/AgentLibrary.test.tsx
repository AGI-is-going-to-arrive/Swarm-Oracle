import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    identities: [],
    loading: false,
    error: null,
    fetchIdentities: vi.fn(),
  }),
}));

afterEach(cleanup);

describe('AgentLibrary', () => {
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
});
