import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorldlineRoundtableView from './WorldlineRoundtableView';

const {
  appendUserTurnMock,
  copyTextMock,
  createReplayArtifactMock,
  createThreadMock,
  getAgentsMock,
  getReplayArtifactMock,
  getScenarioMock,
  getStoryMock,
  importReplayScenarioMock,
  loadRoomMock,
  loadThreadMock,
  loadOracleReplayLocalCopyMock,
  openRoomMock,
  resetMock,
  saveOracleReplayLocalCopyMock,
  setActiveThreadMock,
  setComposerDraftMock,
  setInteractionModeMock,
  storeState,
  wsMock,
} = vi.hoisted(() => {
  const openRoom = vi.fn(async () => 'room-1');
  const loadRoom = vi.fn(async () => {});
  const loadThread = vi.fn(async () => {});
  const createThread = vi.fn(async () => ({
    id: 'thread-hotseat',
    room_id: 'room-1',
    title: 'Hotseat Thread',
    mode: 'followup',
    interaction_mode: 'hotseat',
    participant_set_hash: 'hash',
    memory_partition_id: 'partition',
    room_type: 'worldline_roundtable',
    room_title: 'Worldline Roundtable',
    room_status: 'done',
    language: 'en',
    turns: [],
    created_at: '2026-03-29T00:00:00Z',
    updated_at: '2026-03-29T00:00:01Z',
  }));
  return {
    createReplayArtifactMock: vi.fn(async () => ({ id: 'artifact-1' })),
    getAgentsMock: vi.fn(),
    getReplayArtifactMock: vi.fn(),
    getScenarioMock: vi.fn(),
    getStoryMock: vi.fn(),
    importReplayScenarioMock: vi.fn(async () => ({ id: 'imported-scenario' })),
    loadOracleReplayLocalCopyMock: vi.fn(),
    openRoomMock: openRoom,
    loadRoomMock: loadRoom,
    loadThreadMock: loadThread,
    createThreadMock: createThread,
    appendUserTurnMock: vi.fn(async () => {}),
    setActiveThreadMock: vi.fn(),
    setInteractionModeMock: vi.fn(),
    setComposerDraftMock: vi.fn(),
    resetMock: vi.fn(),
    saveOracleReplayLocalCopyMock: vi.fn((_payload: unknown) => 'local-roundtable'),
    copyTextMock: vi.fn(async (_value: string) => {}),
    wsMock: vi.fn(),
    storeState: {
      snapshot: {
        id: 'room-1',
        scenario_id: 'scenario-1',
        anchor_branch_id: null,
        room_type: 'worldline_roundtable',
        title: 'Worldline Roundtable',
        language: 'en',
        status: 'done',
        current_phase: 'verdict',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
        memory_partition_id: 'room-partition',
        participants: [
          {
            id: 'rep-a',
            room_id: 'room-1',
            role_slot: 'representative',
            display_name: 'Representative A',
            source_branch_id: 'branch-a',
            source_agent_id: 'agent-a',
            persona_snapshot_json: {
              agent_role: 'Marshal',
            },
          },
          {
            id: 'archivist',
            room_id: 'room-1',
            role_slot: 'archivist',
            display_name: 'Archivist',
          },
        ],
        threads: [
          {
            id: 'thread-room',
            room_id: 'room-1',
            title: 'Main Desk',
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
            phase: 'opening',
            participant_id: 'rep-a',
            content: 'The first hinge was delayed too long.',
            emotion: 'focused',
            created_at: '2026-03-29T00:00:00Z',
          },
        ],
        result_ready: true,
      },
      result: {
        summary: 'The roundtable converged on a single hinge.',
        archivist_note: 'Summary-only crossline scope held.',
        phase_insights: [
          {
            phase: 'verdict',
            stakes: 'Archive the hinge.',
            moderator_focus: 'Keep the scope narrow.',
            commentary: 'Done.',
          },
        ],
      },
      threadsById: {
        'thread-room': {
          id: 'thread-room',
          room_id: 'room-1',
          title: 'Main Desk',
          mode: 'room',
          interaction_mode: 'auto_recap',
          participant_set_hash: 'hash-room',
          memory_partition_id: 'room-partition',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
          room_type: 'worldline_roundtable',
          room_title: 'Worldline Roundtable',
          room_status: 'done',
          language: 'en',
          turns: [
            {
              id: 'turn-1',
              room_id: 'room-1',
              thread_id: 'thread-room',
              sequence: 1,
              phase: 'opening',
              participant_id: 'rep-a',
              content: 'The first hinge was delayed too long.',
              emotion: 'focused',
              created_at: '2026-03-29T00:00:00Z',
            },
          ],
        },
      },
      threadOrder: ['thread-room'],
      activeThreadId: 'thread-room',
      interactionMode: 'archivist_route',
      composerDraft: '',
      scopeNotice: null,
      sending: false,
      status: 'done',
      pendingDrafts: {},
      openRoom,
      loadRoom,
      loadThread,
      createThread,
      appendUserTurn: vi.fn(async () => {}),
      setActiveThread: vi.fn(),
      setInteractionMode: vi.fn(),
      setComposerDraft: vi.fn(),
      reset: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'roundtable.shortlist_count') {
        return `${String(options?.count ?? '')} / ${String(options?.max ?? '')} worldlines selected`;
      }
      return ({
        'roundtable.title': 'Worldline Roundtable',
        'roundtable.entry_cta': 'Start Roundtable',
        'roundtable.entry_hint': 'Invite one representative from each ending and let the Archivist host the debrief.',
        'roundtable.selection_mode_representative': 'All representatives',
        'roundtable.selection_mode_manual_shortlist': 'Manual shortlist',
        'roundtable.selection_mode_expert_witness': 'Expert witness',
        'roundtable.shortlist_hint': 'Seat only the worldlines you pick here.',
        'roundtable.shortlist_toggle_on': 'Seat this worldline',
        'roundtable.shortlist_toggle_off': 'Leave this worldline out',
        'roundtable.witness_hint': 'Keep one representative for each worldline, then invite one extra witness.',
        'roundtable.witness_section': 'Witness stand',
        'roundtable.witness_selected': 'Current witness',
        'roundtable.witness_badge': 'Expert witness',
        'roundtable.role_witness': 'Expert witness',
        'roundtable.loading': 'Preparing the worldline roundtable...',
        'roundtable.role_archivist': 'Archivist',
        'common.loading': 'Loading',
      }[key] ?? key);
    },
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(async () => {}),
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    createReplayArtifact: createReplayArtifactMock,
    getAgents: getAgentsMock,
    getReplayArtifact: getReplayArtifactMock,
    getScenario: getScenarioMock,
    getStory: getStoryMock,
    importReplayScenario: importReplayScenarioMock,
  };
});

vi.mock('../hooks/useWorldlineRoundtableWS', () => ({
  useWorldlineRoundtableWS: (roomId?: string, ready?: boolean) => wsMock(roomId, ready),
}));

vi.mock('../stores/worldlineRoundtableStore', () => ({
  useWorldlineRoundtableStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
}));

vi.mock('../lib/copyText', () => ({
  copyText: (value: string) => copyTextMock(value),
}));

vi.mock('../lib/oracleReplay', () => ({
  loadOracleReplayLocalCopy: (id: string, expectedKind?: string) => loadOracleReplayLocalCopyMock(id, expectedKind),
  normalizeOracleReplayPayload: vi.fn(),
  saveOracleReplayLocalCopy: (payload: unknown) => saveOracleReplayLocalCopyMock(payload),
}));

vi.mock('../game/managers/VizSynthesizer', () => ({
  mapRoleToSpriteId: () => 'sprite_default',
}));

  beforeEach(() => {
  createReplayArtifactMock.mockClear();
  getAgentsMock.mockReset();
  getReplayArtifactMock.mockReset();
  getScenarioMock.mockReset();
  getStoryMock.mockReset();
  importReplayScenarioMock.mockReset();
  loadOracleReplayLocalCopyMock.mockReset();
  openRoomMock.mockClear();
  loadRoomMock.mockClear();
  loadThreadMock.mockClear();
  createThreadMock.mockClear();
  appendUserTurnMock.mockClear();
  setActiveThreadMock.mockClear();
  setInteractionModeMock.mockClear();
    setComposerDraftMock.mockClear();
    resetMock.mockClear();
    saveOracleReplayLocalCopyMock.mockClear();
    copyTextMock.mockClear();
    wsMock.mockClear();
    Object.defineProperty(window, 'scrollTo', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

describe('WorldlineRoundtableView', () => {
  it('creates a live roundtable room from a multi-ending result', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        {
          id: 'msg-a',
          branch: 'branch-a',
          agent: 'Representative A',
          agent_id: 'agent-a',
          message: 'Archive A should seat A.',
          emotion: 'focused',
          round: 1,
        },
        {
          id: 'msg-b',
          branch: 'branch-b',
          agent: 'Representative B',
          agent_id: 'agent-b',
          message: 'Archive B should seat B.',
          emotion: 'focused',
          round: 1,
        },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'Archive A',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'Story A',
          insight: 'Insight A',
          key_moments: ['A'],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-b',
          title: 'Archive B',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'Story B',
          insight: 'Insight B',
          key_moments: ['B'],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    });
    getAgentsMock.mockResolvedValue([
      {
        id: 'agent-a',
        name: 'Representative A',
        role: 'Marshal',
        persona: 'Keeps the garrison together.',
        tier: 'CORE',
        emotion: 'focused',
      },
      {
        id: 'agent-b',
        name: 'Representative B',
        role: 'Steward',
        persona: 'Keeps the granaries open.',
        tier: 'IMPORTANT',
        emotion: 'focused',
      },
    ]);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();
    expect(screen.getByText('Reseat each worldline representative')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
    expect(loadRoomMock).toHaveBeenCalledWith('room-1');
  });

  it('lets manual_shortlist launch only the selected worldlines', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked three ways?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-b', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
        { id: 'msg-c', branch: 'branch-c', agent: 'Representative C', agent_id: 'agent-c', message: 'C', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked three ways?',
      status: 'done',
      branches: [
        { id: 'branch-a', title: 'Archive A', probability: 0.5, status: 'COMPLETED', story: 'Story A', insight: 'Insight A', key_moments: ['A'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Archive B', probability: 0.3, status: 'COMPLETED', story: 'Story B', insight: 'Insight B', key_moments: ['B'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-c', title: 'Archive C', probability: 0.2, status: 'COMPLETED', story: 'Story C', insight: 'Insight C', key_moments: ['C'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([
      { id: 'agent-a', name: 'Representative A', role: 'Marshal', persona: 'Keeps A steady.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-b', name: 'Representative B', role: 'Steward', persona: 'Keeps B supplied.', tier: 'IMPORTANT', emotion: 'focused' },
      { id: 'agent-c', name: 'Representative C', role: 'Speaker', persona: 'Keeps C loud.', tier: 'IMPORTANT', emotion: 'focused' },
    ]);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Manual shortlist' }));
    expect(screen.getByText('2 / 3 worldlines selected')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Seat this worldline' })[0]);
    expect(screen.getByText('3 / 3 worldlines selected')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Leave this worldline out' })[2]);
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
  });

  it('launches expert_witness with an extra witness selection', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked with one witness?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-a2', branch: 'branch-a', agent: 'Witness A', agent_id: 'agent-c', message: 'A witness', emotion: 'focused', round: 2 },
        { id: 'msg-b', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked with one witness?',
      status: 'done',
      branches: [
        { id: 'branch-a', title: 'Archive A', probability: 0.6, status: 'COMPLETED', story: 'Story A', insight: 'Insight A', key_moments: ['A'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Archive B', probability: 0.4, status: 'COMPLETED', story: 'Story B', insight: 'Insight B', key_moments: ['B'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([
      { id: 'agent-a', name: 'Representative A', role: 'Marshal', persona: 'Keeps A steady.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-b', name: 'Representative B', role: 'Steward', persona: 'Keeps B supplied.', tier: 'IMPORTANT', emotion: 'focused' },
      { id: 'agent-c', name: 'Witness A', role: 'Quartermaster', persona: 'Tracks the missing grain.', tier: 'IMPORTANT', emotion: 'focused' },
    ]);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expert witness' }));
    expect(screen.getByText('Witness stand')).toBeInTheDocument();
    const witnessStand = screen.getByText('Witness stand').closest('section');
    expect(witnessStand).not.toBeNull();
    await user.click(within(witnessStand as HTMLElement).getByRole('button', { name: /Witness A/ }));
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    });
  });

  it('allows reseating representatives after a live table is already open', async () => {
    storeState.snapshot = {
      ...storeState.snapshot,
      id: 'room-live',
      participants: [
        {
          id: 'rep-a',
          room_id: 'room-live',
          role_slot: 'representative',
          display_name: 'Representative A',
          source_branch_id: 'branch-a',
          source_agent_id: 'agent-a',
          persona_snapshot_json: {
            agent_role: 'Marshal',
            impact_score: 0.92,
            selection_reason: 'top_impact',
          },
        },
        {
          id: 'rep-b',
          room_id: 'room-live',
          role_slot: 'representative',
          display_name: 'Representative B',
          source_branch_id: 'branch-b',
          source_agent_id: 'agent-b',
          persona_snapshot_json: {
            agent_role: 'Steward',
            impact_score: 0.88,
            selection_reason: 'top_impact',
          },
        },
        {
          id: 'archivist',
          room_id: 'room-live',
          role_slot: 'archivist',
          display_name: 'Archivist',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-live',
          title: 'Main Desk',
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
          id: 'turn-room',
          room_id: 'room-live',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'opening',
          participant_id: 'rep-a',
          content: 'Existing live roundtable.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
      result_ready: true,
    } as any;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
    } as any;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as any;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';

    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        {
          id: 'msg-a1',
          branch: 'branch-a',
          agent: 'Representative A',
          agent_id: 'agent-a',
          message: 'Archive A should seat A first.',
          emotion: 'focused',
          round: 1,
        },
        {
          id: 'msg-a2',
          branch: 'branch-a',
          agent: 'Representative C',
          agent_id: 'agent-c',
          message: 'Archive A can also seat C.',
          emotion: 'focused',
          round: 2,
        },
        {
          id: 'msg-b1',
          branch: 'branch-b',
          agent: 'Representative B',
          agent_id: 'agent-b',
          message: 'Archive B keeps B.',
          emotion: 'focused',
          round: 1,
        },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'Archive A',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'Story A',
          insight: 'Insight A',
          key_moments: ['A'],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-b',
          title: 'Archive B',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'Story B',
          insight: 'Insight B',
          key_moments: ['B'],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    });
    getAgentsMock.mockResolvedValue([
      {
        id: 'agent-a',
        name: 'Representative A',
        role: 'Marshal',
        persona: 'Keeps the garrison together.',
        tier: 'CORE',
        emotion: 'focused',
      },
      {
        id: 'agent-b',
        name: 'Representative B',
        role: 'Steward',
        persona: 'Keeps the granaries open.',
        tier: 'IMPORTANT',
        emotion: 'focused',
      },
      {
        id: 'agent-c',
        name: 'Representative C',
        role: 'Strategist',
        persona: 'Prefers patient redeployment.',
        tier: 'IMPORTANT',
        emotion: 'focused',
      },
    ]);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findAllByRole('button', { name: 'Reseat and reopen' })).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Reseat and reopen' })[0]);
    expect(await screen.findByText('Reopen this lineup')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Representative C/ }));
    await user.click(screen.getAllByRole('button', { name: 'Reopen this lineup' })[0]);

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-c' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
    expect(loadRoomMock).toHaveBeenCalledWith('room-1');
  });

  it('renders a read-only replay from local storage and disables sending', async () => {
    const replaySnapshot = {
      id: 'room-1',
      scenario_id: 'scenario-1',
      anchor_branch_id: null,
      room_type: 'worldline_roundtable',
      title: 'Worldline Roundtable',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      memory_partition_id: 'room-partition',
      participants: [
        {
          id: 'rep-a',
          room_id: 'room-1',
          role_slot: 'representative',
          display_name: 'Representative A',
          source_branch_id: 'branch-a',
          source_agent_id: 'agent-a',
          persona_snapshot_json: {
            agent_role: 'Marshal',
          },
        },
        {
          id: 'archivist',
          room_id: 'room-1',
          role_slot: 'archivist',
          display_name: 'Archivist',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-1',
          title: 'Main Desk',
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
          phase: 'opening',
          participant_id: 'rep-a',
          content: 'The first hinge was delayed too long.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
      result_ready: true,
    };
    const replayResult = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'Summary-only crossline scope held.',
      phase_insights: [
        {
          phase: 'verdict',
          stakes: 'Archive the hinge.',
          moderator_focus: 'Keep the scope narrow.',
          commentary: 'Done.',
        },
      ],
    };
    loadOracleReplayLocalCopyMock.mockReturnValue({
      kind: 'worldline_roundtable_v1',
      scenarioReplay: {
        scenario: {
          id: 'scenario-1',
          question: 'What if the empire forked?',
          status: 'done',
          agents: [],
          language: 'en',
        },
        storyData: {
          scenario_id: 'scenario-1',
          question: 'What if the empire forked?',
          status: 'done',
          branches: [
            {
              id: 'branch-a',
              title: 'Archive A',
              probability: 0.6,
              status: 'COMPLETED',
              story: 'Story A',
              insight: 'Insight A',
              key_moments: ['A'],
              parent_branch_id: null,
              fork_reason: '',
            },
            {
              id: 'branch-b',
              title: 'Archive B',
              probability: 0.4,
              status: 'COMPLETED',
              story: 'Story B',
              insight: 'Insight B',
              key_moments: ['B'],
              parent_branch_id: null,
              fork_reason: '',
            },
          ],
        },
        agents: [],
        predictions: [],
        scenarioMeta: {
          director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
          cooldowns: {},
          cards: { usageLog: [] },
          betting: { bets: [] },
          commitment: { active: false, branchId: null, branchTitle: null, committedAtRound: null, committedAt: null, outcome: null },
          objectives: { generatedForQuestion: null, generatedForProfile: null, goals: [] },
          archive: { keyMoments: [], branchSnapshots: [] },
        },
        campaignSummary: null,
        campaignScenarioSummary: null,
        isDailyChallenge: false,
      },
      roomSnapshot: replaySnapshot,
      roomResult: replayResult,
      activeThreadId: 'thread-room',
      selectedAgentIds: ['agent-a'],
    });

    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/roundtable/replay?local=replay-1']}>
        <Routes>
          <Route path="/roundtable/replay" element={<WorldlineRoundtableView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Read-only replay')).toBeInTheDocument();
    expect(screen.getByText('The first hinge was delayed too long.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save read-only copy' }));
    expect(screen.getByRole('button', { name: 'Read-only copy saved' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import local run' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('lets a live table reopen the representative picker and rebuild from the current seating', async () => {
    storeState.snapshot = {
      id: 'room-live',
      scenario_id: 'scenario-1',
      anchor_branch_id: null,
      room_type: 'worldline_roundtable',
      title: 'Worldline Roundtable',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      memory_partition_id: 'room-partition',
      participants: [
        {
          id: 'rep-a',
          room_id: 'room-live',
          role_slot: 'representative',
          display_name: 'Representative A',
          source_branch_id: 'branch-a',
          source_agent_id: 'agent-a',
          persona_snapshot_json: {
            agent_role: 'Marshal',
            impact_score: 0.91,
            selection_reason: 'user_selected',
          },
        },
        {
          id: 'rep-b',
          room_id: 'room-live',
          role_slot: 'representative',
          display_name: 'Representative B',
          source_branch_id: 'branch-b',
          source_agent_id: 'agent-b',
          persona_snapshot_json: {
            agent_role: 'Steward',
            impact_score: 0.83,
            selection_reason: 'top_impact',
          },
        },
        {
          id: 'archivist',
          room_id: 'room-live',
          role_slot: 'archivist',
          display_name: 'Archivist',
        },
      ],
      threads: [
        {
          id: 'thread-room',
          room_id: 'room-live',
          title: 'Main Desk',
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
          room_id: 'room-live',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'opening',
          participant_id: 'rep-a',
          content: 'Seat A is already live.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
      result_ready: true,
    } as any;
    storeState.result = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'Summary-only crossline scope held.',
      phase_insights: [],
    } as any;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as any;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';

    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        {
          id: 'msg-a',
          branch: 'branch-a',
          agent: 'Representative A',
          agent_id: 'agent-a',
          message: 'Archive A should keep A.',
          emotion: 'focused',
          round: 1,
        },
        {
          id: 'msg-b',
          branch: 'branch-b',
          agent: 'Representative B',
          agent_id: 'agent-b',
          message: 'Archive B should keep B.',
          emotion: 'focused',
          round: 1,
        },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'Archive A',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'Story A',
          insight: 'Insight A',
          key_moments: ['A'],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-b',
          title: 'Archive B',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'Story B',
          insight: 'Insight B',
          key_moments: ['B'],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    });
    getAgentsMock.mockResolvedValue([
      {
        id: 'agent-a',
        name: 'Representative A',
        role: 'Marshal',
        persona: 'Keeps the garrison together.',
        tier: 'CORE',
        emotion: 'focused',
      },
      {
        id: 'agent-b',
        name: 'Representative B',
        role: 'Steward',
        persona: 'Keeps the granaries open.',
        tier: 'IMPORTANT',
        emotion: 'focused',
      },
    ]);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Representatives')).toBeInTheDocument();
    expect(screen.queryByText('Reseat each worldline representative')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Reseat and reopen' })[0]);
    expect(screen.getByText('Reseat each worldline representative')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Reopen this lineup' })[0]);

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
    expect(loadRoomMock).toHaveBeenCalledWith('room-1');
  });
});
