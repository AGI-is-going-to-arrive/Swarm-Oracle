/**
 * FE-3 — NodeConversationSheet tests.
 *
 * Critical assertions:
 *   - mobile breakpoint switches side="bottom"
 *   - mobile inner scroll touchStart stops propagation (drag-to-close guard)
 *   - 6 recovery codes render correctly (delegated to banner's own tests)
 *   - draft unavailable shows amber banner
 *   - focus stability: streaming tokens don't steal activeElement from
 *     textarea / send / close
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDetail } from '../../api/client';

const streamingAriaLiveMockState = vi.hoisted(() => ({
  useStreamingAriaLiveMock: vi.fn(),
  realUseStreamingAriaLive: null as null | ((...args: unknown[]) => unknown),
}));
const historyPickerMockState = vi.hoisted(() => ({
  detail: null as ConversationDetail | null,
}));

vi.mock('../ConversationHistoryPicker', async () => {
  const React = await import('react');
  return {
    ConversationHistoryPicker: ({
      onSelect,
    }: {
      onSelect: (detail: ConversationDetail) => void;
    }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'mock-conversation-history-select',
          onClick: () => {
            if (historyPickerMockState.detail) onSelect(historyPickerMockState.detail);
          },
        },
        'history',
      ),
  };
});

import { NodeConversationSheet } from './NodeConversationSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      k: string,
      options?: Record<string, string | number | undefined>,
    ) => {
      const templateSource = k === 'conversation.sheet.snap_handle_aria'
        ? 'Resize bottom sheet, current {{snap}}vh, tap to cycle'
        : options?.defaultValue ?? k;
      const template = String(templateSource);
      return template.replace(/\{\{(\w+)\}\}/g, (_match: string, token: string) => {
        const value = options?.[token];
        return value === undefined ? `{{${token}}}` : String(value);
      });
    },
  }),
}));

vi.mock('../../hooks/useStreamingAriaLive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useStreamingAriaLive')>();
  streamingAriaLiveMockState.realUseStreamingAriaLive = actual.useStreamingAriaLive as (...args: unknown[]) => unknown;
  streamingAriaLiveMockState.useStreamingAriaLiveMock.mockImplementation(actual.useStreamingAriaLive);
  return {
    ...actual,
    useStreamingAriaLive: streamingAriaLiveMockState.useStreamingAriaLiveMock,
  };
});

// Stub WebSocket so shared conversation internals do not spam the console.
class NoopWS {
  static OPEN = 1;
  readyState = NoopWS.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    /* noop */
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // Default: desktop viewport.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
});

afterEach(() => {
  historyPickerMockState.detail = null;
  if (streamingAriaLiveMockState.realUseStreamingAriaLive) {
    streamingAriaLiveMockState.useStreamingAriaLiveMock.mockImplementation(
      streamingAriaLiveMockState.realUseStreamingAriaLive,
    );
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function renderSheet(overrides?: Partial<React.ComponentProps<typeof NodeConversationSheet>>) {
  return render(
    <NodeConversationSheet
      open
      onOpenChange={() => {}}
      threadId="thread-1"
      scenarioId="scen-1"
      identityId="id-1"
      {...overrides}
    />,
  );
}

function makeConversationDetail(overrides?: Partial<ConversationDetail>): ConversationDetail {
  return {
    thread_id: 'history-thread',
    scenario_id: 'scen-1',
    agent_identity_id: 'id-1',
    owner_user_id: 'user-1',
    origin_branch_id: null,
    origin_round_number: null,
    origin_node_id: 'node-1',
    origin_node_type: 'argument',
    last_turn_sequence: 2,
    latest_status: 'committed',
    active_turn_id: null,
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-10T00:00:00Z',
    user_turn_id: 'turn-user',
    assistant_turn_id: 'turn-assistant',
    sequence_range: [1, 2],
    turns: [
      {
        id: 'turn-user',
        thread_id: 'history-thread',
        role: 'user',
        sequence: 1,
        status: 'committed',
        content: 'What happened?',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      },
      {
        id: 'turn-assistant',
        thread_id: 'history-thread',
        role: 'assistant',
        sequence: 2,
        status: 'committed',
        content: '**Restored answer**\n- Visible again',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-10T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

function makeSseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        }),
      }),
    },
  } as unknown as Response;
}

describe('NodeConversationSheet — responsive', () => {
  it('desktop default: data-mobile=false', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('node-conversation-sheet').getAttribute('data-mobile')).toBe('false');
  });

  it('desktop outside interaction does not dismiss the persistent sidecar', () => {
    const onOpenChange = vi.fn();
    const { getByTestId } = render(
      <div>
        <button type="button" data-testid="outside-action">Outside action</button>
        <NodeConversationSheet
          open
          onOpenChange={onOpenChange}
          threadId="thread-1"
          scenarioId="scen-1"
          identityId="id-1"
        />
      </div>,
    );

    expect(getByTestId('node-conversation-sheet').getAttribute('data-mobile')).toBe('false');

    fireEvent.pointerDown(getByTestId('outside-action'));

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('mobile viewport: data-mobile=true', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: /max-width: 768/.test(q),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    const { getByTestId } = renderSheet();
    expect(getByTestId('node-conversation-sheet').getAttribute('data-mobile')).toBe('true');
  });
});

describe('NodeConversationSheet — drag guard', () => {
  it('inner scroll region has data-no-drag and stops touch propagation', () => {
    const { getByTestId } = renderSheet();
    const region = getByTestId('node-conversation-scroll-region');
    expect(region.getAttribute('data-no-drag')).toBe('true');

    // Fire a touchstart event and capture propagation via a parent spy
    // attached to an ancestor we know the event would bubble through.
    const parentSpy = vi.fn();
    // Walk up DOM to find a real ancestor of region.
    const ancestor = region.parentElement;
    expect(ancestor).not.toBeNull();
    ancestor!.addEventListener('touchstart', parentSpy);

    fireEvent.touchStart(region, { touches: [{ clientX: 0, clientY: 0 }] });
    // Native Event.stopPropagation on region prevents parent from receiving.
    expect(parentSpy).not.toHaveBeenCalled();
  });
});

describe('NodeConversationSheet — input + send', () => {
  it('send button is disabled with empty input', () => {
    const { getByTestId } = renderSheet();
    const send = getByTestId('node-conversation-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('send button enables after typing', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'hello' } });
    });
    const send = getByTestId('node-conversation-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('send invokes onSubmit with trimmed text', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = renderSheet({ onSubmit });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '  query  ' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));
    expect(onSubmit).toHaveBeenCalledWith('query');
  });

  it('first submit creates a conversation thread and stores the returned thread id', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ thread_id: 'thread-created' }),
      })
      .mockResolvedValueOnce(
        makeSseResponse([
          'event: turn_started\ndata: {"turn_id":"turn-created","thread_id":"thread-created","sequence":2}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-created","delta":"hello "}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-created","delta":"node"}\n\n',
          'event: turn_completed\ndata: {"turn_id":"turn-created","sequence":2,"status":"committed"}\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'hello node' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-created/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(getByTestId('node-conversation-meta').textContent).toContain('thread=thread-created');
      expect(getByTestId('node-conversation-streaming').textContent).toBe('hello node');
    });
  });

  it('start failure preserves draft + input for retry', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({
        detail: {
          code: 'THREAD_BUSY',
          message: 'Conversation already busy',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'retry me' } });
    });
    await waitFor(() => {
      expect(window.sessionStorage.getItem('swarmoracle_draft:result')).toBe('retry me');
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(ta.value).toBe('retry me');
    expect(window.sessionStorage.getItem('swarmoracle_draft:result')).toBe('retry me');
  });

  it('follow-up submit streams /turn SSE events into the bubble', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        'event: turn_started\ndata: {"turn_id":"turn-2","thread_id":"thread-1","sequence":4}\n\n',
        'event: turn_token_delta\ndata: {"turn_id":"turn-2","delta":"hello "}\n\n',
        'event: turn_token_delta\ndata: {"turn_id":"turn-2","delta":"world"}\n\n',
        'event: turn_completed\ndata: {"turn_id":"turn-2","sequence":4,"status":"committed"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'follow up' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-1/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(getByTestId('node-conversation-streaming').textContent).toBe('hello world');
      expect(getByTestId('node-conversation-cta-continue')).not.toBeNull();
    });
  });

  it('renders committed assistant Markdown instead of raw markers', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        'event: turn_started\ndata: {"turn_id":"turn-md","thread_id":"thread-1","sequence":4}\n\n',
        'event: turn_token_delta\ndata: {"turn_id":"turn-md","delta":"**一、重点**\\n"}\n\n',
        'event: turn_token_delta\ndata: {"turn_id":"turn-md","delta":"- 第一条"}\n\n',
        'event: turn_completed\ndata: {"turn_id":"turn-md","sequence":4,"status":"committed"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'follow up' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      const bubble = getByTestId('node-conversation-streaming');
      expect(bubble.querySelector('strong')?.textContent).toBe('一、重点');
      expect(bubble.querySelector('li')?.textContent).toBe('第一条');
      expect(bubble.textContent).not.toContain('**');
    });
  });

  it('keeps a restored history assistant turn visible after selecting a thread', async () => {
    vi.useRealTimers();
    historyPickerMockState.detail = makeConversationDetail();

    const { getByTestId } = renderSheet();

    fireEvent.click(getByTestId('mock-conversation-history-select'));

    await waitFor(() => {
      const region = getByTestId('node-conversation-scroll-region');
      const bubble = region.querySelector('.conv-bubble');
      expect(region).toHaveTextContent('Restored answer');
      expect(region.querySelector('strong')?.textContent).toBe('Restored answer');
      expect(bubble).not.toHaveClass('conv-bubble--hidden');
    });
  });

  it('aborts the active follow-up request when the sheet unmounts', async () => {
    vi.useRealTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId, unmount } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'follow up' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-1/turn',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(requestSignal).toBeDefined();
    expect(requestSignal?.aborted).toBe(false);

    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it('follow-up submit parses multiline SSE data frames', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        'event: turn_started\ndata: {"turn_id":"turn-2","thread_id":"thread-1","sequence":4}\n\n',
        'event: turn_token_delta\ndata: {"turn_id":"turn-2",\ndata: "delta":"hello world"}\n\n',
        'event: turn_completed\ndata: {"turn_id":"turn-2","sequence":4,"status":"committed"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'follow up' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-1/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(getByTestId('node-conversation-streaming').textContent).toBe('hello world');
      expect(getByTestId('node-conversation-cta-continue')).not.toBeNull();
    });
  });

  it('blocks conversation submission when BYOK baseUrl is set without an apiKey', async () => {
    vi.useRealTimers();
    window.sessionStorage.setItem('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: '',
      baseUrl: 'https://example.com/v1',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId, findByText } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'blocked submit' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await findByText('conversation.error.byok_invalid')).toBeInTheDocument();
  });
});

describe('NodeConversationSheet — a11y', () => {
  it('sheet exposes an accessible title through the dialog relationship', () => {
    const { getByTestId } = renderSheet();
    const sheet = getByTestId('node-conversation-sheet');
    const labelledBy = sheet.getAttribute('aria-labelledby');

    expect(labelledBy).toBeTruthy();
    expect(sheet).toHaveAccessibleName('Conversation');
    expect(document.getElementById(labelledBy!)).toHaveTextContent('Conversation');
  });

  it('sheet exposes an accessible description for the dialog content', () => {
    const { getByTestId } = renderSheet();
    const sheet = getByTestId('node-conversation-sheet');
    const describedBy = sheet.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(sheet).toHaveAccessibleDescription(
      'Ask the shown conversation target about the selected node and review the streamed reply here.',
    );
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'Ask the shown conversation target about the selected node and review the streamed reply here.',
    );
  });

  it('uses result-context copy when opened from the result conversation widget', () => {
    const { getByTestId, getByText } = renderSheet({
      showResultDeepenHint: true,
      origin: {
        surface: 'result',
        nodeId: 'result:branch-1',
        nodeType: 'outcome',
        nodeLabel: 'Archive Branch',
        excerpt: 'The archive branch held because the late challenge never landed.',
        causeContext: ['The council chose the archive path.'],
        relatedContext: ['Counter Branch'],
      },
    });
    const sheet = getByTestId('node-conversation-sheet');

    expect(sheet).toHaveAccessibleName('Result conversation');
    expect(sheet).toHaveAccessibleDescription(
      'Ask about this result and review the streamed reply here.',
    );
    expect(getByTestId('node-context-banner')).toHaveTextContent('Archive Branch');
    expect(getByText('Ask about "Archive Branch"')).toBeInTheDocument();
    expect(getByText('Why did "Archive Branch" become the landing point?')).toBeInTheDocument();
    expect(getByText('What really separates it from "Counter Branch"?')).toBeInTheDocument();
  });

  it('does not emit Radix dialog title/description accessibility warnings on render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderSheet();

    const radixA11yWarnings = consoleError.mock.calls.filter(([message]) =>
      typeof message === 'string'
      && (
        message.includes('`DialogContent` requires a `DialogTitle`')
        || message.includes('Missing `Description` or `aria-describedby={undefined}`')
      ));

    expect(radixA11yWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('sr-only aria-live region is present', () => {
    const { getByTestId } = renderSheet();
    const live = getByTestId('node-conversation-aria-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  it('flushes aria-live immediately whenever open changes', () => {
    const flushNow = vi.fn();
    streamingAriaLiveMockState.useStreamingAriaLiveMock.mockImplementation(() => ({
      appendToken: vi.fn(),
      flushNow,
      reset: vi.fn(),
      complete: vi.fn(),
      bufferRef: { current: '' },
      announceRef: { current: null },
    }));

    const { rerender } = render(
      <NodeConversationSheet
        open
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    expect(flushNow).toHaveBeenCalledTimes(1);

    rerender(
      <NodeConversationSheet
        open={false}
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    expect(flushNow).toHaveBeenCalledTimes(2);
  });

  it('close/open cycle does not replay the previous aria-live transcript', () => {
    let latestApi: { appendToken: (chunk: string) => void } | null = null;
    streamingAriaLiveMockState.useStreamingAriaLiveMock.mockImplementation((...args: unknown[]) => {
      const real = streamingAriaLiveMockState.realUseStreamingAriaLive;
      if (!real) {
        throw new Error('real useStreamingAriaLive is unavailable');
      }
      const api = real(...args);
      latestApi = api as { appendToken: (chunk: string) => void };
      return api;
    });

    const { getByTestId, rerender } = render(
      <NodeConversationSheet
        open
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    const live = getByTestId('node-conversation-aria-live');
    act(() => {
      latestApi?.appendToken('old transcript');
    });
    expect(live.textContent).toBe('');

    rerender(
      <NodeConversationSheet
        open={false}
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );
    expect(live.textContent).toBe('old transcript');

    rerender(
      <NodeConversationSheet
        open
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );
    expect(getByTestId('node-conversation-aria-live').textContent).toBe('');
  });

  it('textarea advertises aria-keyshortcuts for Cmd+Enter and Cmd+R', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input');
    const shortcuts = ta.getAttribute('aria-keyshortcuts') ?? '';
    expect(shortcuts).toContain('Meta+Enter');
    expect(shortcuts).toContain('Meta+R');
  });
});

describe('NodeConversationSheet — keyboard shortcuts', () => {
  it('Cmd+Enter on textarea fires onSubmit with trimmed text', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = renderSheet({ onSubmit });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '  from keyboard  ' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    });
    expect(onSubmit).toHaveBeenCalledWith('from keyboard');
  });

  it('Ctrl+Enter on textarea fires onSubmit (Linux/Windows parity)', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = renderSheet({ onSubmit });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'x' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    });
    expect(onSubmit).toHaveBeenCalledWith('x');
  });

  it('Cmd+R fires onResend and preventDefault blocks browser refresh', () => {
    const onResend = vi.fn();
    const { getByTestId } = renderSheet({ onResend });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    const ev = new KeyboardEvent('keydown', {
      key: 'r',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      ta.dispatchEvent(ev);
    });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Cmd+R without onResend is a no-op (no throw)', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    expect(() => {
      act(() => {
        fireEvent.keyDown(ta, { key: 'r', metaKey: true });
      });
    }).not.toThrow();
  });

  it('claimed modifier shortcuts stop propagation so parent keydown listeners do not fire', () => {
    const onSubmit = vi.fn();
    const onResend = vi.fn();
    const parentSpy = vi.fn();
    const { getByTestId } = render(
      <div onKeyDown={parentSpy}>
        <NodeConversationSheet
          open
          onOpenChange={() => {}}
          threadId="thread-1"
          scenarioId="scen-1"
          identityId="id-1"
          onSubmit={onSubmit}
          onResend={onResend}
        />
      </div>,
    );
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;

    act(() => {
      fireEvent.change(ta, { target: { value: 'claimed shortcut' } });
      fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(ta, { key: 'r', metaKey: true });
      fireEvent.keyDown(ta, { key: 'ArrowUp', metaKey: true });
      fireEvent.keyDown(ta, { key: 'ArrowDown', metaKey: true });
    });

    expect(onSubmit).toHaveBeenCalledWith('claimed shortcut');
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it('plain Enter (no modifier) does NOT submit (normal newline behaviour)', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = renderSheet({ onSubmit });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'draft' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('NodeConversationSheet — mobile snap (40/70/100)', () => {
  beforeEach(() => {
    // Force mobile viewport for the whole suite.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: /max-width: 768/.test(q),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
  });

  it('default snap is 70vh', () => {
    const { getByTestId } = renderSheet();
    const sheet = getByTestId('node-conversation-sheet');
    expect(sheet.getAttribute('data-snap')).toBe('70');
    expect(sheet.className).toContain('max-h-[70vh]');
  });

  it('grab handle is mobile-only', () => {
    const { getByTestId } = renderSheet();
    const handle = getByTestId('node-conversation-snap-handle');
    expect(handle).not.toBeNull();
  });

  it('snap handle aria label interpolates the current snap value', () => {
    const { getByTestId } = renderSheet();
    const handle = getByTestId('node-conversation-snap-handle');
    expect(handle.getAttribute('aria-label')).toBe('Resize bottom sheet, current 70vh, tap to cycle');
    expect(handle.getAttribute('aria-label')).not.toContain('{{snap}}');
  });

  it('clicking handle cycles 70 → 100 → 40 → 70', () => {
    const { getByTestId } = renderSheet();
    const handle = getByTestId('node-conversation-snap-handle');
    const sheet = getByTestId('node-conversation-sheet');
    expect(sheet.getAttribute('data-snap')).toBe('70');
    act(() => {
      fireEvent.click(handle);
    });
    expect(sheet.getAttribute('data-snap')).toBe('100');
    act(() => {
      fireEvent.click(handle);
    });
    expect(sheet.getAttribute('data-snap')).toBe('40');
    act(() => {
      fireEvent.click(handle);
    });
    expect(sheet.getAttribute('data-snap')).toBe('70');
  });

  it('Cmd+ArrowUp on textarea raises snap toward 100', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    const sheet = getByTestId('node-conversation-sheet');
    expect(sheet.getAttribute('data-snap')).toBe('70');
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp', metaKey: true });
    });
    expect(sheet.getAttribute('data-snap')).toBe('100');
    // Raising again stays clamped at 100 (no wrap-around).
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp', metaKey: true });
    });
    expect(sheet.getAttribute('data-snap')).toBe('100');
  });

  it('Cmd+ArrowDown on textarea lowers snap toward 40', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    const sheet = getByTestId('node-conversation-sheet');
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowDown', metaKey: true });
    });
    expect(sheet.getAttribute('data-snap')).toBe('40');
    // Clamped at 40.
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowDown', metaKey: true });
    });
    expect(sheet.getAttribute('data-snap')).toBe('40');
  });

  it('desktop does NOT render the snap handle and has no data-snap attribute', () => {
    // Override back to desktop for this single assertion.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    const { queryByTestId, getByTestId } = renderSheet();
    expect(queryByTestId('node-conversation-snap-handle')).toBeNull();
    const sheet = getByTestId('node-conversation-sheet');
    expect(sheet.hasAttribute('data-snap')).toBe(false);
  });

  it('mobile snap handle has >= 44px hit target', () => {
    const { getByTestId } = renderSheet();
    const handle = getByTestId('node-conversation-snap-handle') as HTMLButtonElement;
    expect(handle.className).toContain('min-h-[44px]');
  });
});

describe('NodeConversationSheet — T0 bootstrap abort', () => {
  it('unmount aborts a pending bootstrap /start request', async () => {
    vi.useRealTimers();
    let startSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/start')) {
        startSignal = init?.signal ?? null;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId, unmount } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'bootstrap abort test' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(startSignal).not.toBeNull();
    expect(startSignal!.aborted).toBe(false);

    unmount();

    expect(startSignal!.aborted).toBe(true);
  });

  it('stale /start resolve after close does not set the active thread', async () => {
    vi.useRealTimers();
    let resolveStart: ((v: Response) => void) | null = null;
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/start')) {
        return new Promise<Response>((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onOpenChange = vi.fn();
    const { getByTestId, rerender } = render(
      <NodeConversationSheet
        open
        onOpenChange={onOpenChange}
        threadId={null}
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;

    act(() => { fireEvent.change(ta, { target: { value: 'pending submit' } }); });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(getByTestId('node-conversation-meta').textContent).toContain('thread=');
    expect(getByTestId('node-conversation-meta').textContent).not.toContain('thread=thread-stale');

    rerender(
      <NodeConversationSheet
        open={false}
        onOpenChange={onOpenChange}
        threadId={null}
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    await act(async () => {
      resolveStart!({
        ok: true,
        json: () => Promise.resolve({ thread_id: 'thread-stale' }),
      } as unknown as Response);
      await new Promise((r) => setTimeout(r, 50));
    });

    rerender(
      <NodeConversationSheet
        open
        onOpenChange={onOpenChange}
        threadId={null}
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    expect(getByTestId('node-conversation-meta').textContent).not.toContain('thread-stale');
  });

  it('send button is disabled during bootstrap pending', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(() => {
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'bootstrap pending' } });
    });
    const sendBefore = getByTestId('node-conversation-send') as HTMLButtonElement;
    expect(sendBefore.disabled).toBe(false);

    fireEvent.click(sendBefore);

    await waitFor(() => {
      const sendDuring = getByTestId('node-conversation-send') as HTMLButtonElement;
      expect(sendDuring.disabled).toBe(true);
    });
  });
});

describe('NodeConversationSheet — T0 draft key isolation', () => {
  it('different origins produce different draft keys in sessionStorage', async () => {
    vi.useRealTimers();

    const originA = { nodeId: 'node-a', nodeType: 'causal', branchId: 'b1', roundNumber: 2 };
    const originB = { nodeId: 'node-b', nodeType: 'argument', branchId: 'b2', roundNumber: 5 };

    const { getByTestId, unmount } = renderSheet({ threadId: null, origin: originA });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'draft for A' } });
    });
    await waitFor(() => {
      expect(window.sessionStorage.getItem('swarmoracle_draft:scen-1:node-a:b1:2')).toBe('draft for A');
    });
    unmount();

    const { getByTestId: getByTestId2 } = renderSheet({ threadId: null, origin: originB });
    const ta2 = getByTestId2('node-conversation-input') as HTMLTextAreaElement;
    expect(ta2.value).toBe('');

    act(() => {
      fireEvent.change(ta2, { target: { value: 'draft for B' } });
    });
    await waitFor(() => {
      expect(window.sessionStorage.getItem('swarmoracle_draft:scen-1:node-b:b2:5')).toBe('draft for B');
    });

    expect(window.sessionStorage.getItem('swarmoracle_draft:scen-1:node-a:b1:2')).toBe('draft for A');
  });

  it('no-origin sheets use result scope draft key', async () => {
    vi.useRealTimers();
    const { getByTestId } = renderSheet({ threadId: null });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'result draft' } });
    });
    await waitFor(() => {
      expect(window.sessionStorage.getItem('swarmoracle_draft:result')).toBe('result draft');
    });
  });
});

describe('NodeConversationSheet — T1 banner integration', () => {
  it('renders NodeContextBanner when origin has display content', () => {
    const origin = {
      nodeId: 'n1',
      nodeType: 'event',
      agentName: 'Agent A',
      roundNumber: 2,
    };
    const { queryByTestId } = renderSheet({ origin });
    expect(queryByTestId('node-context-banner')).not.toBeNull();
  });

  it('does not render banner when origin has no UI fields', () => {
    const origin = { nodeId: 'n1', nodeType: 'event' };
    const { queryByTestId } = renderSheet({ origin });
    expect(queryByTestId('node-context-banner')).toBeNull();
  });

  it('does not render banner when origin is undefined', () => {
    const { queryByTestId } = renderSheet({ origin: undefined });
    expect(queryByTestId('node-context-banner')).toBeNull();
  });

  it('/start body excludes UI-only origin fields (surface, agentName, emotion, stance, nodeLabel, typeColor, targetLabel)', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ thread_id: 'thread-t1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const origin = {
      surface: 'causal' as const,
      nodeId: 'n1',
      nodeType: 'event',
      branchId: 'b1',
      roundNumber: 3,
      excerpt: 'Prompt-visible node excerpt',
      agentName: 'Agent UI',
      emotion: 'calm',
      stance: 0.7,
      nodeLabel: 'UI Label',
      typeColor: '#ff0000',
      targetLabel: 'Graph analyst',
      targetDescription: 'UI-only target copy',
      meaningTitle: 'Event card',
      meaningDescription: 'UI-only meaning copy',
      causeContext: ['UI-only cause copy'],
      effectContext: ['UI-only effect copy'],
      relationContext: ['UI-only relation group copy'],
      relatedContext: ['UI-only relation copy'],
    };
    const { getByTestId } = renderSheet({ threadId: null, origin });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'hello' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const startCall = fetchMock.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('/start'),
    );
    expect(startCall).toBeTruthy();
    const body = JSON.parse(startCall![1].body as string);
    expect(body).not.toHaveProperty('surface');
    expect(body).not.toHaveProperty('agentName');
    expect(body).not.toHaveProperty('emotion');
    expect(body).not.toHaveProperty('stance');
    expect(body).not.toHaveProperty('nodeLabel');
    expect(body).not.toHaveProperty('typeColor');
    expect(body).not.toHaveProperty('targetLabel');
    expect(body).not.toHaveProperty('targetDescription');
    expect(body).not.toHaveProperty('meaningTitle');
    expect(body).not.toHaveProperty('meaningDescription');
    expect(body).not.toHaveProperty('causeContext');
    expect(body).not.toHaveProperty('effectContext');
    expect(body).not.toHaveProperty('relationContext');
    expect(body).not.toHaveProperty('relatedContext');
    expect(body.origin_node_id).toBe('n1');
    expect(body.origin_node_type).toBe('event');
    expect(body.origin_branch_id).toBe('b1');
    expect(body.origin_round_number).toBe(3);
    expect(body.origin_excerpt).toBe('Prompt-visible node excerpt');
  });
});
