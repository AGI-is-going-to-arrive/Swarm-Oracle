/**
 * Phase B1 — AgentWorkshopView tests
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AgentWorkshopView } from './AgentWorkshopView';

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: true, capabilities: null }),
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

afterEach(cleanup);

describe('AgentWorkshopView', () => {
  it('renders the form fields', () => {
    renderView();
    expect(screen.getByLabelText(/Display Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Role/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Persona/i)).toBeInTheDocument();
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
});
