import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShareModal from './ShareModal';
import { decodePublicArtifactHash, MAX_GALLERY_URL_CHARS } from '../gallery/artifactLink';

const { generateSocialCopyMock, html2canvasMock, buildPublicArtifactMock, useCapabilityCheckMock } = vi.hoisted(() => ({
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
  buildPublicArtifactMock: vi.fn(),
  useCapabilityCheckMock: vi.fn(() => {
    const res: {
      loading: boolean;
      enabled: boolean;
      capabilities: null;
      error?: Error | null;
      reload?: () => Promise<void>;
    } = {
      loading: false,
      enabled: true,
      capabilities: null,
    };
    return res;
  }),
}));

const publicArtifactFixture = {
  schema_version: 'public_artifact.v1' as const,
  question: 'Mocked Question?',
  language: 'en',
  display_agent_names: ['Agent Alpha'],
  branch_verdicts: [
    { branch_index: 1, title: 'Branch 1', verdict: 'Verdict 1', confidence: 'high' as const },
  ],
  probability_bars: [
    { branch_index: 1, label: 'Bar 1', probability: 0.9 },
  ],
  transcript_excerpts: [],
  source_summary: { domains: [] },
};

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob'));
    reader.readAsText(blob);
  });
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../api/client', () => ({
  generateSocialCopy: generateSocialCopyMock,
  getSessionBoundUserId: vi.fn(() => 'default_user'),
  buildPublicArtifact: buildPublicArtifactMock,
  getSocialFeed: vi.fn(async () => ({
    scenario_id: 'scenario-1',
    question: 'Mocked Question?',
    generation_mode: 'llm',
    events: [],
    headline_cards: [
      {
        card_id: 'card_1',
        headline: 'Test Headline',
        summary: 'Test Headline Summary',
        branch_title: 'Test Branch',
        round_number: 1,
        event_type: 'Test Event',
        faction_label: 'Test Faction',
        source_event_id: 'event_1',
      },
    ],
  })),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
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
    buildPublicArtifactMock.mockReset();
    buildPublicArtifactMock.mockResolvedValue(publicArtifactFixture);
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

    await waitFor(() => {
      expect(onAutomationStateChange.mock.calls.at(-1)?.[0]?.status).toBe('success');
    });

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
        userId: 'default_user',
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

  describe('Public Artifact Export', () => {
    it('disables buttons and shows hint when capability is disabled', () => {
      useCapabilityCheckMock.mockReturnValueOnce({
        loading: false,
        enabled: false,
        capabilities: null,
      });

      render(<ShareModal scenarioId="scenario-disabled" onClose={() => {}} />);

      expect(screen.getByText('public_artifacts.section_title')).toBeInTheDocument();
      expect(screen.getByText(/public_artifacts\.disabled_hint/)).toBeInTheDocument();

      const downloadJsonBtn = screen.getByRole('button', { name: /public_artifacts\.download_json/ });
      const downloadHtmlBtn = screen.getByRole('button', { name: /public_artifacts\.download_html/ });

      expect(downloadJsonBtn).toBeDisabled();
      expect(downloadHtmlBtn).toBeDisabled();
      expect(screen.queryByRole('button', { name: /public_artifacts\.copy_gallery_link/ })).toBeNull();
    });

    it('copies one sanitized Gallery fragment link and shows an accessible success state', async () => {
      const user = userEvent.setup();
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      render(
        <ShareModal
          scenarioId="scenario-gallery-link"
          shareContext={{
            profileLabel: 'sk-private-must-not-leak',
            permalinkUrl: 'https://private.example.test/result?token=secret',
          }}
          onClose={() => {}}
        />,
      );

      await user.click(screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ }));

      await waitFor(() => {
        expect(writeTextSpy).toHaveBeenCalledTimes(1);
      });
      expect(buildPublicArtifactMock).toHaveBeenCalledTimes(1);
      expect(buildPublicArtifactMock.mock.calls[0][0]).toBe('scenario-gallery-link');

      const copiedUrl = writeTextSpy.mock.calls[0][0];
      const url = new URL(copiedUrl);
      expect(url.pathname.endsWith('/gallery.html')).toBe(true);
      const decoded = decodePublicArtifactHash(url.hash);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(JSON.parse(decoded.json)).toEqual(publicArtifactFixture);
        expect(decoded.json).not.toContain('sk-private-must-not-leak');
        expect(decoded.json).not.toContain('token=secret');
      }
      expect(screen.getByRole('status')).toHaveTextContent('public_artifacts.gallery_link_copied');
      expect(screen.getByRole('button', { name: /public_artifacts\.gallery_link_copied/ })).toBeInTheDocument();
    });

    it('downloads the same sanitized JSON when the Gallery URL exceeds the cap', async () => {
      const oversizedArtifact = {
        ...publicArtifactFixture,
        question: 'x'.repeat(MAX_GALLERY_URL_CHARS),
      };
      buildPublicArtifactMock.mockResolvedValueOnce(oversizedArtifact);
      const user = userEvent.setup();
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      render(<ShareModal scenarioId="scenario-gallery-fallback" onClose={() => {}} />);

      await user.click(screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ }));

      expect(await screen.findByRole('status')).toHaveTextContent(
        'public_artifacts.gallery_link_too_large_downloaded',
      );
      expect(buildPublicArtifactMock).toHaveBeenCalledTimes(1);
      expect(writeTextSpy).not.toHaveBeenCalled();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
      const downloadedBlob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
      expect(await readBlobText(downloadedBlob)).toBe(JSON.stringify(oversizedArtifact));
    });

    it('surfaces clipboard and API failures without downloading unsafe fallbacks', async () => {
      const user = userEvent.setup();
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');
      writeTextSpy.mockRejectedValueOnce(new Error('clipboard denied'));
      const first = render(<ShareModal scenarioId="scenario-gallery-copy-error" onClose={() => {}} />);

      await user.click(screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'public_artifacts.gallery_link_copy_error',
      );
      expect(URL.createObjectURL).not.toHaveBeenCalled();

      first.unmount();
      buildPublicArtifactMock.mockRejectedValueOnce(new Error('artifact API failed'));
      render(<ShareModal scenarioId="scenario-gallery-api-error" onClose={() => {}} />);
      await user.click(screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('public_artifacts.export_error');
      expect(writeTextSpy).toHaveBeenCalledTimes(1);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('deduplicates same-tick clicks while the public artifact request is pending', async () => {
      let resolveArtifact!: (artifact: typeof publicArtifactFixture) => void;
      buildPublicArtifactMock.mockImplementationOnce(() => (
        new Promise<typeof publicArtifactFixture>((resolve) => {
          resolveArtifact = resolve;
        })
      ));
      render(<ShareModal scenarioId="scenario-gallery-dedupe" onClose={() => {}} />);
      const button = screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ });

      act(() => {
        button.click();
        button.click();
      });
      expect(buildPublicArtifactMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveArtifact(publicArtifactFixture);
      });
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    });

    it('aborts and ignores a pending Gallery link request after unmount', async () => {
      let resolveArtifact!: (artifact: typeof publicArtifactFixture) => void;
      let requestSignal: AbortSignal | undefined;
      buildPublicArtifactMock.mockImplementationOnce(
        (_scenarioId: string, options?: { signal?: AbortSignal }) => {
          requestSignal = options?.signal;
          return new Promise<typeof publicArtifactFixture>((resolve) => {
            resolveArtifact = resolve;
          });
        },
      );
      const user = userEvent.setup();
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      const view = render(<ShareModal scenarioId="scenario-gallery-unmount" onClose={() => {}} />);

      await user.click(screen.getByRole('button', { name: /public_artifacts\.copy_gallery_link/ }));
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      view.unmount();
      expect(requestSignal?.aborted).toBe(true);

      await act(async () => {
        resolveArtifact(publicArtifactFixture);
      });
      expect(writeTextSpy).not.toHaveBeenCalled();
    });

    it('triggers download public JSON when enabled and button is clicked', async () => {
      useCapabilityCheckMock.mockReturnValue({
        loading: false,
        enabled: true,
        capabilities: null,
      });

      const user = userEvent.setup();
      render(<ShareModal scenarioId="scenario-enabled-json" onClose={() => {}} />);

      const downloadJsonBtn = screen.getByRole('button', { name: /public_artifacts\.download_json/ });
      expect(downloadJsonBtn).not.toBeDisabled();

      await user.click(downloadJsonBtn);

      expect(buildPublicArtifactMock).toHaveBeenCalledWith('scenario-enabled-json');
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });

    it('triggers download public HTML when enabled and button is clicked', async () => {
      useCapabilityCheckMock.mockReturnValue({
        loading: false,
        enabled: true,
        capabilities: null,
      });

      const user = userEvent.setup();
      render(<ShareModal scenarioId="scenario-enabled-html" onClose={() => {}} />);

      const downloadHtmlBtn = screen.getByRole('button', { name: /public_artifacts\.download_html/ });
      expect(downloadHtmlBtn).not.toBeDisabled();

      await user.click(downloadHtmlBtn);

      expect(buildPublicArtifactMock).toHaveBeenCalledWith('scenario-enabled-html');
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });
  });

  describe('Headline Share Entry', () => {
    it('shows headline-share buttons when social_headlines enabled and headline exists', async () => {
      useCapabilityCheckMock.mockReturnValue({
        loading: false,
        enabled: true,
        capabilities: null,
      });

      const { container } = render(
        <ShareModal
          scenarioId="scenario-headline"
          onClose={() => {}}
          headlineCard={{
            card_id: 'card_1',
            headline: 'PORTS BLOCKED!',
            summary: 'Trade stops.',
            branch_title: 'Blockade Active',
            round_number: 1,
            event_type: 'Economic Shock',
            faction_label: 'Logistics Guild',
            source_event_id: 'event_1',
          }}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('share-headline-card-download-btn')).toBeInTheDocument();
      });

      // Ensure no secret-looking strings appear in the rendered DOM content
      const content = container.textContent || '';
      expect(content).not.toContain('api_key');
      expect(content).not.toContain('base_url');
      expect(content).not.toContain('Bearer');
      expect(content).not.toContain('token');
      expect(content).not.toContain('sk-test');
    });

    it('exports and downloads headline card as PNG using html2canvas and toBlob', async () => {
      useCapabilityCheckMock.mockReturnValue({
        loading: false,
        enabled: true,
        capabilities: null,
      });

      const toBlob = vi.fn((callback: BlobCallback) => {
        callback(new Blob(['png'], { type: 'image/png' }));
      });
      html2canvasMock.mockResolvedValueOnce({ toBlob });

      render(
        <ShareModal
          scenarioId="scenario-headline"
          onClose={() => {}}
          headlineCard={{
            card_id: 'card_1',
            headline: 'PORTS BLOCKED!',
            summary: 'Trade stops.',
            branch_title: 'Blockade Active',
            round_number: 1,
            event_type: 'Economic Shock',
            faction_label: 'Logistics Guild',
            source_event_id: 'event_1',
          }}
        />
      );

      const downloadBtn = await screen.findByTestId('share-headline-card-download-btn');
      const user = userEvent.setup();
      await user.click(downloadBtn);

      await waitFor(() => {
        expect(html2canvasMock).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.objectContaining({
            backgroundColor: '#0a0a14',
            width: 1200,
            height: 630,
          }),
        );
      });

      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', 0.95);
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });

    it('renders retry button and handles reload on capability error', async () => {
      const reloadMock = vi.fn();
      useCapabilityCheckMock.mockImplementation((feature?: string) => {
        if (feature === 'social_headlines') {
          return {
            loading: false,
            enabled: false,
            capabilities: null,
            error: new Error('Headline capability failed'),
            reload: reloadMock,
          };
        }
        return {
          loading: false,
          enabled: true,
          capabilities: null,
          error: null,
        };
      });

      render(
        <ShareModal
          scenarioId="scenario-headline"
          onClose={() => {}}
          headlineCard={{
            card_id: 'card_1',
            headline: 'PORTS BLOCKED!',
            summary: 'Trade stops.',
            branch_title: 'Blockade Active',
            round_number: 1,
            event_type: 'Economic Shock',
            faction_label: 'Logistics Guild',
            source_event_id: 'event_1',
          }}
        />
      );

      expect(screen.getByText('common.capability_error')).toBeInTheDocument();

      const retryBtn = screen.getByRole('button', { name: 'common.retry' });
      expect(retryBtn).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(retryBtn);

      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
  });
});
