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
    const store = new Map<string, string>();
    store.set('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-test',
      reasoningEffort: 'medium',
    }));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
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
    expect(screen.getByText('贸易绞盘')).toBeInTheDocument();
    expect(screen.getByText('命中题材核心')).toBeInTheDocument();
    expect(screen.getByText('关税杠杆')).toBeInTheDocument();
    expect(screen.getByText(/生成好的文案/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.com\/result\/scenario-1/)).toBeInTheDocument();
    expect(generateSocialCopyMock).toHaveBeenCalledWith('scenario-1', 'xiaohongshu', {
      llmApiKey: 'sk-test',
      llmBaseUrl: 'https://example.com/v1/chat/completions',
      llmModel: 'gpt-test',
      userId: 'director-1',
    });
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
});
