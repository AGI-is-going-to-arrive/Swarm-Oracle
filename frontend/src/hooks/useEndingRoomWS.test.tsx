import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEndingRoomWS } from './useEndingRoomWS';

const getEndingRoomMock = vi.fn();
const getEndingRoomResultMock = vi.fn();
const storeState = {
  hydrateSnapshot: vi.fn(),
  hydrateResult: vi.fn(),
  hydrateThread: vi.fn(),
  setPhase: vi.fn(),
  setStatus: vi.fn(),
  startDraft: vi.fn(),
  appendDraft: vi.fn(),
  handleTurnError: vi.fn(),
  commitTurn: vi.fn(),
  setResult: vi.fn(),
  setScopeNotice: vi.fn(),
  setError: vi.fn(),
};

vi.mock('../stores/endingRoomStore', () => ({
  useEndingRoomStore: {
    getState: () => storeState,
  },
}));

vi.mock('../api/client', () => ({
  getEndingRoom: (...args: unknown[]) => getEndingRoomMock(...args),
  getEndingRoomResult: (...args: unknown[]) => getEndingRoomResultMock(...args),
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

function Harness({ roomId, ready = true }: { roomId?: string; ready?: boolean }) {
  useEndingRoomWS(roomId, ready);
  return null;
}

describe('useEndingRoomWS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    getEndingRoomMock.mockReset();
    getEndingRoomResultMock.mockReset();
    Object.values(storeState).forEach((value) => value.mockReset());
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

  it('forwards turn start, delta, and commit events into the store', () => {
    render(<Harness roomId="room-1" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(MockWebSocket.instances[0]?.url).toContain('/ws/ending-room/room-1');

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_turn_start',
          data: {
            room_id: 'room-1',
            thread_id: 'thread-room',
            turn_id: 'turn-1',
            participant_id: 'p-1',
            phase: 'opening',
            sequence: 1,
          },
          meta: { stream_id: 'room-1', sequence: 1, event_id: 'room-1:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_turn_delta',
          data: {
            room_id: 'room-1',
            thread_id: 'thread-room',
            turn_id: 'turn-1',
            participant_id: 'p-1',
            delta: 'Hello',
            chunk_index: 1,
          },
          meta: { stream_id: 'room-1', sequence: 2, event_id: 'room-1:2' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_turn_commit',
          data: {
            id: 'turn-1',
            room_id: 'room-1',
            sequence: 1,
            phase: 'opening',
            participant_id: 'p-1',
            content: 'Hello world',
            emotion: 'focused',
            created_at: '2026-03-29T00:00:00Z',
          },
          meta: { stream_id: 'room-1', sequence: 3, event_id: 'room-1:3' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.startDraft).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: 'thread-room',
      turn_id: 'turn-1',
      participant_id: 'p-1',
    }));
    expect(storeState.appendDraft).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: 'thread-room',
      turn_id: 'turn-1',
      delta: 'Hello',
    }));
    expect(storeState.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      id: 'turn-1',
      content: 'Hello world',
    }));
  });

  it('ignores heartbeat events', () => {
    render(<Harness roomId="room-heartbeat" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'heartbeat',
          data: { ts: '2026-03-29T00:00:00Z' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setStatus).not.toHaveBeenCalled();
    expect(storeState.startDraft).not.toHaveBeenCalled();
  });

  it('treats recoverable stream turn errors as draft cleanup instead of a room-level fatal error', () => {
    render(<Harness roomId="room-recoverable-error" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_turn_error',
          data: {
            room_id: 'room-recoverable-error',
            thread_id: 'thread-room',
            turn_id: 'turn-1',
            participant_id: 'p-1',
            message: 'stream_interrupted',
            code: 'stream_interrupted',
            recoverable: true,
          },
          meta: { stream_id: 'room-recoverable-error', sequence: 1, event_id: 'room-recoverable-error:1' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.handleTurnError).toHaveBeenCalledWith(expect.objectContaining({
      turn_id: 'turn-1',
      code: 'stream_interrupted',
      recoverable: true,
    }));
    expect(storeState.setError).not.toHaveBeenCalled();
  });

  it('resyncs when sequence gaps are detected', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-gap',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-gap',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
      result: { summary: 'Summary' },
    });

    render(<Harness roomId="room-gap" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    await act(async () => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'crossfire' },
          meta: { stream_id: 'room-gap', sequence: 3, event_id: 'room-gap:3' },
        }),
      } as MessageEvent<string>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndingRoomMock).toHaveBeenCalledWith('room-gap');
    expect(getEndingRoomResultMock).toHaveBeenCalledWith('room-gap');
    expect(storeState.hydrateSnapshot).toHaveBeenCalled();
    expect(storeState.hydrateResult).toHaveBeenCalled();
  });

  it('resyncs once on the initial socket open to catch fast-completing rooms', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-open',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-open',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
      result: { summary: 'Summary' },
    });

    render(<Harness roomId="room-open" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    await act(async () => {
      MockWebSocket.instances[0]?.onopen?.({} as Event);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndingRoomMock).toHaveBeenCalledWith('room-open');
    expect(getEndingRoomResultMock).toHaveBeenCalledWith('room-open');
    expect(storeState.hydrateSnapshot).toHaveBeenCalled();
    expect(storeState.hydrateResult).toHaveBeenCalled();
  });

  it('sends auth first and waits for auth_ok before resyncing when a token is present', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-auth-ok',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-auth-ok',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
      result: { summary: 'Summary' },
    });
    window.localStorage.setItem('swarmoracle_session_token', 'token-abc');

    render(<Harness roomId="room-auth-ok" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.({} as Event);
    });

    expect(MockWebSocket.instances[0]?.sentMessages).toEqual([
      JSON.stringify({ type: 'auth', token: 'token-abc' }),
    ]);
    expect(getEndingRoomMock).not.toHaveBeenCalled();

    await act(async () => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: 'auth_ok' }),
      } as MessageEvent<string>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndingRoomMock).toHaveBeenCalledWith('room-auth-ok');
    expect(getEndingRoomResultMock).toHaveBeenCalledWith('room-auth-ok');
    expect(storeState.hydrateSnapshot).toHaveBeenCalled();
    expect(storeState.hydrateResult).toHaveBeenCalled();
  });

  it('does not trigger a second resync when the first post-open event starts above sequence one', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-open-gap',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-open-gap',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: true,
      result: { summary: 'Summary' },
    });

    render(<Harness roomId="room-open-gap" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    await act(async () => {
      MockWebSocket.instances[0]?.onopen?.({} as Event);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndingRoomMock).toHaveBeenCalledTimes(1);
    expect(getEndingRoomResultMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'crossfire' },
          meta: { stream_id: 'room-open-gap', sequence: 14, event_id: 'room-open-gap:14' },
        }),
      } as MessageEvent<string>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getEndingRoomMock).toHaveBeenCalledTimes(1);
    expect(getEndingRoomResultMock).toHaveBeenCalledTimes(1);
    expect(storeState.setPhase).toHaveBeenCalledWith('crossfire');
  });

  it('drops duplicate or stale sequence events from the same room stream', () => {
    render(<Harness roomId="room-stale-sequence" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'crossfire' },
          meta: { stream_id: 'room-stale-sequence', sequence: 1, event_id: 'room-stale-sequence:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'closing' },
          meta: { stream_id: 'room-stale-sequence', sequence: 1, event_id: 'room-stale-sequence:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'opening' },
          meta: { stream_id: 'room-stale-sequence', sequence: 0, event_id: 'room-stale-sequence:0' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.setPhase).toHaveBeenCalledTimes(1);
    expect(storeState.setPhase).toHaveBeenCalledWith('crossfire');
  });

  it('ignores stale socket events after a newer ending-room reconnect succeeds', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-stale-socket',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'opening',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: false,
    });

    render(<Harness roomId="room-stale-socket" />);

    act(() => {
      vi.runOnlyPendingTimers();
      MockWebSocket.instances[0]?.onopen?.({} as Event);
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(1500);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    await act(async () => {
      MockWebSocket.instances[1]?.onopen?.({} as Event);
      await Promise.resolve();
      await Promise.resolve();
    });

    storeState.setPhase.mockClear();

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_phase_change',
          data: { phase: 'verdict' },
          meta: { stream_id: 'room-stale-socket', sequence: 1, event_id: 'room-stale-socket:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.emitClose(1006);
      vi.advanceTimersByTime(3000);
    });

    expect(storeState.setPhase).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect after a normal close', () => {
    render(<Harness roomId="room-close" />);

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

  it('hydrates thread creation and scope notices', () => {
    render(<Harness roomId="room-thread-events" />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_thread_created',
          data: {
            id: 'thread-1',
            room_id: 'room-thread-events',
            title: 'Follow-up Thread',
            mode: 'followup',
            interaction_mode: 'thread_followup',
            participant_set_hash: 'hash',
            memory_partition_id: 'partition',
            room_type: 'ending_chamber',
            room_title: 'Ending Chamber',
            room_status: 'done',
            language: 'en',
            turns: [],
            created_at: '2026-03-29T00:00:00Z',
            updated_at: '2026-03-29T00:00:01Z',
          },
          meta: { stream_id: 'room-thread-events', sequence: 1, event_id: 'room-thread-events:1' },
        }),
      } as MessageEvent<string>);
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'ending_room_scope_notice',
          data: {
            thread_id: 'thread-1',
            memory_partition_id: 'partition',
          },
          meta: { stream_id: 'room-thread-events', sequence: 2, event_id: 'room-thread-events:2' },
        }),
      } as MessageEvent<string>);
    });

    expect(storeState.hydrateThread).toHaveBeenCalledWith(expect.objectContaining({
      id: 'thread-1',
      mode: 'followup',
    }));
    expect(storeState.setScopeNotice).toHaveBeenCalledWith({
      threadId: 'thread-1',
      memoryPartitionId: 'partition',
    });
  });
});
