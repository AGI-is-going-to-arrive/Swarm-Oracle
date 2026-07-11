import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProfileManager } from './ModelProfileManager';
import type { ModelProfile } from '../types';

// Mock translation
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (key === 'setup.provider_gemini') return 'Google Gemini';
      // Real i18next accepts an interpolation options object as the 2nd arg; in that
      // case return the key (the mock does not interpolate). Keep string-fallback support.
      return typeof fallback === 'string' ? fallback || key : key;
    },
    i18n: { language: 'en' },
  }),
}));

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
const listModelProfilesMock = vi.hoisted(() => vi.fn());
const createModelProfileMock = vi.hoisted(() => vi.fn());
const patchModelProfileMock = vi.hoisted(() => vi.fn());
const deleteModelProfileMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('../api/client', () => ({
  listModelProfiles: listModelProfilesMock,
  createModelProfile: createModelProfileMock,
  patchModelProfile: patchModelProfileMock,
  deleteModelProfile: deleteModelProfileMock,
}));

afterEach(() => {
  cleanup();
  useCapabilityCheckMock.mockReset();
  listModelProfilesMock.mockReset();
  createModelProfileMock.mockReset();
  patchModelProfileMock.mockReset();
  deleteModelProfileMock.mockReset();
});

const mockProfiles: ModelProfile[] = [
  {
    id: 'profile-1',
    user_id: 'user-1',
    name: 'OpenAI GPT-4o',
    description: 'Main OpenAI model',
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    has_api_key: true,
    rpm: 60,
    tpm: 100000,
    concurrency: 5,
    supports_structured_outputs: true,
    supports_native_search: false,
    native_search_upstream: 'off',
    storage_notice: 'Local storage only',
    created_at: '2026-06-12T15:50:32Z',
    updated_at: '2026-06-12T15:50:32Z',
  },
  {
    id: 'profile-2',
    user_id: 'user-1',
    name: 'Ollama Llama 3',
    description: 'Local model',
    provider: 'ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'llama3',
    has_api_key: false,
    rpm: null,
    tpm: null,
    concurrency: null,
    supports_structured_outputs: false,
    supports_native_search: false,
    native_search_upstream: 'off',
    storage_notice: 'Local storage only',
    created_at: '2026-06-12T15:50:32Z',
    updated_at: '2026-06-12T15:50:32Z',
  },
];

describe('ModelProfileManager', () => {
  it('renders disabled placeholder when capability is disabled', () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: false,
      loading: false,
      error: null,
      reload: vi.fn(),
    });

    render(<ModelProfileManager />);
    expect(screen.getByText('model_profiles.disabled_hint')).toBeInTheDocument();
  });

  it('renders retry button when capability check errors', () => {
    const reloadMock = vi.fn();
    useCapabilityCheckMock.mockReturnValue({
      enabled: false,
      loading: false,
      error: new Error('Probe failed'),
      reload: reloadMock,
    });

    render(<ModelProfileManager />);
    expect(screen.getByText('common.capability_error_title')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'common.retry' });
    fireEvent.click(retryBtn);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('renders list of profiles when capability is enabled', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: mockProfiles, count: 2 });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI GPT-4o')).toBeInTheDocument();
      expect(screen.getByText('Ollama Llama 3')).toBeInTheDocument();
    });
  });

  it('supports creating a new model profile', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({ ...mockProfiles[0], id: 'new-id' });

    render(<ModelProfileManager />);

    // Click add profile
    const addBtn = screen.getByRole('button', { name: 'model_profiles.add_profile' });
    fireEvent.click(addBtn);

    // Fill form
    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'New Profile' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4' } });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), { target: { value: 'sk-test' } });

    // Submit
    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith({
        name: 'New Profile',
        description: undefined,
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4',
        api_key: 'sk-test',
        rpm: null,
        tpm: null,
        concurrency: null,
        supports_structured_outputs: null,
        supports_native_search: null,
        native_search_upstream: 'auto',
      });
    });
  });

  it('allows an exact-local model profile to be created without an api key', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({ ...mockProfiles[1], id: 'local-new' });

    render(<ModelProfileManager />);
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.add_profile' }));
    fireEvent.change(screen.getByLabelText('model_profiles.provider'), {
      target: { value: 'ollama' },
    });
    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), {
      target: { value: 'Local Ollama' },
    });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), {
      target: { value: 'llama3.2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'ollama',
        base_url: 'http://localhost:11434/v1',
        model: 'llama3.2',
        api_key: undefined,
      }));
    });
  });

  it('supports three-state select roundtrip for supports fields', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({ ...mockProfiles[0], id: 'new-id-2' });

    render(<ModelProfileManager />);

    const addBtn = screen.getByRole('button', { name: 'model_profiles.add_profile' });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'Three-State Profile' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4' } });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), { target: { value: 'sk-test' } });

    const structuredSelect = screen.getByLabelText('model_profiles.supports_structured_outputs') as HTMLSelectElement;
    const nativeSearchSelect = screen.getByLabelText('model_profiles.supports_native_search') as HTMLSelectElement;
    expect(structuredSelect.value).toBe('auto');
    expect(nativeSearchSelect.value).toBe('auto');

    fireEvent.change(structuredSelect, { target: { value: 'on' } });
    fireEvent.change(nativeSearchSelect, { target: { value: 'off' } });

    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith(expect.objectContaining({
        supports_structured_outputs: true,
        supports_native_search: false,
        native_search_upstream: 'off',
      }));
    });
  });

  it('passes the native_search_upstream xai_responses value as a string through the create payload', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({ ...mockProfiles[0], id: 'new-id-xai' });

    render(<ModelProfileManager />);

    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.add_profile' }));
    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'Upstream Profile' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'grok-composer-2.5-fast' } });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), { target: { value: 'sk-test' } });

    // The native-search select is now a 4-option upstream enum; selecting an
    // upstream-specific value must be sent verbatim (NOT mapped to a boolean).
    const nativeSearchSelect = screen.getByLabelText('model_profiles.supports_native_search') as HTMLSelectElement;
    fireEvent.change(nativeSearchSelect, { target: { value: 'xai_responses' } });
    expect(nativeSearchSelect.value).toBe('xai_responses');

    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith(expect.objectContaining({
        supports_native_search: null,
        native_search_upstream: 'xai_responses',
      }));
    });
  });

  it('validates concurrency field strictly and rejects invalid values', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({ ...mockProfiles[0], id: 'new-id-concurrency' });

    render(<ModelProfileManager />);

    const addBtn = screen.getByRole('button', { name: 'model_profiles.add_profile' });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'Concurrency Profile' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4' } });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), { target: { value: 'sk-test' } });
    const concurrencyInput = screen.getByLabelText('model_profiles.concurrency') as HTMLInputElement;

    // Float decimal
    fireEvent.change(concurrencyInput, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Negative number
    fireEvent.change(concurrencyInput, { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Zero — backend coerces <=0 to "no cap" (silent no-op), so the UI must reject it
    fireEvent.change(concurrencyInput, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Unsafe-large integer (> Number.MAX_SAFE_INTEGER) — parseInt would silently lose precision
    fireEvent.change(concurrencyInput, { target: { value: '9007199254740993' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Above the sane upper bound (MAX_CONCURRENCY = 1024)
    fireEvent.change(concurrencyInput, { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Non-numeric
    fireEvent.change(concurrencyInput, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_concurrency_invalid')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });

    // Valid positive integer
    fireEvent.change(concurrencyInput, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));
    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith(expect.objectContaining({
        concurrency: 5,
      }));
    });
  });

  it('offers Gemini and applies its OpenAI-compatible base URL when selected', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    createModelProfileMock.mockResolvedValue({
      ...mockProfiles[0],
      id: 'gemini-profile',
      provider: 'gemini',
    });

    render(<ModelProfileManager />);

    await screen.findByText('model_profiles.no_profiles');
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.add_profile' }));

    const providerSelect = screen.getByLabelText('model_profiles.provider') as HTMLSelectElement;
    const geminiOption = screen.getByRole('option', { name: 'Google Gemini' }) as HTMLOptionElement;
    expect(geminiOption.value).toBe('gemini');

    fireEvent.change(providerSelect, { target: { value: 'gemini' } });

    expect(providerSelect.value).toBe('gemini');
    expect(screen.getByLabelText('model_profiles.base_url')).toHaveValue(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );

    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), {
      target: { value: 'Gemini Profile' },
    });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), {
      target: { value: 'gemini-2.5-pro' },
    });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), {
      target: { value: 'sk-gemini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(createModelProfileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Gemini Profile',
          provider: 'gemini',
          base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
          model: 'gemini-2.5-pro',
          api_key: 'sk-gemini',
        }),
      );
    });
  });

  it('redacts api_key on edit form init and supports clear-key action', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: mockProfiles, count: 2 });
    patchModelProfileMock.mockResolvedValue({ ...mockProfiles[0], has_api_key: false });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI GPT-4o')).toBeInTheDocument();
    });

    const editBtns = screen.getAllByRole('button', { name: /Edit/ });
    fireEvent.click(editBtns[0]); // Edit mockProfiles[0]

    // Form inputs checks
    const keyInput = screen.getByLabelText('model_profiles.api_key') as HTMLInputElement;
    expect(keyInput.value).toBe(''); // Initial state MUST be empty, never echo back
    expect(screen.getByText('model_profiles.api_key_set')).toBeInTheDocument(); // Key set badge present

    // Click clear key
    const clearBtn = screen.getByRole('button', { name: 'model_profiles.clear_key' });
    fireEvent.click(clearBtn);

    expect(screen.getByText('model_profiles.key_cleared_on_save')).toBeInTheDocument();

    // Clear base_url to satisfy validation
    fireEvent.change(screen.getByLabelText('model_profiles.base_url'), { target: { value: '' } });
    // Endpoint changes invalidate the old provider-bound model as well. Re-entering
    // it makes the new keyless/server-default binding explicit before saving.
    expect(screen.getByLabelText('model_profiles.model')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4o' } });

    // Submit
    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-1', expect.objectContaining({
        base_url: '',
        model: 'gpt-4o',
      }));
    });
    const patchPayload = patchModelProfileMock.mock.calls[0]?.[1];
    // Changing the endpoint invalidates the old server-side credential atomically;
    // the write-only secret must never be echoed back into this request.
    expect(patchPayload).not.toHaveProperty('api_key');
  });

  it('clears provider-bound fields when an edited profile switches provider', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [mockProfiles[0]], count: 1 });
    patchModelProfileMock.mockResolvedValue({ ...mockProfiles[0], provider: 'deepseek' });

    render(<ModelProfileManager />);
    await screen.findByText('OpenAI GPT-4o');
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));

    fireEvent.change(screen.getByLabelText('model_profiles.provider'), {
      target: { value: 'deepseek' },
    });

    expect(screen.getByLabelText('model_profiles.base_url')).toHaveValue(
      'https://api.deepseek.com/v1',
    );
    expect(screen.getByLabelText('model_profiles.model')).toHaveValue('');
    expect(screen.getByLabelText('model_profiles.api_key')).toHaveValue('');
    expect(screen.getByLabelText('model_profiles.rpm')).toHaveValue(null);
    expect(screen.getByLabelText('model_profiles.tpm')).toHaveValue(null);
    expect(screen.getByLabelText('model_profiles.concurrency')).toHaveValue('');
    expect(screen.getByLabelText('model_profiles.supports_structured_outputs')).toHaveValue('auto');
    expect(screen.getByLabelText('model_profiles.supports_native_search')).toHaveValue('auto');

    fireEvent.change(screen.getByLabelText('model_profiles.model'), {
      target: { value: 'deepseek-chat' },
    });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), {
      target: { value: 'deepseek-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-1', expect.objectContaining({
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        api_key: 'deepseek-key',
        rpm: null,
        tpm: null,
        concurrency: null,
        supports_structured_outputs: null,
        supports_native_search: null,
        native_search_upstream: 'auto',
      }));
    });
  });

  it('backfills native_search_upstream on edit and round-trips xai_responses', async () => {
    const xaiProfile: ModelProfile = {
      ...mockProfiles[0],
      id: 'profile-xai',
      name: 'Grok Proxy',
      native_search_upstream: 'xai_responses',
    };
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [xaiProfile], count: 1 });
    patchModelProfileMock.mockResolvedValue({ ...xaiProfile });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('Grok Proxy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]);

    // Editing an existing profile must back-fill the upstream select from
    // profile.native_search_upstream (not reset to the 'auto' default).
    const nativeSelect = screen.getByLabelText('model_profiles.supports_native_search') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('xai_responses');

    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-xai', expect.objectContaining({
        supports_native_search: null,
        native_search_upstream: 'xai_responses',
      }));
    });
  });

  it('clears a hidden legacy supports_native_search=false when editing to an explicit native upstream', async () => {
    const legacyBlockedProfile: ModelProfile = {
      ...mockProfiles[0],
      id: 'profile-legacy-blocked',
      name: 'Legacy Blocked Proxy',
      supports_native_search: false,
      native_search_upstream: 'off',
    };
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [legacyBlockedProfile], count: 1 });
    patchModelProfileMock.mockResolvedValue({ ...legacyBlockedProfile, native_search_upstream: 'xai_responses' });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('Legacy Blocked Proxy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]);
    fireEvent.change(screen.getByLabelText('model_profiles.supports_native_search'), {
      target: { value: 'xai_responses' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-legacy-blocked', expect.objectContaining({
        supports_native_search: null,
        native_search_upstream: 'xai_responses',
      }));
    });
  });

  it('preserves an existing supports_native_search=true override when editing without changing upstream', async () => {
    const forceEnabledProfile: ModelProfile = {
      ...mockProfiles[0],
      id: 'profile-force-native',
      name: 'Force Native Auto',
      supports_native_search: true,
      native_search_upstream: 'auto',
    };
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [forceEnabledProfile], count: 1 });
    patchModelProfileMock.mockResolvedValue({ ...forceEnabledProfile });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('Force Native Auto')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]);
    expect(screen.getByLabelText('model_profiles.supports_native_search')).toHaveValue('auto');

    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-force-native', expect.objectContaining({
        supports_native_search: true,
        native_search_upstream: 'auto',
      }));
    });
  });

  it('clears an existing supports_native_search=true override when editing to a different upstream', async () => {
    const forceEnabledProfile: ModelProfile = {
      ...mockProfiles[0],
      id: 'profile-force-native-switch',
      name: 'Force Native Switch',
      supports_native_search: true,
      native_search_upstream: 'auto',
    };
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [forceEnabledProfile], count: 1 });
    patchModelProfileMock.mockResolvedValue({ ...forceEnabledProfile, native_search_upstream: 'xai_responses' });

    render(<ModelProfileManager />);

    await waitFor(() => {
      expect(screen.getByText('Force Native Switch')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]);
    fireEvent.change(screen.getByLabelText('model_profiles.supports_native_search'), {
      target: { value: 'xai_responses' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'model_profiles.save' }));

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-force-native-switch', expect.objectContaining({
        supports_native_search: null,
        native_search_upstream: 'xai_responses',
      }));
    });
  });

  it('performs client-side validations for base_url api_key rules', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });

    render(<ModelProfileManager />);

    // Click add profile
    const addBtn = screen.getByRole('button', { name: 'model_profiles.add_profile' });
    fireEvent.click(addBtn);

    // Fill base URL but no API Key
    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'Invalid Profile' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4' } });
    fireEvent.change(screen.getByLabelText('model_profiles.base_url'), { target: { value: 'https://api.openai.com/v1' } });
    // Keep API Key blank

    // Submit
    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_base_url_api_key')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });
  });

  it('validates base_url shape strictly', async () => {
    useCapabilityCheckMock.mockReturnValue({
      enabled: true,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });

    render(<ModelProfileManager />);

    const addBtn = screen.getByRole('button', { name: 'model_profiles.add_profile' });
    fireEvent.click(addBtn);

    // Fill invalid URL (has query params)
    fireEvent.change(screen.getByLabelText('model_profiles.profile_name'), { target: { value: 'Invalid Url' } });
    fireEvent.change(screen.getByLabelText('model_profiles.model'), { target: { value: 'gpt-4' } });
    fireEvent.change(screen.getByLabelText('model_profiles.base_url'), { target: { value: 'https://api.openai.com/v1?key=123' } });
    fireEvent.change(screen.getByLabelText('model_profiles.api_key'), { target: { value: 'sk-test' } });

    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText('model_profiles.validation_invalid_base_url')).toBeInTheDocument();
      expect(createModelProfileMock).not.toHaveBeenCalled();
    });
  });
});
