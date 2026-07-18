import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Scenario } from '../types';
import { useSimulationWS } from './useSimulationWS';

const storeState = {
  status: 'simulating' as string,
  activeScenarioId: null as string | null,
  scenario: null as { id: string } | null,
  setScenario: vi.fn(),
  handleWSEvent: vi.fn(),
  setCancelled: vi.fn(),
};

const { dispatchVizEventMock, getScenarioMock } = vi.hoisted(() => ({
  dispatchVizEventMock: vi.fn(),
  getScenarioMock: vi.fn(),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: {
    getState: () => storeState,
  },
}));

vi.mock('../api/client', () => ({
  getScenario: getScenarioMock,
}));

vi.mock('../game/managers/EventBridge', () => ({
  dispatchVizEvent: dispatchVizEventMock,
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
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
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

function Harness({ scenarioId, ready = true }: { scenarioId?: string; ready?: boolean }) {
  useSimulationWS(scenarioId, ready);
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useSimulationWS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    getScenarioMock.mockReset();
    dispatchVizEventMock.mockReset();
    storeState.status = 'simulating';
    storeState.activeScenarioId = null;
    storeState.scenario = null;
    storeState.setScenario.mockReset();
    storeState.handleWSEvent.mockReset();
    storeState.setCancelled.mockReset();
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
    const localStore = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStore.delete(key);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('forwards flat and legacy nested visualization payloads without dropping metadata', () => {
    render(<Harness scenarioId="scenario-viz" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'viz:bubble_show',
          sprite_id: 'agent-flat',
          bubble_text: 'Flat payload',
          emotion: '',
          emotion_metadata_status: 'unavailable',
          emotion_metadata_failure_code: 'LLM_TIMEOUT',
          meta: { stream_id: 'scenario-viz', sequence: 1, event_id: 'viz-flat' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'viz:bubble_show',
          data: {
            sprite_id: 'agent-nested',
            bubble_text: 'Nested payload',
            emotion: 'neutral',
          },
          meta: { stream_id: 'scenario-viz', sequence: 2, event_id: 'viz-nested' },
        }),
      } as MessageEvent<string>);
    });

    expect(dispatchVizEventMock).toHaveBeenNthCalledWith(1, 'viz:bubble_show', {
      sprite_id: 'agent-flat',
      bubble_text: 'Flat payload',
      emotion: '',
      emotion_metadata_status: 'unavailable',
      emotion_metadata_failure_code: 'LLM_TIMEOUT',
    });
    expect(dispatchVizEventMock).toHaveBeenNthCalledWith(2, 'viz:bubble_show', {
      sprite_id: 'agent-nested',
      bubble_text: 'Nested payload',
      emotion: 'neutral',
    });
  });

  it('polls the latest scenario snapshot after reconnect when no state event arrives first', async () => {
    const scenario = {
      id: 'scenario-1',
      question: 'Q',
      status: 'simulating',
      created_at: '2026-03-23T00:00:00Z',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    } satisfies Scenario;
    getScenarioMock.mockResolvedValue(scenario);

    render(<Harness scenarioId="scenario-1" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(2000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    await act(async () => {
      MockWebSocket.instances[1]?.onopen?.(new Event('open'));
      await flushMicrotasks();
    });

    expect(storeState.setScenario).toHaveBeenCalledWith(scenario);
  });

  it('polls scenario status on clean close while still non-terminal (missed simulation_done safety net)', async () => {
    const doneScenario = {
      id: 'scenario-close-done',
      question: 'Q',
      status: 'done' as const,
      created_at: '2026-03-23T00:00:00Z',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    } satisfies Scenario;
    getScenarioMock.mockResolvedValue(doneScenario);
    storeState.status = 'simulating';
    storeState.activeScenarioId = 'scenario-close-done';
    storeState.scenario = { id: 'scenario-close-done' };

    render(<Harness scenarioId="scenario-close-done" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
    });

    getScenarioMock.mockClear();
    storeState.setScenario.mockClear();

    await act(async () => {
      // Clean close (1000) does not reconnect; must still poll terminal status.
      MockWebSocket.instances[0]?.emitClose(1000);
      await flushMicrotasks();
    });

    expect(getScenarioMock).toHaveBeenCalledWith('scenario-close-done');
    expect(storeState.setScenario).toHaveBeenCalledWith(doneScenario);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not overwrite newer WS state with a slower reconnect snapshot', async () => {
    const deferred = createDeferred<Scenario>();
    getScenarioMock.mockReturnValue(deferred.promise);

    render(<Harness scenarioId="scenario-2" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(2000);
      MockWebSocket.instances[1]?.onopen?.(new Event('open'));
    });

    act(() => {
      MockWebSocket.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'done' },
          meta: { stream_id: 'scenario-2', sequence: 1, event_id: 'scenario-2:1' },
        }),
      } as MessageEvent<string>);
    });

    await act(async () => {
      deferred.resolve({
        id: 'scenario-2',
        question: 'Q',
        status: 'simulating',
        created_at: '2026-03-23T00:00:00Z',
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        messages: [],
      });
      await flushMicrotasks();
    });

    expect(storeState.handleWSEvent).toHaveBeenCalledWith({
      type: 'status',
      data: { status: 'done' },
      meta: { stream_id: 'scenario-2', sequence: 1, event_id: 'scenario-2:1' },
    }, 'scenario-2');
    expect(storeState.setScenario).not.toHaveBeenCalled();
  });

  it('ignores stale socket events after a newer reconnect succeeds', async () => {
    const scenario = {
      id: 'scenario-3',
      question: 'Q',
      status: 'simulating',
      created_at: '2026-03-23T00:00:00Z',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    } satisfies Scenario;
    getScenarioMock.mockResolvedValue(scenario);

    render(<Harness scenarioId="scenario-3" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(2000);
    });

    await act(async () => {
      MockWebSocket.instances[1]?.onopen?.(new Event('open'));
      await flushMicrotasks();
    });

    storeState.handleWSEvent.mockClear();

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'done' },
          meta: { stream_id: 'scenario-3', sequence: 1, event_id: 'scenario-3:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(4000);
    });

    expect(storeState.handleWSEvent).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('drops duplicate or stale sequence events from the same stream', () => {
    render(<Harness scenarioId="scenario-4" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'simulating' },
          meta: { stream_id: 'scenario-4', sequence: 2, event_id: 'scenario-4:2' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'done' },
          meta: { stream_id: 'scenario-4', sequence: 2, event_id: 'scenario-4:2' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'error' },
          meta: { stream_id: 'scenario-4', sequence: 1, event_id: 'scenario-4:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.handleWSEvent).toHaveBeenCalledTimes(1);
  });

  it('drops an event whose stream identity belongs to a different scenario', () => {
    render(<Harness scenarioId="scenario-b" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'done' },
          meta: { stream_id: 'scenario-a', sequence: 1, event_id: 'scenario-a:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.handleWSEvent).not.toHaveBeenCalled();
  });

  it('polls the latest scenario snapshot when a sequence gap is detected', async () => {
    const scenario = {
      id: 'scenario-gap',
      question: 'Q',
      status: 'done',
      created_at: '2026-03-23T00:00:00Z',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    } satisfies Scenario;
    getScenarioMock.mockResolvedValue(scenario);

    render(<Harness scenarioId="scenario-gap" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'simulating' },
          meta: { stream_id: 'scenario-gap', sequence: 1, event_id: 'scenario-gap:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'done' },
          meta: { stream_id: 'scenario-gap', sequence: 3, event_id: 'scenario-gap:3' },
        }),
      } as MessageEvent<string>);
    });

    await act(async () => {
      await flushMicrotasks();
    });

    expect(getScenarioMock).toHaveBeenCalledWith('scenario-gap');
    expect(storeState.setScenario).toHaveBeenCalledWith(scenario);
  });

  it('sends auth first and waits for auth_ok before resyncing when a token is present', async () => {
    const scenario = {
      id: 'scenario-auth-ok',
      question: 'Q',
      status: 'done',
      created_at: '2026-03-23T00:00:00Z',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    } satisfies Scenario;
    getScenarioMock.mockResolvedValue(scenario);
    window.localStorage.setItem('swarmoracle_session_token', 'token-123');

    render(<Harness scenarioId="scenario-auth-ok" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
    });

    expect(MockWebSocket.instances[0]?.sentMessages).toEqual([
      JSON.stringify({ type: 'auth', token: 'token-123' }),
    ]);
    expect(getScenarioMock).not.toHaveBeenCalled();

    await act(async () => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: 'auth_ok' }),
      } as MessageEvent<string>);
      await flushMicrotasks();
    });

    expect(getScenarioMock).toHaveBeenCalledWith('scenario-auth-ok');
    expect(storeState.setScenario).toHaveBeenCalledWith(scenario);
  });

  it('emits debug logs with ws metadata when the debug switch is enabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    window.sessionStorage.setItem('swarmoracle.ws-debug', '1');

    render(<Harness scenarioId="scenario-debug" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          data: { status: 'simulating' },
          meta: {
            stream_id: 'scenario-debug',
            sequence: 1,
            event_id: 'scenario-debug:1',
            manager_instance_id: 'manager-1',
          },
        }),
      } as MessageEvent<string>);
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[SimulationWS] receive',
      expect.objectContaining({
        streamId: 'scenario-debug',
        sequence: 1,
        eventId: 'scenario-debug:1',
      }),
    );
    debugSpy.mockRestore();
  });

  it('does not reconnect on 4001 auth failure close', () => {
    render(<Harness scenarioId="scenario-auth" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.emitClose(4001);
      vi.advanceTimersByTime(30000);
    });

    // Should NOT have created a second WebSocket
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not reconnect on 4404 not-found close', () => {
    render(<Harness scenarioId="scenario-404" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.emitClose(4404);
      vi.advanceTimersByTime(30000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('still reconnects on 1006 abnormal close', () => {
    render(<Harness scenarioId="scenario-1006" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(2000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('handles simulation_cancelled event by setting cancelled state and suppressing reconnect', () => {
    render(<Harness scenarioId="scenario-cancel" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.(new Event('open'));
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'simulation_cancelled',
          reason: 'user_cancelled',
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setCancelled).toHaveBeenCalledWith('user_cancelled', 'scenario-cancel');

    // Socket was closed cleanly by the cancel handler — emitClose(1006) should
    // not trigger a reconnect because cleanedUp guard is set.
    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(30000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
