import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EndingChatModal from './EndingChatModal';

const onAutomationStateChangeMock = vi.fn();

const storeState = {
  snapshot: null as any,
  result: null as any,
  threadsById: {} as Record<string, unknown>,
  threadOrder: [] as string[],
  activeThreadId: null as string | null,
  interactionMode: 'archivist_route',
  composerDraft: '',
  scopeNotice: null as null | { threadId: string; memoryPartitionId: string },
  sending: false,
  status: 'idle',
  error: null as string | null,
  pendingDrafts: {} as Record<string, unknown>,
  openRoom: vi.fn(async () => 'room-1'),
  loadRoom: vi.fn(async () => {}),
  loadThread: vi.fn(async () => {}),
  createThread: vi.fn(async () => ({
    id: 'thread-followup',
    room_id: 'room-1',
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
  })),
  appendUserTurn: vi.fn(async () => {}),
  setActiveThread: vi.fn(),
  setInteractionMode: vi.fn(),
  setComposerDraft: vi.fn(),
  reset: vi.fn(),
};

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string) => ({
      'common.close': 'Close',
      'ending_room.title': 'Ending Chamber',
      'ending_room.status_done': 'Debrief complete',
      'ending_room.status_live': 'Speaking',
      'ending_room.status_draft': 'Preparing',
      'ending_room.current_branch_badge': 'Current worldline',
      'ending_room.mode_debrief': 'Debrief',
      'ending_room.mode_one_move_only': 'One Move Only',
      'ending_room.replay_readonly': 'Replay mode is read-only for ending chambers.',
      'ending_room.loading': 'Preparing the current ending chamber...',
      'ending_room.empty': 'No chamber record is available for this ending yet.',
      'ending_room.participant_unknown': 'Unknown participant',
      'ending_room.transcript_title': 'Chamber Transcript',
      'ending_room.draft_badge': 'Speaking',
      'result.story': 'Story',
      'result.insight': 'Insight',
      'roundtable.phase_verdict': 'Archive Verdict',
      'roundtable.phase_opening': 'Ending Recall',
      'roundtable.phase_crossfire': 'Fault Line',
      'roundtable.phase_rebuttal': 'If Replayed',
      'common.loading': 'Loading',
    }[key] ?? key),
    i18n: {
      language: 'en',
    },
  }),
}));

vi.mock('../hooks/useEndingRoomWS', () => ({
  useEndingRoomWS: vi.fn(),
}));

vi.mock('../game/managers/VizSynthesizer', () => ({
  mapRoleToSpriteId: () => 'sprite_default',
}));

vi.mock('../stores/endingRoomStore', () => ({
  useEndingRoomStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
}));

describe('EndingChatModal', () => {
  beforeEach(() => {
    onAutomationStateChangeMock.mockReset();
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
    storeState.interactionMode = 'archivist_route';
    storeState.composerDraft = '';
    storeState.scopeNotice = null;
    storeState.sending = false;
    storeState.status = 'idle';
    storeState.error = null;
    storeState.pendingDrafts = {};
    storeState.openRoom.mockReset();
    storeState.loadRoom.mockReset();
    storeState.loadThread.mockReset();
    storeState.createThread.mockReset();
    storeState.appendUserTurn.mockReset();
    storeState.setActiveThread.mockReset();
    storeState.setInteractionMode.mockReset();
    storeState.setComposerDraft.mockReset();
    storeState.reset.mockReset();
  });

  const branch = {
    id: 'branch-1',
    title: 'Archive Branch',
    probability: 0.64,
    status: 'COMPLETED' as const,
    fork_round: 1,
    story: 'A full branch story.',
    insight: 'A clean insight.',
    summary: 'A concise branch summary.',
    key_moments: ['Moment 1'],
    parent_branch_id: null,
    fork_reason: 'Early fork',
  };

  it('renders replay fallback transcript without creating a live room', () => {
    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        language="en"
        readOnly
        fallbackMessages={[
          {
            agent: 'Archivist',
            agent_id: 'agent-1',
            message: 'Fallback transcript line.',
            emotion: 'calm',
            branch: 'branch-1',
            round: 1,
          },
        ]}
        onClose={() => {}}
        onModeChange={vi.fn()}
        onAutomationStateChange={onAutomationStateChangeMock}
      />,
    );

    expect(screen.getByText('Fallback transcript line.')).toBeInTheDocument();
    expect(screen.getByText('Replay mode is read-only for ending chambers.')).toBeInTheDocument();
    expect(storeState.openRoom).not.toHaveBeenCalled();
  });

  it('renders thread rail, participant strip, and composer from the store', () => {
    storeState.snapshot = {
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'one_move_only',
      title: 'One Move Only',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:00Z',
      result_ready: true,
      participants: [
        {
          id: 'p-1',
          room_id: 'room-1',
          role_slot: 'agent',
          source_agent_id: 'agent-1',
          display_name: 'Archivist',
          persona_snapshot_json: {
            agent_role: 'Judge',
          },
        },
        {
          id: 'p-2',
          room_id: 'room-1',
          role_slot: 'archivist',
          display_name: 'The Archivist',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-1',
          title: 'One Move Only',
          mode: 'room',
          interaction_mode: 'auto_recap',
          participant_set_hash: 'hash-room',
          memory_partition_id: 'room-partition',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
        },
        {
          id: 'thread-followup',
          room_id: 'room-1',
          title: 'Follow-up Thread',
          mode: 'followup',
          interaction_mode: 'thread_followup',
          participant_set_hash: 'hash-thread',
          memory_partition_id: 'thread-partition',
          created_at: '2026-03-29T00:00:02Z',
          updated_at: '2026-03-29T00:00:03Z',
        },
      ],
      turns: [
        {
          id: 'turn-1',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'opening',
          participant_id: 'p-1',
          content: 'Committed turn.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
    };
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'one_move_only',
        room_title: 'One Move Only',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
      'thread-followup': {
        ...storeState.snapshot.threads[1],
        room_type: 'one_move_only',
        room_title: 'One Move Only',
        room_status: 'done',
        language: 'en',
        turns: [
          {
            id: 'turn-2',
            room_id: 'room-1',
            thread_id: 'thread-followup',
            sequence: 2,
            phase: 'verdict',
            participant_id: 'p-2',
            content: 'Thread-local answer.',
            emotion: 'measured',
            created_at: '2026-03-29T00:00:02Z',
          },
        ],
      },
    };
    storeState.threadOrder = ['thread-room', 'thread-followup'];
    storeState.activeThreadId = 'thread-followup';
    storeState.result = {
      summary: 'Final summary.',
      next_move: 'Delay the decision by one round.',
    };
    storeState.status = 'done';

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="one_move_only"
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Thread-local answer.')).toBeInTheDocument();
    expect(screen.getAllByText('Follow-up Thread').length).toBeGreaterThan(0);
    expect(screen.getByText('Current participants')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(storeState.openRoom).toHaveBeenCalledWith('scenario-1', {
      roomType: 'one_move_only',
      anchorBranchId: 'branch-1',
      selectedBranchIds: ['branch-1'],
      language: 'en',
    });
  });

  it('sends follow-up turns and supports creating a thread', async () => {
    const user = userEvent.setup();
    storeState.snapshot = {
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:00Z',
      result_ready: true,
      participants: [
        {
          id: 'p-1',
          room_id: 'room-1',
          role_slot: 'agent',
          source_agent_id: 'agent-1',
          display_name: 'Nadia',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-1',
          title: 'Ending Chamber',
          mode: 'room',
          interaction_mode: 'auto_recap',
          participant_set_hash: 'hash-room',
          memory_partition_id: 'room-partition',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
        },
      ],
      turns: [],
    };
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'ending_chamber',
        room_title: 'Ending Chamber',
        room_status: 'done',
        language: 'en',
        turns: [],
      },
    };
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.result = {
      summary: 'Final summary.',
    };
    storeState.status = 'done';

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New thread' }));
    expect(storeState.createThread).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Hotseat' }));
    expect(storeState.setInteractionMode).toHaveBeenCalledWith('hotseat');

    await user.click(screen.getByRole('button', { name: 'All present' }));
    expect(storeState.setInteractionMode).toHaveBeenCalledWith('all_present');

    await user.click(screen.getByRole('button', { name: 'Key moment' }));
    expect(storeState.setComposerDraft).toHaveBeenCalledWith(expect.stringContaining('Moment 1'));
  });

  it('switches modes via callback', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={onModeChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'One Move Only' }));

    expect(onModeChange).toHaveBeenCalledWith('one_move_only');
  });

  it('renders user follow-up turns as You when the user participant is not in the visible participant list', () => {
    storeState.snapshot = {
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:00Z',
      result_ready: true,
      participants: [
        {
          id: 'p-archivist',
          room_id: 'room-1',
          role_slot: 'archivist',
          display_name: 'The Archivist',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-1',
          title: 'Ending Chamber',
          mode: 'room',
          interaction_mode: 'auto_recap',
          participant_set_hash: 'hash-room',
          memory_partition_id: 'room-partition',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
        },
      ],
      turns: [],
    };
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'ending_chamber',
        room_title: 'Ending Chamber',
        room_status: 'done',
        language: 'en',
        turns: [
          {
            id: 'turn-user',
            room_id: 'room-1',
            thread_id: 'thread-room',
            sequence: 1,
            phase: 'verdict',
            participant_id: 'p-user',
            content: 'Why did this ending lock in?',
            emotion: 'curious',
            source: 'user_turn',
            created_at: '2026-03-29T00:00:02Z',
          },
        ],
      },
    };
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.result = {
      summary: 'Final summary.',
    };
    storeState.status = 'done';

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Why did this ending lock in?')).toBeInTheDocument();
  });
});
