/**
 * Phase B1 — AgentWorkshopView tests
 */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { AgentWorkshopView } from './AgentWorkshopView';
import { useAgentStore } from '../stores/agentStore';
import type { AgentIdentityInfo } from '../types';
import type { DocumentAgentResult } from '../api/client';

const mockApi = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  listAgentIdentities: vi.fn(),
  getSessionBoundUserId: vi.fn(() => 'test_user'),
}));

vi.mock('../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/client')>(),
  ...mockApi,
}));

vi.mock('../components/AgentWorkshop/PersonaExportMenu', () => ({
  PersonaExportMenu: ({ onImported }: { onImported?: (id: string) => void }) => (
    <button type="button" onClick={() => onImported?.('from-backup')}>Import saved persona</button>
  ),
}));

vi.mock('./AgentWorkshop/DocumentUploader', () => ({
  DocumentUploader: ({ onAgentsCreated }: { onAgentsCreated?: (result: DocumentAgentResult) => void }) => (
    <button type="button" onClick={() => onAgentsCreated?.({ agents_created: 1, entities_extracted: 1, identities: [{ id: 'from-document', name: 'Researcher', role: 'Analyst' }] })}>
      Finish document import
    </button>
  ),
}));

const existingAgent: AgentIdentityInfo = {
  id: 'existing', user_id: 'test_user', kind: 'custom', display_name: 'Existing Agent', role: 'Advisor',
  persona: null, decision_bias: null, decision_bias_json: null, preferred_tier: 'IMPORTANT',
  continuity_key: 'existing', created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
};

const mockCapability = vi.hoisted(() => ({
  loading: false,
  enabled: true,
  error: null as Error | null,
  reload: vi.fn(),
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

// Suppress i18next missing key warnings
const languageState = vi.hoisted(() => ({ current: 'en' }));
const translate = vi.hoisted(() => (key: string, fallback?: string) => {
  if (key === 'agents.save_error') return languageState.current === 'zh' ? '无法保存角色，请重试。' : 'Could not save the agent. Please retry.';
  if (key === 'agents.load_error') return languageState.current === 'zh' ? '无法加载角色。' : 'Could not load agents.';
  return fallback ?? key;
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const workshopTree = (route = '/agents/new') => (
  <MemoryRouter initialEntries={[route]}>
    <Routes>
      <Route path="/agents/new" element={<AgentWorkshopView />} />
      <Route path="/agents/:id/edit" element={<AgentWorkshopView />} />
      <Route path="/agents" element={<div>Returned to library</div>} />
    </Routes>
  </MemoryRouter>
);

const renderView = (route = '/agents/new') => render(workshopTree(route));

beforeEach(() => {
  mockCapability.loading = false;
  mockCapability.enabled = true;
  mockCapability.error = null;
  mockCapability.reload.mockClear();
  languageState.current = 'en';
  mockApi.createAgent.mockReset().mockResolvedValue({ id: 'created' });
  mockApi.updateAgent.mockReset().mockResolvedValue({ detail: 'updated' });
  mockApi.getSessionBoundUserId.mockReset().mockReturnValue('test_user');
  mockApi.listAgentIdentities.mockReset().mockResolvedValue([existingAgent]);
  useAgentStore.setState({ identities: [], selectedIds: new Set(), cacheValid: false, loadedUserId: null, loadingUserId: null, loading: false, error: null, requestSeq: 0 });
  useAgentStore.getState().setIdentities([existingAgent]);
});

afterEach(cleanup);

describe('AgentWorkshopView', () => {
  it('renders the form fields', () => {
    renderView();
    expect(screen.getByLabelText(/Display Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Role/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Persona')).toBeInTheDocument();
  });

  it('submit button is disabled when name/role are empty', () => {
    renderView();
    const btn = screen.getByText('Create Agent');
    expect(btn).toBeDisabled();
  });

  it('submit button enables when name and role are filled', () => {
    renderView();
    const nameInput = screen.getByLabelText(/Display Name/i);
    const roleInput = screen.getByLabelText(/Role/i);
    fireEvent.change(nameInput, { target: { value: 'Test Agent' } });
    fireEvent.change(roleInput, { target: { value: 'Advisor' } });
    const btn = screen.getByText('Create Agent');
    expect(btn).not.toBeDisabled();
  });

  it('renders knowledge domain checkboxes', () => {
    renderView();
    expect(screen.getByText('economics')).toBeInTheDocument();
    expect(screen.getByText('technology')).toBeInTheDocument();
    expect(screen.getByText('philosophy')).toBeInTheDocument();
  });

  it('has a cancel button that navigates back', () => {
    renderView();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows retryable capability probe errors instead of disabled copy', () => {
    mockCapability.enabled = false;
    mockCapability.error = new Error('capability probe failed');
    renderView();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not check custom agent availability. Please retry.',
    );
    expect(screen.queryByText('Custom agents feature is not enabled.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockCapability.reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes the shared populated library after creation before returning', async () => {
    const created = { ...existingAgent, id: 'created', display_name: 'New Agent' };
    mockApi.listAgentIdentities.mockResolvedValue([existingAgent, created]);
    renderView();
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: 'New Agent' } });
    fireEvent.change(screen.getByLabelText(/Role/i), { target: { value: 'Advisor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    expect(await screen.findByText('Returned to library')).toBeInTheDocument();
    expect(mockApi.createAgent).toHaveBeenCalledOnce();
    expect(useAgentStore.getState().identities).toEqual([existingAgent, created]);
  });

  it('updates an edited identity without losing the home selection', async () => {
    useAgentStore.getState().toggleSelection('existing');
    const edited = { ...existingAgent, display_name: 'Revised name' };
    mockApi.listAgentIdentities.mockResolvedValueOnce([existingAgent]).mockResolvedValueOnce([edited]);
    renderView('/agents/existing/edit');
    await waitFor(() => expect(screen.getByLabelText(/Display Name/i)).toHaveValue('Existing Agent'));
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: 'Revised name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Returned to library')).toBeInTheDocument();
    expect(useAgentStore.getState().identities).toEqual([edited]);
    expect([...useAgentStore.getState().selectedIds]).toEqual(['existing']);
  });

  it('refreshes shared identities when a document import completes', async () => {
    const imported = { ...existingAgent, id: 'from-document', display_name: 'Researcher' };
    mockApi.listAgentIdentities.mockResolvedValue([existingAgent, imported]);
    renderView();
    fireEvent.click(screen.getByRole('tab', { name: 'Import from document' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish document import' }));
    await waitFor(() => expect(useAgentStore.getState().identities).toEqual([existingAgent, imported]));
    expect(screen.queryByText('Returned to library')).not.toBeInTheDocument();
  });

  it('refreshes shared identities after a persona backup import', async () => {
    const imported = { ...existingAgent, id: 'from-backup' };
    mockApi.listAgentIdentities.mockResolvedValue([existingAgent, imported]);
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Import saved persona' }));
    expect(await screen.findByText('Returned to library')).toBeInTheDocument();
    expect(useAgentStore.getState().identities).toEqual([existingAgent, imported]);
  });

  it('keeps a successful create committed when refreshing fails', async () => {
    mockApi.listAgentIdentities.mockRejectedValueOnce(new Error('offline'));
    renderView();
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: 'New Agent' } });
    fireEvent.change(screen.getByLabelText(/Role/i), { target: { value: 'Advisor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(await screen.findByText('Returned to library')).toBeInTheDocument();
    expect(useAgentStore.getState().cacheValid).toBe(false);
    expect(useAgentStore.getState().error).toBe('offline');
    expect(mockApi.createAgent).toHaveBeenCalledOnce();
  });

  it('does not publish an old owner save into a new owner session', async () => {
    let resolveCreate!: (result: { id: string }) => void;
    mockApi.createAgent.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }));
    renderView();
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: 'New Agent' } });
    fireEvent.change(screen.getByLabelText(/Role/i), { target: { value: 'Advisor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    mockApi.getSessionBoundUserId.mockReturnValue('new-owner');
    await act(async () => { resolveCreate({ id: 'old-owner-created' }); });
    expect(mockApi.listAgentIdentities).not.toHaveBeenCalled();
    expect(screen.queryByText('Returned to library')).not.toBeInTheDocument();
  });

  it('localizes a save failure at render time without exposing the raw server error', async () => {
    mockApi.createAgent.mockRejectedValueOnce(new Error('private upstream details'));
    const view = renderView();
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: 'My name stays intact' } });
    fireEvent.change(screen.getByLabelText(/Role/i), { target: { value: 'Advisor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the agent. Please retry.');
    expect(screen.queryByText('private upstream details')).not.toBeInTheDocument();
    languageState.current = 'zh';
    view.rerender(workshopTree());
    expect(screen.getByRole('alert')).toHaveTextContent('无法保存角色，请重试。');
    expect(screen.getByLabelText(/Display Name/i)).toHaveValue('My name stays intact');
    expect(mockApi.createAgent).toHaveBeenCalledOnce();
  });

  it('keeps a load error translated after language switching without refetching the form', async () => {
    mockApi.listAgentIdentities.mockRejectedValueOnce(new Error('private identity lookup details'));
    const view = renderView('/agents/existing/edit');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load agents.');
    languageState.current = 'zh';
    view.rerender(workshopTree('/agents/existing/edit'));
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载角色。');
    expect(mockApi.listAgentIdentities).toHaveBeenCalledOnce();
  });
});
