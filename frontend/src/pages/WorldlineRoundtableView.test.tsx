import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorldlineRoundtableView from './WorldlineRoundtableView';
import { clearPretextCache } from '../lib/textLayout/pretext';
import {
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  predictTextOverflow,
} from '../lib/textLayout/textOverflowPredictor';

const {
  getMockLanguage,
  setMockLanguage,
  changeLanguageMock,
  appendUserTurnMock,
  buildOracleReplayShareUrlMock,
  buildOracleReplayUrlMock,
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
  let currentLanguage = 'en';
  const openRoom = vi.fn(async () => 'room-1');
  const loadRoom = vi.fn(async () => {});
  const loadThread = vi.fn(async () => {});
  const setActiveThread = vi.fn();
  const setInteractionMode = vi.fn();
  const setComposerDraft = vi.fn();
  const reset = vi.fn();
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
    getMockLanguage: () => currentLanguage,
    setMockLanguage: (language: string) => {
      currentLanguage = language;
    },
    changeLanguageMock: vi.fn(async (language: string) => {
      currentLanguage = language;
    }),
    createReplayArtifactMock: vi.fn(async () => ({ id: 'artifact-1' })),
    buildOracleReplayShareUrlMock: vi.fn((_origin: string, _payload: unknown, artifactId: string) => `https://example.com/roundtable/replay?roomShare=${artifactId}`),
    buildOracleReplayUrlMock: vi.fn(async (_origin: string, _payload: unknown) => 'https://example.com/roundtable/replay?roomReplay=token'),
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
    setActiveThreadMock: setActiveThread,
    setInteractionModeMock: setInteractionMode,
    setComposerDraftMock: setComposerDraft,
    resetMock: reset,
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
      setActiveThread,
      setInteractionMode,
      setComposerDraft,
      reset,
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
        'roundtable.selection_mode_trait_mix': 'Trait mix',
        'roundtable.selection_mode_fault_line_first': 'Fault line first',
        'roundtable.selection_mode_witness_augmented': 'Witness augmented',
        'roundtable.shortlist_hint': 'Seat only the worldlines you pick here.',
        'roundtable.trait_mix_hint': 'Auto-seat a higher-contrast cast.',
        'roundtable.fault_line_hint': 'Auto-seat the two most divergent worldlines first.',
        'roundtable.shortlist_toggle_on': 'Seat this worldline',
        'roundtable.shortlist_toggle_off': 'Leave this worldline out',
        'roundtable.witness_hint': 'Keep one representative for each worldline, then invite one extra witness.',
        'roundtable.witness_augmented_hint': 'Keep the representative seats, then auto-add one extra witness.',
        'roundtable.witness_section': 'Witness stand',
        'roundtable.witness_augmented_section': 'Augmented witness stand',
        'roundtable.witness_selected': 'Current witness',
        'roundtable.witness_badge': 'Expert witness',
        'roundtable.role_witness': 'Expert witness',
        'roundtable.loading': 'Preparing the worldline roundtable...',
        'roundtable.phase_verdict': 'Archive Verdict',
        'roundtable.role_archivist': 'Archivist',
        'roundtable.action_continue': 'Continue this table',
        'roundtable.action_new_thread': 'Start anchored thread',
        'roundtable.action_copy_brief': 'Copy roundtable brief',
        'roundtable.action_brief_copied': 'Roundtable brief copied',
        'roundtable.action_follow_phase': 'Follow this phase',
        'roundtable.action_follow_quote': 'Follow this quote',
        'roundtable.action_thread_from_anchor': 'Start thread from current anchor',
        'common.loading': 'Loading',
      }[key] ?? key);
    },
    i18n: {
      get language() {
        return getMockLanguage();
      },
      changeLanguage: changeLanguageMock,
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
  buildOracleReplayLocalUrl: (origin: string, _payload: unknown, localId: string) => `${origin}/roundtable/replay?roomLocal=${localId}`,
  buildOracleReplayShareUrl: (origin: string, payload: unknown, artifactId: string) => buildOracleReplayShareUrlMock(origin, payload, artifactId),
  buildOracleReplayUrl: (origin: string, payload: unknown) => buildOracleReplayUrlMock(origin, payload),
  loadOracleReplayLocalCopy: (id: string, expectedKind?: string) => loadOracleReplayLocalCopyMock(id, expectedKind),
  normalizeOracleReplayPayload: vi.fn(),
  readOracleReplayPayload: vi.fn(),
  saveOracleReplayLocalCopy: (payload: unknown) => saveOracleReplayLocalCopyMock(payload),
}));

vi.mock('../game/managers/VizSynthesizer', () => ({
  mapRoleToSpriteId: () => 'sprite_default',
}));

beforeEach(() => {
  setMockLanguage('en');
  createReplayArtifactMock.mockClear();
  buildOracleReplayShareUrlMock.mockClear();
  buildOracleReplayUrlMock.mockClear();
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
  changeLanguageMock.mockClear();
  setMockLanguage('en');
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
      selectionRecipe: 'representative',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
    expect(loadRoomMock).toHaveBeenCalledWith('room-1');
  });

  it('keeps the current UI language and launches the room in that language even when the scenario language differs', async () => {
    setMockLanguage('en');
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: '如果帝国分裂了？',
      status: 'done',
      agents: [],
      language: 'zh',
      messages: [
        { id: 'msg-a', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-b', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: '如果帝国分裂了？',
      status: 'done',
      branches: [
        { id: 'branch-a', title: 'Archive A', probability: 0.5, status: 'COMPLETED', story: 'Story A', insight: 'Insight A', key_moments: ['A'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Archive B', probability: 0.5, status: 'COMPLETED', story: 'Story B', insight: 'Insight B', key_moments: ['B'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([
      { id: 'agent-a', name: 'Representative A', role: 'Marshal', persona: 'Keeps A steady.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-b', name: 'Representative B', role: 'Steward', persona: 'Keeps B supplied.', tier: 'IMPORTANT', emotion: 'focused' },
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
    expect(changeLanguageMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
      language: 'en',
    }));
    expect(changeLanguageMock).not.toHaveBeenCalled();
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
      selectionRecipe: 'manual_shortlist',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
  });

  it('offers quick follow-up and brief-copy actions on the summary rail', async () => {
    const user = userEvent.setup();
    storeState.snapshot = {
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
          persona_snapshot_json: { agent_role: 'Marshal' },
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
      turns: [],
      result_ready: true,
    } as any;
    storeState.result = {
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
    } as any;
    storeState.threadsById = {
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
        turns: [],
      },
    } as any;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What broke first?',
      scene_theme: 'court',
      status: 'done',
      language: 'en',
      agents: [],
    });
    getStoryMock.mockResolvedValue({
      question: 'What broke first?',
      branches: [
        {
          id: 'branch-a',
          title: 'Branch A',
          probability: 0.62,
          insight: 'Branch A insight',
          story: 'Story A',
          key_moments: ['Moment A'],
        },
        {
          id: 'branch-b',
          title: 'Branch B',
          probability: 0.38,
          insight: 'Branch B insight',
          story: 'Story B',
          key_moments: ['Moment B'],
        },
      ],
    });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('The roundtable converged on a single hinge.');

    await user.click(screen.getByRole('button', { name: 'Continue this table' }));
    expect(setComposerDraftMock).toHaveBeenCalledWith('Continue from this table: why did "The roundtable converged on a single hinge." become the table verdict?');

    await user.click(screen.getByRole('button', { name: 'Copy roundtable brief' }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalled());
    expect(copyTextMock).toHaveBeenCalledWith(expect.stringContaining('## Archivist Verdict'));
  });

  it('can start an anchored follow-up thread from a phase insight card', async () => {
    const user = userEvent.setup();
    storeState.snapshot = {
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
          persona_snapshot_json: { agent_role: 'Marshal' },
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
      turns: [],
      result_ready: true,
    } as any;
    storeState.result = {
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
    } as any;
    storeState.threadsById = {
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
        turns: [],
      },
    } as any;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What broke first?',
      scene_theme: 'court',
      status: 'done',
      language: 'en',
      agents: [],
    });
    getStoryMock.mockResolvedValue({
      question: 'What broke first?',
      branches: [
        {
          id: 'branch-a',
          title: 'Branch A',
          probability: 0.62,
          insight: 'Branch A insight',
          story: 'Story A',
          key_moments: ['Moment A'],
        },
        {
          id: 'branch-b',
          title: 'Branch B',
          probability: 0.38,
          insight: 'Branch B insight',
          story: 'Story B',
          key_moments: ['Moment B'],
        },
      ],
    });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Archive the hinge.');
    await user.click(screen.getAllByRole('button', { name: 'Start anchored thread' })[1]);

    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: 'Archive Verdict',
      questionAnchorIds: ['roundtable:phase:room-1:verdict-0'],
      interactionMode: 'thread_followup',
    }));
    expect(setInteractionModeMock).toHaveBeenCalledWith('thread_followup');
  });

  it('lets a verdict chip reuse the same thread-from-anchor rule', async () => {
    const user = userEvent.setup();
    setComposerDraftMock.mockImplementation((value: string) => {
      storeState.composerDraft = value;
    });
    storeState.snapshot = {
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
          persona_snapshot_json: { agent_role: 'Marshal' },
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
      turns: [],
      result_ready: true,
    } as any;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
      phase_insights: [],
    } as any;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: [],
      },
    } as any;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';

    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      scene_theme: 'court',
      agents: [],
      language: 'en',
      messages: [],
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
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: 'Continue this table' });
    await user.click(screen.getByRole('button', { name: 'Continue this table' }));
    await user.click(screen.getByRole('button', { name: 'Start thread from current anchor' }));
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: null,
      questionAnchorIds: ['roundtable:verdict:room-1'],
      interactionMode: 'thread_followup',
    }));
  });

  it('can anchor a thread from a committed roundtable quote', async () => {
    const user = userEvent.setup();
    storeState.snapshot = {
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
          persona_snapshot_json: { agent_role: 'Marshal' },
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
          phase: 'verdict',
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
      scene_theme: 'court',
      agents: [],
      language: 'en',
      messages: [],
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
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Existing live roundtable.');
    const quoteBubble = screen.getByText('Existing live roundtable.').closest('article');
    expect(quoteBubble).not.toBeNull();
    const quoteBubbleScope = within(quoteBubble as HTMLElement);

    await user.click(quoteBubbleScope.getByRole('button', { name: 'Follow this quote' }));
    expect(setComposerDraftMock).toHaveBeenCalledWith('Follow this quote: Representative A said "Existing live roundtable.". Which disagreement on this table does that line actually lock in?');

    await user.click(quoteBubbleScope.getByRole('button', { name: 'Start anchored thread' }));
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: 'Representative A',
      questionAnchorIds: ['roundtable:quote:thread-room:turn-1'],
      interactionMode: 'thread_followup',
    }));
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
      selectionRecipe: 'expert_witness',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    });
  });

  it('uses trait_mix to auto-pick a more contrasted cast', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked into rival courts and frontier command?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a1', branch: 'branch-a', agent: 'Emperor A', agent_id: 'agent-a1', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-a2', branch: 'branch-a', agent: 'Clerk A', agent_id: 'agent-a2', message: 'A2', emotion: 'focused', round: 2 },
        { id: 'msg-b1', branch: 'branch-b', agent: 'Marshal B', agent_id: 'agent-b1', message: 'B', emotion: 'focused', round: 1 },
        { id: 'msg-b2', branch: 'branch-b', agent: 'Priest B', agent_id: 'agent-b2', message: 'Broken vow', emotion: 'focused', round: 2 },
        { id: 'msg-b3', branch: 'branch-b', agent: 'Priest B', agent_id: 'agent-b2', message: 'Broken vow again', emotion: 'focused', round: 3 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked into rival courts and frontier command?',
      status: 'done',
      branches: [
        { id: 'branch-a', title: 'Archive A', probability: 0.55, status: 'COMPLETED', story: 'Story A', insight: 'Court politics split the archive.', key_moments: ['Court panic'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Archive B', probability: 0.45, status: 'COMPLETED', story: 'Story B', insight: 'The temple framed the split as a broken vow.', key_moments: ['Broken vow'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([
      { id: 'agent-a1', name: 'Emperor A', role: 'Emperor', persona: 'Keeps the court intact.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-a2', name: 'Clerk A', role: 'Ledger clerk', persona: 'Tracks every missing seal.', tier: 'IMPORTANT', emotion: 'focused' },
      { id: 'agent-b1', name: 'Marshal B', role: 'Frontier commander', persona: 'Pushes supply and tempo.', tier: 'IMPORTANT', emotion: 'focused' },
      { id: 'agent-b2', name: 'Priest B', role: 'Temple priest', persona: 'Frames the branch as a broken vow.', tier: 'CORE', emotion: 'focused' },
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
    await user.click(screen.getByRole('button', { name: 'Trait mix' }));
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'trait_mix',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a1' },
        { branchId: 'branch-b', agentId: 'agent-b2' },
      ],
      selectedWitness: null,
    });
  });

  it('uses fault_line_first to auto-shortlist the strongest split', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive split across court, frontier, and market pressure?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a', branch: 'branch-a', agent: 'Emperor A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-b', branch: 'branch-b', agent: 'Marshal B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
        { id: 'msg-c', branch: 'branch-c', agent: 'Merchant C', agent_id: 'agent-c', message: 'C', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the archive split across court, frontier, and market pressure?',
      status: 'done',
      branches: [
        { id: 'branch-a', title: 'Court Line', probability: 0.52, status: 'COMPLETED', story: 'Story A', insight: 'Court legitimacy cracks first.', key_moments: ['Court panic'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Frontier Line', probability: 0.18, status: 'COMPLETED', story: 'Story B', insight: 'Frontier supply and orbit timing snap first.', key_moments: ['Orbit convoy delay'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-c', title: 'Market Line', probability: 0.30, status: 'COMPLETED', story: 'Story C', insight: 'Cash rotation freezes first.', key_moments: ['Cash run'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([
      { id: 'agent-a', name: 'Emperor A', role: 'Emperor', persona: 'Keeps the court intact.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-b', name: 'Marshal B', role: 'Frontier commander', persona: 'Pushes supply and tempo.', tier: 'CORE', emotion: 'focused' },
      { id: 'agent-c', name: 'Merchant C', role: 'Market broker', persona: 'Protects foot traffic and cash rotation.', tier: 'IMPORTANT', emotion: 'focused' },
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
    await user.click(screen.getByRole('button', { name: 'Fault line first' }));
    expect(screen.getByText('2 / 3 worldlines selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'fault_line_first',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
  });

  it('uses witness_augmented to auto-attach a witness without manual picking', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked with an extra witness?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a1', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-a2', branch: 'branch-a', agent: 'Witness A', agent_id: 'agent-c', message: 'A witness', emotion: 'focused', round: 2 },
        { id: 'msg-b1', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked with an extra witness?',
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
    await user.click(screen.getByRole('button', { name: 'Witness augmented' }));
    expect(screen.getByText('Augmented witness stand')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'witness_augmented',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    });
  });

  it('keeps the latest witness mode when switching between expert_witness and witness_augmented before launch', async () => {
    storeState.snapshot = null as any;
    storeState.result = null as any;
    storeState.threadsById = {} as any;
    storeState.threadOrder = [];
    storeState.activeThreadId = null as any;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked with an extra witness?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a1', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-a2', branch: 'branch-a', agent: 'Witness A', agent_id: 'agent-c', message: 'A witness', emotion: 'focused', round: 2 },
        { id: 'msg-b1', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire forked with an extra witness?',
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
    await user.click(screen.getByRole('button', { name: 'Witness augmented' }));
    await user.click(screen.getByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
      selectionRecipe: 'witness_augmented',
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    }));
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
      selectionRecipe: 'representative',
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
    const replaySnapshot: any = {
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
      activeThreadId: 'thread-hotseat',
      selectedAgentIds: ['agent-a'],
    });
    replaySnapshot.threads.push({
      id: 'thread-hotseat',
      room_id: 'room-1',
      title: 'Representative A',
      mode: 'followup',
      interaction_mode: 'hotseat',
      participant_set_hash: 'hash-hotseat',
      memory_partition_id: 'thread-hotseat-partition',
      addressed_agent_ids_json: ['agent-a'],
      created_at: '2026-03-29T00:00:02Z',
      updated_at: '2026-03-29T00:00:03Z',
    });
    replaySnapshot.turns.push({
      id: 'turn-hotseat',
      room_id: 'room-1',
      thread_id: 'thread-hotseat',
      sequence: 2,
      phase: 'verdict',
      participant_id: 'rep-a',
      content: 'This stays inside Representative A.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:02Z',
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
    expect(screen.getByText('This stays inside Representative A.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(setInteractionModeMock).toHaveBeenCalledWith('hotseat');
    expect(screen.getAllByText('Using the active roundtable thread only').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Save read-only copy' }));
    expect(screen.getByRole('button', { name: 'Read-only copy saved' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import local run' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('falls back to a local replay link when artifact and token replay links are both unavailable', async () => {
    const user = userEvent.setup();
    createReplayArtifactMock.mockRejectedValueOnce(new Error('artifact offline'));
    buildOracleReplayUrlMock.mockRejectedValueOnce(new Error('token too large'));
    saveOracleReplayLocalCopyMock.mockReturnValueOnce('local-roundtable-copy');
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire forked?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [],
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

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy replay' }));

    await waitFor(() => {
      expect(saveOracleReplayLocalCopyMock).toHaveBeenCalledTimes(1);
      expect(copyTextMock).toHaveBeenCalledWith('http://localhost:3000/roundtable/replay?roomLocal=local-roundtable-copy');
    });
    expect(screen.getByRole('button', { name: 'Read-only copy saved' })).toBeInTheDocument();
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
      selectionRecipe: 'representative',
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

describe('WorldlineRoundtableView text layout contracts', () => {
  beforeEach(() => {
    clearPretextCache();
  });

  it('keeps the picker hint readable but flags extreme transcript monologues', () => {
    const pickerPrediction = predictTextOverflow(
      'Seat one representative for each ending. The table starts with high-impact picks while trying to avoid the same voice on every worldline.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.roundtablePickerHint,
    );
    const transcriptPrediction = predictTextOverflow(
      'Roundtable verdict: this branch kept calling panic strategy, panic strategy, and panic strategy until every cost looked inevitable and every missing witness got folded back into the same generic explanation.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.roundtableTranscriptBubble,
    );

    expect(pickerPrediction.overflow).toBe(false);
    expect(transcriptPrediction.lineCount).toBeGreaterThan(1);
  });
});
