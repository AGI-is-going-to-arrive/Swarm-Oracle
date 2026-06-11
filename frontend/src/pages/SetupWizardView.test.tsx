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

  it('preserves pre-existing model and RPM when wizard is finished', async () => {
    const user = userEvent.setup();
    const { saveLlmProviderPolicy, loadLlmProviderPolicy } = await import('../lib/llmProviderPolicy');

    saveLlmProviderPolicy({
      apiKey: 'old-key',
      baseUrl: 'old-url',
      model: 'custom-model',
      reasoningEffort: 'high',
      disableUserQuota: true,
      requestsPerMinute: 100,
      tokensPerMinute: 50000,
    });

    renderWizard();

    // Select the first radio (openai)
    const radios = screen.getAllByRole('radio');
    const firstRadio = radios[0];
    firstRadio.focus();
    await user.keyboard('[Space]');

    // Click next
    const nextBtn = screen.getByRole('button', { name: 'setup.next' });
    await user.click(nextBtn);

    // In step 2, update API key
    const keyInput = screen.getByLabelText(/setup\.api_key_label/i);
    await user.clear(keyInput);
    await user.type(keyInput, 'new-secret-key');

    // Click next
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    // Click finish
    await user.click(screen.getByRole('button', { name: 'setup.finish' }));

    // Read policy back and check
    const finalPolicy = loadLlmProviderPolicy();
    expect(finalPolicy.apiKey).toBe('new-secret-key');
    expect(finalPolicy.baseUrl).toBe('https://api.openai.com/v1');
    expect(finalPolicy.model).toBe('custom-model');
    expect(finalPolicy.reasoningEffort).toBe('high');
    expect(finalPolicy.disableUserQuota).toBe(true);
    expect(finalPolicy.requestsPerMinute).toBe(100);
    expect(finalPolicy.tokensPerMinute).toBe(50000);
  });
});
