import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WorldlineRoundtableView from './WorldlineRoundtableView';
import { __resetCapabilityCacheForTests } from '../hooks/useCapabilityCheck';
import { clearPretextCache } from '../lib/textLayout/pretext';
import {
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  predictTextOverflow,
} from '../lib/textLayout/textOverflowPredictor';
import type {
  EndingRoomInteractionMode,
  EndingRoomPlanningData,
  EndingRoomResult,
  EndingRoomSnapshot,
  EndingRoomThreadSnapshot,
} from '../types';

interface MockStoreState {
  snapshot: EndingRoomSnapshot | null;
  result: EndingRoomResult | null;
  threadsById: Record<string, EndingRoomThreadSnapshot>;
  threadOrder: string[];
  activeThreadId: string | null;
  interactionMode: EndingRoomInteractionMode;
  composerDraft: string;
  scopeNotice: null | { threadId: string; memoryPartitionId: string };
  sending: boolean;
  status: 'idle' | 'loading' | 'draft' | 'live' | 'done' | 'error';
  planningState: EndingRoomPlanningData | null;
  pendingDrafts: Record<string, unknown>;
  openRoom: (...args: unknown[]) => Promise<string>;
  loadRoom: (...args: unknown[]) => Promise<void>;
  loadThread: (...args: unknown[]) => Promise<void>;
  createThread: (...args: unknown[]) => Promise<EndingRoomThreadSnapshot>;
  appendUserTurn: (...args: unknown[]) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  setInteractionMode: (mode: EndingRoomInteractionMode) => void;
  setComposerDraft: (value: string) => void;
  reset: () => void;
}

type AutomationTextWindow = Window & {
  render_game_to_text?: () => string;
};

const {
  createBaseStoreState,
  getMockLanguage,
  setMockLanguage,
  changeLanguageMock,
  appendUserTurnMock,
  buildOracleReplayShareUrlMock,
  buildOracleReplayUrlMock,
  copyTextMock,
  createReplayArtifactMock,
  getActiveEndingRoomMock,
  getCapabilitiesMock,
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
  const createThread = vi.fn(async (): Promise<EndingRoomThreadSnapshot> => ({
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
  const createBaseStoreState = (): MockStoreState => ({
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
    planningState: null,
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
  });
  return {
    createBaseStoreState,
    getMockLanguage: () => currentLanguage,
    setMockLanguage: (language: string) => {
      currentLanguage = language;
    },
    changeLanguageMock: vi.fn(async (language: string) => {
      currentLanguage = language;
    }),
    createReplayArtifactMock: vi.fn(async () => ({ id: 'artifact-1' })),
    getActiveEndingRoomMock: vi.fn(),
    getCapabilitiesMock: vi.fn(async () => ({
      factions: { enabled: false },
      agent_conversation: { enabled: false },
      roundtable_analyst: { enabled: false },
      roundtable_survey: { enabled: false },
    })),
    buildOracleReplayShareUrlMock: vi.fn((origin: string, payload: unknown, artifactId: string) => {
      void origin;
      void payload;
      return `https://example.com/roundtable/replay?roomShare=${artifactId}`;
    }),
    buildOracleReplayUrlMock: vi.fn(async (origin: string, payload: unknown) => {
      void origin;
      void payload;
      return 'https://example.com/roundtable/replay?roomReplay=token';
    }),
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
    saveOracleReplayLocalCopyMock: vi.fn((payload: unknown) => {
      void payload;
      return 'local-roundtable';
    }),
    copyTextMock: vi.fn(async (value: string) => {
      void value;
    }),
    wsMock: vi.fn(),
    storeState: createBaseStoreState(),
  };
});

/* CSS contract assertions removed — sidebar summary card no longer exists */
const endingChatCssContract = readFileSync('src/components/EndingChatModal.css', 'utf8');
const roundtableCssContract = readFileSync('src/pages/WorldlineRoundtable.css', 'utf8');
const roundtableViewSource = readFileSync('src/pages/WorldlineRoundtableView.tsx', 'utf8');
const phaseInsightTimelineSource = readFileSync('src/pages/roundtable/PhaseInsightTimeline.tsx', 'utf8');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'roundtable.shortlist_count') {
        return `${String(options?.count ?? '')} / ${String(options?.max ?? '')} worldlines selected`;
      }
      if (key === 'roundtable.thread_label') {
        return ` · Thread ${String(options?.count ?? '')}`;
      }
      if (key === 'roundtable.reps_summary') {
        return `${String(options?.count ?? '')} reps · Expand details`;
      }
      if (key === 'roundtable.mode_note_hotseat_named') {
        return `Focus on ${String(options?.name ?? '')} — let this worldline explain its position.`;
      }
      if (key === 'roundtable.verdict_prompt') {
        return `How did the table reach this consensus? About "${String(options?.summary ?? '')}".`;
      }
      if (key === 'roundtable.phase_prompt_default') {
        return `What was the main point in "${String(options?.label ?? '')}"?`;
      }
      if (key === 'roundtable.phase_prompt') {
        return `About "${String(options?.label ?? '')}": ${String(options?.stakes ?? '')}`;
      }
      if (key === 'roundtable.quote_prompt') {
        return `${String(options?.speaker ?? '')} said "${String(options?.snippet ?? '')}" — can you expand on that?`;
      }
      if (key === 'roundtable.picker_branch_impact_summary') {
        return `Impact ${String(options?.impact ?? 0)} · ${String(options?.turns ?? 0)} turns · ${String(options?.hinges ?? 0)} hinge hits · latest R${String(options?.round ?? 0)}`;
      }
      if (key === 'roundtable.picker_witness_impact_summary') {
        return `Impact ${String(options?.impact ?? 0)}`;
      }
      if (key === 'roundtable.picker_drag_announce_start' || key === 'roundtable.picker_drag_announce_start_en') {
        return `Picked up ${String(options?.name ?? '')}.`;
      }
      if (key === 'roundtable.picker_drag_announce_over') {
        return `Moved over ${String(options?.title ?? '')} seat.`;
      }
      if (key === 'roundtable.picker_drag_announce_seated') {
        return `${String(options?.name ?? '')} seated successfully.`;
      }
      if (key === 'roundtable.picker_drag_announce_cancel_with_name') {
        return `Drop cancelled, ${String(options?.name ?? '')} returned to the candidate pool.`;
      }
      return ({
        'roundtable.title': 'Worldline Roundtable',
        'roundtable.entry_cta': 'Start Roundtable',
        'roundtable.entry_hint': 'One representative from each ending joins the table, guided by the host.',
        'roundtable.selection_mode_representative': 'All representatives',
        'roundtable.selection_mode_manual_shortlist': 'Hand-pick',
        'roundtable.selection_mode_expert_witness': 'Invite expert',
        'roundtable.selection_mode_trait_mix': 'Clash mix',
        'roundtable.selection_mode_fault_line_first': 'Biggest split first',
        'roundtable.selection_mode_witness_augmented': 'Auto-fill',
        'roundtable.format_selector_label': 'Discussion format',
        'roundtable.format_label': 'Format',
        'roundtable.format_deep_dive': 'Deep Dive',
        'roundtable.format_quick_review': 'Quick Review',
        'roundtable.format_clash_mode': 'Clash Mode',
        'roundtable.cast_label': 'Cast mode',
        'roundtable.cast_smart_pick': 'Auto Cast',
        'roundtable.cast_custom': 'Custom Cast',
        'roundtable.planning_preparing': 'Preparing the roundtable',
        'roundtable.planning_turns': `${String(options?.count ?? 0)} turns planned`,
        'roundtable.shortlist_hint': 'Pick 2-4 worldlines to seat at the table; the rest sit this one out.',
        'roundtable.trait_mix_hint': 'Swap in representatives with sharper disagreements.',
        'roundtable.fault_line_hint': 'Auto-pick the two worldlines that diverge the most.',
        'roundtable.shortlist_toggle_on': 'Add to table',
        'roundtable.shortlist_toggle_off': 'Skip for now',
        'roundtable.witness_hint': 'Keep one rep per worldline, then bring in one expert.',
        'roundtable.witness_augmented_hint': 'Keep current reps, auto-add one expert.',
        'roundtable.witness_section': 'Expert seat',
        'roundtable.witness_augmented_section': 'Extra expert seat',
        'roundtable.witness_selected': 'Current expert',
        'roundtable.witness_badge': 'Expert',
        'roundtable.role_witness': 'Expert',
        'roundtable.loading': 'Setting up the roundtable...',
        'roundtable.phase_verdict': 'Wrap-up',
        'roundtable.phase_opening': 'Recap',
        'roundtable.phase_crossfire': 'Debate',
        'roundtable.phase_rebuttal': 'What if',
        'roundtable.phase_closing': 'Wrap-up',
        'roundtable.role_archivist': 'Host',
        'roundtable.action_continue': 'Keep asking',
        'roundtable.action_new_thread': 'New topic',
        'roundtable.action_copy_brief': 'Copy summary',
        'roundtable.action_brief_copied': 'Summary copied',
        'roundtable.action_follow_phase': 'Dig into this phase',
        'roundtable.action_hotseat_quote': 'Question this rep',
        'roundtable.action_follow_quote': 'Follow up on this',
        'roundtable.action_thread_from_anchor': 'New topic from here',
        'roundtable.action_expand_turn': 'Show full text',
        'roundtable.action_collapse_turn': 'Collapse',
        'roundtable.new_messages': `${String(options?.count ?? 0)} new messages`,
        'roundtable.back_to_results': 'Back to results',
        'roundtable.back_to_table': 'Back to table',
        'roundtable.reseat_reopen': 'Reseat & restart',
        'roundtable.copy_replay': 'Copy replay',
        'roundtable.replay_copied': 'Replay link copied',
        'roundtable.save_readonly': 'Save copy',
        'roundtable.readonly_saved': 'Copy saved',
        'roundtable.import_replay': 'Import run',
        'roundtable.importing': 'Importing…',
        'roundtable.worldline_count': `${String(options?.count ?? 0)} worldlines`,
        'roundtable.representative_count': `${String(options?.count ?? 0)} reps`,
        'roundtable.thread_count': `${String(options?.count ?? 0)} topics`,
        'roundtable.readonly_replay': 'Read-only replay',
        'roundtable.table_status': 'Progress',
        'roundtable.hosted_by_archivist': 'Host-guided',
        'roundtable.scope_this_table': 'This table only',
        'roundtable.scope_note': 'Follow-ups only reference this table\'s discussion and existing conclusions.',
        'roundtable.speaking_now': 'Speaking',
        'roundtable.hotseat_target': 'Questioned',
        'roundtable.impact_score': `Impact ${String(options?.score ?? 0)}`,
        'roundtable.participant_count': `${String(options?.count ?? 0)} participants`,
        'roundtable.follow_up_mode': 'Follow-up mode',
        'roundtable.transcript_title': 'Discussion',
        'roundtable.threads_label': 'Topics',
        'roundtable.phase_nav_label': 'Phase navigation',
        'roundtable.composer_placeholder': 'Keep asking the representatives...',
        'roundtable.sending': 'Sending…',
        'roundtable.send': 'Send',
        'roundtable.theme_cues_label': 'Theme cues',
        'roundtable.phase_insights_label': 'Discussion Flow',
        'roundtable.phase_insights_title': 'Discussion Flow',
        'roundtable.phase_unknown': 'Phase',
        'roundtable.verdict_title': 'Wrap-up',
        'roundtable.archivist_note_title': 'Host note',
        'roundtable.question_title': 'Question',
        'roundtable.synthesis_eyebrow': 'Discussion Result',
        'roundtable.question_anchor_label': 'Question discussed',
        'roundtable.question_anchor_compact': 'About',
        'roundtable.scope_title': 'Scope',
        'roundtable.representatives_title': 'Representatives',
        'roundtable.expand_roster': 'Show all',
        'roundtable.collapse_roster': 'Collapse',
        'roundtable.more_actions': 'More actions',
        'roundtable.explore_tab': 'Deep Dive',
        'roundtable.explore_agent_chat': '1-on-1 Interview',
        'roundtable.explore_analyst': 'Research Analyst',
        'roundtable.explore_survey': 'Cross-Examine',
        'roundtable.explore_agent_chat_desc': 'Pick a participant and dig deeper into their reasoning.',
        'roundtable.explore_analyst_desc': 'Let the analyst cross-reference causal graphs, memory, and web data.',
        'roundtable.explore_survey_desc': 'Pose the same question to multiple participants and spot the differences.',
        'roundtable.explore_agent_chat_placeholder': 'Tap a participant above to start a private conversation.',
        'roundtable.explore_analyst_placeholder': 'e.g. "Why did Worldline 2 diverge after Round 3?"',
        'roundtable.explore_survey_placeholder': 'e.g. "What single decision would you change if you could?"',
        'roundtable.explore_locked': 'The verdict must be in before you can explore further.',
        'roundtable.error_missing_scenario': 'Roundtable replay is missing its base scenario snapshot.',
        'roundtable.error_invalid_replay': 'This roundtable replay link is invalid.',
        'roundtable.error_missing_id': 'Missing scenario id.',
        'roundtable.error_not_done': 'The result is not finished yet, so the roundtable is not available.',
        'roundtable.error_too_few_branches': 'The roundtable needs at least two endings.',
        'roundtable.error_restore_failed': 'Could not restore the saved roundtable. Refresh and try again.',
        'roundtable.speaker_you': 'You',
        'roundtable.speaker_unknown': 'Unknown',
        'roundtable.placeholder_hotseat': 'The selected representative is lining up a reply…',
        'roundtable.placeholder_archivist': 'The Archivist is routing the question to the right representative…',
        'roundtable.scope_followup_active': 'Following this roundtable thread only',
        'roundtable.scope_table_active': 'Using this table and crossline summaries only',
        'roundtable.scope_followup_default': 'Using the active roundtable thread only',
        'roundtable.scope_table_default': 'Using this table and crossline summaries',
        'roundtable.replay_readonly': 'Replay mode is read-only for this table.',
        'roundtable.import_error': 'Failed to import roundtable replay',
        'roundtable.participant_details': 'Participant details',
        'roundtable.participants': 'Participants',
        'roundtable.thread_main_table': 'Main table',
        'roundtable.discussion_log': 'Roundtable discussion log',
        'roundtable.long_turn': 'Long turn',
        'roundtable.selection_reason_user_selected': 'Your pick',
        'roundtable.selection_reason_fallback': 'Auto-filled',
        'roundtable.selection_reason_top_impact': 'High impact',
        'roundtable.host_guided_label': 'Host-guided',
        'roundtable.hotseat_question_one': 'Question one rep',
        'roundtable.mode_note_hotseat': 'Pick one rep to question — get a clear answer from one worldline.',
        'roundtable.mode_note_thread_followup': 'Split off one disagreement into its own thread so the main discussion stays clean.',
        'roundtable.mode_note_default': 'The host sorts out the disagreement first, then passes it to the right rep.',
        'roundtable.verdict_prompt_default': 'Why did the roundtable reach this conclusion?',
        'roundtable.anchor_kind_verdict': 'Discussion result',
        'roundtable.anchor_kind_phase': 'Phase',
        'roundtable.anchor_kind_quote': 'Quote',
        'roundtable.anchor_kind_default': 'Anchor',
        'roundtable.picker_default_hint_existing': 'The current table stays available until you reopen it. Swap representatives here, then rebuild the roundtable with the new lineup.',
        'roundtable.picker_default_hint_new': 'Seat one representative for each ending. The table starts with high-impact picks while trying to avoid the same voice on every worldline.',
        'roundtable.picker_launch_loading': 'Launching…',
        'roundtable.picker_launch_reopen': 'Reopen this lineup',
        'roundtable.picker_launch_open': 'Open this lineup',
        'roundtable.picker_selected_label': 'Selected',
        'roundtable.picker_seating_heading': 'Seating board',
        'roundtable.picker_seating_hint_drag': 'Drag candidates into seats. Mobile keeps tap-to-seat.',
        'roundtable.picker_seating_hint_tap': 'Tap-to-seat is active on this device.',
        'roundtable.picker_empty_representative': 'Drop here to seat',
        'roundtable.picker_empty_witness': 'Drop here to seat a witness',
        'roundtable.picker_occupied_label': 'Currently seated',
        'roundtable.picker_drag_announce_no_seat': 'Not over a valid seat.',
        'roundtable.picker_drag_announce_cancel': 'Drop cancelled.',
        'roundtable.picker_reseat_heading': 'Reseat each worldline representative',
        'roundtable.picker_seating_mode_label': 'Roundtable seating mode',
        'roundtable.picker_back_to_table': 'Back to current table',
        'common.loading': 'Loading',
        'common.close': 'Close',
        'common.collapse': 'Collapse',
        'common.expand': 'Expand',
        'common.you': 'You',
        'common.unknown_speaker': 'Unknown',
        'ending_room.participant_unknown': 'Unknown',
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
    getActiveEndingRoom: getActiveEndingRoomMock,
    getCapabilities: getCapabilitiesMock,
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
  sanitizeOracleReplayPayload: (payload: unknown) => payload,
  saveOracleReplayLocalCopy: (payload: unknown) => saveOracleReplayLocalCopyMock(payload),
}));

vi.mock('../game/managers/VizSynthesizer', () => ({
  mapRoleToSpriteId: () => 'sprite_default',
}));

beforeEach(() => {
  setMockLanguage('en');
  __resetCapabilityCacheForTests();
  createReplayArtifactMock.mockReset();
  createReplayArtifactMock.mockImplementation(async () => ({ id: 'artifact-1' }));
  buildOracleReplayShareUrlMock.mockReset();
  buildOracleReplayShareUrlMock.mockImplementation((origin: string, payload: unknown, artifactId: string) => {
    void origin;
    void payload;
    return `https://example.com/roundtable/replay?roomShare=${artifactId}`;
  });
  buildOracleReplayUrlMock.mockReset();
  buildOracleReplayUrlMock.mockImplementation(async (origin: string, payload: unknown) => {
    void origin;
    void payload;
    return 'https://example.com/roundtable/replay?roomReplay=token';
  });
  getCapabilitiesMock.mockReset();
  getCapabilitiesMock.mockImplementation(async () => ({
    factions: { enabled: false },
    agent_conversation: { enabled: false },
    roundtable_analyst: { enabled: false },
    roundtable_survey: { enabled: false },
  }));
  getActiveEndingRoomMock.mockReset();
  getActiveEndingRoomMock.mockImplementation(async () => null);
  getAgentsMock.mockReset();
  getReplayArtifactMock.mockReset();
  getScenarioMock.mockReset();
  getStoryMock.mockReset();
  importReplayScenarioMock.mockReset();
  loadOracleReplayLocalCopyMock.mockReset();
  openRoomMock.mockReset();
  openRoomMock.mockImplementation(async () => 'room-1');
  loadRoomMock.mockReset();
  loadRoomMock.mockImplementation(async () => {});
  loadThreadMock.mockReset();
  loadThreadMock.mockImplementation(async () => {});
  createThreadMock.mockReset();
  createThreadMock.mockImplementation(async (): Promise<EndingRoomThreadSnapshot> => ({
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
  changeLanguageMock.mockReset();
  changeLanguageMock.mockImplementation(async (language: string) => {
    setMockLanguage(language);
  });
  appendUserTurnMock.mockReset();
  appendUserTurnMock.mockImplementation(async () => {});
  setActiveThreadMock.mockReset();
  setInteractionModeMock.mockReset();
  setComposerDraftMock.mockReset();
  resetMock.mockReset();
  saveOracleReplayLocalCopyMock.mockReset();
  saveOracleReplayLocalCopyMock.mockImplementation((payload: unknown) => {
    void payload;
    return 'local-roundtable';
  });
  copyTextMock.mockReset();
  copyTextMock.mockImplementation(async (value: string) => {
    void value;
  });
  wsMock.mockReset();
  Object.assign(storeState, createBaseStoreState());
  setViewportWidth(1024);
  Object.defineProperty(window, 'scrollTo', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
    writable: true,
    configurable: true,
  });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
});

function renderRoundtableView(initialEntry = '/roundtable/scenario-1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

function setTranscriptScrollMetrics(
  element: HTMLDivElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  let currentScrollTop = scrollTop;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
}

function makeSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

describe('WorldlineRoundtableView', () => {
  it('keeps live hero actions in a single scrollable strip', async () => {
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

    renderRoundtableView();

    await screen.findByText('Worldline Roundtable');

    const actionStrip = document.querySelector('.worldline-roundtable-hero__actions') as HTMLDivElement | null;
    expect(actionStrip).toBeTruthy();
    expect(actionStrip!.style.overflowX).toBe('');
  });

  it('renders question anchors when storyData.question exists', async () => {
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
        { id: 'branch-a', title: 'A', probability: 0.5, insight: 'A', story: 'A', key_moments: [] },
        { id: 'branch-b', title: 'B', probability: 0.5, insight: 'B', story: 'B', key_moments: [] },
      ],
    });
    getAgentsMock.mockResolvedValue([]);

    renderRoundtableView();

    await screen.findByText('Worldline Roundtable');

    await waitFor(() => {
      expect(document.querySelector('.worldline-roundtable-question-anchor')).toBeTruthy();
      expect(document.querySelector('.worldline-roundtable-transcript-header__question')).toBeTruthy();
      expect(document.querySelector('.worldline-roundtable-phase-question')).toBeTruthy();
    });
    expect(screen.getByText('Discussion Result')).toBeInTheDocument();
    expect(screen.getByText('Question discussed')).toBeInTheDocument();
    expect(screen.getAllByText('About')).toHaveLength(2);
  });

  it('does not render question anchors when storyData.question is absent', async () => {
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      scene_theme: 'court',
      status: 'done',
      language: 'en',
      agents: [],
    });
    getStoryMock.mockResolvedValue({
      branches: [
        { id: 'branch-a', title: 'A', probability: 0.5, insight: 'A', story: 'A', key_moments: [] },
        { id: 'branch-b', title: 'B', probability: 0.5, insight: 'B', story: 'B', key_moments: [] },
      ],
    });
    getAgentsMock.mockResolvedValue([]);

    renderRoundtableView();

    await screen.findByText('Worldline Roundtable');

    expect(document.querySelector('.worldline-roundtable-question-anchor')).toBeFalsy();
    expect(document.querySelector('.worldline-roundtable-transcript-header__question')).toBeFalsy();
    expect(document.querySelector('.worldline-roundtable-phase-question')).toBeFalsy();
  });

  it('does not show the planning skeleton over an already loaded result', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot!,
      turns: [],
      result_ready: true,
    };
    storeState.result = baseState.result;
    storeState.threadsById = {
      'thread-room': {
        ...baseState.threadsById['thread-room'],
        turns: [],
      },
    };
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.planningState = {
      room_id: 'room-1',
      discussion_format: 'quick_review',
      cast_mode: 'smart_pick',
      planned_turn_count: 3,
      phase: 'opening',
    };
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
        { id: 'branch-a', title: 'Branch A', probability: 0.62, insight: 'A', story: 'Story A', key_moments: [] },
        { id: 'branch-b', title: 'Branch B', probability: 0.38, insight: 'B', story: 'Story B', key_moments: [] },
      ],
    });
    getAgentsMock.mockResolvedValue([]);

    renderRoundtableView();

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();
    expect(screen.queryByText('Preparing the roundtable')).not.toBeInTheDocument();
  });

  it('creates a live roundtable room from a multi-ending result', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    expect(await screen.findByText('Reseat each worldline representative')).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Deep Dive' })).toBeChecked();
    expect(await screen.findByRole('radio', { name: 'Auto Cast' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Quick Review' }));
    await user.click(screen.getByRole('radio', { name: 'Custom Cast' }));
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    await waitFor(() => {
      expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
        roomType: 'worldline_roundtable',
        selectedBranchIds: ['branch-a', 'branch-b'],
        selectionRecipe: 'representative',
        discussionFormat: 'quick_review',
        castMode: 'custom',
        language: 'en',
        selectedRepresentatives: [
          { branchId: 'branch-a', agentId: 'agent-a' },
          { branchId: 'branch-b', agentId: 'agent-b' },
        ],
        selectedWitness: null,
      });
    });
    await waitFor(() => {
      expect(loadRoomMock).toHaveBeenCalledWith('room-1');
    });
  });

  describe('revisiting a completed roundtable', () => {
    const completedScenario = {
      id: 'scenario-1',
      question: 'What broke first?',
      scene_theme: 'court',
      status: 'done',
      language: 'en',
      agents: [],
    };
    const completedStory = {
      question: 'What broke first?',
      branches: [
        { id: 'branch-a', title: 'Branch A', probability: 0.62, insight: 'A', story: 'Story A', key_moments: [] },
        { id: 'branch-b', title: 'Branch B', probability: 0.38, insight: 'B', story: 'Story B', key_moments: [] },
      ],
    };

    function startWithoutHydratedRoom() {
      storeState.snapshot = null;
      storeState.result = null;
      storeState.threadsById = {};
      storeState.threadOrder = [];
      storeState.activeThreadId = null;
      storeState.status = 'idle';
      getScenarioMock.mockResolvedValue(completedScenario);
      getStoryMock.mockResolvedValue(completedStory);
      getAgentsMock.mockResolvedValue([]);
    }

    it('rehydrates the persisted completed room so the verdict + Deep Dive render', async () => {
      startWithoutHydratedRoom();
      const baseState = createBaseStoreState();
      const resolvedRoom = {
        ...baseState.snapshot!,
        turns: [],
        status: 'done' as const,
        result_ready: true,
      };
      getActiveEndingRoomMock.mockResolvedValue(resolvedRoom);
      // loadRoom hydrates the shared store exactly like the live completion path.
      loadRoomMock.mockImplementation(async () => {
        storeState.snapshot = resolvedRoom;
        storeState.result = baseState.result;
        storeState.threadsById = {
          'thread-room': { ...baseState.threadsById['thread-room'], turns: [] },
        };
        storeState.threadOrder = ['thread-room'];
        storeState.activeThreadId = 'thread-room';
        storeState.status = 'done';
      });

      renderRoundtableView();

      // The completed verdict synthesis renders instead of the picker.
      await screen.findByText('The roundtable converged on a single hinge.');
      const synthesisSection = document.querySelector('.worldline-roundtable-synthesis');
      expect(synthesisSection).toBeTruthy();
      expect(
        within(synthesisSection as HTMLElement).getByRole('heading', {
          level: 2,
          name: 'The roundtable converged on a single hinge.',
        }),
      ).toBeInTheDocument();
      // PostVerdictPanel Deep Dive entry is present.
      expect(document.querySelector('.roundtable-phase-nav__pill.is-explore')).toBeTruthy();
      // The picker is NOT shown.
      expect(screen.queryByText('Reseat each worldline representative')).not.toBeInTheDocument();

      // Resolved read-only and hydrated via loadRoom — never created a room.
      expect(getActiveEndingRoomMock).toHaveBeenCalledWith('scenario-1', 'worldline_roundtable');
      expect(loadRoomMock).toHaveBeenCalledWith(resolvedRoom.id, { throwOnError: true });
      await waitFor(() => expect(wsMock).toHaveBeenLastCalledWith(resolvedRoom.id, false));
      expect(wsMock).not.toHaveBeenCalledWith(resolvedRoom.id, true);
      expect(openRoomMock).not.toHaveBeenCalled();
    });

    it('falls back to the picker when no persisted room exists (resolve returns null)', async () => {
      startWithoutHydratedRoom();
      getActiveEndingRoomMock.mockResolvedValue(null);

      renderRoundtableView();

      expect(await screen.findByText('Reseat each worldline representative')).toBeInTheDocument();
      expect(getActiveEndingRoomMock).toHaveBeenCalledWith('scenario-1', 'worldline_roundtable');
      // No hydration and no error surface for the "no existing room" case.
      expect(loadRoomMock).not.toHaveBeenCalled();
      expect(openRoomMock).not.toHaveBeenCalled();
      expect(document.querySelector('.worldline-roundtable-empty--error')).toBeNull();
    });

    it('shows a retryable error instead of the picker when active-room resolve throws', async () => {
      startWithoutHydratedRoom();
      getActiveEndingRoomMock.mockRejectedValue(new Error('resolve failed'));

      renderRoundtableView();

      expect(await screen.findByText('Could not restore the saved roundtable. Refresh and try again.')).toBeInTheDocument();
      expect(screen.queryByText('Reseat each worldline representative')).not.toBeInTheDocument();
      expect(loadRoomMock).not.toHaveBeenCalled();
      expect(openRoomMock).not.toHaveBeenCalled();
      expect(document.querySelector('.worldline-roundtable-empty--error')).toBeTruthy();
    });

    it('shows a retryable error when the persisted room cannot hydrate', async () => {
      startWithoutHydratedRoom();
      const resolvedRoom = {
        ...createBaseStoreState().snapshot!,
        status: 'done' as const,
        result_ready: true,
      };
      getActiveEndingRoomMock.mockResolvedValue(resolvedRoom);
      loadRoomMock.mockRejectedValue(new Error('load failed'));

      renderRoundtableView();

      expect(await screen.findByText('Could not restore the saved roundtable. Refresh and try again.')).toBeInTheDocument();
      expect(screen.queryByText('Reseat each worldline representative')).not.toBeInTheDocument();
      expect(loadRoomMock).toHaveBeenCalledWith(resolvedRoom.id, { throwOnError: true });
      expect(openRoomMock).not.toHaveBeenCalled();
    });
  });

  it('keeps the current UI language and launches the room in that language even when the scenario language differs', async () => {
    setMockLanguage('en');
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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

    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
      language: 'en',
    }));
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it('does not refetch scenario data or reset the room when only the UI language changes', async () => {
    setMockLanguage('en');
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the empire split?',
      status: 'done',
      agents: [],
      language: 'en',
      messages: [
        { id: 'msg-a', branch: 'branch-a', agent: 'Representative A', agent_id: 'agent-a', message: 'A', emotion: 'focused', round: 1 },
        { id: 'msg-b', branch: 'branch-b', agent: 'Representative B', agent_id: 'agent-b', message: 'B', emotion: 'focused', round: 1 },
      ],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What if the empire split?',
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

    const view = (
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>
    );

    const { rerender } = render(view);

    expect(await screen.findByText('Worldline Roundtable')).toBeInTheDocument();
    expect(getScenarioMock).toHaveBeenCalledTimes(1);
    expect(getStoryMock).toHaveBeenCalledTimes(1);
    expect(getAgentsMock).toHaveBeenCalledTimes(1);

    resetMock.mockClear();
    setMockLanguage('zh');
    rerender(view);

    await waitFor(() => {
      expect(screen.getByText('Worldline Roundtable')).toBeInTheDocument();
    });
    expect(getScenarioMock).toHaveBeenCalledTimes(1);
    expect(getStoryMock).toHaveBeenCalledTimes(1);
    expect(getAgentsMock).toHaveBeenCalledTimes(1);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('lets manual_shortlist launch only the selected worldlines', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    expect(await screen.findByTestId('roundtable-seating-board')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Hand-pick' }));
    expect(screen.getByText('2 / 3 worldlines selected')).toBeInTheDocument();
    expect(screen.getByTestId('roundtable-seat-slot-branch-a')).toBeInTheDocument();
    expect(screen.getByTestId('roundtable-seat-slot-branch-b')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Add to table' })[0]);
    expect(screen.getByText('3 / 3 worldlines selected')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Skip for now' })[2]);
    expect(screen.queryByTestId('roundtable-seat-slot-branch-c')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'manual_shortlist',
      discussionFormat: 'deep_dive',
      castMode: 'custom',
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'Summary-only crossline scope held.',
      phase_insights: [
        {
          phase: 'verdict',
          stakes: 'Archive the hinge.',
          moderator_focus: 'Keep the scope narrow.',
          commentary: 'Explain the hinge in plain language.',
        },
      ],
    } as EndingRoomResult;
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
    } as Record<string, EndingRoomThreadSnapshot>;
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

    renderRoundtableView();

    await screen.findByText('The roundtable converged on a single hinge.');

    const synthesisSection = document.querySelector('.worldline-roundtable-synthesis');
    expect(synthesisSection).toBeTruthy();
    const synthesisScope = within(synthesisSection as HTMLElement);

    expect(synthesisScope.getByRole('heading', { level: 2, name: 'The roundtable converged on a single hinge.' })).toBeInTheDocument();
    expect(screen.getByText('Summary-only crossline scope held.', { selector: '.worldline-roundtable-synthesis__note' })).toBeInTheDocument();

    const summaryActions = synthesisSection!.querySelector('.worldline-roundtable-synthesis__actions');
    expect(summaryActions).toBeTruthy();
    const actionsScope = within(summaryActions as HTMLElement);
    expect(actionsScope.getByRole('button', { name: 'Keep asking' })).toBeVisible();
    expect(actionsScope.getByRole('button', { name: 'New topic' })).toBeVisible();
    expect(actionsScope.getByRole('button', { name: 'Copy summary' })).toBeVisible();

    await user.click(actionsScope.getByRole('button', { name: 'Keep asking' }));
    expect(setComposerDraftMock).toHaveBeenCalledWith('How did the table reach this consensus? About "The roundtable converged on a single hinge.".');

    await user.click(actionsScope.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalled());
    expect(copyTextMock).toHaveBeenCalledWith(expect.stringContaining('## Wrap-up'));
  });

  it('keeps critical summary actions reachable in the live synthesis section on compact viewports', async () => {
    setViewportWidth(640);
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

    renderRoundtableView();

    await screen.findByText('The roundtable converged on a single hinge.');

    const synthesisSection = document.querySelector('.worldline-roundtable-synthesis');
    expect(synthesisSection).toBeTruthy();
    const synthesisScope = within(synthesisSection as HTMLElement);
    expect(synthesisScope.getByRole('button', { name: 'Keep asking' })).toBeVisible();
    expect(synthesisScope.getByRole('button', { name: 'New topic' })).toBeVisible();
    expect(synthesisScope.getByRole('button', { name: 'Copy summary' })).toBeVisible();
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'Summary-only crossline scope held.',
      phase_insights: [
        {
          phase: 'verdict',
          stakes: 'Archive the hinge.',
          moderator_focus: 'Keep the scope narrow.',
          commentary: 'Explain the hinge in plain language.',
        },
      ],
    } as EndingRoomResult;
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
    } as Record<string, EndingRoomThreadSnapshot>;
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
    await screen.findByRole('button', { name: 'Keep asking' });
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Explain the hinge in plain language\./,
    }));
    await within(phaseSection as HTMLElement).findByText(/Explain the hinge in plain language\./, { selector: '.worldline-roundtable-insight p' });
    await user.click(within(phaseSection as HTMLElement).getByRole('button', { name: 'New topic' }));

    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: expect.stringContaining('Wrap-up'),
      questionAnchorIds: ['roundtable:phase:room-1:verdict-0'],
      interactionMode: 'thread_followup',
    }));
    await waitFor(() => expect(setComposerDraftMock).toHaveBeenCalledWith(
      'About "Wrap-up·Explain the hinge in plain language.": Explain the hinge in plain language.',
    ));
    expect(setInteractionModeMock).toHaveBeenCalledWith('thread_followup');
  });

  it('keeps phase insight actions working after the third card', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled four distinct beats.',
      archivist_note: 'Keep following the later phases.',
      phase_insights: [
        { phase: 'opening', stakes: 'Opening hinge.', moderator_focus: 'Focus the frame.', commentary: 'Opening.' },
        { phase: 'crossfire', stakes: 'Crossfire hinge.', moderator_focus: 'Expose the weak seam.', commentary: 'Crossfire.' },
        { phase: 'rebuttal', stakes: 'Rebuttal hinge.', moderator_focus: 'Absorb and redirect.', commentary: 'Rebuttal.' },
        { phase: 'closing', stakes: 'Closing hinge.', moderator_focus: 'Compress the takeaway.', commentary: 'Closing.' },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'What changed last?',
      scene_theme: 'court',
      status: 'done',
      language: 'en',
      agents: [],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'What changed last?',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'Branch A',
          probability: 0.6,
          insight: 'Branch A insight',
          story: 'Story A',
          key_moments: ['Moment A'],
        },
        {
          id: 'branch-b',
          title: 'Branch B',
          probability: 0.4,
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

    await screen.findByText('The table settled four distinct beats.');
    await screen.findByRole('button', { name: 'Keep asking' });
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Closing\./,
    }));
    await within(phaseSection as HTMLElement).findByText(/Closing\./, { selector: '.worldline-roundtable-insight p' });
    await user.click(within(phaseSection as HTMLElement).getByRole('button', { name: 'New topic' }));

    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: expect.any(String),
      questionAnchorIds: ['roundtable:phase:room-1:closing-3'],
      interactionMode: 'thread_followup',
    }));
  });

  it('renders phase insight commentary instead of stakes-only shorthand', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'opening',
          stakes: 'Opening hinge.',
          moderator_focus: 'Focus the frame.',
          commentary: 'Representative A argues that the hinge was the missed verification loop, not the ending label.',
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    await screen.findByRole('button', { name: 'Keep asking' });
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Representative A argues/,
    }));
    expect(within(phaseSection as HTMLElement).getByText(/Representative A argues that the hinge was the missed verification loop, not the ending label\./, { selector: '.worldline-roundtable-insight p' })).toBeInTheDocument();
    expect(within(phaseSection as HTMLElement).queryByText(/Opening hinge\./, { selector: '.worldline-roundtable-insight p' })).toBeNull();
  });

  it('renders phase chip with correct class and exposes stakes/moderator_focus when expanded', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'opening',
          stakes: 'Opening hinge.',
          moderator_focus: 'Focus the frame.',
          commentary: 'Representative A pins the supply road as the hinge.',
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    const chip = phaseSection!.querySelector('.phase-chip.phase-chip--opening');
    expect(chip).toBeTruthy();
    expect(chip?.textContent?.trim()).toBe('Recap');
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Representative A pins the supply road as the hinge/,
    }));
    expect(within(phaseSection as HTMLElement).getByText(
      'Representative A pins the supply road as the hinge.',
      { selector: '.phase-insight-expanded__body' },
    )).toBeInTheDocument();
    const expandedStakes = phaseSection!.querySelector('.phase-insight-expanded__stakes');
    expect(expandedStakes?.textContent).toContain('Opening hinge.');
    const expandedFocus = phaseSection!.querySelector('.phase-insight-expanded__focus');
    expect(expandedFocus?.textContent).toContain('Focus the frame.');
  });

  it('renders unknown phase insights with a neutral chip fallback', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'afterparty',
          stakes: 'Unknown phase stakes.',
          moderator_focus: 'Keep the fallback readable.',
          commentary: 'Unknown phase commentary stays readable.',
        },
      ],
    } as unknown as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    const unknownChip = phaseSection!.querySelector('.phase-chip.phase-chip--unknown');
    expect(unknownChip).toBeTruthy();
    expect(unknownChip?.textContent?.trim()).toBe('Phase');
    expect(phaseSection!.querySelector('.phase-chip--afterparty')).toBeNull();
  });

  it('prefers insight_body over commentary for the expanded paragraph when present', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'verdict',
          stakes: 'Verdict hinge.',
          moderator_focus: 'Close the loop.',
          commentary: 'Short collapsed text used for the trigger title.',
          insight_body: 'Expanded analytical body that should replace the commentary inside the expanded paragraph.',
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Short collapsed text used for the trigger title/,
    }));
    const body = phaseSection!.querySelector('.phase-insight-expanded__body');
    expect(body?.textContent).toContain('Expanded analytical body that should replace the commentary');
    expect(body?.textContent).not.toContain('Short collapsed text used for the trigger title.');
  });

  it('clips long insight_body in the expanded paragraph and keeps phase actions reachable', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    const longBody = `${'Expanded analytical body detail '.repeat(12)}tail-marker`;
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'crossfire',
          stakes: 'Crossfire hinge.',
          moderator_focus: 'Compare only the real split.',
          commentary: 'Short collapsed crossfire text.',
          insight_body: longBody,
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Short collapsed crossfire text/,
    }));
    const body = phaseSection!.querySelector('.phase-insight-expanded__body');
    expect(body?.textContent).toContain('Expanded analytical body detail');
    expect(body?.textContent).toContain('…');
    expect(body?.textContent).not.toContain('tail-marker');
    expect(body?.textContent?.length).toBeLessThanOrEqual(181);
    expect(within(phaseSection as HTMLElement).getByRole('button', {
      name: 'Dig into this phase',
    })).toBeInTheDocument();
    expect(within(phaseSection as HTMLElement).getByRole('button', {
      name: 'New topic',
    })).toBeInTheDocument();
  });

  it('falls back to commentary when insight_body is blank (backward compat)', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'closing',
          stakes: 'Closing hinge.',
          moderator_focus: 'Compress the takeaway.',
          commentary: 'Closing commentary used as the body fallback.',
          insight_body: '   ',
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    await user.click(within(phaseSection as HTMLElement).getByRole('button', {
      name: /Closing commentary used as the body fallback/,
    }));
    const body = phaseSection!.querySelector('.phase-insight-expanded__body');
    expect(body?.textContent).toContain('Closing commentary used as the body fallback.');
  });

  it('keeps phase insight details collapsed until the reader opens a phase', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The table settled on one archival verdict.',
      archivist_note: 'Keep the table scoped.',
      phase_insights: [
        {
          phase: 'opening',
          stakes: 'Opening hinge.',
          moderator_focus: 'Focus the frame.',
          commentary: 'Representative A pins the supply road as the hinge.',
        },
      ],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await screen.findByText('The table settled on one archival verdict.');
    const phaseSection = screen.getByRole('heading', { name: 'Discussion Flow' }).closest('.roundtable-phase-section');
    expect(phaseSection).toBeTruthy();
    const phaseTrigger = within(phaseSection as HTMLElement).getByRole('button', {
      name: /Representative A pins the supply road as the hinge/i,
    });
    expect(phaseTrigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(phaseTrigger);

    expect(phaseTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(phaseSection as HTMLElement).getByText(
      'Representative A pins the supply road as the hinge.',
      { selector: '.worldline-roundtable-insight p' },
    )).toBeInTheDocument();
  });

  it('does not duplicate the archivist note when it matches the summary verbatim', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'The roundtable converged on a single hinge.',
      phase_insights: [],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await waitFor(() => {
      expect(document.querySelector('.worldline-roundtable-synthesis')).toBeTruthy();
    });
    const synthesisSection = document.querySelector('.worldline-roundtable-synthesis');
    expect(synthesisSection).toBeTruthy();
    expect(within(synthesisSection as HTMLElement).getByRole('heading', { level: 2, name: 'The roundtable converged on a single hinge.' })).toBeInTheDocument();
    expect(within(synthesisSection as HTMLElement).queryByText('The roundtable converged on a single hinge.', { selector: '.worldline-roundtable-synthesis__note' })).toBeNull();
  });

  it('applies transcript layout metadata to long pending drafts', async () => {
    const longDraft = '请继续沿着这张圆桌追问：为什么这条世界线会把短期军令当成长期秩序，并要求档案官替所有后续成本收口？';
    storeState.pendingDrafts = {
      'draft-1': {
        turnId: 'draft-1',
        threadId: 'thread-room',
        participantId: 'rep-a',
        phase: 'verdict',
        content: longDraft,
        sequence: 2,
      },
    } as MockStoreState['pendingDrafts'];

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
    const bubble = screen.getByText(longDraft).closest('article');
    expect(bubble).not.toBeNull();
    expect(Number(bubble?.getAttribute('data-layout-lines') ?? '0')).toBeGreaterThan(1);
    expect(bubble?.style.minHeight).not.toBe('');
  });

  it('keeps transcript bubbles from shrinking over their action row', async () => {
    const longTurn = 'The verdict still needs a longer follow-up so the quote actions stay fully readable inside the same bubble.';
    const baseState = createBaseStoreState();
    baseState.snapshot!.turns = [
      {
        id: 'turn-1',
        room_id: 'room-1',
        thread_id: 'thread-room',
        sequence: 1,
        phase: 'verdict',
        participant_id: 'rep-a',
        content: longTurn,
        emotion: 'focused',
        created_at: '2026-03-29T00:00:00Z',
      },
    ];
    baseState.threadsById['thread-room'] = {
      ...baseState.threadsById['thread-room'],
      turns: baseState.snapshot!.turns,
    };
    storeState.snapshot = baseState.snapshot;
    storeState.result = baseState.result;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
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

    renderRoundtableView();

    await waitFor(() => {
      expect(document.querySelector('.worldline-roundtable-transcript-list .ending-chat-bubble')).toBeTruthy();
    });

    const bubble = document.querySelector('.worldline-roundtable-transcript-list .ending-chat-bubble');
    const actionRow = bubble?.querySelector('.ending-chat-bubble__actions');
    expect(bubble).toBeTruthy();
    expect(actionRow).toBeTruthy();
    expect(endingChatCssContract).toMatch(/\.ending-chat-bubble\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*flex-shrink:\s*0;/);
    expect(endingChatCssContract).toMatch(/\.ending-chat-bubble__actions\s*\{[\s\S]*position:\s*relative;[\s\S]*z-index:\s*1;/);
  });

  it('keeps spotlight bubble overrides more specific than EndingChatModal base bubble styles', () => {
    expect(roundtableViewSource).toContain("import './WorldlineRoundtable.css';");
    expect(roundtableViewSource).toContain("import '../components/EndingChatModal.css';");
    expect(roundtableCssContract).toMatch(
      /\.worldline-roundtable-transcript-list\s+\.ending-chat-bubble\.ending-chat-bubble--spotlight\s*\{/,
    );
  });

  it('resets native button chrome for phase timeline accordion triggers', () => {
    expect(roundtableViewSource).not.toContain('py-0 hover:no-underline');
    expect(roundtableCssContract).not.toMatch(/\.roundtable-phase-timeline__item\s+button\s*\{/);
    expect(roundtableCssContract).toMatch(
      /\.roundtable-phase-timeline__item\s+\.roundtable-phase-timeline__trigger\s*\{[\s\S]*appearance:\s*none;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;/,
    );
  });

  it('renders phase-type chips instead of generic phase numbering', () => {
    expect(phaseInsightTimelineSource).toContain('const phaseClass = isEndingRoomPhase(insight.phase)');
    expect(phaseInsightTimelineSource).toContain('phase-chip ${phaseClass}');
    expect(phaseInsightTimelineSource).toContain('getEndingRoomPhaseLabel(insight.phase, t)');
    expect(roundtableCssContract).not.toContain("content: 'Phase '");
    expect(roundtableCssContract).toMatch(/\.phase-chip\s*\{[\s\S]*flex-shrink:\s*0;/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--opening\s*\{/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--crossfire\s*\{/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--rebuttal\s*\{/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--closing\s*\{/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--verdict\s*\{/);
    expect(roundtableCssContract).toMatch(/\.phase-chip--unknown\s*\{/);
    expect(roundtableCssContract).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.phase-chip\s*\{[\s\S]*forced-color-adjust:\s*none;/,
    );
    expect(roundtableCssContract).toMatch(
      /\.roundtable-phase-timeline__content\s*\{[\s\S]*padding:\s*2px 0 10px;/,
    );
  });

  it('exposes transcript layout telemetry through render_game_to_text', async () => {
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
        { id: 'branch-a', title: 'Branch A', probability: 0.62, insight: 'Insight A', story: 'Story A', key_moments: ['M1'] },
        { id: 'branch-b', title: 'Branch B', probability: 0.38, insight: 'Insight B', story: 'Story B', key_moments: ['M2'] },
      ],
    });
    getAgentsMock.mockResolvedValue([]);
    storeState.pendingDrafts = {
      'draft-1': {
        turnId: 'draft-1',
        threadId: 'thread-room',
        participantId: 'rep-a',
        phase: 'verdict',
        content: '请继续沿着这张圆桌追问：为什么这条世界线会把短期军令当成长期秩序，并要求档案官替所有后续成本收口？',
        sequence: 2,
      },
    } as MockStoreState['pendingDrafts'];

    renderRoundtableView();

    await screen.findByText('The roundtable converged on a single hinge.');
    const payload = JSON.parse((window as AutomationTextWindow).render_game_to_text?.() ?? '{}');
    expect(payload.page.controls.transcript_layout.turn_count).toBeGreaterThanOrEqual(1);
    expect(payload.page.controls.transcript_layout.draft_count).toBeGreaterThanOrEqual(1);
    expect(payload.page.controls.transcript_layout.max_draft_lines).toBeGreaterThan(1);
    expect(payload.page.controls.transcript_layout.max_draft_min_height_px).toBeGreaterThan(0);
    expect(payload.page.controls.current_speaker_turn_key).toBe('draft-1');
    expect(payload.page.controls.current_speaker_participant_id).toBe('rep-a');
    expect(payload.page.controls.stream_state).toBe('turn_delta');
    expect(payload.page.controls.pending_drafts).toEqual([
      {
        turn_key: 'draft-1',
        participant_id: 'rep-a',
        phase: 'verdict',
        variant: 'stream',
        content_length: '请继续沿着这张圆桌追问：为什么这条世界线会把短期军令当成长期秩序，并要求档案官替所有后续成本收口？'.length,
      },
    ]);
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
      phase_insights: [],
    } as EndingRoomResult;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: [],
      },
    } as Record<string, EndingRoomThreadSnapshot>;
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

    await screen.findByRole('button', { name: 'Keep asking' });
    await user.click(screen.getByRole('button', { name: 'Keep asking' }));
    await user.click(screen.getByRole('button', { name: 'New topic from here' }));
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
    } as EndingRoomResult;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as Record<string, EndingRoomThreadSnapshot>;
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

    await user.click(quoteBubbleScope.getByRole('button', { name: 'Follow up on this' }));
    expect(setComposerDraftMock).toHaveBeenCalledWith('Representative A said "Existing live roundtable." — can you expand on that?');

    await user.click(quoteBubbleScope.getByRole('button', { name: 'New topic' }));
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith('room-1', {
      title: 'Representative A',
      questionAnchorIds: ['roundtable:quote:thread-room:turn-1'],
      interactionMode: 'thread_followup',
    }));
  });

  it('lets a representative quote pivot directly into hotseat follow-up', async () => {
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
    } as EndingRoomResult;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as Record<string, EndingRoomThreadSnapshot>;
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

    await user.click(quoteBubbleScope.getByRole('button', { name: 'Question this rep' }));

    expect(setInteractionModeMock).toHaveBeenCalledWith('hotseat');
    expect(setComposerDraftMock).toHaveBeenCalledWith('Representative A said "Existing live roundtable." — can you expand on that?');
  });

  it('launches expert_witness with an extra witness selection', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    await user.click(await screen.findByRole('button', { name: 'Invite expert' }));
    expect(screen.getByTestId('roundtable-seat-slot-witness')).toBeInTheDocument();
    const witnessStand = screen.getByRole('heading', { name: 'Expert seat' }).closest('section');
    expect(witnessStand).not.toBeNull();
    await user.click(within(witnessStand as HTMLElement).getByRole('button', { name: /Witness A/ }));
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'expert_witness',
      discussionFormat: 'deep_dive',
      castMode: 'custom',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    });
  });

  it('uses trait_mix to auto-pick a more contrasted cast', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    await user.click(await screen.findByRole('button', { name: 'Clash mix' }));
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'trait_mix',
      discussionFormat: 'clash_mode',
      castMode: 'smart_pick',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a2' },
        { branchId: 'branch-b', agentId: 'agent-b2' },
      ],
      selectedWitness: null,
    });
  });

  it('uses fault_line_first to auto-shortlist the strongest split', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    await user.click(await screen.findByRole('button', { name: 'Biggest split first' }));
    expect(screen.getByText('2 / 3 worldlines selected')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'fault_line_first',
      discussionFormat: 'clash_mode',
      castMode: 'smart_pick',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: null,
    });
  });

  it('uses witness_augmented to auto-attach a witness without manual picking', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    await user.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    expect(screen.getByRole('heading', { name: 'Extra expert seat' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'witness_augmented',
      discussionFormat: 'deep_dive',
      castMode: 'custom',
      language: 'en',
      selectedRepresentatives: [
        { branchId: 'branch-a', agentId: 'agent-a' },
        { branchId: 'branch-b', agentId: 'agent-b' },
      ],
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    });
  });

  it('keeps the latest witness mode when switching between expert_witness and witness_augmented before launch', async () => {
    storeState.snapshot = null;
    storeState.result = null;
    storeState.threadsById = {};
    storeState.threadOrder = [];
    storeState.activeThreadId = null;
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
    await user.click(await screen.findByRole('button', { name: 'Invite expert' }));
    await user.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await user.click(await screen.findByRole('button', { name: 'Open this lineup' }));

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
      selectionRecipe: 'witness_augmented',
      selectedWitness: { branchId: 'branch-a', agentId: 'agent-c' },
    }));
  });

  it('allows reseating representatives after a live table is already open', async () => {
    storeState.snapshot = {
      ...storeState.snapshot,
      id: 'room-live',
      discussion_format: 'clash_mode',
      cast_mode: 'smart_pick',
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'Existing live summary.',
      archivist_note: 'Current table summary.',
    } as EndingRoomResult;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as Record<string, EndingRoomThreadSnapshot>;
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

    // Open the action menu dropdown first
    const menuTrigger = await screen.findByRole('button', { name: 'More actions' });
    await user.click(menuTrigger);
    const reseatBtn = await screen.findByRole('button', { name: 'Reseat & restart' });
    await user.click(reseatBtn);
    expect(await screen.findByText('Reopen this lineup')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Representative C/ }));
    await user.click(screen.getAllByRole('button', { name: 'Reopen this lineup' })[0]);

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'representative',
      discussionFormat: 'clash_mode',
      castMode: 'smart_pick',
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
    const replaySnapshot: EndingRoomSnapshot = {
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
      question_anchor_ids_json: ['roundtable:verdict:room-1'],
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

    expect(await screen.findByText('This stays inside Representative A.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(setInteractionModeMock).toHaveBeenCalledWith('hotseat');
    expect(screen.getAllByText('Using the active roundtable thread only').length).toBeGreaterThan(0);
    const threadRail = screen.getByRole('tablist', { name: 'Topics' });
    expect(within(threadRail).getByText('Discussion result')).toBeInTheDocument();
    expect(screen.getByText((_, node) => node?.textContent === 'Discussion resultDiscussion result')).toBeInTheDocument();

    // Open the action menu to access Save copy / Import run
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Save copy' }));
    // Re-open menu to check saved state
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Copy saved' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import run' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('shows a localized import error instead of a raw ApiError.message when import replay fails', async () => {
    const replaySnapshot: EndingRoomSnapshot = {
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

    // ApiError is an Error subclass carrying a `.code`; the pre-fix catch stored
    // `nextError.message` (raw `API 400 ...`) directly into the UI. The fix routes
    // it through getLocalizedApiErrorMessage, which maps/falls back to localized copy.
    const apiError = Object.assign(
      new Error('API 400 IMPORT_BROKEN: raw backend detail leaked to user'),
      { code: 'IMPORT_BROKEN', status: 400 },
    );
    importReplayScenarioMock.mockRejectedValueOnce(apiError);

    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/roundtable/replay?local=replay-1']}>
        <Routes>
          <Route path="/roundtable/replay" element={<WorldlineRoundtableView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('The first hinge was delayed too long.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Import run' }));

    // Localized fallback is shown; navigation did not occur.
    expect(await screen.findByText('Failed to import roundtable replay')).toBeInTheDocument();
    expect(screen.queryByText('sim-import-destination')).not.toBeInTheDocument();
    // The raw ApiError.message must never reach the UI.
    expect(
      screen.queryByText((_, node) => Boolean(node?.textContent?.includes('IMPORT_BROKEN'))),
    ).toBeNull();
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

    // Open the action menu to access Copy replay
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Copy replay' }));

    await waitFor(() => {
      expect(saveOracleReplayLocalCopyMock).toHaveBeenCalledTimes(1);
      expect(copyTextMock).toHaveBeenCalledWith('http://localhost:3000/roundtable/replay?roomLocal=local-roundtable-copy');
    });
    // Re-open menu to check saved state
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Copy saved' })).toBeInTheDocument();
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
    } as EndingRoomSnapshot;
    storeState.result = {
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'Summary-only crossline scope held.',
      phase_insights: [],
    } as EndingRoomResult;
    storeState.threadsById = {
      'thread-room': {
        ...storeState.snapshot.threads[0],
        room_type: 'worldline_roundtable',
        room_title: 'Worldline Roundtable',
        room_status: 'done',
        language: 'en',
        turns: storeState.snapshot.turns,
      },
    } as Record<string, EndingRoomThreadSnapshot>;
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

    // Open the action menu to access Reseat & restart
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Reseat & restart' }));
    expect(screen.getByText('Reseat each worldline representative')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Reopen this lineup' })[0]);

    expect(openRoomMock).toHaveBeenCalledWith('scenario-1', {
      roomType: 'worldline_roundtable',
      selectedBranchIds: ['branch-a', 'branch-b'],
      selectionRecipe: 'representative',
      discussionFormat: 'deep_dive',
      castMode: 'smart_pick',
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

  it('collapses and expands long transcript monologues in the live table', async () => {
    const user = userEvent.setup();
    const longTurn = '圆桌记录反复回到同一个调度失误：先把边防资源挪空，再让财政用短账补洞，最后再把这一连串误差包装成必然代价，于是每个分支都开始为同一套失血逻辑找借口。'.repeat(4);
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        {
          id: 'turn-long',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 1,
          phase: 'verdict',
          participant_id: 'rep-a',
          content: longTurn,
          emotion: 'focused',
          created_at: '2026-03-29T00:00:00Z',
        },
      ],
    } as EndingRoomSnapshot;
    storeState.result = baseState.result;
    storeState.threadsById = {
      'thread-room': {
        ...baseState.threadsById['thread-room'],
        turns: storeState.snapshot.turns,
      },
    } as Record<string, EndingRoomThreadSnapshot>;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.pendingDrafts = {};
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

    const turnText = await screen.findByText(longTurn);
    expect(turnText).toHaveClass('worldline-roundtable-transcript-copy', 'is-collapsed');
    const collapsedPayload = JSON.parse((window as AutomationTextWindow).render_game_to_text?.() ?? '{}');
    expect(collapsedPayload.page.controls.transcript_layout.collapsible_turn_count).toBeGreaterThanOrEqual(1);
    expect(collapsedPayload.page.controls.transcript_layout.collapsed_turn_count).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole('button', { name: 'Show full text' }));
    expect(turnText).not.toHaveClass('is-collapsed');
    const expandedPayload = JSON.parse((window as AutomationTextWindow).render_game_to_text?.() ?? '{}');
    expect(expandedPayload.page.controls.transcript_layout.collapsed_turn_count).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(turnText).toHaveClass('is-collapsed');
  });
});

describe('WorldlineRoundtableView synthesis section', () => {
  const setupFullMocks = () => {
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
        { id: 'branch-a', title: 'Archive A', probability: 0.6, status: 'COMPLETED', story: 'Story A', insight: 'Insight A', key_moments: ['A'], parent_branch_id: null, fork_reason: '' },
        { id: 'branch-b', title: 'Archive B', probability: 0.4, status: 'COMPLETED', story: 'Story B', insight: 'Insight B', key_moments: ['B'], parent_branch_id: null, fork_reason: '' },
      ],
    });
    getAgentsMock.mockResolvedValue([]);
  };

  it('renders verdict summary in the main area above transcript', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = {
      summary: 'Synthesis verdict text here',
      next_move: 'Consider the second hinge',
      archivist_note: 'Archivist note for context',
      phase_insights: [],
    } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    setupFullMocks();

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for shell to render (sidebar has the same summary text)
    await screen.findByText('The first hinge was delayed too long.');
    const synthesisSection = document.querySelector('.worldline-roundtable-synthesis');
    expect(synthesisSection).toBeTruthy();
    expect(synthesisSection!.querySelector('.worldline-roundtable-synthesis__title')!.textContent)
      .toBe('Synthesis verdict text here');
    expect(screen.getByText('Consider the second hinge')).toBeInTheDocument();
    expect(screen.getAllByText('Archivist note for context').length).toBeGreaterThanOrEqual(1);
  });

  it('hides synthesis section when result has no summary', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = { summary: '', phase_insights: [] } as EndingRoomResult;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    setupFullMocks();

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('The first hinge was delayed too long.');
    expect(document.querySelector('.worldline-roundtable-synthesis')).toBeNull();
  });
});

describe('WorldlineRoundtableView phase nav', () => {
  it('renders phase pills when transcript has multiple phases and scrolls on click', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        { id: 'turn-open', room_id: 'room-1', thread_id: 'thread-room', sequence: 1, phase: 'opening', participant_id: 'rep-a', content: 'Opening remark.', emotion: 'focused', created_at: '2026-03-29T00:00:00Z' },
        { id: 'turn-cross', room_id: 'room-1', thread_id: 'thread-room', sequence: 2, phase: 'crossfire', participant_id: 'rep-a', content: 'Crossfire point.', emotion: 'focused', created_at: '2026-03-29T00:00:01Z' },
        { id: 'turn-verdict', room_id: 'room-1', thread_id: 'thread-room', sequence: 3, phase: 'verdict', participant_id: 'archivist', content: 'Final verdict.', emotion: 'calm', created_at: '2026-03-29T00:00:02Z' },
      ],
    } as EndingRoomSnapshot;
    storeState.result = baseState.result;
    storeState.threadsById = {
      'thread-room': { ...baseState.threadsById['thread-room'], turns: storeState.snapshot.turns },
    } as Record<string, EndingRoomThreadSnapshot>;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Opening remark.');
    const nav = document.querySelector('.roundtable-phase-nav');
    expect(nav).toBeTruthy();
    const pills = nav!.querySelectorAll('.roundtable-phase-nav__pill');
    expect(pills.length).toBe(4); // 3 phase pills + 1 "Deep Dive" explore pill

    // Verify pill labels — phases go through getEndingRoomPhaseLabel → i18n mock keys
    const labels = [...pills].map((pill) => pill.textContent);
    expect(labels.length).toBe(4);
    expect(labels.every((l) => l && l.length > 0)).toBe(true);
  });

  it('hides phase nav when only one phase exists', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = baseState.result;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('The first hinge was delayed too long.');
    // Phase nav renders when verdict exists (for Deep Dive), but no phase pills when only 1 phase
    const nav = document.querySelector('.roundtable-phase-nav');
    const phasePills = nav?.querySelectorAll('.roundtable-phase-nav__pill:not(.is-explore)') ?? [];
    expect(phasePills.length).toBe(0);
  });

  it('calls scrollIntoView on the target phase divider when a pill is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        { id: 'turn-open', room_id: 'room-1', thread_id: 'thread-room', sequence: 1, phase: 'opening', participant_id: 'rep-a', content: 'Opening.', emotion: 'focused', created_at: '2026-03-29T00:00:00Z' },
        { id: 'turn-cross', room_id: 'room-1', thread_id: 'thread-room', sequence: 2, phase: 'crossfire', participant_id: 'rep-a', content: 'Crossfire.', emotion: 'focused', created_at: '2026-03-29T00:00:01Z' },
      ],
    } as EndingRoomSnapshot;
    storeState.result = baseState.result;
    storeState.threadsById = { 'thread-room': { ...baseState.threadsById['thread-room'], turns: storeState.snapshot.turns } } as Record<string, EndingRoomThreadSnapshot>;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Opening.');
    const pills = document.querySelectorAll('.roundtable-phase-nav__pill');
    expect(pills.length).toBe(3); // 2 phase pills + 1 "Deep Dive" explore pill

    // Mock scrollIntoView on the target divider
    const divider = document.querySelector('[id^="phase-"]');
    expect(divider).toBeTruthy();
    const scrollSpy = vi.fn();
    divider!.scrollIntoView = scrollSpy;

    await user.click(pills[0]);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('uses auto scroll behavior when reduced motion is preferred', async () => {
    const user = userEvent.setup({ delay: null });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });

    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        { id: 'turn-open', room_id: 'room-1', thread_id: 'thread-room', sequence: 1, phase: 'opening', participant_id: 'rep-a', content: 'Opening.', emotion: 'focused', created_at: '2026-03-29T00:00:00Z' },
        { id: 'turn-cross', room_id: 'room-1', thread_id: 'thread-room', sequence: 2, phase: 'crossfire', participant_id: 'rep-a', content: 'Crossfire.', emotion: 'focused', created_at: '2026-03-29T00:00:01Z' },
      ],
    } as EndingRoomSnapshot;
    storeState.result = baseState.result;
    storeState.threadsById = { 'thread-room': { ...baseState.threadsById['thread-room'], turns: storeState.snapshot.turns } } as Record<string, EndingRoomThreadSnapshot>;
    storeState.threadOrder = ['thread-room'];
    storeState.activeThreadId = 'thread-room';
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Opening.');
    const divider = document.querySelector('[id^="phase-"]');
    expect(divider).toBeTruthy();
    const scrollSpy = vi.fn();
    divider!.scrollIntoView = scrollSpy;

    const pills = document.querySelectorAll('.roundtable-phase-nav__pill');
    expect(pills.length).toBe(3); // 2 phase pills + 1 "Deep Dive" explore pill
    await user.click(pills[0]);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });

    // Open the action menu to access Reseat & restart
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Reseat & restart' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });
});

describe('WorldlineRoundtableView post-verdict panel', () => {
  it('switches between analyst and survey tabs and streams SSE-backed results', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        ...baseState.snapshot!.turns,
        {
          id: 'turn-2',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 2,
          phase: 'crossfire',
          participant_id: 'rep-a',
          content: 'A sharper disagreement surfaces in crossfire.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:02Z',
        },
      ],
    } as EndingRoomSnapshot;
    storeState.threadsById = {
      ...baseState.threadsById,
      'thread-room': {
        ...baseState.threadsById['thread-room'],
        turns: storeState.snapshot!.turns,
      },
    };
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);
    getCapabilitiesMock.mockResolvedValue({
      factions: { enabled: false },
      agent_conversation: { enabled: false },
      roundtable_analyst: { enabled: true },
      roundtable_survey: { enabled: true },
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/analyst')) {
        return Promise.resolve(makeSseResponse([
          'event: analyst_thinking\ndata: {"action":"query_causal_graph"\ndata: ,"params":{"query":"hinge"},"iteration":1}\n\n',
          'event: analyst_tool_result\ndata: {"action":"query_causal_graph","summary":"The graph tightens around the hinge.","iteration":1,"elapsed_ms":45}\n\n',
          'event: analyst_response\ndata: {"answer":"The hinge still decides the fork."\ndata: ,"iterations":1,"stopped_reason":"final_response"}\n\n',
        ]));
      }
      if (url.endsWith('/survey')) {
        return Promise.resolve(makeSseResponse([
          'event: survey_response\ndata: {"participant_id":"rep-a","display_name":"Representative A"\ndata: ,"role":"representative","source_agent_id":"agent-a","source_branch_id":"branch-a","agent_identity_id":null,"answer":"Hold the hinge.","elapsed_ms":30}\n\n',
          'event: survey_response\ndata: {"participant_id":"archivist","display_name":"Archivist","role":"archivist","source_agent_id":null,"source_branch_id":null,"agent_identity_id":null,"answer":"Archive the split.","elapsed_ms":55}\n\n',
        ]));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');

    await user.click(screen.getByRole('button', { name: 'Deep Dive' }));

    const analystTab = await screen.findByRole('tab', { name: /Research Analyst/i });
    const surveyTab = await screen.findByRole('tab', { name: /Cross-Examine/i });
    await waitFor(() => {
      expect(analystTab).toBeEnabled();
      expect(surveyTab).toBeEnabled();
    });

    await user.click(analystTab);
    await waitFor(() => {
      expect(analystTab).toHaveAttribute('aria-selected', 'true');
      expect(document.getElementById('pvp-panel-analyst')).toHaveAttribute('aria-hidden', 'false');
    });
    const analystView = await screen.findByTestId('analyst-stream-view');
    const analystTextarea = within(analystView).getByPlaceholderText('roundtable.analyst_placeholder');
    await user.type(analystTextarea, 'What is the hinge?');
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_ask' }));

    await screen.findByText('The hinge still decides the fork.');
    expect(screen.getByText('The graph tightens around the hinge.')).toBeInTheDocument();

    await user.click(surveyTab);
    await waitFor(() => {
      expect(surveyTab).toHaveAttribute('aria-selected', 'true');
      expect(document.getElementById('pvp-panel-survey')).toHaveAttribute('aria-hidden', 'false');
    });
    const surveyView = await screen.findByTestId('survey-stream-view');
    const surveyTextarea = within(surveyView).getByPlaceholderText('roundtable.survey_placeholder');
    await user.type(surveyTextarea, 'What should each side do?');
    await user.click(screen.getByRole('button', { name: 'roundtable.survey_ask' }));

    await screen.findByText('Hold the hinge.');
    await screen.findByText('Archive the split.');

    await user.click(analystTab);
    expect(screen.getByText('The hinge still decides the fork.')).toBeInTheDocument();
    expect(document.getElementById('pvp-panel-survey')).toHaveAttribute('aria-hidden', 'true');
  });

  it('parses a trailing analyst response frame without a terminal blank line', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot as EndingRoomSnapshot;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'Q',
      status: 'done',
      scene_theme: 'court',
      agents: [],
      language: 'en',
      messages: [],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'Q',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'A',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'S',
          insight: 'I',
          key_moments: [],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-b',
          title: 'B',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'S2',
          insight: 'I2',
          key_moments: [],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    });
    getAgentsMock.mockResolvedValue([]);
    getCapabilitiesMock.mockResolvedValue({
      factions: { enabled: false },
      agent_conversation: { enabled: false },
      roundtable_analyst: { enabled: true },
      roundtable_survey: { enabled: false },
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/analyst')) {
        return Promise.resolve(makeSseResponse([
          'event: analyst_response\ndata: {"answer":"Trailing frame answer.","iterations":1,"stopped_reason":"final_response"}',
        ]));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');
    await user.click(screen.getByRole('button', { name: 'Deep Dive' }));

    const analystTab = await screen.findByRole('tab', { name: /Research Analyst/i });
    await user.click(analystTab);

    const analystView = await screen.findByTestId('analyst-stream-view');
    const analystTextarea = within(analystView).getByPlaceholderText('roundtable.analyst_placeholder');
    await user.type(analystTextarea, 'Need the trailing frame');
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_ask' }));

    await screen.findByText('Trailing frame answer.');
  });

  it('resets analyst cache when the result object changes even if summary text stays the same', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot,
      turns: [
        ...baseState.snapshot!.turns,
        {
          id: 'turn-2',
          room_id: 'room-1',
          thread_id: 'thread-room',
          sequence: 2,
          phase: 'crossfire',
          participant_id: 'rep-a',
          content: 'A sharper disagreement surfaces in crossfire.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:02Z',
        },
      ],
    } as EndingRoomSnapshot;
    storeState.threadsById = {
      ...baseState.threadsById,
      'thread-room': {
        ...baseState.threadsById['thread-room'],
        turns: storeState.snapshot!.turns,
      },
    };
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);
    getCapabilitiesMock.mockResolvedValue({
      factions: { enabled: false },
      agent_conversation: { enabled: false },
      roundtable_analyst: { enabled: true },
      roundtable_survey: { enabled: false },
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/analyst')) {
        return Promise.resolve(makeSseResponse([
          'event: analyst_response\ndata: {"answer":"Cached analyst answer.","iterations":1,"stopped_reason":"final_response"}\n\n',
        ]));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    const view = renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');

    await user.click(screen.getByRole('button', { name: 'Deep Dive' }));
    const analystTab = await screen.findByRole('tab', { name: /Research Analyst/i });
    await waitFor(() => expect(analystTab).toBeEnabled());
    await user.click(analystTab);

    await waitFor(() => {
      expect(analystTab).toHaveAttribute('aria-selected', 'true');
      expect(document.getElementById('pvp-panel-analyst')).toHaveAttribute('aria-hidden', 'false');
    });
    const analystView = await screen.findByTestId('analyst-stream-view');
    const analystTextarea = within(analystView).getByPlaceholderText('roundtable.analyst_placeholder');
    await user.type(analystTextarea, 'Why did it fork?');
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_ask' }));
    await screen.findByText('Cached analyst answer.');

    storeState.result = {
      ...storeState.result!,
      summary: 'The roundtable converged on a single hinge.',
      archivist_note: 'A new archivist note arrived after reseating.',
      phase_insights: [
        {
          phase: 'verdict',
          stakes: 'Re-evaluate the hinge.',
          moderator_focus: 'Re-open the evidence.',
          commentary: 'Same summary, different supporting context.',
        },
      ],
    } as EndingRoomResult;

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Cached analyst answer.')).toBeNull();
    });
    expect(screen.getByPlaceholderText('roundtable.analyst_placeholder')).toBeInTheDocument();
  });

  it('aborts an in-flight analyst stream when the result context changes', async () => {
    const user = userEvent.setup();
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot as EndingRoomSnapshot;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({
      id: 'scenario-1',
      question: 'Q',
      status: 'done',
      scene_theme: 'court',
      agents: [],
      language: 'en',
      messages: [],
    });
    getStoryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      question: 'Q',
      status: 'done',
      branches: [
        {
          id: 'branch-a',
          title: 'A',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'S',
          insight: 'I',
          key_moments: [],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-b',
          title: 'B',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'S2',
          insight: 'I2',
          key_moments: [],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    });
    getAgentsMock.mockResolvedValue([]);
    getCapabilitiesMock.mockResolvedValue({
      factions: { enabled: false },
      agent_conversation: { enabled: false },
      roundtable_analyst: { enabled: true },
      roundtable_survey: { enabled: false },
    });

    let analystSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/analyst')) {
        analystSignal = init?.signal ?? undefined;
        return Promise.resolve(new Response(
          new ReadableStream<Uint8Array>({
            start() {
              init?.signal?.addEventListener('abort', () => {
                /* keep the stream pending until abort */
              });
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        ));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    const view = renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');
    await user.click(screen.getByRole('button', { name: 'Deep Dive' }));

    const analystTab = await screen.findByRole('tab', { name: /Research Analyst/i });
    await user.click(analystTab);

    const analystView = await screen.findByTestId('analyst-stream-view');
    const analystTextarea = within(analystView).getByPlaceholderText('roundtable.analyst_placeholder');
    await user.type(analystTextarea, 'Keep streaming');
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_ask' }));

    await waitFor(() => {
      expect(analystSignal).toBeDefined();
      expect(screen.getByRole('button', { name: 'roundtable.analyst_stop' })).toBeInTheDocument();
    });

    storeState.result = {
      ...storeState.result!,
      archivist_note: 'Changed context while analyst stream was active.',
    } as EndingRoomResult;

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(analystSignal?.aborted).toBe(true);
    });
  });
});

describe('WorldlineRoundtableView mobile roster modal', () => {
  it('renders a mobile roster trigger button and opens the modal on click', async () => {
    const user = userEvent.setup({ delay: null });
    const baseState = createBaseStoreState();
    storeState.snapshot = {
      ...baseState.snapshot!,
      participants: [
        ...baseState.snapshot!.participants,
        {
          id: 'witness-1',
          room_id: 'room-1',
          role_slot: 'critic',
          display_name: 'Witness A',
          source_branch_id: 'branch-b',
          source_agent_id: 'agent-b',
        },
      ],
    };
    storeState.result = baseState.result;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('The first hinge was delayed too long.');

    // Trigger button exists (hidden via CSS on desktop, but present in DOM)
    const trigger = document.querySelector('.roundtable-mobile-roster-trigger');
    expect(trigger).toBeTruthy();
    // Count should match participants (including archivist), not just representatives
    expect(trigger!.textContent).toContain('3 participant');
    expect(trigger!.getAttribute('aria-controls')).toBe('mobile-roster-dialog');

    // Modal initially hidden
    expect(document.querySelector('.roundtable-mobile-roster-overlay')).toBeNull();

    // Trigger has aria-expanded="false" before open
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');

    // Click opens modal
    await user.click(trigger as HTMLElement);
    const modal = document.querySelector('.roundtable-mobile-roster-modal');
    expect(modal).toBeTruthy();
    expect(modal!.textContent).toContain('Representative A');
    expect(modal!.textContent).toContain('Expert');

    // Dialog semantics
    expect(modal!.getAttribute('role')).toBe('dialog');
    expect(modal!.getAttribute('aria-modal')).toBe('true');
    expect(modal!.getAttribute('aria-labelledby')).toBe('mobile-roster-title');
    expect(modal!.getAttribute('id')).toBe('mobile-roster-dialog');
    expect(document.getElementById('mobile-roster-title')!.textContent).toBe('Participants');

    // Trigger aria-expanded="true" while open
    expect(trigger!.getAttribute('aria-expanded')).toBe('true');

    // Escape closes modal
    await user.keyboard('{Escape}');
    expect(document.querySelector('.roundtable-mobile-roster-overlay')).toBeNull();
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('WorldlineRoundtableView new message pill', () => {
  it('stays quiet when the transcript is pinned to the bottom', async () => {
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    const view = renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const transcriptList = view.container.querySelector('.worldline-roundtable-transcript-list') as HTMLDivElement | null;
    expect(transcriptList).toBeTruthy();
    setTranscriptScrollMetrics(transcriptList!, {
      scrollHeight: 640,
      clientHeight: 320,
      scrollTop: 320,
    });
    fireEvent.scroll(transcriptList!);

    const nextTurn: EndingRoomSnapshot['turns'][number] = {
      id: 'turn-2',
      room_id: 'room-1',
      thread_id: 'thread-room',
      sequence: 2,
      phase: 'crossfire',
      participant_id: 'rep-a',
      content: 'A committed follow-up lands while the reader stays at the bottom.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:02Z',
    };
    storeState.snapshot = {
      ...storeState.snapshot!,
      turns: [...storeState.snapshot!.turns, nextTurn],
    };
    storeState.threadsById = {
      ...storeState.threadsById,
      'thread-room': {
        ...storeState.threadsById['thread-room'],
        turns: [...storeState.threadsById['thread-room'].turns, nextTurn],
      },
    };

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('A committed follow-up lands while the reader stays at the bottom.');
    expect(screen.queryByRole('button', { name: '1 new messages' })).toBeNull();
  });

  it('resets unread baseline when switching threads', async () => {
    const baselineTurn: EndingRoomSnapshot['turns'][number] = {
      id: 'turn-1b',
      room_id: 'room-1',
      thread_id: 'thread-room',
      sequence: 2,
      phase: 'crossfire',
      participant_id: 'rep-a',
      content: 'Baseline activity keeps the room thread warm.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:01Z',
    };
    storeState.snapshot = {
      ...storeState.snapshot!,
      turns: [...storeState.snapshot!.turns, baselineTurn],
    };
    storeState.threadsById = {
      ...storeState.threadsById,
      'thread-room': {
        ...storeState.threadsById['thread-room'],
        turns: [...storeState.threadsById['thread-room'].turns, baselineTurn],
      },
    };
    const alternateThread: EndingRoomThreadSnapshot = {
      id: 'thread-followup',
      room_id: 'room-1',
      title: 'Follow-up Thread',
      mode: 'followup',
      interaction_mode: 'archivist_route',
      participant_set_hash: 'hash-followup',
      memory_partition_id: 'partition-followup',
      room_type: 'worldline_roundtable',
      room_title: 'Worldline Roundtable',
      room_status: 'done',
      language: 'en',
      turns: [
        {
          id: 'turn-followup-1',
          room_id: 'room-1',
          thread_id: 'thread-followup',
          sequence: 1,
          phase: 'verdict',
          participant_id: 'archivist',
          content: 'A new follow-up thread begins cleanly.',
          emotion: 'calm',
          created_at: '2026-03-29T00:00:03Z',
        },
      ],
      created_at: '2026-03-29T00:00:02Z',
      updated_at: '2026-03-29T00:00:03Z',
    };
    storeState.snapshot = {
      ...storeState.snapshot!,
      threads: [...storeState.snapshot!.threads, {
        id: 'thread-followup',
        room_id: 'room-1',
        title: 'Follow-up Thread',
        mode: 'followup',
        interaction_mode: 'archivist_route',
        participant_set_hash: 'hash-followup',
        memory_partition_id: 'partition-followup',
        created_at: '2026-03-29T00:00:02Z',
        updated_at: '2026-03-29T00:00:03Z',
      }],
    };
    storeState.threadsById = {
      ...storeState.threadsById,
      'thread-followup': alternateThread,
    };
    storeState.threadOrder = ['thread-room', 'thread-followup'];
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    const view = renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    storeState.activeThreadId = 'thread-followup';
    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('A new follow-up thread begins cleanly.');

    const followupTurn: EndingRoomSnapshot['turns'][number] = {
      id: 'turn-followup-2',
      room_id: 'room-1',
      thread_id: 'thread-followup',
      sequence: 2,
      phase: 'verdict',
      participant_id: 'archivist',
      content: 'Unread state should start clean in the switched thread.',
      emotion: 'calm',
      created_at: '2026-03-29T00:00:04Z',
    };
    storeState.threadsById = {
      ...storeState.threadsById,
      'thread-followup': {
        ...storeState.threadsById['thread-followup'],
        turns: [...storeState.threadsById['thread-followup'].turns, followupTurn],
      },
    };

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Unread state should start clean in the switched thread.');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 new messages' })).toBeInTheDocument();
    });
  });

  it('resets unread baseline when switching rooms', async () => {
    const baselineTurn: EndingRoomSnapshot['turns'][number] = {
      id: 'turn-1b',
      room_id: 'room-1',
      thread_id: 'thread-room',
      sequence: 2,
      phase: 'crossfire',
      participant_id: 'rep-a',
      content: 'Baseline room activity keeps unread tracking primed.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:01Z',
    };
    storeState.snapshot = {
      ...storeState.snapshot!,
      turns: [...storeState.snapshot!.turns, baselineTurn],
    };
    storeState.threadsById = {
      ...storeState.threadsById,
      'thread-room': {
        ...storeState.threadsById['thread-room'],
        turns: [...storeState.threadsById['thread-room'].turns, baselineTurn],
      },
    };
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    const view = renderRoundtableView();
    await screen.findByText('The first hinge was delayed too long.');

    storeState.snapshot = {
      ...storeState.snapshot!,
      id: 'room-2',
      scenario_id: 'scenario-2',
      threads: [
        {
          id: 'thread-room-2',
          room_id: 'room-2',
          title: 'Main Desk',
          mode: 'room',
          interaction_mode: 'auto_recap',
          participant_set_hash: 'hash-room-2',
          memory_partition_id: 'room-partition-2',
          created_at: '2026-03-29T00:00:04Z',
          updated_at: '2026-03-29T00:00:05Z',
        },
      ],
      turns: [
        {
          id: 'turn-room-2',
          room_id: 'room-2',
          thread_id: 'thread-room-2',
          sequence: 1,
          phase: 'opening',
          participant_id: 'rep-a',
          content: 'A fresh room starts without stale unread state.',
          emotion: 'focused',
          created_at: '2026-03-29T00:00:05Z',
        },
      ],
    };
    storeState.threadsById = {
      'thread-room-2': {
        ...storeState.threadsById['thread-room'],
        id: 'thread-room-2',
        room_id: 'room-2',
        participant_set_hash: 'hash-room-2',
        memory_partition_id: 'room-partition-2',
        turns: [
          {
            id: 'turn-room-2',
            room_id: 'room-2',
            thread_id: 'thread-room-2',
            sequence: 1,
            phase: 'opening',
            participant_id: 'rep-a',
            content: 'A fresh room starts without stale unread state.',
            emotion: 'focused',
            created_at: '2026-03-29T00:00:05Z',
          },
        ],
      },
    };
    storeState.threadOrder = ['thread-room-2'];
    storeState.activeThreadId = 'thread-room-2';

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('A fresh room starts without stale unread state.');

    const roomTwoTurn: EndingRoomSnapshot['turns'][number] = {
      id: 'turn-room-2b',
      room_id: 'room-2',
      thread_id: 'thread-room-2',
      sequence: 2,
      phase: 'crossfire',
      participant_id: 'rep-a',
      content: 'Unread state should restart from one in the fresh room.',
      emotion: 'focused',
      created_at: '2026-03-29T00:00:06Z',
    };
    storeState.snapshot = {
      ...storeState.snapshot!,
      turns: [...storeState.snapshot!.turns, roomTwoTurn],
    };
    storeState.threadsById = {
      'thread-room-2': {
        ...storeState.threadsById['thread-room-2'],
        turns: [...storeState.threadsById['thread-room-2'].turns, roomTwoTurn],
      },
    };

    view.rerender(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Unread state should restart from one in the fresh room.');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 new messages' })).toBeInTheDocument();
    });
  });
});

describe('WorldlineRoundtableView tablet sidebar collapsible', () => {
  it('wraps sidebar content in a details element with a summary toggle', async () => {
    const baseState = createBaseStoreState();
    storeState.snapshot = baseState.snapshot;
    storeState.result = baseState.result;
    storeState.threadsById = baseState.threadsById;
    storeState.threadOrder = baseState.threadOrder;
    storeState.activeThreadId = baseState.activeThreadId;
    storeState.pendingDrafts = {};
    getScenarioMock.mockResolvedValue({ id: 'scenario-1', question: 'Q', status: 'done', scene_theme: 'court', agents: [], language: 'en', messages: [] });
    getStoryMock.mockResolvedValue({ scenario_id: 'scenario-1', question: 'Q', status: 'done', branches: [{ id: 'branch-a', title: 'A', probability: 0.6, status: 'COMPLETED', story: 'S', insight: 'I', key_moments: [], parent_branch_id: null, fork_reason: '' }, { id: 'branch-b', title: 'B', probability: 0.4, status: 'COMPLETED', story: 'S2', insight: 'I2', key_moments: [], parent_branch_id: null, fork_reason: '' }] });
    getAgentsMock.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/roundtable/scenario-1']}>
        <Routes>
          <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('The first hinge was delayed too long.');

    const details = document.querySelector('.worldline-roundtable-sidebar__collapsible');
    expect(details).toBeTruthy();
    expect(details!.tagName).toBe('DETAILS');

    const summary = details!.querySelector('.worldline-roundtable-sidebar__summary');
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toContain('rep');
  });
});
