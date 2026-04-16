import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndingRoomThreadSnapshot } from '../types';
import { useEndingRoomStore } from './endingRoomStore';

const appendEndingRoomThreadUserTurnMock = vi.fn();
const appendEndingRoomUserTurnMock = vi.fn();
const createEndingRoomMock = vi.fn();
const createEndingRoomThreadMock = vi.fn();
const getEndingRoomMock = vi.fn();
const getEndingRoomResultMock = vi.fn();
const getEndingRoomThreadMock = vi.fn();

vi.mock('../api/client', () => ({
  appendEndingRoomThreadUserTurn: (...args: unknown[]) => appendEndingRoomThreadUserTurnMock(...args),
  appendEndingRoomUserTurn: (...args: unknown[]) => appendEndingRoomUserTurnMock(...args),
  createEndingRoom: (...args: unknown[]) => createEndingRoomMock(...args),
  createEndingRoomThread: (...args: unknown[]) => createEndingRoomThreadMock(...args),
  getEndingRoom: (...args: unknown[]) => getEndingRoomMock(...args),
  getEndingRoomResult: (...args: unknown[]) => getEndingRoomResultMock(...args),
  getEndingRoomThread: (...args: unknown[]) => getEndingRoomThreadMock(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock('../i18n/config', () => ({
  default: {
    t: (key: string) => key,
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function roomThread(id: string, mode: 'room' | 'followup' = 'room'): EndingRoomThreadSnapshot {
  return {
    id,
    room_id: 'room-1',
    title: mode === 'room' ? 'Ending Chamber' : 'Follow-up Thread',
    mode,
    interaction_mode: mode === 'room' ? 'auto_recap' : 'thread_followup',
    participant_set_hash: `${id}-hash`,
    memory_partition_id: `${id}-partition`,
    created_at: '2026-03-29T00:00:00Z',
    updated_at: '2026-03-29T00:00:01Z',
    turns: [],
    room_type: 'ending_chamber' as const,
    room_title: 'Ending Chamber',
    room_status: 'done' as const,
    language: 'en' as const,
  };
}

describe('endingRoomStore', () => {
  beforeEach(() => {
    appendEndingRoomThreadUserTurnMock.mockReset();
    appendEndingRoomUserTurnMock.mockReset();
    createEndingRoomMock.mockReset();
    createEndingRoomThreadMock.mockReset();
    getEndingRoomMock.mockReset();
    getEndingRoomResultMock.mockReset();
    getEndingRoomThreadMock.mockReset();
    useEndingRoomStore.getState().reset();
  });

  it('opens a room, hydrates threads, and resolves the default active thread', async () => {
    createEndingRoomMock.mockResolvedValue({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    getEndingRoomMock.mockResolvedValue({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
      result: {
        summary: 'Summary',
        archivist_note: 'Archivist',
      },
    });

    const roomId = await useEndingRoomStore.getState().openRoom('scenario-1', {
      roomType: 'ending_chamber',
      anchorBranchId: 'branch-1',
      selectedBranchIds: ['branch-1'],
      language: 'en',
    });

    expect(roomId).toBe('room-1');
    expect(useEndingRoomStore.getState().status).toBe('done');
    expect(useEndingRoomStore.getState().activeThreadId).toBe('thread-room');
    expect(useEndingRoomStore.getState().threadOrder).toEqual(['thread-room']);
  });

  it('ignores stale openRoom responses after a newer room request wins', async () => {
    const first = createDeferred<{
      id: string;
      scenario_id: string;
      anchor_branch_id: string;
      room_type: 'ending_chamber';
      title: string;
      language: 'en';
      status: 'live';
      current_phase: 'opening';
      created_at: string;
      updated_at: string;
      participants: [];
      threads: EndingRoomThreadSnapshot[];
      turns: [];
      result_ready: false;
    }>();
    const second = createDeferred<{
      id: string;
      scenario_id: string;
      anchor_branch_id: string;
      room_type: 'one_move_only';
      title: string;
      language: 'en';
      status: 'live';
      current_phase: 'opening';
      created_at: string;
      updated_at: string;
      participants: [];
      threads: EndingRoomThreadSnapshot[];
      turns: [];
      result_ready: false;
    }>();

    createEndingRoomMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstPromise = useEndingRoomStore.getState().openRoom('scenario-1', {
      roomType: 'ending_chamber',
      anchorBranchId: 'branch-1',
      selectedBranchIds: ['branch-1'],
      language: 'en',
    });
    const secondPromise = useEndingRoomStore.getState().openRoom('scenario-1', {
      roomType: 'one_move_only',
      anchorBranchId: 'branch-2',
      selectedBranchIds: ['branch-2'],
      language: 'en',
    });

    second.resolve({
      id: 'room-2',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-2',
      room_type: 'one_move_only',
      title: 'One Move',
      language: 'en',
      status: 'live',
      current_phase: 'opening',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      threads: [roomThread('thread-room-2', 'room')],
      turns: [],
      result_ready: false,
    });
    await secondPromise;

    first.resolve({
      id: 'room-1',
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
      threads: [roomThread('thread-room-1', 'room')],
      turns: [],
      result_ready: false,
    });
    await firstPromise;

    expect(useEndingRoomStore.getState().snapshot?.id).toBe('room-2');
    expect(useEndingRoomStore.getState().snapshot?.room_type).toBe('one_move_only');
    expect(useEndingRoomStore.getState().activeThreadId).toBe('thread-room-2');
  });

  it('hydrates a follow-up thread and appends follow-up turns into that thread bucket', async () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    useEndingRoomStore.getState().hydrateThread({
      ...roomThread('thread-followup', 'followup'),
      title: 'Investigate the hinge',
    });
    useEndingRoomStore.getState().setActiveThread('thread-followup');

    useEndingRoomStore.getState().commitTurn({
      id: 'turn-1',
      room_id: 'room-1',
      thread_id: 'thread-followup',
      sequence: 4,
      phase: 'verdict',
      participant_id: 'p-1',
      content: 'Thread-local answer.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:02Z',
    });

    expect(useEndingRoomStore.getState().threadsById['thread-followup']?.turns[0]?.content).toBe('Thread-local answer.');
  });

  it('hydrates room-level snapshot turns into the default room thread bucket', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [
        {
          id: 'turn-room-1',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'opening',
          participant_id: 'p-1',
          content: 'Room transcript is present.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:02Z',
        },
      ],
      result_ready: true,
    });

    expect(useEndingRoomStore.getState().threadsById['thread-room']?.turns[0]?.content).toBe('Room transcript is present.');
  });

  it('ignores late draft events once the turn has already been committed', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });

    useEndingRoomStore.getState().commitTurn({
      id: 'turn-committed',
      room_id: 'room-1',
      thread_id: 'thread-room',
      sequence: 3,
      phase: 'verdict',
      participant_id: 'p-1',
      content: 'Committed answer.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:02Z',
    });

    useEndingRoomStore.getState().startDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-committed',
      participant_id: 'p-1',
      phase: 'verdict',
      sequence: 3,
    });
    useEndingRoomStore.getState().appendDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-committed',
      participant_id: 'p-1',
      delta: 'late delta',
      chunk_index: 99,
    });

    expect(useEndingRoomStore.getState().pendingDrafts).toEqual({});
    expect(useEndingRoomStore.getState().threadsById['thread-room']?.turns[0]?.content).toBe('Committed answer.');
  });

  it('drops stale pending drafts when a resync snapshot already contains the committed turn', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });

    useEndingRoomStore.getState().startDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-ghost',
      participant_id: 'p-1',
      phase: 'verdict',
      sequence: 5,
    });
    useEndingRoomStore.getState().appendDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-ghost',
      participant_id: 'p-1',
      delta: 'ghost draft',
      chunk_index: 1,
    });

    expect(useEndingRoomStore.getState().pendingDrafts['turn-ghost']?.content).toBe('ghost draft');

    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:02Z',
      participants: [],
      threads: [roomThread('thread-room', 'room')],
      turns: [
        {
          id: 'turn-ghost',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 5,
          phase: 'verdict',
          participant_id: 'p-1',
          content: 'Committed after resync.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:02Z',
        },
      ],
      result_ready: true,
    });

    expect(useEndingRoomStore.getState().pendingDrafts).toEqual({});
    expect(useEndingRoomStore.getState().threadsById['thread-room']?.turns[0]?.content).toBe('Committed after resync.');
  });

  it('drops stale pending drafts when a thread hydrate brings back the committed turn', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    useEndingRoomStore.getState().hydrateThread({
      ...roomThread('thread-followup', 'followup'),
      title: 'Investigate the hinge',
    });

    useEndingRoomStore.getState().startDraft({
      room_id: 'room-1',
      thread_id: 'thread-followup',
      turn_id: 'turn-followup',
      participant_id: 'p-1',
      phase: 'verdict',
      sequence: 6,
    });
    useEndingRoomStore.getState().appendDraft({
      room_id: 'room-1',
      thread_id: 'thread-followup',
      turn_id: 'turn-followup',
      participant_id: 'p-1',
      delta: 'thread ghost draft',
      chunk_index: 1,
    });

    useEndingRoomStore.getState().hydrateThread({
      ...roomThread('thread-followup', 'followup'),
      title: 'Investigate the hinge',
      turns: [
        {
          id: 'turn-followup',
          room_id: 'room-1',
          thread_id: 'thread-followup',
          sequence: 6,
          phase: 'verdict',
          participant_id: 'p-1',
          content: 'Committed inside thread.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
    });

    expect(useEndingRoomStore.getState().pendingDrafts).toEqual({});
    expect(useEndingRoomStore.getState().threadsById['thread-followup']?.turns[0]?.content).toBe('Committed inside thread.');
  });

  it('drops a recoverable stream draft error without poisoning the whole room state', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'live',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });

    useEndingRoomStore.getState().startDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-stream',
      participant_id: 'p-1',
      phase: 'verdict',
      sequence: 7,
    });
    useEndingRoomStore.getState().appendDraft({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-stream',
      participant_id: 'p-1',
      delta: 'partial stream',
      chunk_index: 1,
    });

    useEndingRoomStore.getState().handleTurnError({
      room_id: 'room-1',
      thread_id: 'thread-room',
      turn_id: 'turn-stream',
      participant_id: 'p-1',
      message: 'stream_interrupted',
      recoverable: true,
    });

    expect(useEndingRoomStore.getState().pendingDrafts).toEqual({});
    expect(useEndingRoomStore.getState().status).toBe('live');
    expect(useEndingRoomStore.getState().error).toBeNull();
  });

  it('creates a follow-up thread and switches the active thread', async () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    createEndingRoomThreadMock.mockResolvedValue({
      ...roomThread('thread-followup', 'followup'),
      title: 'Archivist follow-up',
    });

    await useEndingRoomStore.getState().createThread('room-1', {
      title: 'Archivist follow-up',
      questionAnchorIds: ['ending:verdict:branch-1'],
      interactionMode: 'thread_followup',
    });

    expect(createEndingRoomThreadMock).toHaveBeenCalledWith('room-1', expect.objectContaining({
      title: 'Archivist follow-up',
      questionAnchorIds: ['ending:verdict:branch-1'],
    }));
    expect(useEndingRoomStore.getState().activeThreadId).toBe('thread-followup');
    expect(useEndingRoomStore.getState().threadOrder).toContain('thread-followup');
    expect(useEndingRoomStore.getState().snapshot?.threads.map((thread) => thread.id)).toContain('thread-followup');
  });

  it('routes composer sends to the thread endpoint when a follow-up thread is active', async () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    useEndingRoomStore.getState().hydrateThread({
      ...roomThread('thread-followup', 'followup'),
      title: 'Follow-up Thread',
    });
    useEndingRoomStore.getState().setActiveThread('thread-followup');
    appendEndingRoomThreadUserTurnMock.mockResolvedValue({
      room_id: 'room-1',
      thread_id: 'thread-followup',
      memory_partition_id: 'thread-followup-partition',
      turns: [
        {
          id: 'turn-1',
          room_id: 'room-1',
          thread_id: 'thread-followup',
          sequence: 5,
          phase: 'verdict',
          participant_id: 'p-1',
          content: 'Narrow answer.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
    });
    getEndingRoomThreadMock.mockResolvedValue({
      ...roomThread('thread-followup', 'followup'),
      title: 'Follow-up Thread',
      turns: [
        {
          id: 'turn-1',
          room_id: 'room-1',
          thread_id: 'thread-followup',
          sequence: 5,
          phase: 'verdict',
          participant_id: 'p-1',
          content: 'Narrow answer.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
    });

    await useEndingRoomStore.getState().appendUserTurn({
      content: 'Stay inside this thread.',
      questionAnchorIds: ['ending:quote:branch-1:turn-1'],
      interactionMode: 'thread_followup',
    });

    expect(appendEndingRoomThreadUserTurnMock).toHaveBeenCalledWith('thread-followup', expect.objectContaining({
      content: 'Stay inside this thread.',
      questionAnchorIds: ['ending:quote:branch-1:turn-1'],
    }));
    expect(useEndingRoomStore.getState().composerDraft).toBe('');
  });

  it('reloads the room after appending turns so late-created user participants hydrate into the snapshot', async () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
    });
    useEndingRoomStore.getState().hydrateResult({
      id: 'room-1',
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
      threads: [roomThread('thread-room', 'room')],
      turns: [],
      result_ready: true,
      result: {
        summary: 'Summary',
      },
    });
    appendEndingRoomUserTurnMock.mockResolvedValue({
      room_id: 'room-1',
      thread_id: 'thread-room',
      memory_partition_id: 'room-partition',
      turns: [
        {
          id: 'turn-user',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 4,
          phase: 'verdict',
          participant_id: 'participant-user',
          content: 'User follow-up',
          emotion: 'curious',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
    });
    getEndingRoomMock.mockResolvedValue({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:04Z',
      participants: [
        {
          id: 'participant-user',
          room_id: 'room-1',
          role_slot: 'user',
          display_name: 'You',
        },
      ],
      threads: [roomThread('thread-room', 'room')],
      turns: [
        {
          id: 'turn-user',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 4,
          phase: 'verdict',
          participant_id: 'participant-user',
          content: 'User follow-up',
          emotion: 'curious',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
      result_ready: true,
    });
    getEndingRoomResultMock.mockResolvedValue({
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:04Z',
      participants: [
        {
          id: 'participant-user',
          room_id: 'room-1',
          role_slot: 'user',
          display_name: 'You',
        },
      ],
      threads: [roomThread('thread-room', 'room')],
      turns: [
        {
          id: 'turn-user',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 4,
          phase: 'verdict',
          participant_id: 'participant-user',
          content: 'User follow-up',
          emotion: 'curious',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
      result_ready: true,
      result: {
        summary: 'Summary',
      },
    });

    await useEndingRoomStore.getState().appendUserTurn({
      content: 'User follow-up',
      questionAnchorIds: ['ending:key_moment:branch-1:0'],
      interactionMode: 'archivist_route',
    });

    expect(appendEndingRoomUserTurnMock).toHaveBeenCalledWith('room-1', expect.objectContaining({
      content: 'User follow-up',
      questionAnchorIds: ['ending:key_moment:branch-1:0'],
    }));
    expect(getEndingRoomMock).toHaveBeenCalledWith('room-1');
    expect(useEndingRoomStore.getState().snapshot?.participants[0]?.display_name).toBe('You');
  });
});
