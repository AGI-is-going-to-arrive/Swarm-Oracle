/**
 * Phase B1 — AgentWorkshopView tests
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AgentWorkshopView } from './AgentWorkshopView';

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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const renderView = () =>
  render(
    <MemoryRouter initialEntries={['/agents/new']}>
      <AgentWorkshopView />
    </MemoryRouter>,
  );

beforeEach(() => {
  mockCapability.loading = false;
  mockCapability.enabled = true;
  mockCapability.error = null;
  mockCapability.reload.mockClear();
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
});
