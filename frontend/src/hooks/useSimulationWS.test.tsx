import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Scenario } from '../types';
import { useSimulationWS } from './useSimulationWS';

const storeState = {
  setScenario: vi.fn(),
  handleWSEvent: vi.fn(),
};

const { getScenarioMock } = vi.hoisted(() => ({
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
  dispatchVizEvent: vi.fn(),
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

  send(data: string) {
    void data;
    // no-op: captures auth frames without side effects
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
    storeState.setScenario.mockReset();
    storeState.handleWSEvent.mockReset();
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    });
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
});
