import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShareModal from './ShareModal';

const { generateSocialCopyMock, html2canvasMock } = vi.hoisted(() => ({
  generateSocialCopyMock: vi.fn(async (
    ...args: [string?, string?, unknown?, { signal?: AbortSignal }?]
  ) => {
    void args;
    return {
      copy: '生成好的文案',
      platform_name: '小红书',
    };
  }),
  html2canvasMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../api/client', () => ({
  generateSocialCopy: generateSocialCopyMock,
}));

vi.mock('../hooks/screenCaptureHtmlVendor', () => ({
  html2canvas: html2canvasMock,
}));

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({
    userId: 'director-1',
    userName: 'Local Director',
  }),
}));

describe('ShareModal automation callback', () => {
  beforeEach(() => {
    const sessionStore = new Map<string, string>();
    sessionStore.set('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
    }));
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        sessionStore.delete(key);
      }),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:swarmoracle-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    html2canvasMock.mockReset();
    generateSocialCopyMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports selected platform and generated copy', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <ShareModal
        scenarioId="scenario-1"
        shareContext={{
          profileLabel: '贸易经济',
          runtimePresetLabel: '校准',
          profileHooks: ['关税杠杆', '港口封锁'],
          resonanceLabel: '命中题材核心',
          permalinkUrl: 'https://example.com/result/scenario-1',
        }}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('share_modal');
    expect(latestState.active_platform).toBe('xiaohongshu');
    expect(latestState.status).toBe('success');
    expect(latestState.has_copy).toBe(true);
    expect(latestState.copy_length).toBeGreaterThan(0);
    expect(screen.getByText('share.ready')).toBeInTheDocument();
    expect(screen.getByText('share.ready_hint')).toBeInTheDocument();
    expect(screen.getByText('生成好的文案')).toBeInTheDocument();
    expect(screen.queryByText('贸易经济')).not.toBeInTheDocument();
    expect(screen.queryByText('校准')).not.toBeInTheDocument();
    expect(screen.queryByText('命中题材核心')).not.toBeInTheDocument();
    expect(screen.queryByText('关税杠杆')).not.toBeInTheDocument();
    expect(screen.queryByText(/https:\/\/example\.com\/result\/scenario-1/)).not.toBeInTheDocument();
    expect(generateSocialCopyMock).toHaveBeenCalledWith(
      'scenario-1',
      'xiaohongshu',
      {
        llmApiKey: 'sk-test',
        llmBaseUrl: 'https://example.com/v1/chat/completions',
        llmModel: 'gpt-test',
        llmRequestsPerMinute: 10,
        llmTokensPerMinute: 100000,
        userId: 'director-1',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('exposes dialog semantics and closes from Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ShareModal
        scenarioId="scenario-dialog"
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'share.title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const closeButton = screen.getByRole('button', { name: 'common.close' });
    expect(closeButton).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading guidance before the generated copy is ready', async () => {
    let resolveRequest!: (value: { copy: string; platform_name: string }) => void;
    generateSocialCopyMock.mockImplementationOnce(
      () => new Promise<{ copy: string; platform_name: string }>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <ShareModal
        scenarioId="scenario-2"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    const loadingRegion = screen.getByRole('status');
    expect(loadingRegion).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('share.generating_hint')).toBeInTheDocument();
    const loadingState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(loadingState.status).toBe('loading');
    expect(loadingState.loading).toBe(true);

    resolveRequest({
      copy: '稍后完成的文案',
      platform_name: '小红书',
    });

    await waitFor(() => {
      expect(screen.getByText(/稍后完成的文案/)).toBeInTheDocument();
    });
  });

  it('keeps an in-flight request alive when automation updates rerender the parent', async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveRequest!: (value: { copy: string; platform_name: string }) => void;
    generateSocialCopyMock.mockImplementationOnce(
      (
        _scenarioId?: string,
        _platform?: string,
        _options?: unknown,
        requestOptions?: { signal?: AbortSignal },
      ) => {
        requestSignal = requestOptions?.signal;
        return new Promise<{ copy: string; platform_name: string }>((resolve) => {
          resolveRequest = resolve;
        });
      },
    );
    const user = userEvent.setup();

    function RerenderHarness() {
      const [, setAutomationState] = useState<Record<string, unknown> | null>(null);
      return (
        <ShareModal
          scenarioId="scenario-parent-rerender"
          onClose={() => {}}
          onAutomationStateChange={setAutomationState}
        />
      );
    }

    render(<RerenderHarness />);

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    await waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    expect(requestSignal?.aborted).toBe(false);

    resolveRequest({
      copy: '父级重渲染后仍然完成的文案',
      platform_name: '小红书',
    });

    await waitFor(() => {
      expect(screen.getByText(/父级重渲染后仍然完成的文案/)).toBeInTheDocument();
    });
    expect(requestSignal?.aborted).toBe(false);
  });

  it('aborts in-flight social-copy generation when unmounted', async () => {
    let requestSignal: AbortSignal | undefined;
    generateSocialCopyMock.mockImplementationOnce(
      (
        _scenarioId?: string,
        _platform?: string,
        _options?: unknown,
        requestOptions?: { signal?: AbortSignal },
      ) => {
        requestSignal = requestOptions?.signal;
        return new Promise<{ copy: string; platform_name: string }>(() => undefined);
      },
    );
    const user = userEvent.setup();
    const view = render(
      <ShareModal
        scenarioId="scenario-abort"
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    await waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it('shows an explicit copy error when Clipboard API is unavailable', async () => {
    const user = userEvent.setup();

    render(
      <ShareModal
        scenarioId="scenario-3"
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));
    await waitFor(() => {
      expect(screen.getByText(/生成好的文案/)).toBeInTheDocument();
    });

    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'share.copy_btn' }));

    expect(writeTextSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/share\.copy_error/)).toBeInTheDocument();
    });
  });

  it('maps structured API errors to localized generation messages', async () => {
    generateSocialCopyMock.mockRejectedValueOnce({
      status: 503,
      code: 'LLM_TEMPORARILY_UNAVAILABLE',
    });

    const user = userEvent.setup();

    render(
      <ShareModal
        scenarioId="scenario-4"
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-live', 'assertive');
      expect(alert).toHaveTextContent(/common\.api_errors\.llm_unavailable/);
    });
  });

  it('turns blank generated copy into a visible error instead of an empty success state', async () => {
    generateSocialCopyMock.mockResolvedValueOnce({
      copy: '   \n\t  ',
      platform_name: '小红书',
    });

    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <ShareModal
        scenarioId="scenario-blank"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('share.error');
    });

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.status).toBe('error');
    expect(latestState.has_copy).toBe(false);
    expect(latestState.copy_length).toBe(0);
    expect(screen.queryByText('share.ready')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'share.copy_btn' })).not.toBeInTheDocument();
  });

  it('blocks copy generation when BYOK baseUrl is set without an apiKey', async () => {
    window.sessionStorage.setItem('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: '',
      baseUrl: 'https://example.com/v1',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
    }));
    const user = userEvent.setup();

    render(
      <ShareModal
        scenarioId="scenario-invalid"
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /share\.platform_xiaohongshu/ }));

    expect(generateSocialCopyMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/conversation\.error\.byok_invalid/)).toBeInTheDocument();
  });

  it('exports the offscreen share artifact as a PNG without rendering BYOK secrets', async () => {
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob(['png'], { type: 'image/png' }));
    });
    html2canvasMock.mockResolvedValueOnce({ toBlob });
    const user = userEvent.setup();

    render(
      <ShareModal
        scenarioId="scenario-image"
        shareContext={{
          profileLabel: 'Risk desk',
          runtimePresetLabel: 'Balanced',
          profileHooks: ['hook'],
          resonanceLabel: 'resonance',
          permalinkUrl: 'https://example.com/result/scenario-image',
        }}
        branches={[
          {
            id: 'b1',
            parent_branch_id: null,
            fork_round: 0,
            fork_reason: 'baseline',
            title: 'Outcome A',
            description: 'Description',
            summary: 'Summary',
            story: 'Story',
            probability: 0,
            insight: 'Unicode 标题 ✅',
            key_moments: [],
            status: 'COMPLETED',
          },
        ]}
        agentNames={['Agent One']}
        sourceFamilies={['news_deep']}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('sk-test')).not.toBeInTheDocument();
    expect(screen.queryByText('https://example.com/v1/chat/completions')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('share-export-image-btn'));

    await waitFor(() => {
      expect(html2canvasMock).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          backgroundColor: '#0f172a',
          width: 1200,
          height: 630,
        }),
      );
    });
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', 0.95);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });
});
