import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import SetupWizardView from './SetupWizardView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const renderWizard = () =>
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <SetupWizardView />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('SetupWizardView provider selection', () => {
  it('makes the first radio tabbable before any preset is selected', () => {
    renderWizard();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(radios[0]).toHaveAttribute('tabIndex', '0');
    expect(radios.slice(1).every((radio) => radio.getAttribute('tabIndex') === '-1')).toBe(
      true,
    );
  });

  it('selects the initial focused radio with Space', async () => {
    const user = userEvent.setup();
    renderWizard();

    const firstRadio = screen.getAllByRole('radio')[0];
    firstRadio.focus();
    await user.keyboard('[Space]');

    expect(firstRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'setup.next' })).not.toBeDisabled();
  });

  it('selects the initial focused radio with Enter', async () => {
    const user = userEvent.setup();
    renderWizard();

    const firstRadio = screen.getAllByRole('radio')[0];
    firstRadio.focus();
    await user.keyboard('[Enter]');

    expect(firstRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'setup.next' })).not.toBeDisabled();
  });
});
