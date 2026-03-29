import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EndingChatModal from './EndingChatModal';

const onAutomationStateChangeMock = vi.fn();

const storeState = {
  snapshot: null as any,
  result: null as any,
  status: 'idle',
  error: null as string | null,
  pendingDrafts: {} as Record<string, unknown>,
  openRoom: vi.fn(async () => 'room-1'),
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
      'ending_room.current_branch_badge': 'Current worldline',
      'ending_room.mode_debrief': 'Debrief',
      'ending_room.mode_one_move_only': 'One Move Only',
      'ending_room.replay_readonly': 'Replay mode is read-only for ending chambers.',
      'ending_room.loading': 'Preparing the current ending chamber...',
      'ending_room.empty': 'No chamber record is available for this ending yet.',
      'ending_room.participant_unknown': 'Unknown participant',
      'ending_room.transcript_title': 'Chamber Transcript',
      'ending_room.draft_badge': 'Speaking',
      'ending_room.archivist_note': 'Archivist Note',
      'result.story': 'Story',
      'result.insight': 'Insight',
      'roundtable.phase_verdict': 'Archive Verdict',
      'roundtable.phase_opening': 'Ending Recall',
      'roundtable.phase_rebuttal': 'If Replayed',
    }[key] ?? key),
    i18n: {
      language: 'en',
    },
  }),
}));

vi.mock('../hooks/useEndingRoomWS', () => ({
  useEndingRoomWS: vi.fn(),
}));

vi.mock('../api/client', () => ({
  createEndingRoom: vi.fn(),
  getEndingRoomResult: vi.fn(),
}));

vi.mock('../stores/endingRoomStore', () => ({
  useEndingRoomStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
}));

describe('EndingChatModal', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    onAutomationStateChangeMock.mockReset();
    storeState.snapshot = null;
    storeState.result = null;
    storeState.status = 'idle';
    storeState.error = null;
    storeState.pendingDrafts = {};
    storeState.openRoom.mockReset();
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
    expect(screen.getAllByText('Replay mode is read-only for ending chambers.')).toHaveLength(2);
    expect(storeState.openRoom).not.toHaveBeenCalled();
  });

  it('renders committed turns, drafts, and result summary from the store', () => {
    storeState.snapshot = {
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'one_move_only',
      title: 'One Move Only',
      language: 'en',
      status: 'live',
      current_phase: 'rebuttal',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:00Z',
      result_ready: true,
      participants: [
        {
          id: 'p-1',
          room_id: 'room-1',
          role_slot: 'agent',
          display_name: 'Archivist',
        },
      ],
      turns: [
        {
          id: 'turn-1',
          room_id: 'room-1',
          sequence: 1,
          phase: 'opening',
          participant_id: 'p-1',
          content: 'Committed turn.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
    };
    storeState.result = {
      summary: 'Final summary.',
      next_move: 'Delay the decision by one round.',
    };
    storeState.status = 'live';
    storeState.pendingDrafts = {
      'draft-1': {
        turnId: 'draft-1',
        participantId: 'p-1',
        phase: 'rebuttal',
        sequence: 2,
        content: 'Streaming draft.',
      },
    };

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

    expect(screen.getByText('Committed turn.')).toBeInTheDocument();
    expect(screen.getByText('Streaming draft.')).toBeInTheDocument();
    expect(screen.getByText('Final summary.')).toBeInTheDocument();
    expect(screen.getByText('Delay the decision by one round.')).toBeInTheDocument();
    expect(storeState.openRoom).toHaveBeenCalledWith('scenario-1', {
      roomType: 'one_move_only',
      anchorBranchId: 'branch-1',
      selectedBranchIds: ['branch-1'],
      language: 'en',
    });
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
});
