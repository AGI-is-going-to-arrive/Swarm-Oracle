import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSessionToken } from '../api/client';
import { useNodeConversationTransport } from './useNodeConversationTransport';

afterEach(() => vi.unstubAllGlobals());

describe('useNodeConversationTransport', () => {
  it('reports a stream that ends without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }));
    const onTransportError = vi.fn();
    const { result } = renderHook(() => useNodeConversationTransport({ scenarioId: 'scenario', setThreadId: vi.fn(), onTransportError, onWsEvent: vi.fn() }));
    await act(async () => { await result.current.streamTurn('thread', 'Question'); });
    expect(onTransportError).toHaveBeenCalledWith('SERVER_ERROR');
  });

  it('ignores frames that arrive after cancellation even when the reader ignores AbortSignal', async () => {
    let resolveRead!: (value: { done: boolean; value: Uint8Array }) => void;
    const read = vi.fn(() => new Promise<{ done: boolean; value: Uint8Array }>(resolve => { resolveRead = resolve; }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({ read }) } }));
    const onWsEvent = vi.fn();
    const { result } = renderHook(() => useNodeConversationTransport({ scenarioId: 'scenario', setThreadId: vi.fn(), onTransportError: vi.fn(), onWsEvent }));
    const pending = result.current.streamTurn('thread', 'Question');
    await act(async () => { await Promise.resolve(); });
    result.current.abortActiveRequest();
    resolveRead({ done: false, value: new TextEncoder().encode('event: turn_started\ndata: {"thread_id":"thread","turn_id":"late","sequence":2}\n\n') });
    await pending;
    expect(onWsEvent).not.toHaveBeenCalled();
  });
  it('keeps transport callbacks stable when origin values stay the same', () => {
    const setThreadId = vi.fn();
    const onTransportError = vi.fn();
    const onWsEvent = vi.fn();

    const { result, rerender } = renderHook(
      ({ origin }: { origin: { nodeId: string; nodeType: string } }) =>
        useNodeConversationTransport({
          scenarioId: 'scenario-1',
          identityId: 'identity-1',
          originNodeId: origin.nodeId,
          originNodeType: origin.nodeType,
          setThreadId,
          onTransportError,
          onWsEvent,
        }),
      {
        initialProps: {
          origin: {
            nodeId: 'node-1',
            nodeType: 'argument',
          },
        },
      },
    );

    const initialStartConversation = result.current.startConversation;
    const initialStreamTurn = result.current.streamTurn;

    rerender({
      origin: {
        nodeId: 'node-1',
        nodeType: 'argument',
      },
    });

    expect(result.current.startConversation).toBe(initialStartConversation);
    expect(result.current.streamTurn).toBe(initialStreamTurn);
  });

  it('checks the current credential before dispatching a late chunk without relying on rerender', async () => {
    setSessionToken('session-a');
    let resolveRead!: (value: { done: boolean; value: Uint8Array }) => void;
    let signal: AbortSignal | null | undefined;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }))
      .mockResolvedValue({ done: true });
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return Promise.resolve({ ok: true, body: { getReader: () => ({ read }) } });
    }));
    const onWsEvent = vi.fn();
    const onTransportError = vi.fn();
    const { result } = renderHook(() => useNodeConversationTransport({
      scenarioId: 'scenario', setThreadId: vi.fn(), onTransportError, onWsEvent,
    }));
    const pending = result.current.streamTurn('thread', 'Question');
    await act(async () => { await Promise.resolve(); });
    localStorage.setItem('swarmoracle_session_token', 'session-b');
    resolveRead({ done: false, value: new TextEncoder().encode(
      'event: turn_started\ndata: {"thread_id":"thread","turn_id":"late","sequence":2}\n\n',
    ) });
    await pending;
    expect(onWsEvent).not.toHaveBeenCalled();
    expect(onTransportError).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });

  it('rejects a delayed bootstrap body after credentials change without a component update', async () => {
    setSessionToken('session-a');
    let resolveBody!: (payload: { thread_id: string }) => void;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true,
      json: () => new Promise(resolve => { resolveBody = resolve; }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const setThreadId = vi.fn();
    const onTransportError = vi.fn();
    const { result } = renderHook(() => useNodeConversationTransport({
      scenarioId: 'scenario', setThreadId, onTransportError, onWsEvent: vi.fn(),
    }));
    const pending = result.current.startConversation('A question');
    await act(async () => { await Promise.resolve(); });
    localStorage.setItem('swarmoracle_session_token', 'session-b');
    resolveBody({ thread_id: 'a-private-thread' });
    expect(await pending).toBe(false);
    expect(setThreadId).not.toHaveBeenCalled();
    expect(onTransportError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
