import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionTester } from './ConnectionTester';
import { testLlmConnection, probeNativeSearch } from '../../api/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../../api/client', () => ({
  testLlmConnection: vi.fn(),
  probeNativeSearch: vi.fn(),
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
      false, // decoupled
      undefined,
      undefined,
    );
    expect(probeNativeSearch).not.toHaveBeenCalled();
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
    vi.mocked(probeNativeSearch).mockResolvedValue({
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
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
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

    expect(probeNativeSearch).toHaveBeenCalledWith(
      'key',
      'http://127.0.0.1:8317/v1',
      undefined,
      'auto',
      undefined,
    );
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'http://127.0.0.1:8317/v1',
      undefined,
      undefined,
      undefined,
      false,
      false, // decoupled
      'auto',
      undefined,
    );
  });

  it('renders a supported native-search probe block', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
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
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
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

  it('renders the effective API form when the backend derives Responses from a chat base URL', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
      would_inject_tools: true,
      blocking_reasons: [],
      message: 'native search available',
      detail: {
        provider: 'xai',
        is_proxy: false,
        api_form: 'chat',
        effective_api_form: 'responses',
        adapter: 'xai',
        supports_native_search: true,
      },
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="auto"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    const detail = await waitFor(() => {
      const node = container.querySelector('.tester__native-detail');
      expect(node).toBeInTheDocument();
      return node;
    });
    expect(detail).toHaveTextContent('responses');
    expect(detail).not.toHaveTextContent('chat');
  });

  it('passes the native-search support override to both probe paths', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
      would_inject_tools: false,
      blocking_reasons: ['capability_off'],
      message: 'capability disabled',
      detail: {
        provider: 'xai',
        is_proxy: false,
        api_form: 'responses',
        adapter: 'xai',
        supports_native_search: false,
      },
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="xai_responses"
        supportsNativeSearchOverride={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => {
      expect(probeNativeSearch).toHaveBeenCalledWith(
        'key',
        'https://api.x.ai/v1/responses',
        undefined,
        'xai_responses',
        false,
      );
    });
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'https://api.x.ai/v1/responses',
      undefined,
      undefined,
      undefined,
      false,
      false,
      'xai_responses',
      false,
    );
  });

  it('passes a null native-search support override instead of dropping it', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
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
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="xai_responses"
        supportsNativeSearchOverride={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => {
      expect(probeNativeSearch).toHaveBeenCalledWith(
        'key',
        'https://api.x.ai/v1/responses',
        undefined,
        'xai_responses',
        null,
      );
    });
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'https://api.x.ai/v1/responses',
      undefined,
      undefined,
      undefined,
      false,
      false,
      'xai_responses',
      null,
    );
  });

  it('passes a true native-search support override to both probe and full test', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
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
    });
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="auto"
        supportsNativeSearchOverride={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    await waitFor(() => {
      expect(probeNativeSearch).toHaveBeenCalledWith(
        'key',
        'https://api.x.ai/v1/responses',
        undefined,
        'auto',
        true,
      );
    });
    expect(testLlmConnection).toHaveBeenCalledWith(
      'key',
      'https://api.x.ai/v1/responses',
      undefined,
      undefined,
      undefined,
      false,
      false,
      'auto',
      true,
    );
  });

  it('renders probe request failures separately from unsupported native search', async () => {
    vi.mocked(probeNativeSearch).mockRejectedValue(new Error('probe exploded'));
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
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
      expect(container.querySelector('.tester__native--error')).toBeInTheDocument();
    });
    expect(screen.getByText('setup.native_probe_failed')).toBeInTheDocument();
    expect(screen.queryByText('setup.native_probe_unsupported')).not.toBeInTheDocument();
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

  it('renders native-search probe immediately while full connection test is pending or timed out', async () => {
    vi.mocked(probeNativeSearch).mockResolvedValue({
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
    });

    let resolveLlmTest: (value: unknown) => void = () => {};
    const llmPromise = new Promise((resolve) => {
      resolveLlmTest = resolve;
    });
    vi.mocked(testLlmConnection).mockReturnValue(llmPromise as unknown as ReturnType<typeof testLlmConnection>);

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

    // main status should be in testing state
    expect(screen.getByRole('status')).toHaveTextContent('setup.testing');

    // native search probe should render immediately
    await waitFor(() => {
      expect(container.querySelector('.tester__native--ok')).toBeInTheDocument();
    });
    expect(screen.getByText('setup.native_probe_supported')).toBeInTheDocument();
    expect(screen.getByText('native search available')).toBeInTheDocument();

    resolveLlmTest({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    });

    // Wait for the full test state update to settle to prevent act() warnings
    expect(await screen.findByRole('status')).toHaveTextContent('OK.');
  });

  it('keeps the button disabled while the native probe is still pending', async () => {
    let resolveNativeProbe: (value: unknown) => void = () => {};
    vi.mocked(probeNativeSearch).mockReturnValue(new Promise((resolve) => {
      resolveNativeProbe = resolve;
    }) as unknown as ReturnType<typeof probeNativeSearch>);
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'grok', response: 'OK.' },
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="xai_responses"
      />,
    );

    const button = screen.getByRole('button', { name: 'setup.test_button' });
    await user.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('OK.');
    expect(button).toBeDisabled();

    resolveNativeProbe({
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
    });

    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('ignores a pending native probe after the tested inputs change', async () => {
    let resolveNativeProbe: (value: unknown) => void = () => {};
    vi.mocked(probeNativeSearch).mockReturnValue(new Promise((resolve) => {
      resolveNativeProbe = resolve;
    }) as unknown as ReturnType<typeof probeNativeSearch>);
    vi.mocked(testLlmConnection).mockReturnValue(new Promise(() => {}) as unknown as ReturnType<typeof testLlmConnection>);

    const user = userEvent.setup();
    const { rerender } = render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="xai_responses"
        supportsNativeSearchOverride={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    expect(screen.getByText('setup.native_probe_probing')).toBeInTheDocument();

    rerender(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="off"
        supportsNativeSearchOverride={false}
      />,
    );

    await act(async () => {
      resolveNativeProbe({
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
      });
    });

    expect(screen.queryByText('setup.native_probe_supported')).not.toBeInTheDocument();
    expect(screen.queryByText('native search available')).not.toBeInTheDocument();
  });

  it('treats omitted and null native-search support overrides as different tested inputs', async () => {
    let resolveNativeProbe: (value: unknown) => void = () => {};
    vi.mocked(probeNativeSearch).mockReturnValue(new Promise((resolve) => {
      resolveNativeProbe = resolve;
    }) as unknown as ReturnType<typeof probeNativeSearch>);
    vi.mocked(testLlmConnection).mockReturnValue(new Promise(() => {}) as unknown as ReturnType<typeof testLlmConnection>);

    const user = userEvent.setup();
    const { rerender } = render(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="auto"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));
    expect(screen.getByText('setup.native_probe_probing')).toBeInTheDocument();

    rerender(
      <ConnectionTester
        baseUrl="https://api.x.ai/v1/responses"
        apiKey="key"
        includeNativeProbe
        nativeSearchUpstream="auto"
        supportsNativeSearchOverride={null}
      />,
    );

    await act(async () => {
      resolveNativeProbe({
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
      });
    });

    expect(screen.queryByText('setup.native_probe_supported')).not.toBeInTheDocument();
    expect(screen.queryByText('native search available')).not.toBeInTheDocument();
  });

  it('records raw payload for non-ApiError connection failures', async () => {
    vi.mocked(testLlmConnection).mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent('setup.test_failure_network');
    await user.click(screen.getByRole('button', { name: 'setup.show_log' }));
    expect(container.querySelector('.tester__log')).toHaveTextContent(
      '"message": "setup.test_failure_network"',
    );
  });
});
