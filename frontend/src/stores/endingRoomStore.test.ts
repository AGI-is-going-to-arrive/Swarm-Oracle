import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEndingRoomStore } from './endingRoomStore';

const createEndingRoomMock = vi.fn();
const getEndingRoomMock = vi.fn();
const getEndingRoomResultMock = vi.fn();

vi.mock('../api/client', () => ({
  createEndingRoom: (...args: unknown[]) => createEndingRoomMock(...args),
  getEndingRoom: (...args: unknown[]) => getEndingRoomMock(...args),
  getEndingRoomResult: (...args: unknown[]) => getEndingRoomResultMock(...args),
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

describe('endingRoomStore', () => {
  beforeEach(() => {
    createEndingRoomMock.mockReset();
    getEndingRoomMock.mockReset();
    getEndingRoomResultMock.mockReset();
    useEndingRoomStore.getState().reset();
  });

  it('opens a room and hydrates a ready result payload', async () => {
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
    expect(useEndingRoomStore.getState().result?.summary).toBe('Summary');
  });

  it('commits a turn and clears the matching pending draft', () => {
    useEndingRoomStore.getState().hydrateSnapshot({
      id: 'room-2',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'zh',
      status: 'live',
      current_phase: 'opening',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: false,
    });
    useEndingRoomStore.getState().startDraft({
      room_id: 'room-2',
      turn_id: 'turn-1',
      participant_id: 'p-1',
      phase: 'opening',
      sequence: 1,
    });
    useEndingRoomStore.getState().appendDraft({
      room_id: 'room-2',
      turn_id: 'turn-1',
      participant_id: 'p-1',
      delta: '你好',
      chunk_index: 1,
    });

    useEndingRoomStore.getState().commitTurn({
      id: 'turn-1',
      room_id: 'room-2',
      sequence: 1,
      phase: 'opening',
      participant_id: 'p-1',
      content: '你好，世界',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:02Z',
    });

    expect(useEndingRoomStore.getState().pendingDrafts['turn-1']).toBeUndefined();
    expect(useEndingRoomStore.getState().snapshot?.turns).toHaveLength(1);
    expect(useEndingRoomStore.getState().snapshot?.turns[0]?.content).toBe('你好，世界');
  });

  it('loads a room and fetches the result only when ready', async () => {
    getEndingRoomMock.mockResolvedValue({
      id: 'room-3',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'one_move_only',
      title: 'One Move Only',
      language: 'en',
      status: 'live',
      current_phase: 'rebuttal',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      participants: [],
      turns: [],
      result_ready: false,
    });

    await useEndingRoomStore.getState().loadRoom('room-3');

    expect(getEndingRoomResultMock).not.toHaveBeenCalled();
    expect(useEndingRoomStore.getState().status).toBe('live');
    expect(useEndingRoomStore.getState().snapshot?.room_type).toBe('one_move_only');
  });
});
