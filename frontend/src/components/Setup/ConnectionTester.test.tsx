import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionTester } from './ConnectionTester';
import { testLlmConnection } from '../../api/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../../api/client', () => ({
  testLlmConnection: vi.fn(),
  isApiError: vi.fn((error: unknown) => error instanceof Error && 'status' in error),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectionTester', () => {
  it('treats the backend nested llm ok response as success', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: {
        status: 'ok',
        model: 'gpt-test',
        response: 'model responded',
      },
    });

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'model responded',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--success')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'setup.test_failure',
    );

    // ConnectionTester must request a credential-only check (no 36-call parallelism
    // probe) — the 6th arg is includeProbe=false, so the backend skips the slow
    // measure_provider_parallelism path that caused the 53s timeout. (Gate3 setup-timeout fix)
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'https://api.example.com/v1',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
    );
  });

  it('surfaces the backend nested llm error response as failure', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: {
        status: 'error',
        model: 'gpt-test',
        error: 'invalid api key',
      },
    });

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="bad-key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'invalid api key',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--error')).toBeInTheDocument();
    });
  });

  it('keeps the legacy top-level success response including latency', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      status: 'success',
      message: 'legacy ok',
      latency_ms: 42,
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'legacy ok · 42 ms',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--success')).toBeInTheDocument();
    });
  });

  it('renders a blocked native-search probe block with backend message + detail', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
      native_search: {
        would_inject_tools: false,
        blocking_reasons: ['is_proxy', 'is_chat'],
        message: 'local proxy cannot use native search',
        detail: {
          provider: 'local',
          is_proxy: true,
          api_form: 'chat',
          adapter: 'null',
          supports_native_search: false,
        },
      },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester
        baseUrl="http://127.0.0.1:8317/v1"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="auto"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => {
      expect(container.querySelector('.tester__native--blocked')).toBeInTheDocument();
    });
    expect(screen.getByText('setup.native_probe_unsupported')).toBeInTheDocument();
    expect(screen.getByText('local proxy cannot use native search')).toBeInTheDocument();
    expect(container.querySelector('.tester__native-detail')).toHaveTextContent('provider=local');

    // includeNativeProbe (7th) + nativeSearchUpstream="auto" (8th) forwarded to the API
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'http://127.0.0.1:8317/v1',
      undefined,
      undefined,
      undefined,
      false,
      true,
      'auto',
    );
  });

  it('renders a supported native-search probe block', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
      native_search: {
        would_inject_tools: true,
        blocking_reasons: [],
        message: 'native search available',
        detail: {
          provider: 'xai',
          is_proxy: false,
          api_form: 'responses',
          adapter: 'xai',
          supports_native_search: true,
        },
      },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="xai_responses"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => {
      expect(container.querySelector('.tester__native--ok')).toBeInTheDocument();
    });
    expect(screen.getByText('setup.native_probe_supported')).toBeInTheDocument();
  });

  it('omits the native-search block when backend returns no native_search', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'gpt-test', response: 'ok' },
    });

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    await screen.findByRole('status');
    expect(container.querySelector('.tester__native')).not.toBeInTheDocument();
  });
});
