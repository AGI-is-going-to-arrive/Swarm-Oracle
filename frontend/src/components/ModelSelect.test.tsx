import { cleanup, render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelSelect } from './ModelSelect';
import { listModels } from '../api/client';
import i18n from '../i18n/config';

const realTranslations = vi.hoisted(() => ({ enabled: false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => realTranslations.enabled ? i18n.t(key) : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  listModels: vi.fn(),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ModelSelect', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    realTranslations.enabled = false;
  });

  it('localizes an allowlist error after switching language and preserves a manually entered model', async () => {
    realTranslations.enabled = true;
    vi.mocked(listModels).mockRejectedValueOnce({ status: 400, code: 'LLM_BASE_URL_NOT_ALLOWED', message: 'private endpoint credentials' });
    const props = { baseUrl: 'https://provider.invalid/v1', value: 'My original model', onChange: vi.fn() };
    const view = render(<ModelSelect {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This model service URL is not allowed');
    expect(screen.getByRole('textbox')).toHaveValue('My original model');
    await act(async () => { await i18n.changeLanguage('zh'); });
    view.rerender(<ModelSelect {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('此模型服务地址不在服务器允许列表中');
    expect(screen.queryByText(/private endpoint credentials/)).not.toBeInTheDocument();
    expect(listModels).toHaveBeenCalledOnce();
  });

  it('uses a localized generic fallback without exposing unknown provider errors', async () => {
    realTranslations.enabled = true;
    vi.mocked(listModels).mockRejectedValueOnce(new Error('upstream secret sk-private'));
    render(<ModelSelect baseUrl="https://provider.invalid/v1" value="custom-model" onChange={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(i18n.t('model_select.list_failed'));
    expect(alert).not.toHaveTextContent('sk-private');
    expect(screen.getByRole('textbox')).toHaveValue('custom-model');
  });

  it('renders select dropdown when supported is true and models are not empty', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: ['gpt-4', 'gpt-3.5-turbo'],
      provider: 'openai',
      supported: true,
    });

    const handleChange = vi.fn();
    render(
      <ModelSelect
        baseUrl="https://api.openai.com/v1"
        apiKey="test-key"
        value=""
        onChange={handleChange}
      />
    );

    // Wait for debounce timer (500ms) to run
    await act(async () => {
      await sleep(550);
    });

    await waitFor(() => {
      expect(listModels).toHaveBeenCalledWith('https://api.openai.com/v1', 'test-key');
    });

    // Check if dropdown is rendered
    const select = await screen.findByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /gpt-4/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /gpt-3.5-turbo/i })).toBeInTheDocument();
  });

  it('renders input fallback when supported is false', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [],
      provider: 'custom',
      supported: false,
      reason: 'Not supported',
    });

    const handleChange = vi.fn();
    render(
      <ModelSelect
        baseUrl="https://api.custom.com/v1"
        apiKey="test-key"
        value="my-custom-model"
        onChange={handleChange}
      />
    );

    await act(async () => {
      await sleep(550);
    });

    await waitFor(() => {
      expect(listModels).toHaveBeenCalled();
    });

    // It should render input fallback
    const input = await screen.findByRole('textbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('my-custom-model');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('model_select.fallback_hint')).toBeInTheDocument();
  });

  it('allows manual input override toggle', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: ['gpt-4', 'gpt-3.5-turbo'],
      provider: 'openai',
      supported: true,
    });

    const handleChange = vi.fn();
    render(
      <ModelSelect
        baseUrl="https://api.openai.com/v1"
        value="gpt-4"
        onChange={handleChange}
      />
    );

    await act(async () => {
      await sleep(550);
    });

    await waitFor(() => {
      expect(listModels).toHaveBeenCalled();
    });

    // Originally it should render select dropdown because value is in models list
    const select = await screen.findByRole('combobox');
    expect(select).toBeInTheDocument();

    // Toggle manual input
    const toggleBtn = screen.getByRole('button', { name: 'model_select.manual_input' });

    act(() => {
      fireEvent.click(toggleBtn);
    });

    // Now it should show textbox
    const input = await screen.findByRole('textbox');
    expect(input).toBeInTheDocument();

    // Toggle back to dropdown
    const dropdownBtn = screen.getByRole('button', { name: 'model_select.use_dropdown' });

    act(() => {
      fireEvent.click(dropdownBtn);
    });

    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });
});
