import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShareModal from './ShareModal';

const { generateSocialCopyMock } = vi.hoisted(() => ({
  generateSocialCopyMock: vi.fn(async () => ({
    copy: '生成好的文案',
    platform_name: '小红书',
  })),
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
    generateSocialCopyMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports selected platform and generated copy', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <ShareModal
        scenarioId="scenario-1"
        shareContext={{
          profileLabel: '贸易绞盘',
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
    expect(screen.queryByText('贸易绞盘')).not.toBeInTheDocument();
    expect(screen.queryByText('校准')).not.toBeInTheDocument();
    expect(screen.queryByText('命中题材核心')).not.toBeInTheDocument();
    expect(screen.queryByText('关税杠杆')).not.toBeInTheDocument();
    expect(screen.queryByText(/https:\/\/example\.com\/result\/scenario-1/)).not.toBeInTheDocument();
    expect(generateSocialCopyMock).toHaveBeenCalledWith('scenario-1', 'xiaohongshu', {
      llmApiKey: 'sk-test',
      llmBaseUrl: 'https://example.com/v1/chat/completions',
      llmModel: 'gpt-test',
      llmRequestsPerMinute: 10,
      llmTokensPerMinute: 100000,
      userId: 'director-1',
    });
  });

  it('exposes dialog semantics and an accessible close control', () => {
    render(
      <ShareModal
        scenarioId="scenario-dialog"
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'share.title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
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
});
