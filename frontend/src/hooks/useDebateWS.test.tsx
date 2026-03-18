import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebateWS } from './useDebateWS';

const storeState = {
  setError: vi.fn(),
  setDebate: vi.fn(),
  setPhase: vi.fn(),
  setScore: vi.fn(),
  setCounterplay: vi.fn(),
  appendTurn: vi.fn(),
  setVerdict: vi.fn(),
  debate: null,
};

vi.mock('../stores/debateStore', () => ({
  useDebateStore: {
    getState: () => storeState,
  },
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  emitClose(code: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

function Harness({ debateId, ready = true }: { debateId?: string; ready?: boolean }) {
  useDebateWS(debateId, ready);
  return null;
}

describe('useDebateWS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    Object.values(storeState).forEach((value) => {
      if (typeof value === 'function') {
        value.mockReset();
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('clears the delayed initial connect when unmounted before the timer fires', () => {
    const view = render(<Harness debateId="debate-1" />);

    view.unmount();

    act(() => {
      vi.runAllTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not reconnect after a normal close', () => {
    render(<Harness debateId="debate-2" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      MockWebSocket.instances[0]?.emitClose(1000);
      vi.advanceTimersByTime(20_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('still reconnects after an abnormal close', () => {
    render(<Harness debateId="debate-3" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(1_500);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('forwards debate_counterplay events into the store', () => {
    render(<Harness debateId="debate-4" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_counterplay',
          data: {
            debate_id: 'debate-4',
            kind: 'winner',
            target_value: 'opposition',
            confidence: 0.6,
            phase: 'crossfire',
            variant: 'reversal',
            outcome: null,
            user_name: 'QA',
            created_at: new Date().toISOString(),
          },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setCounterplay).toHaveBeenCalledWith(expect.objectContaining({
      debate_id: 'debate-4',
      kind: 'winner',
      target_value: 'opposition',
    }));
  });
});
