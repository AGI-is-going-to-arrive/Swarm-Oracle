import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPretextCache } from '../lib/textLayout/pretext';
import {
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  estimateBubbleHeight,
  predictTextOverflow,
} from '../lib/textLayout/textOverflowPredictor';
import EndingChatModal from './EndingChatModal';

const onAutomationStateChangeMock = vi.fn();
const useEndingRoomWSMock = vi.fn();
const copyTextMock = vi.fn(async (_value: string) => {});

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
      'ending_room.action_continue': 'Continue from verdict',
      'ending_room.action_new_thread': 'Start anchored thread',
      'ending_room.action_copy_brief': 'Copy chamber brief',
      'ending_room.action_brief_copied': 'Chamber brief copied',
      'ending_room.action_follow_insight': 'Follow this insight',
      'ending_room.action_follow_quote': 'Follow this quote',
      'ending_room.action_thread_from_anchor': 'Start thread from current anchor',
      'result.story': 'Story',
      'result.insight': 'Insight',
      'roundtable.phase_verdict': 'Archive Verdict',
      'roundtable.phase_opening': 'Ending Recall',
      'roundtable.phase_crossfire': 'Fault Line',
      'roundtable.phase_rebuttal': 'If Replayed',
      'roundtable.gallery_title': 'Crossline Gallery',
      'roundtable.gallery_hint': 'This view exposes summaries and key quotes from other worldlines, not the full transcript.',
      'common.loading': 'Loading',
      'ending_room.foreign_summary_badge': 'Crossline summary',
    }[key] ?? key),
    i18n: {
      language: 'en',
    },
  }),
}));

vi.mock('../hooks/useEndingRoomWS', () => ({
  useEndingRoomWS: (...args: unknown[]) => useEndingRoomWSMock(...args),
}));

vi.mock('../game/managers/VizSynthesizer', () => ({
  mapRoleToSpriteId: () => 'sprite_default',
}));

vi.mock('../lib/copyText', () => ({
  copyText: (value: string) => copyTextMock(value),
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
    useEndingRoomWSMock.mockReset();
    copyTextMock.mockReset();
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
    expect(screen.getAllByText('Replay mode is read-only for ending chambers.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(storeState.openRoom).not.toHaveBeenCalled();
  });

  it('keeps a read-only contract for committed and draft bubble sizing', () => {
    clearPretextCache();

    const committedPrediction = predictTextOverflow(
      'Archivist: the hinge failed because everyone treated optics as stability.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomBubble,
    );
    const draftHeight = estimateBubbleHeight(
      '请先钉住真正的转折点，再把代价拆开。\n第二行继续追问：是谁把这次误判扩散成了整条世界线的共识？',
      ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomDraftBubble,
    );
    const committedHeight = estimateBubbleHeight(
      'Archivist: the hinge failed because everyone treated optics as stability.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomBubble,
    );

    expect(committedPrediction.overflow).toBe(false);
    expect(draftHeight).toBeGreaterThanOrEqual(committedHeight);
  });

  it('renders crossline gallery as a summary-only view', () => {
    storeState.snapshot = {
      id: 'room-gallery',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'crossline_gallery',
      title: 'Crossline Gallery',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      result_ready: true,
      participants: [{
        id: 'p-archivist',
        room_id: 'room-gallery',
        role_slot: 'archivist',
        display_name: 'The Archivist',
      }],
      threads: [],
      turns: [],
    };
    storeState.result = {
      summary: 'Summaries only.',
      archivist_note: 'No foreign full transcripts.',
      supporting_turns: [],
      next_move: null,
      by_phase: [],
      quotes: [],
    };

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="crossline_gallery"
        selectedBranchIds={['branch-2']}
        galleryBranches={[
          branch,
          {
            ...branch,
            id: 'branch-2',
            title: 'Second Branch',
            summary: 'A distant branch summary.',
            insight: 'Another line bent differently.',
            key_moments: ['Moment 2'],
            probability: 0.36,
          },
        ]}
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
        onAutomationStateChange={onAutomationStateChangeMock}
      />,
    );

    expect(screen.getAllByText('Crossline Gallery').length).toBeGreaterThan(0);
    expect(screen.getByText('Second Branch')).toBeInTheDocument();
    expect(screen.getByText('Another line bent differently.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getAllByText('This view exposes summaries and key quotes from other worldlines, not the full transcript.').length).toBeGreaterThan(0);
  });

  it('offers anchored verdict actions without breaking chamber scope', async () => {
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
      updated_at: '2026-03-29T00:00:01Z',
      result_ready: true,
      participants: [],
      threads: [],
      turns: [],
    };
    storeState.result = {
      summary: 'The hinge held because the council blinked first.',
      archivist_note: 'Stay inside the branch scope.',
      supporting_turns: [],
      next_move: 'Force the council to expose its costs.',
      by_phase: [],
      quotes: [],
    };

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
        onAutomationStateChange={onAutomationStateChangeMock}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue from verdict' }));
    expect(storeState.setComposerDraft).toHaveBeenCalledWith('Continue from this ending: why did "The hinge held because the council blinked first." hold?');

    await user.click(screen.getByRole('button', { name: 'Start anchored thread' }));
    await waitFor(() => expect(storeState.createThread).toHaveBeenCalledWith('room-1', {
      title: null,
      questionAnchorIds: ['ending:verdict:branch-1'],
      interactionMode: 'thread_followup',
    }));
    expect(storeState.setInteractionMode).toHaveBeenCalledWith('thread_followup');

    await user.click(screen.getByRole('button', { name: 'Copy chamber brief' }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalled());
    expect(copyTextMock).toHaveBeenCalledWith(expect.stringContaining('## Archivist Verdict'));
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
    const threadBubble = screen.getByText('Thread-local answer.').closest('article');
    expect(threadBubble).not.toBeNull();
    const threadBubbleScope = within(threadBubble as HTMLElement);
    expect(threadBubbleScope.getByRole('button', { name: 'Follow this quote' })).toBeInTheDocument();
    expect(storeState.openRoom).toHaveBeenCalledTimes(1);
    expect(storeState.openRoom).toHaveBeenCalledWith('scenario-1', {
      roomType: 'one_move_only',
      anchorBranchId: 'branch-1',
      selectedBranchIds: ['branch-1'],
      language: 'en',
    });
  });

  it('can anchor a follow-up directly from a transcript quote', async () => {
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
          display_name: 'Archivist',
          persona_snapshot_json: {
            agent_role: 'Judge',
          },
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
      turns: [
        {
          id: 'turn-1',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'verdict',
          participant_id: 'p-1',
          content: 'Thread-local answer.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
    };
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'ending_chamber',
        room_title: 'Ending Chamber',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    };
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.result = {
      summary: 'Final summary.',
      next_move: 'Delay the decision by one round.',
    };

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

    const user = userEvent.setup();
    const threadBubble = screen.getByText('Thread-local answer.').closest('article');
    expect(threadBubble).not.toBeNull();
    const threadBubbleScope = within(threadBubble as HTMLElement);

    await user.click(threadBubbleScope.getByRole('button', { name: 'Follow this quote' }));
    expect(storeState.setComposerDraft).toHaveBeenCalledWith('Follow this quote: Archivist said "Thread-local answer.". Which hinge was this line really pointing at?');

    await user.click(threadBubbleScope.getByRole('button', { name: 'Start anchored thread' }));
    await waitFor(() => expect(storeState.createThread).toHaveBeenCalledWith('room-1', {
      title: null,
      questionAnchorIds: ['ending:quote:branch-1:turn-1'],
      interactionMode: 'thread_followup',
    }));
  });

  it('lets a key moment anchor reuse the same thread-from-anchor rule', async () => {
    storeState.setComposerDraft.mockImplementation((value: string) => {
      storeState.composerDraft = value;
    });
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
      updated_at: '2026-03-29T00:00:01Z',
      result_ready: true,
      participants: [],
      threads: [],
      turns: [],
    };
    storeState.result = {
      summary: 'The hinge held because the council blinked first.',
      archivist_note: 'Stay inside the branch scope.',
      supporting_turns: [],
      next_move: 'Force the council to expose its costs.',
      by_phase: [],
      quotes: [],
    };

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

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Key moment' }));
    await user.click(screen.getByRole('button', { name: 'Start thread from current anchor' }));
    await waitFor(() => expect(storeState.createThread).toHaveBeenCalledWith('room-1', {
      title: null,
      questionAnchorIds: ['ending:key_moment:branch-1:0'],
      interactionMode: 'thread_followup',
    }));
  });

  it('cleans up the delayed room bootstrap timer on unmount', async () => {
    vi.useFakeTimers();

    const rendered = render(
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

    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rendered.unmount();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('keeps the ending-room websocket alive and refetches once when the room is done but the result is still missing', () => {
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
      updated_at: '2026-03-29T00:00:01Z',
      result_ready: true,
      participants: [],
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
        id: 'thread-room',
        room_id: 'room-1',
        title: 'Ending Chamber',
        mode: 'room',
        interaction_mode: 'auto_recap',
        participant_set_hash: 'hash-room',
        memory_partition_id: 'room-partition',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
        room_type: 'ending_chamber',
        room_title: 'Ending Chamber',
        room_status: 'done',
        language: 'en',
        turns: [],
      },
    };
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.result = null;
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

    expect(useEndingRoomWSMock).toHaveBeenCalledWith('room-1', true);
    expect(storeState.loadRoom).toHaveBeenCalledWith('room-1');
  });

  it('keeps the ending-room websocket active after the result is ready so follow-up broadcasts still sync', () => {
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
      updated_at: '2026-03-29T00:00:01Z',
      result_ready: true,
      participants: [],
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
        id: 'thread-room',
        room_id: 'room-1',
        title: 'Ending Chamber',
        mode: 'room',
        interaction_mode: 'auto_recap',
        participant_set_hash: 'hash-room',
        memory_partition_id: 'room-partition',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
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

    expect(useEndingRoomWSMock).toHaveBeenCalledWith('room-1', true);
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

    await user.click(screen.getByRole('button', { name: 'Question one role' }));
    expect(storeState.setInteractionMode).toHaveBeenCalledWith('hotseat');

    await user.click(screen.getByRole('button', { name: 'Current lineup responds' }));
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

  it('keeps a manually selected hotseat target instead of snapping back to the preferred first agent', async () => {
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
          display_name: 'Archivist',
          persona_snapshot_json: {
            agent_role: 'Judge',
          },
        },
        {
          id: 'p-2',
          room_id: 'room-1',
          role_slot: 'agent',
          source_agent_id: 'agent-2',
          display_name: 'Strategist',
          persona_snapshot_json: {
            agent_role: 'Planner',
          },
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
    storeState.interactionMode = 'hotseat';
    storeState.result = { summary: 'Final summary.' };
    storeState.status = 'done';

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        selectedAgentIds={['agent-1']}
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
      />,
    );

    const strategistPill = screen.getByRole('button', { name: 'Strategist' });
    await user.click(strategistPill);

    expect(strategistPill.className).toContain('is-active');
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

  it('shows draft bubbles inside the active follow-up thread instead of hiding them', () => {
    storeState.snapshot = {
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
      result_ready: true,
      participants: [
        {
          id: 'p-archivist',
          room_id: 'room-1',
          role_slot: 'archivist',
          display_name: 'The Archivist',
        },
        {
          id: 'p-strategist',
          room_id: 'room-1',
          role_slot: 'agent',
          source_agent_id: 'agent-1',
          display_name: 'Strategist',
          persona_snapshot_json: {
            agent_role: 'Strategist',
          },
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
        {
          id: 'thread-followup',
          room_id: 'room-1',
          title: 'Follow-up Thread',
          mode: 'followup',
          interaction_mode: 'hotseat',
          participant_set_hash: 'hash-followup',
          memory_partition_id: 'thread-partition',
          addressed_agent_ids_json: ['agent-1'],
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
        room_status: 'live',
        language: 'en',
        turns: [],
      },
      'thread-followup': {
        ...storeState.snapshot.threads[1],
        room_type: 'ending_chamber',
        room_title: 'Ending Chamber',
        room_status: 'live',
        language: 'en',
        turns: [],
      },
    };
    storeState.threadOrder = ['thread-room', 'thread-followup'];
    storeState.activeThreadId = 'thread-followup';
    storeState.interactionMode = 'hotseat';
    storeState.result = { summary: 'Final summary.' };
    storeState.status = 'live';
    storeState.pendingDrafts = {
      'draft-followup': {
        turnId: 'draft-followup',
        threadId: 'thread-followup',
        participantId: 'p-strategist',
        phase: 'verdict',
        sequence: 1,
        content: 'The hinge is still unfolding...',
      },
    };

    render(
      <EndingChatModal
        open
        scenarioId="scenario-1"
        branch={branch}
        roomType="ending_chamber"
        selectedAgentIds={['agent-1']}
        language="en"
        readOnly={false}
        onClose={() => {}}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Strategist').length).toBeGreaterThan(0);
    expect(screen.getByText('The hinge is still unfolding...')).toBeInTheDocument();
  });
});
