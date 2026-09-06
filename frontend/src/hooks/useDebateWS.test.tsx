import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebateWS } from './useDebateWS';

const getDebateMock = vi.fn();
const storeState = {
  setError: vi.fn(),
  setDebate: vi.fn(),
  setPhase: vi.fn(),
  setScore: vi.fn(),
  setParticipants: vi.fn(),
  setCounterplay: vi.fn(),
  appendTurn: vi.fn(),
  setVerdict: vi.fn(),
  setTerminalStatus: vi.fn(),
  status: 'live',
  activeDebateId: null as string | null,
  debate: null,
};

vi.mock('../stores/debateStore', () => ({
  useDebateStore: {
    getState: () => storeState,
  },
}));

vi.mock('../api/client', () => ({
  getDebate: (...args: unknown[]) => getDebateMock(...args),
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
    const sessionStore = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        sessionStore.delete(key);
      }),
    });
    getDebateMock.mockReset();
    storeState.status = 'live';
    storeState.activeDebateId = null;
    Object.values(storeState).forEach((value) => {
      if (typeof value === 'function') {
        value.mockReset();
      }
    });
    storeState.setTerminalStatus.mockImplementation((status: string, id: string) => {
      storeState.status = status;
      storeState.activeDebateId = id;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hydrates cancellation and drops late runtime events', async () => {
    const snapshot = { id: 'debate-1', status: 'cancelled', turns: [] };
    getDebateMock.mockResolvedValue(snapshot);
    render(<Harness debateId="debate-1" />);
    act(() => { vi.advanceTimersByTime(0); });
    const socket = MockWebSocket.instances[0];
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'status', data: { status: 'cancelled' } }) } as MessageEvent<string>);
      await Promise.resolve();
    });
    act(() => {
      for (const event of [
        { type: 'debate_phase_change', data: { phase: 'verdict' } },
        { type: 'debate_score_update', data: { score: { proposition: 100, opposition: 0 }, audience_meter: 100 } },
        { type: 'status', data: { status: 'error', error: 'late' } },
        { type: 'debate_verdict', data: {} },
      ]) socket.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    });
    expect(storeState.setTerminalStatus).toHaveBeenCalledWith('cancelled', 'debate-1');
    expect(storeState.setDebate).toHaveBeenCalledWith(snapshot, 'debate-1');
    expect(storeState.setPhase).not.toHaveBeenCalled();
    expect(storeState.setScore).not.toHaveBeenCalled();
    expect(storeState.setError).not.toHaveBeenCalled();
    expect(storeState.setVerdict).not.toHaveBeenCalled();
  });

  it('treats deletion as permanent for the current socket', () => {
    render(<Harness debateId="debate-1" />);
    act(() => { vi.advanceTimersByTime(0); });
    const socket = MockWebSocket.instances[0];
    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'status', data: { status: 'deleted' } }) } as MessageEvent<string>);
      socket.onmessage?.({ data: JSON.stringify({ type: 'status', data: { status: 'done' } }) } as MessageEvent<string>);
    });
    expect(storeState.setTerminalStatus).toHaveBeenCalledOnce();
    expect(storeState.setTerminalStatus).toHaveBeenCalledWith('deleted', 'debate-1');
    expect(storeState.setDebate).not.toHaveBeenCalled();
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

  it('ignores stale socket messages after switching debates', () => {
    const view = render(<Harness debateId="debate-old" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const staleSocket = MockWebSocket.instances[0];

    view.rerender(<Harness debateId="debate-new" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      staleSocket?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'verdict' },
          meta: { stream_id: 'debate-old', sequence: 1, event_id: 'debate-old:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setPhase).not.toHaveBeenCalled();
  });

  it('ignores stale socket close events after a reconnect replaced the active socket', () => {
    render(<Harness debateId="debate-stale-close" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const staleSocket = MockWebSocket.instances[0];
    expect(staleSocket).toBeDefined();

    act(() => {
      staleSocket?.emitClose(1006);
      vi.advanceTimersByTime(1_500);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      staleSocket?.onclose?.({ code: 1006 } as CloseEvent);
      vi.advanceTimersByTime(12_000);
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
          meta: { stream_id: 'debate-4', sequence: 1, event_id: 'debate-4:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setCounterplay).toHaveBeenCalledWith(expect.objectContaining({
      debate_id: 'debate-4',
      kind: 'winner',
      target_value: 'opposition',
    }));
  });

  it('ignores heartbeat events', () => {
    render(<Harness debateId="debate-heartbeat" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'heartbeat',
          data: { ts: new Date().toISOString() },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setError).not.toHaveBeenCalled();
    expect(storeState.setDebate).not.toHaveBeenCalled();
    expect(storeState.setPhase).not.toHaveBeenCalled();
    expect(storeState.setScore).not.toHaveBeenCalled();
    expect(storeState.setParticipants).not.toHaveBeenCalled();
    expect(storeState.setCounterplay).not.toHaveBeenCalled();
    expect(storeState.appendTurn).not.toHaveBeenCalled();
    expect(storeState.setVerdict).not.toHaveBeenCalled();
  });

  it('forwards structured runtime errors into the store', () => {
    render(<Harness debateId="debate-error" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: {
            status: 'error',
            error: {
              code: 'DEBATE_RUNTIME_FAILED',
              message: 'Debate failed unexpectedly. Please retry.',
            },
          },
          meta: { stream_id: 'debate-error', sequence: 1, event_id: 'debate-error:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setError).toHaveBeenCalledWith({
      code: 'DEBATE_RUNTIME_FAILED',
      message: 'Debate failed unexpectedly. Please retry.',
    });
  });

  it('forwards debate_verdict phase insights into the store', () => {
    render(<Harness debateId="debate-5" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_verdict',
          data: {
            winner: 'proposition',
            verdict_tone: 'order',
            score: { proposition: 80, opposition: 72, audience_meter: 3 },
            breakdown: { coherence: { proposition: 4, opposition: 3 } },
            best_argument: 'Best',
            best_rebuttal: 'Rebuttal',
            judge_summary: 'Summary',
            replay: [],
            phase_insights: [
              {
                phase: 'opening',
                stakes: 'Opening stakes',
                judge_focus: 'Opening focus',
                commentary: 'Opening commentary',
                pressure_side: 'balanced',
                pressure_margin: 0,
                turn_count: 2,
                confidence_drift: {
                  direction: 'balanced',
                  phase_margin: 0,
                  cumulative_margin: 0,
                },
              },
            ],
          },
          meta: { stream_id: 'debate-5', sequence: 1, event_id: 'debate-5:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setVerdict).toHaveBeenCalledWith(expect.objectContaining({
      winner: 'proposition',
      phase_insights: expect.any(Array),
    }));
  });

  it('forwards participant update events into the store', () => {
    render(<Harness debateId="debate-participants" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_participants_update',
          data: {
            participants: [
              {
                side: 'proposition',
                name: 'Dr. Vale',
                role: 'Budget auditor',
                persona: 'Reads every promise through the public ledger.',
              },
            ],
          },
          meta: {
            stream_id: 'debate-participants',
            sequence: 1,
            event_id: 'debate-participants:1',
          },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setParticipants).toHaveBeenCalledWith([
      expect.objectContaining({
        side: 'proposition',
        name: 'Dr. Vale',
        role: 'Budget auditor',
      }),
    ], 'debate-participants');
  });

  it('drops duplicate or stale debate events by sequence', () => {
    render(<Harness debateId="debate-seq" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'crossfire' },
          meta: { stream_id: 'debate-seq', sequence: 2, event_id: 'debate-seq:2' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'verdict' },
          meta: { stream_id: 'debate-seq', sequence: 2, event_id: 'debate-seq:2' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'opening' },
          meta: { stream_id: 'debate-seq', sequence: 1, event_id: 'debate-seq:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setPhase).toHaveBeenCalledTimes(1);
    expect(storeState.setPhase).toHaveBeenCalledWith('crossfire');
  });

  it('polls the latest debate snapshot when a sequence gap is detected', async () => {
    getDebateMock.mockResolvedValue({
      id: 'debate-gap',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'done',
      current_phase: 'verdict',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: true,
    });

    render(<Harness debateId="debate-gap" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'opening' },
          meta: { stream_id: 'debate-gap', sequence: 1, event_id: 'debate-gap:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'closing' },
          meta: { stream_id: 'debate-gap', sequence: 3, event_id: 'debate-gap:3' },
        }),
      } as MessageEvent<string>);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getDebateMock).toHaveBeenCalledWith('debate-gap');
    expect(storeState.setDebate).toHaveBeenCalled();
  });

  it('emits debug logs with ws metadata when the debug switch is enabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    window.sessionStorage.setItem('swarmoracle.ws-debug', '1');

    render(<Harness debateId="debate-debug" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'debate_phase_change',
          data: { phase: 'opening' },
          meta: {
            stream_id: 'debate-debug',
            sequence: 1,
            event_id: 'debate-debug:1',
            manager_instance_id: 'manager-1',
          },
        }),
      } as MessageEvent<string>);
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[DebateWS] receive',
      expect.objectContaining({
        streamId: 'debate-debug',
        sequence: 1,
        eventId: 'debate-debug:1',
      }),
    );
    debugSpy.mockRestore();
  });

});
