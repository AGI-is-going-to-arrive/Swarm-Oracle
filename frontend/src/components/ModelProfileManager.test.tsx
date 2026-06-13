import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProfileManager } from './ModelProfileManager';
import type { ModelProfile } from '../types';

// Mock translation
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
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
        supports_structured_outputs: false,
        supports_native_search: false,
      });
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

    expect(screen.getByText('Key will be cleared on save')).toBeInTheDocument();

    // Clear base_url to satisfy validation
    fireEvent.change(screen.getByLabelText('model_profiles.base_url'), { target: { value: '' } });

    // Submit
    const saveBtn = screen.getByRole('button', { name: 'model_profiles.save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchModelProfileMock).toHaveBeenCalledWith('profile-1', expect.objectContaining({
        api_key: '',
        base_url: '',
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
