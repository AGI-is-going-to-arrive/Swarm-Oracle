import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import SetupWizardView from './SetupWizardView';
import { LLM_PROVIDER_PRESETS } from '../lib/llmProviderPolicy';
import { createModelProfile, testLlmConnection } from '../api/client';

const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  listModelProfiles: vi.fn(() => Promise.resolve({ profiles: [], count: 0 })),
  createModelProfile: vi.fn(() => Promise.resolve({})),
  listModels: vi.fn(() => Promise.resolve({ models: [], provider: 'openai', supported: false })),
  testLlmConnection: vi.fn(),
  probeNativeSearch: vi.fn(),
  isApiError: vi.fn((error: unknown) => error instanceof Error && 'status' in error),
}));

const renderWizard = () =>
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <SetupWizardView />
    </MemoryRouter>,
  );

async function reachLocalConnectionStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: /setup\.provider_ollama/i }));
  await user.click(screen.getByRole('button', { name: 'setup.next' }));
  await user.type(screen.getByLabelText('model_profiles.model'), 'llama3.2');
  await user.click(screen.getByRole('button', { name: 'setup.next' }));
}

async function reachOpenAiConnectionStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: /setup\.provider_openai/i }));
  await user.click(screen.getByRole('button', { name: 'setup.next' }));
  await user.type(screen.getByLabelText(/setup\.api_key_label/i), 'openai-key');
  await user.type(screen.getByLabelText('model_profiles.model'), 'gpt-test');
  await user.click(screen.getByRole('button', { name: 'setup.next' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('SetupWizardView provider selection', () => {
  it('keeps Finish disabled until the current connection is verified or explicitly accepted as unverified', async () => {
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);

    const finish = screen.getByRole('button', { name: 'setup.finish' });
    expect(finish).toBeDisabled();

    const allowUnverified = screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' });
    await user.click(allowUnverified);
    expect(finish).toBeEnabled();
    await user.click(allowUnverified);
    expect(finish).toBeDisabled();
    expect(createModelProfile).not.toHaveBeenCalled();
  });

  it('allows a verified localhost Ollama configuration without requiring an API key', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'llama3.2', response: 'local model ready' },
    });
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);

    const finish = screen.getByRole('button', { name: 'setup.finish' });
    expect(finish).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => expect(finish).toBeEnabled());
    expect(screen.queryByRole('checkbox', { name: 'setup.allow_unverified_label' })).not.toBeInTheDocument();
    expect(screen.getByText('setup.connection_verified_hint')).toBeInTheDocument();
    expect(testLlmConnection).toHaveBeenCalledWith(
      undefined,
      'http://localhost:11434/v1',
      'llama3.2',
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
    );

    await user.click(finish);
    await waitFor(() => expect(createModelProfile).toHaveBeenCalledWith({
      name: 'setup.provider_ollama',
      provider: 'ollama',
      base_url: 'http://localhost:11434/v1',
      model: 'llama3.2',
      api_key: '',
    }));
  });

  it('keeps a keyless local configuration usable when profile saving is disabled', async () => {
    const user = userEvent.setup();
    const { loadLlmProviderPolicy, validateByok } = await import('../lib/llmProviderPolicy');
    renderWizard();
    await user.click(screen.getByRole('radio', { name: /setup\.provider_lmstudio/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));
    await user.type(screen.getByLabelText('model_profiles.model'), 'local-model');
    await user.click(screen.getByRole('checkbox', { name: 'setup.save_profile_checkbox' }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));
    await user.click(screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' }));
    await user.click(screen.getByRole('button', { name: 'setup.finish' }));

    await waitFor(() => {
      const policy = loadLlmProviderPolicy();
      expect(policy).toMatchObject({
        apiKey: '',
        baseUrl: 'http://localhost:1234/v1',
        model: 'local-model',
      });
      expect(validateByok(policy)).toEqual({ valid: true });
    });
    expect(createModelProfile).not.toHaveBeenCalled();
  });

  it('derives the API-key requirement from a custom endpoint locality', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('radio', { name: /setup\.provider_custom/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    const baseUrlInput = screen.getByLabelText(/setup\.base_url_label/i);
    const next = screen.getByRole('button', { name: 'setup.next' });
    await user.type(baseUrlInput, 'http://127.0.0.1:8317/v1');
    await user.type(screen.getByLabelText('model_profiles.model'), 'local-relay-model');

    const apiKeyInput = screen.getByLabelText(/setup\.api_key_label/i);
    expect(apiKeyInput.closest('label')).toHaveTextContent('setup.optional_label');
    expect(next).toBeEnabled();

    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'https://relay.example.com/v1');

    expect(apiKeyInput.closest('label')).not.toHaveTextContent('setup.optional_label');
    expect(next).toBeDisabled();
  });

  it('clears a remote provider key when its endpoint changes to exact-local', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('radio', { name: /setup\.provider_openai/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    const apiKeyInput = screen.getByLabelText(/setup\.api_key_label/i);
    await user.type(apiKeyInput, 'remote-secret');
    const baseUrlInput = screen.getByLabelText(/setup\.base_url_label/i);
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'http://localhost:8317/v1');

    expect(apiKeyInput).toHaveValue('');
    expect(apiKeyInput).toBeDisabled();
    expect(apiKeyInput.closest('label')).toHaveTextContent('setup.optional_label');
  });

  it('never carries a remote provider key across another endpoint or provider', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('radio', { name: /setup\.provider_openai/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    const apiKeyInput = screen.getByLabelText(/setup\.api_key_label/i);
    const baseUrlInput = screen.getByLabelText(/setup\.base_url_label/i);
    await user.type(apiKeyInput, 'openai-secret');
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'https://relay.example.com/v1');
    expect(apiKeyInput).toHaveValue('');

    await user.type(apiKeyInput, 'relay-secret');
    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    await user.click(screen.getByRole('radio', { name: /setup\.provider_gemini/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByLabelText(/setup\.api_key_label/i)).toHaveValue('');
    expect(createModelProfile).not.toHaveBeenCalled();
    expect(testLlmConnection).not.toHaveBeenCalled();
  });

  it('never carries a model selection across provider presets', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole('radio', { name: /setup\.provider_ollama/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));
    await user.type(screen.getByLabelText('model_profiles.model'), 'llama3.2');
    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    await user.click(screen.getByRole('radio', { name: /setup\.provider_openai/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByLabelText('model_profiles.model')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'setup.next' })).toBeDisabled();
  });

  it('keeps Finish locked after failure until the user explicitly accepts an unverified save', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'error', model: 'llama3.2', error: 'model unavailable' },
    });
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);

    const finish = screen.getByRole('button', { name: 'setup.finish' });
    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    await screen.findByText('model unavailable');
    expect(finish).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' }));
    expect(finish).toBeEnabled();
  });

  it('resets verification after base URL, API key, or model changes', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'gpt-test', response: 'ready' },
    });
    const user = userEvent.setup();
    renderWizard();
    await reachOpenAiConnectionStep(user);

    const verify = async () => {
      const finish = screen.getByRole('button', { name: 'setup.finish' });
      await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
      await waitFor(() => expect(finish).toBeEnabled());
    };
    const editAndReturn = async (
      label: RegExp | string,
      value: string,
      freshApiKey?: string,
    ) => {
      await user.click(screen.getByRole('button', { name: 'setup.back' }));
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
      if (freshApiKey) {
        const keyInput = screen.getByLabelText(/setup\.api_key_label/i);
        expect(keyInput).toHaveValue('');
        await user.type(keyInput, freshApiKey);
      }
      await user.click(screen.getByRole('button', { name: 'setup.next' }));
      expect(screen.getByRole('button', { name: 'setup.finish' })).toBeDisabled();
    };

    await verify();
    await editAndReturn(
      /setup\.base_url_label/i,
      'https://api-alt.example.com/v1',
      'api-alt-key',
    );
    await verify();
    await editAndReturn(/setup\.api_key_label/i, 'second-key');
    await verify();
    await editAndReturn('model_profiles.model', 'gpt-next');
  });

  it('resets verification when the provider changes', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'llama3.2', response: 'ready' },
    });
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);
    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'setup.finish' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    await user.click(screen.getByRole('radio', { name: /setup\.provider_lmstudio/i }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));
    const modelInput = screen.getByLabelText('model_profiles.model');
    expect(modelInput).toHaveValue('');
    expect(screen.getByRole('button', { name: 'setup.next' })).toBeDisabled();
    await user.type(modelInput, 'lmstudio-model');
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByRole('button', { name: 'setup.finish' })).toBeDisabled();
  });

  it('clears explicit unverified consent when a connection field changes', async () => {
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);
    const allowUnverified = screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' });
    await user.click(allowUnverified);
    expect(screen.getByRole('button', { name: 'setup.finish' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    const modelInput = screen.getByLabelText('model_profiles.model');
    await user.clear(modelInput);
    await user.type(modelInput, 'llama3.3');
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'setup.finish' })).toBeDisabled();
  });

  it('keeps verification when only the model-profile save preference changes', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'llama3.2', response: 'ready' },
    });
    const user = userEvent.setup();
    renderWizard();
    await reachLocalConnectionStep(user);
    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'setup.finish' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'setup.back' }));
    await user.click(screen.getByRole('checkbox', { name: 'setup.save_profile_checkbox' }));
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByRole('button', { name: 'setup.finish' })).toBeEnabled();
    expect(screen.getByText('setup.connection_verified_hint')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('setup.test_success');
  });

  it('protects the Gemini provider preset contract', () => {
    const geminiPreset = LLM_PROVIDER_PRESETS.find(
      (preset) => preset.id === 'gemini',
    );

    expect(geminiPreset).toMatchObject({
      nameKey: 'setup.provider_gemini',
      baseUrl: GEMINI_BASE_URL,
      requiresApiKey: true,
    });
  });

  it('makes the first radio tabbable before any preset is selected', () => {
    renderWizard();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(7);
    const geminiRadio = screen.getByRole('radio', {
      name: /setup\.provider_gemini/i,
    });
    expect(geminiRadio).toHaveTextContent(GEMINI_BASE_URL);
    expect(radios[0]).toHaveAttribute('tabIndex', '0');
    expect(radios.slice(1).every((radio) => radio.getAttribute('tabIndex') === '-1')).toBe(
      true,
    );
  });

  it('prefills Gemini base URL and keeps the API key required', async () => {
    const user = userEvent.setup();
    renderWizard();

    const geminiRadio = screen.getByRole('radio', {
      name: /setup\.provider_gemini/i,
    });
    await user.click(geminiRadio);

    expect(geminiRadio).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    expect(screen.getByLabelText(/setup\.base_url_label/i)).toHaveValue(
      GEMINI_BASE_URL,
    );
    expect(screen.getByLabelText(/setup\.api_key_label/i)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'setup.next' })).toBeDisabled();
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

  it('clears credentials/base_url/model but keeps non-secret global prefs after saving a profile', async () => {
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

    // The old custom-provider model must not follow the newly selected preset.
    const modelInput = screen.getByLabelText('model_profiles.model');
    expect(modelInput).toHaveValue('');
    expect(screen.getByRole('button', { name: 'setup.next' })).toBeDisabled();
    await user.type(modelInput, 'gpt-new-provider');

    // Click next
    await user.click(screen.getByRole('button', { name: 'setup.next' }));

    // Explicitly accept saving this configuration without a connection test.
    await user.click(screen.getByRole('checkbox', { name: 'setup.allow_unverified_label' }));

    // Click finish
    await user.click(screen.getByRole('button', { name: 'setup.finish' }));

    await waitFor(() => expect(createModelProfile).toHaveBeenCalledWith({
      name: 'setup.provider_openai',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-new-provider',
      api_key: 'new-secret-key',
    }));

    // Read policy back and check
    await waitFor(() => {
      const finalPolicy = loadLlmProviderPolicy();
      // A profile is saved (saveToProfiles defaults on), so the DB owns the credentials
      // AND base_url + model. All three are cleared from the session draft — leaving a
      // residual base_url with no key would make the home page validateByok hit
      // `baseUrl && !apiKey` → BYOK_INVALID and deadlock the launch. Only the global
      // prefs the DB profile does NOT carry (reasoningEffort / quota / rpm / tpm) survive.
      expect(finalPolicy.apiKey).toBe('');
      expect(finalPolicy.baseUrl).toBe('');
      expect(finalPolicy.model).toBe('');
      expect(finalPolicy.reasoningEffort).toBe('high');
      expect(finalPolicy.disableUserQuota).toBe(true);
      expect(finalPolicy.requestsPerMinute).toBe(100);
      expect(finalPolicy.tokensPerMinute).toBe(50000);
    });
  });
});
