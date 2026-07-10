import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  sanitizeOracleReplayPayload,
  type OracleReplayPayload,
} from './oracleReplay';
import type { ScenarioResultReplayPayload } from './scenarioReplay';

function makeScenarioReplay(): ScenarioResultReplayPayload {
  return {
    scenario: {
      id: 'scenario-1',
      question: 'What if?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      total_rounds: 1,
      mode: 'blackboard',
      visualization_enabled: false,
      scene_theme: null,
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: null,
      gameplay_state: null,
    },
    storyData: {
      scenario_id: 'scenario-1',
      question: 'What if?',
      status: 'done',
      branches: [],
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
    campaignScenarioSummary: null,
    campaignSummary: null,
    isDailyChallenge: false,
  };
}

function makeRoomPayload(
  overrides?: Partial<OracleReplayPayload>,
): OracleReplayPayload {
  return {
    kind: 'ending_room_v1',
    scenarioReplay: null,
    scenarioId: 'scenario-1',
    roomSnapshot: {
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
      memory_partition_id: 'partition-1',
      result_ready: true,
      participants: [],
      threads: [],
      turns: [],
    },
    roomResult: null,
    branchId: 'branch-1',
    selectedAgentIds: [],
    activeThreadId: null,
    ...overrides,
  };
}

describe('oracle replay urls', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('routes ending-room replay urls through the dedicated replay route', () => {
    const payload = makeRoomPayload();

    expect(buildOracleReplayShareUrl('https://example.com', payload, 'artifact-1'))
      .toBe('https://example.com/result/replay?roomShare=artifact-1');
    expect(buildOracleReplayLocalUrl('https://example.com', payload, 'local-1'))
      .toBe('https://example.com/result/replay?roomLocal=local-1');
  });

  it('keeps roundtable replay urls on the roundtable replay route', () => {
    const scenarioReplay = makeScenarioReplay();
    const payload: OracleReplayPayload = {
      kind: 'worldline_roundtable_v1' as const,
      scenarioReplay,
      scenarioId: 'scenario-1',
      roomSnapshot: {
        id: 'room-1',
        scenario_id: 'scenario-1',
        anchor_branch_id: null,
        room_type: 'worldline_roundtable',
        title: 'Roundtable',
        language: 'en',
        status: 'done',
        current_phase: 'verdict',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
        memory_partition_id: 'partition-1',
        result_ready: true,
        participants: [],
        threads: [],
        turns: [],
      },
      roomResult: null,
      branchId: null,
      selectedAgentIds: [],
      activeThreadId: null,
    };

    expect(buildOracleReplayShareUrl('https://example.com', payload, 'artifact-1'))
      .toBe('https://example.com/roundtable/replay?roomShare=artifact-1');
  });

  it('sanitizes nested scenario replay agents in inline tokens and local copies', async () => {
    const sensitiveAgent = {
      id: 'agent-1',
      name: 'Archivist',
      role: 'Private role',
      persona: 'Private persona baseline',
      tier: 'IMPORTANT' as const,
      emotion: 'calm',
      agent_identity_id: 'identity-secret',
    };
    const scenarioReplay = makeScenarioReplay();
    scenarioReplay.scenario.agents = [sensitiveAgent];
    scenarioReplay.agents = [sensitiveAgent];
    const payload = makeRoomPayload({ scenarioReplay });

    const url = await buildOracleReplayUrl('https://example.com', payload);
    const inlinePayload = await readOracleReplayPayload(new URL(url).searchParams, 'ending_room_v1');
    expect(inlinePayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(inlinePayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('persona');
    expect(inlinePayload?.scenarioReplay?.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(inlinePayload?.scenarioReplay?.agents[0]).not.toHaveProperty('persona');

    const localId = saveOracleReplayLocalCopy(payload);
    const localPayload = loadOracleReplayLocalCopy(localId, 'ending_room_v1');
    expect(localPayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(localPayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('persona');
    expect(localPayload?.scenarioReplay?.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(localPayload?.scenarioReplay?.agents[0]).not.toHaveProperty('persona');
  });

  it('keeps only render-safe room snapshot and result fields', () => {
    const payload = makeRoomPayload({
      selectedAgentIds: ['agent-private'],
      activeThreadId: 'thread-private',
      roomResult: {
        summary: 'Visible verdict',
        next_move: 'Visible next move',
        archivist_note: 'Visible note',
        phase_insights: [{
          phase: 'verdict',
          stakes: 'Visible stakes',
          moderator_focus: 'Visible focus',
          commentary: 'Visible commentary',
          insight_body: 'Visible insight',
        }],
        supporting_turns: [{
          turn_id: 'turn-private',
          phase: 'verdict',
          participant_id: 'participant-private',
          label: 'Private coordinate',
          explanation: 'Private coordinate explanation',
        }],
        scope: {
          owner_id: 'owner-private',
          memory_partition_id: 'partition-private',
        },
      },
    });
    payload.roomSnapshot.participants = [{
      id: 'participant-private',
      room_id: 'room-1',
      source_branch_id: 'branch-private',
      source_agent_id: 'agent-private',
      role_slot: 'representative',
      display_name: 'Visible representative',
      worldline_echo_key: 'echo-private',
      persona_snapshot_json: {
        agent_identity_id: 'identity-private',
        agent_persona: 'persona-private',
      },
      visibility_scope_json: { owner_id: 'owner-private' },
    }];
    payload.roomSnapshot.threads = [{
      id: 'thread-private',
      room_id: 'room-1',
      title: 'Visible thread',
      mode: 'followup',
      interaction_mode: 'hotseat',
      participant_set_hash: 'participant-set-private',
      memory_partition_id: 'partition-private',
      addressed_agent_ids_json: ['agent-private'],
      question_anchor_ids_json: ['turn-private'],
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
    }];
    payload.roomSnapshot.turns = [{
      id: 'turn-private',
      room_id: 'room-1',
      thread_id: 'thread-private',
      sequence: 1,
      phase: 'verdict',
      participant_id: 'participant-private',
      content: 'Visible replay line',
      emotion: 'calm',
      source: 'assistant_followup',
      interaction_mode: 'hotseat',
      memory_partition_id: 'partition-private',
      addressed_agent_ids_json: ['agent-private'],
      question_anchor_ids_json: ['turn-private'],
      cited_branch_id: 'branch-private',
      cited_refs_json: { owner_id: 'owner-private' },
      created_at: '2026-03-29T00:00:01Z',
    }];
    Object.assign(payload.roomSnapshot, { owner_id: 'owner-private' });

    const sanitized = sanitizeOracleReplayPayload(payload);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.roomSnapshot.title).toBe('Ending Chamber');
    expect(sanitized.roomSnapshot.participants[0]?.display_name).toBe('Visible representative');
    expect(sanitized.roomSnapshot.threads[0]?.title).toBe('Visible thread');
    expect(sanitized.roomSnapshot.turns[0]?.content).toBe('Visible replay line');
    expect(sanitized.roomResult?.summary).toBe('Visible verdict');
    expect(sanitized.roomResult?.phase_insights?.[0]?.commentary).toBe('Visible commentary');

    expect(sanitized.roomSnapshot.id).not.toBe('room-1');
    expect(sanitized.roomSnapshot.scenario_id).not.toBe('scenario-1');
    expect(sanitized.roomSnapshot).not.toHaveProperty('owner_id');
    expect(sanitized.roomSnapshot).not.toHaveProperty('memory_partition_id');
    expect(sanitized.roomSnapshot).not.toHaveProperty('memory_partition_version');
    expect(sanitized.roomSnapshot.participants[0]).not.toHaveProperty('room_id');
    expect(sanitized.roomSnapshot.participants[0]).not.toHaveProperty('source_branch_id');
    expect(sanitized.roomSnapshot.participants[0]).not.toHaveProperty('source_agent_id');
    expect(sanitized.roomSnapshot.participants[0]).not.toHaveProperty('persona_snapshot_json');
    expect(sanitized.roomSnapshot.participants[0]).not.toHaveProperty('visibility_scope_json');
    expect(sanitized.roomSnapshot.threads[0]).not.toHaveProperty('room_id');
    expect(sanitized.roomSnapshot.threads[0]).not.toHaveProperty('memory_partition_id');
    expect(sanitized.roomSnapshot.threads[0]).not.toHaveProperty('participant_set_hash');
    expect(sanitized.roomSnapshot.threads[0]).not.toHaveProperty('addressed_agent_ids_json');
    expect(sanitized.roomSnapshot.threads[0]).not.toHaveProperty('question_anchor_ids_json');
    expect(sanitized.roomSnapshot.turns[0]?.id).not.toBe('turn-private');
    expect(sanitized.roomSnapshot.turns[0]?.thread_id).not.toBe('thread-private');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('room_id');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('memory_partition_id');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('addressed_agent_ids_json');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('question_anchor_ids_json');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('cited_branch_id');
    expect(sanitized.roomSnapshot.turns[0]).not.toHaveProperty('cited_refs_json');
    expect(sanitized.roomResult).not.toHaveProperty('supporting_turns');
    expect(sanitized.roomResult).not.toHaveProperty('scope');
    expect(sanitized.selectedAgentIds).toEqual([]);
    expect(sanitized.activeThreadId).not.toBe('thread-private');
    for (const secret of [
      'owner-private',
      'partition-private',
      'participant-set-private',
      'agent-private',
      'branch-private',
      'identity-private',
      'persona-private',
      'echo-private',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('normalizes legacy room payloads into a renderable safe replay', () => {
    const legacy = makeRoomPayload();
    legacy.roomSnapshot.participants = [{
      id: 'participant-private',
      room_id: 'room-1',
      source_agent_id: 'agent-private',
      role_slot: 'representative',
      display_name: 'Visible representative',
      persona_snapshot_json: { agent_persona: 'persona-private' },
    }];
    legacy.roomSnapshot.threads = [{
      id: 'thread-private',
      room_id: 'room-1',
      title: 'Visible thread',
      mode: 'room',
      interaction_mode: 'auto_recap',
      participant_set_hash: 'participant-set-private',
      memory_partition_id: 'partition-private',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
    }];
    legacy.roomSnapshot.turns = [{
      id: 'turn-private',
      room_id: 'room-1',
      thread_id: 'thread-private',
      sequence: 1,
      phase: 'verdict',
      participant_id: 'participant-private',
      content: 'Visible replay line',
      emotion: 'calm',
      created_at: '2026-03-29T00:00:01Z',
    }];
    legacy.activeThreadId = 'thread-private';

    const normalized = normalizeOracleReplayPayload(legacy, 'ending_room_v1');

    expect(normalized?.roomSnapshot.participants[0]?.display_name).toBe('Visible representative');
    expect(normalized?.roomSnapshot.threads[0]?.title).toBe('Visible thread');
    expect(normalized?.roomSnapshot.turns[0]?.content).toBe('Visible replay line');
    expect(normalized?.roomSnapshot.turns[0]?.participant_id)
      .toBe(normalized?.roomSnapshot.participants[0]?.id);
    expect(normalized?.roomSnapshot.turns[0]?.thread_id)
      .toBe(normalized?.roomSnapshot.threads[0]?.id);
    expect(normalized?.activeThreadId).toBe(normalized?.roomSnapshot.threads[0]?.id);
    expect(JSON.stringify(normalized)).not.toContain('persona-private');
    expect(JSON.stringify(normalized)).not.toContain('agent-private');
    expect(JSON.stringify(normalized)).not.toContain('partition-private');
  });

  it('serializes an Oracle-specific scenario whitelist with consistent remapped references', () => {
    const scenarioReplay = makeScenarioReplay();
    const rootBranch = {
      id: 'branch-private-root',
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: '',
      title: 'Visible root',
      description: 'Visible root description',
      summary: 'Visible root summary',
      story: 'Visible root story',
      insight: 'Visible root insight',
      key_moments: ['Visible root moment'],
      probability: 0.4,
      status: 'COMPLETED' as const,
    };
    const childBranch = {
      id: 'branch-private-child',
      parent_branch_id: 'branch-private-root',
      fork_round: 1,
      fork_reason: 'Visible fork',
      title: 'Visible child',
      description: 'Visible child description',
      summary: 'Visible child summary',
      story: 'Visible child story',
      insight: 'Visible child insight',
      key_moments: ['Visible child moment'],
      probability: 0.6,
      status: 'COMPLETED' as const,
      replay_kind: 'counterfactual',
      replay_source_branch_id: 'branch-private-root',
    };
    const sensitiveAgent = {
      id: 'agent-private',
      name: 'Visible representative',
      role: 'Visible role',
      persona: 'persona-private',
      tier: 'IMPORTANT' as const,
      emotion: 'calm',
      group_id: 'group-private',
      agent_identity_id: 'identity-private',
    };
    scenarioReplay.scenario = {
      ...scenarioReplay.scenario,
      id: 'scenario-private',
      question: 'Visible question',
      agents: [sensitiveAgent],
      branches: [rootBranch, childBranch],
      groups: [{
        id: 'group-private',
        name: 'Visible group',
        leader_agent_id: 'agent-private',
        member_count: 1,
      }],
      hierarchical: true,
      messages: [{
        agent: 'Visible representative',
        agent_id: 'agent-private',
        message: 'Visible message already represented by the room replay',
        emotion: 'calm',
        branch: 'branch-private-child',
        round: 1,
      }],
      director_state: { owner_id: 'owner-private' } as never,
      gameplay_state: { profile_id: 'profile-private' } as never,
    };
    Object.assign(scenarioReplay.scenario, {
      user_id: 'user-private',
      internal_owner_id: 'owner-private',
    });
    scenarioReplay.storyData = {
      scenario_id: 'scenario-private',
      question: 'Visible question',
      status: 'done',
      verdict: 'Visible verdict',
      verdict_confidence: 'high',
      branches: [rootBranch, childBranch],
    };
    scenarioReplay.agents = [sensitiveAgent];
    scenarioReplay.predictions = [{
      id: 'prediction-private',
      scenario_id: 'scenario-private',
      user_name: 'user-private',
      prediction_text: 'Private prediction',
      confidence: 0.8,
      score: null,
      score_reason: null,
      created_at: '2026-03-17T00:00:00Z',
    }];
    Object.assign(scenarioReplay.scenarioMeta, {
      owner_id: 'owner-private',
      profile_id: 'profile-private',
    });
    scenarioReplay.campaignSummary = {
      profile: { user_id: 'user-private' },
      mastery: { profile_id: 'profile-private' },
    } as unknown as NonNullable<ScenarioResultReplayPayload['campaignSummary']>;
    scenarioReplay.campaignScenarioSummary = {
      profile_id: 'profile-private',
      scenario_id: 'scenario-private',
    } as unknown as NonNullable<ScenarioResultReplayPayload['campaignScenarioSummary']>;
    scenarioReplay.isDailyChallenge = true;

    const payload = makeRoomPayload({
      kind: 'worldline_roundtable_v1',
      scenarioReplay,
      scenarioId: 'scenario-private',
      branchId: 'branch-private-child',
      selectedAgentIds: ['agent-private'],
      activeThreadId: 'thread-private',
      roomResult: { summary: 'Visible verdict' },
    });
    payload.roomSnapshot.scenario_id = 'scenario-private';
    payload.roomSnapshot.anchor_branch_id = 'branch-private-child';
    payload.roomSnapshot.room_type = 'worldline_roundtable';
    payload.roomSnapshot.participants = [{
      id: 'participant-private',
      room_id: 'room-1',
      source_branch_id: 'branch-private-child',
      source_agent_id: 'agent-private',
      role_slot: 'representative',
      display_name: 'Visible representative',
      worldline_echo_key: 'agent-private',
      persona_snapshot_json: {
        agent_identity_id: 'identity-private',
        agent_persona: 'persona-private',
      },
    }];
    payload.roomSnapshot.threads = [{
      id: 'thread-private',
      room_id: 'room-1',
      title: 'Visible thread',
      mode: 'room',
      interaction_mode: 'auto_recap',
      participant_set_hash: 'participant-set-private',
      memory_partition_id: 'partition-private',
      addressed_agent_ids_json: ['participant-private'],
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
    }];
    payload.roomSnapshot.turns = [{
      id: 'turn-private',
      room_id: 'room-1',
      thread_id: 'thread-private',
      sequence: 1,
      phase: 'verdict',
      participant_id: 'participant-private',
      content: 'Visible replay line',
      emotion: 'calm',
      addressed_agent_ids_json: ['participant-private'],
      cited_branch_id: 'branch-private-child',
      created_at: '2026-03-29T00:00:01Z',
    }];

    const sanitized = sanitizeOracleReplayPayload(payload);
    const serialized = JSON.stringify(sanitized);
    const sanitizedScenario = sanitized.scenarioReplay?.scenario;
    const sanitizedStory = sanitized.scenarioReplay?.storyData;
    const sanitizedAgent = sanitized.scenarioReplay?.agents[0];
    const sanitizedRoot = sanitizedScenario?.branches[0];
    const sanitizedChild = sanitizedScenario?.branches[1];

    expect(sanitized.scenarioId).toBeNull();
    expect(sanitizedScenario?.id).toBe('oracle-replay-scenario');
    expect(sanitizedStory?.scenario_id).toBe(sanitizedScenario?.id);
    expect(sanitized.roomSnapshot.scenario_id).toBe(sanitizedScenario?.id);
    expect(sanitizedScenario?.agents[0]?.id).toBe(sanitizedAgent?.id);
    expect(sanitizedScenario?.groups[0]?.leader_agent_id).toBe(sanitizedAgent?.id);
    expect(sanitizedScenario?.agents[0]?.group_id).toBe(sanitizedScenario?.groups[0]?.id);
    expect(sanitizedChild?.parent_branch_id).toBe(sanitizedRoot?.id);
    expect(sanitizedChild?.replay_source_branch_id).toBe(sanitizedRoot?.id);
    expect(sanitizedStory?.branches.map((branch) => branch.id))
      .toEqual(sanitizedScenario?.branches.map((branch) => branch.id));
    expect(sanitizedStory?.branches[1]?.parent_branch_id).toBe(sanitizedRoot?.id);
    expect(sanitized.branchId).toBe(sanitizedChild?.id);
    expect(sanitized.roomSnapshot.anchor_branch_id).toBe(sanitizedChild?.id);
    expect(sanitized.roomSnapshot.participants[0]?.source_branch_id).toBe(sanitizedChild?.id);
    expect(sanitized.roomSnapshot.participants[0]?.source_agent_id).toBe(sanitizedAgent?.id);
    expect(sanitized.roomSnapshot.threads[0]?.addressed_agent_ids_json)
      .toEqual([sanitized.roomSnapshot.participants[0]?.id]);
    expect(sanitized.roomSnapshot.turns[0]?.addressed_agent_ids_json)
      .toEqual([sanitized.roomSnapshot.participants[0]?.id]);
    expect(sanitized.roomSnapshot.turns[0]?.cited_branch_id).toBe(sanitizedChild?.id);
    expect(sanitized.selectedAgentIds).toEqual([sanitizedAgent?.id]);
    expect(sanitized.scenarioReplay?.predictions).toEqual([]);
    expect(sanitized.scenarioReplay?.campaignSummary).toBeNull();
    expect(sanitized.scenarioReplay?.campaignScenarioSummary).toBeNull();
    expect(sanitized.scenarioReplay?.isDailyChallenge).toBe(false);
    expect(sanitizedScenario).not.toHaveProperty('messages');
    expect(sanitizedScenario).not.toHaveProperty('director_state');
    expect(sanitizedScenario).not.toHaveProperty('gameplay_state');
    for (const privateSentinel of [
      'scenario-private',
      'branch-private-root',
      'branch-private-child',
      'agent-private',
      'group-private',
      'participant-private',
      'thread-private',
      'turn-private',
      'prediction-private',
      'identity-private',
      'persona-private',
      'participant-set-private',
      'partition-private',
      'owner-private',
      'user-private',
      'profile-private',
    ]) {
      expect(serialized).not.toContain(privateSentinel);
    }
  });
});
