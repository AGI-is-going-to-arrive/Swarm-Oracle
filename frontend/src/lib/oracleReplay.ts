import type {
  AgentInfo,
  BranchInfo,
  EndingRoomParticipant,
  EndingRoomResult,
  EndingRoomSnapshot,
  EndingRoomThread,
  EndingRoomTurn,
  GroupInfo,
  Scenario,
  StoryBranch,
} from '../types';
import {
  decodeReplayEnvelope,
  encodeReplayEnvelope,
  normalizeReplayOrigin,
} from './replayCodec';
import {
  normalizeScenarioResultReplayPayload,
  type ScenarioResultReplayPayload,
  type ScenarioReplayAgentInfo,
} from './scenarioReplay';
import { createCompatUuid } from './compatUuid';

const ORACLE_REPLAY_LOCAL_STORAGE_KEY = 'swarmoracle:oracle-replay:v1';
const ORACLE_REPLAY_QUERY_KEY = 'roomReplay';
const ORACLE_REPLAY_SHARE_QUERY_KEY = 'roomShare';
const ORACLE_REPLAY_LOCAL_QUERY_KEY = 'roomLocal';
const oracleReplayMemoryCache: Record<string, OracleReplayPayload> = {};

export type OracleReplayKind = 'ending_room_v1' | 'worldline_roundtable_v1';

export interface OracleReplayPayload {
  kind: OracleReplayKind;
  scenarioReplay: ScenarioResultReplayPayload | null;
  scenarioId?: string | null;
  roomSnapshot: EndingRoomSnapshot;
  roomResult: EndingRoomResult | null;
  branchId?: string | null;
  selectedAgentIds?: string[];
  activeThreadId?: string | null;
}

function getOracleReplayStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof window === 'undefined') {
      return null;
    }
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

function buildOracleReplayPath(payload: OracleReplayPayload, queryKey: string, queryValue: string): string {
  const params = new URLSearchParams();
  params.set(queryKey, queryValue);
  if (payload.kind === 'worldline_roundtable_v1') {
    return `/roundtable/replay?${params.toString()}`;
  }
  return `/result/replay?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEndingRoomSnapshot(value: unknown): value is EndingRoomSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.scenario_id === 'string'
    && typeof value.room_type === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && typeof value.current_phase === 'string'
    && Array.isArray(value.participants)
    && Array.isArray(value.threads)
    && Array.isArray(value.turns)
  );
}

function isEndingRoomResult(value: unknown): value is EndingRoomResult | null {
  return value == null || isRecord(value);
}

const ORACLE_REPLAY_SCENARIO_ID = 'oracle-replay-scenario';

interface OracleReplayReferenceMaps {
  agentIdMap: Map<string, string>;
  branchIdMap: Map<string, string>;
  groupIdMap: Map<string, string>;
}

function createReplayIdMap(ids: string[], prefix: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    if (id && !result.has(id)) {
      result.set(id, `${prefix}-${result.size + 1}`);
    }
  }
  return result;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function finiteNumberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function branchStatusValue(value: unknown): BranchInfo['status'] {
  return value === 'ACTIVE' || value === 'PRUNED' ? value : 'COMPLETED';
}

function sanitizeOracleReplayAgent(
  value: unknown,
  maps: OracleReplayReferenceMaps,
): ScenarioReplayAgentInfo | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const id = maps.agentIdMap.get(value.id);
  if (!id) return null;
  const agent: ScenarioReplayAgentInfo = {
    id,
    name: stringValue(value.name, 'Agent'),
    role: stringValue(value.role),
    tier: value.tier === 'CORE' || value.tier === 'CROWD' ? value.tier : 'IMPORTANT',
    emotion: stringValue(value.emotion, 'neutral'),
  };
  if (typeof value.stance === 'string') agent.stance = value.stance;
  if (typeof value.group_id === 'string') {
    const groupId = maps.groupIdMap.get(value.group_id);
    if (groupId) agent.group_id = groupId;
  }
  if (typeof value.group_name === 'string') agent.group_name = value.group_name;
  if (value.source_type === 'generated' || value.source_type === 'custom' || value.source_type === 'replay') {
    agent.source_type = value.source_type;
  }
  return agent;
}

function sanitizeOracleReplayBranch(
  value: unknown,
  maps: OracleReplayReferenceMaps,
): BranchInfo | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const id = maps.branchIdMap.get(value.id);
  if (!id) return null;
  const parentId = typeof value.parent_branch_id === 'string'
    ? maps.branchIdMap.get(value.parent_branch_id) ?? null
    : null;
  const replaySourceId = typeof value.replay_source_branch_id === 'string'
    ? maps.branchIdMap.get(value.replay_source_branch_id) ?? null
    : null;
  const branch: BranchInfo = {
    id,
    parent_branch_id: parentId,
    fork_round: finiteNumberValue(value.fork_round),
    fork_reason: stringValue(value.fork_reason),
    title: stringValue(value.title, 'Branch'),
    description: stringValue(value.description),
    summary: stringValue(value.summary, stringValue(value.insight)),
    story: stringValue(value.story),
    insight: stringValue(value.insight),
    key_moments: stringArrayValue(value.key_moments),
    probability: finiteNumberValue(value.probability),
    status: branchStatusValue(value.status),
  };
  if (typeof value.replay_kind === 'string') branch.replay_kind = value.replay_kind;
  if (replaySourceId) branch.replay_source_branch_id = replaySourceId;
  return branch;
}

function storyBranchFromScenarioBranch(
  branch: BranchInfo,
  originalStoryBranch: unknown,
): StoryBranch {
  const storyRecord = isRecord(originalStoryBranch) ? originalStoryBranch : null;
  const storyBranch: StoryBranch = {
    id: branch.id,
    title: branch.title,
    probability: branch.probability,
    status: branch.status,
    story: branch.story,
    insight: branch.insight,
    key_moments: branch.key_moments,
    parent_branch_id: branch.parent_branch_id,
    fork_reason: branch.fork_reason,
  };
  if (branch.replay_kind) storyBranch.replay_kind = branch.replay_kind;
  if (branch.replay_source_branch_id) {
    storyBranch.replay_source_branch_id = branch.replay_source_branch_id;
  }
  if (typeof storyRecord?.question_answer === 'string') {
    storyBranch.question_answer = storyRecord.question_answer;
  }
  return storyBranch;
}

function createOracleReplayScenarioMeta(): ScenarioResultReplayPayload['scenarioMeta'] {
  return {
    director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
    cooldowns: {},
    cards: { usageLog: [] },
    betting: { bets: [] },
    commitment: {
      active: false,
      branchId: null,
      branchTitle: null,
      committedAtRound: null,
      committedAt: null,
      outcome: null,
    },
    objectives: { generatedForQuestion: null, generatedForProfile: null, goals: [] },
    archive: { keyMoments: [], branchSnapshots: [] },
  };
}

function sanitizeOracleScenarioReplay(
  payload: ScenarioResultReplayPayload,
): {
  payload: ScenarioResultReplayPayload;
  maps: OracleReplayReferenceMaps;
} {
  const scenario = payload.scenario;
  const scenarioAgents = Array.isArray(scenario.agents) ? scenario.agents : [];
  const replayAgents = Array.isArray(payload.agents) ? payload.agents : [];
  const agentSources = [...scenarioAgents];
  const knownAgentIds = new Set(agentSources.map((agent) => agent.id));
  for (const agent of replayAgents) {
    if (!knownAgentIds.has(agent.id)) {
      knownAgentIds.add(agent.id);
      agentSources.push(agent as AgentInfo);
    }
  }

  const scenarioBranches = Array.isArray(scenario.branches) ? scenario.branches : [];
  const storyBranches = Array.isArray(payload.storyData.branches) ? payload.storyData.branches : [];
  const branchSources: unknown[] = [...scenarioBranches];
  const knownBranchIds = new Set(
    branchSources.flatMap((branch) => (
      isRecord(branch) && typeof branch.id === 'string' ? [branch.id] : []
    )),
  );
  for (const branch of storyBranches) {
    if (!knownBranchIds.has(branch.id)) {
      knownBranchIds.add(branch.id);
      branchSources.push(branch);
    }
  }

  const groups = Array.isArray(scenario.groups) ? scenario.groups : [];
  const maps: OracleReplayReferenceMaps = {
    agentIdMap: createReplayIdMap(agentSources.map((agent) => agent.id), 'oracle-replay-agent'),
    branchIdMap: createReplayIdMap([...knownBranchIds], 'oracle-replay-branch'),
    groupIdMap: createReplayIdMap(groups.map((group) => group.id), 'oracle-replay-group'),
  };
  const sanitizedAgents = agentSources.flatMap((agent) => {
    const sanitized = sanitizeOracleReplayAgent(agent, maps);
    return sanitized ? [sanitized] : [];
  });
  const sanitizedBranches = branchSources.flatMap((branch) => {
    const sanitized = sanitizeOracleReplayBranch(branch, maps);
    return sanitized ? [sanitized] : [];
  });
  const storyBranchByOriginalId = new Map(storyBranches.map((branch) => [branch.id, branch]));
  const originalBranchIds = [...knownBranchIds];
  const sanitizedStoryBranches = sanitizedBranches.map((branch, index) => (
    storyBranchFromScenarioBranch(
      branch,
      storyBranchByOriginalId.get(originalBranchIds[index] ?? ''),
    )
  ));
  const sanitizedGroups = groups.flatMap((groupValue) => {
    if (!isRecord(groupValue) || typeof groupValue.id !== 'string') return [];
    const id = maps.groupIdMap.get(groupValue.id);
    if (!id) return [];
    const group: GroupInfo = {
      id,
      name: stringValue(groupValue.name, 'Group'),
      leader_agent_id: typeof groupValue.leader_agent_id === 'string'
        ? maps.agentIdMap.get(groupValue.leader_agent_id) ?? null
        : null,
      member_count: finiteNumberValue(groupValue.member_count),
    };
    return [group];
  });

  const sanitizedScenario: Scenario = {
    id: ORACLE_REPLAY_SCENARIO_ID,
    question: stringValue(scenario.question),
    status: scenario.status,
    created_at: stringValue(scenario.created_at),
    agents: sanitizedAgents,
    branches: sanitizedBranches,
    groups: sanitizedGroups,
    hierarchical: Boolean(scenario.hierarchical),
  };
  if (scenario.language === 'zh' || scenario.language === 'en') {
    sanitizedScenario.language = scenario.language;
  }
  if (typeof scenario.total_rounds === 'number') sanitizedScenario.total_rounds = scenario.total_rounds;
  if (scenario.mode === 'raw' || scenario.mode === 'blackboard' || scenario.mode === null) {
    sanitizedScenario.mode = scenario.mode;
  }
  if (typeof scenario.visualization_enabled === 'boolean') {
    sanitizedScenario.visualization_enabled = scenario.visualization_enabled;
  }
  if (typeof scenario.scene_theme === 'string' || scenario.scene_theme === null) {
    sanitizedScenario.scene_theme = scenario.scene_theme;
  }

  return {
    maps,
    payload: {
      scenario: sanitizedScenario,
      storyData: {
        scenario_id: ORACLE_REPLAY_SCENARIO_ID,
        question: stringValue(payload.storyData.question, sanitizedScenario.question),
        status: stringValue(payload.storyData.status, sanitizedScenario.status),
        branches: sanitizedStoryBranches,
        ...(typeof payload.storyData.verdict === 'string' || payload.storyData.verdict === null
          ? { verdict: payload.storyData.verdict }
          : {}),
        ...(payload.storyData.verdict_confidence === 'high'
          || payload.storyData.verdict_confidence === 'medium'
          || payload.storyData.verdict_confidence === 'low'
          || payload.storyData.verdict_confidence === null
          ? { verdict_confidence: payload.storyData.verdict_confidence }
          : {}),
      },
      agents: sanitizedAgents,
      predictions: [],
      scenarioMeta: createOracleReplayScenarioMeta(),
      campaignScenarioSummary: null,
      campaignSummary: null,
      isDailyChallenge: false,
    },
  };
}

function asReplayParticipant(value: Partial<EndingRoomParticipant>): EndingRoomParticipant {
  return value as EndingRoomParticipant;
}

function asReplayThread(value: Partial<EndingRoomThread>): EndingRoomThread {
  return value as EndingRoomThread;
}

function asReplayTurn(value: Partial<EndingRoomTurn>): EndingRoomTurn {
  return value as EndingRoomTurn;
}

function sanitizeRoundtableAnchorId(
  value: string,
  turnIdMap: Map<string, string>,
): string | null {
  const [domain, kind, , ...extraParts] = value.split(':');
  if (domain !== 'roundtable') return null;
  if (kind === 'verdict') return 'roundtable:verdict:oracle-replay-room';
  if (kind === 'phase') {
    const extra = extraParts.join(':');
    return /^(opening|crossfire|rebuttal|closing|verdict)-\d+$/.test(extra)
      ? `roundtable:phase:oracle-replay-room:${extra}`
      : null;
  }
  if (kind === 'quote') {
    const turnId = turnIdMap.get(extraParts.join(':'));
    return turnId ? `roundtable:quote:oracle-replay-room:${turnId}` : null;
  }
  return null;
}

function sanitizeEndingRoomSnapshotForReplay(
  snapshot: EndingRoomSnapshot,
  maps: OracleReplayReferenceMaps,
): {
  snapshot: EndingRoomSnapshot;
  threadIdMap: Map<string, string>;
} {
  const turnIdMap = createReplayIdMap(
    snapshot.turns.flatMap((turn) => (
      isRecord(turn) && typeof turn.id === 'string' ? [turn.id] : []
    )),
    'oracle-replay-turn',
  );
  const participantIdMap = new Map<string, string>();
  const participants = snapshot.participants.flatMap((participantValue, index) => {
    if (!isRecord(participantValue)) return [];
    const id = `oracle-replay-participant-${index + 1}`;
    if (typeof participantValue.id === 'string') {
      participantIdMap.set(participantValue.id, id);
    }
    if (typeof participantValue.role_slot !== 'string' || typeof participantValue.display_name !== 'string') {
      return [];
    }
    const participant = asReplayParticipant({
      id,
      role_slot: participantValue.role_slot as EndingRoomParticipant['role_slot'],
      display_name: participantValue.display_name,
    });
    if (typeof participantValue.source_branch_id === 'string') {
      const sourceBranchId = maps.branchIdMap.get(participantValue.source_branch_id);
      if (sourceBranchId) participant.source_branch_id = sourceBranchId;
    }
    if (typeof participantValue.source_agent_id === 'string') {
      const sourceAgentId = maps.agentIdMap.get(participantValue.source_agent_id);
      if (sourceAgentId) participant.source_agent_id = sourceAgentId;
    }
    if (typeof participantValue.worldline_echo_key === 'string') {
      const echoKey = maps.agentIdMap.get(participantValue.worldline_echo_key);
      if (echoKey) participant.worldline_echo_key = echoKey;
    }
    return [participant];
  });

  const threadIdMap = new Map<string, string>();
  const threads = snapshot.threads.flatMap((threadValue, index) => {
    if (!isRecord(threadValue)) return [];
    const id = `oracle-replay-thread-${index + 1}`;
    if (typeof threadValue.id === 'string') {
      threadIdMap.set(threadValue.id, id);
    }
    if (
      typeof threadValue.title !== 'string'
      || typeof threadValue.mode !== 'string'
      || typeof threadValue.interaction_mode !== 'string'
    ) {
      return [];
    }
    const replayThread = asReplayThread({
      id,
      title: threadValue.title,
      mode: threadValue.mode as EndingRoomThread['mode'],
      interaction_mode: threadValue.interaction_mode as EndingRoomThread['interaction_mode'],
    });
    const addressedAgentIds = stringArrayValue(threadValue.addressed_agent_ids_json)
      .flatMap((agentId) => {
        const mapped = participantIdMap.get(agentId) ?? maps.agentIdMap.get(agentId);
        return mapped ? [mapped] : [];
      });
    if (addressedAgentIds.length > 0) {
      replayThread.addressed_agent_ids_json = addressedAgentIds;
    }
    const questionAnchorIds = stringArrayValue(threadValue.question_anchor_ids_json)
      .flatMap((anchorId) => {
        const mapped = sanitizeRoundtableAnchorId(anchorId, turnIdMap);
        return mapped ? [mapped] : [];
      });
    if (questionAnchorIds.length > 0) {
      replayThread.question_anchor_ids_json = questionAnchorIds;
    }
    return [replayThread];
  });

  const turns = snapshot.turns.flatMap((turnValue, index) => {
    if (!isRecord(turnValue)) return [];
    if (
      typeof turnValue.sequence !== 'number'
      || typeof turnValue.phase !== 'string'
      || typeof turnValue.content !== 'string'
      || typeof turnValue.emotion !== 'string'
    ) {
      return [];
    }
    const participantId = typeof turnValue.participant_id === 'string'
      ? participantIdMap.get(turnValue.participant_id)
      : null;
    const threadId = typeof turnValue.thread_id === 'string'
      ? threadIdMap.get(turnValue.thread_id)
      : null;
    const replayTurn = asReplayTurn({
      id: typeof turnValue.id === 'string'
        ? turnIdMap.get(turnValue.id) ?? `oracle-replay-turn-${index + 1}`
        : `oracle-replay-turn-${index + 1}`,
      sequence: turnValue.sequence,
      phase: turnValue.phase as EndingRoomTurn['phase'],
      participant_id: participantId ?? 'oracle-replay-participant-unknown',
      content: turnValue.content,
      emotion: turnValue.emotion,
    });
    if (threadId) {
      replayTurn.thread_id = threadId;
    }
    if (
      turnValue.source === 'auto_recap'
      || turnValue.source === 'user_turn'
      || turnValue.source === 'assistant_followup'
    ) {
      replayTurn.source = turnValue.source;
    }
    if (typeof turnValue.interaction_mode === 'string') {
      replayTurn.interaction_mode = turnValue.interaction_mode as EndingRoomTurn['interaction_mode'];
    }
    const addressedAgentIds = stringArrayValue(turnValue.addressed_agent_ids_json)
      .flatMap((agentId) => {
        const mapped = participantIdMap.get(agentId) ?? maps.agentIdMap.get(agentId);
        return mapped ? [mapped] : [];
      });
    if (addressedAgentIds.length > 0) {
      replayTurn.addressed_agent_ids_json = addressedAgentIds;
    }
    const questionAnchorIds = stringArrayValue(turnValue.question_anchor_ids_json)
      .flatMap((anchorId) => {
        const mapped = sanitizeRoundtableAnchorId(anchorId, turnIdMap);
        return mapped ? [mapped] : [];
      });
    if (questionAnchorIds.length > 0) {
      replayTurn.question_anchor_ids_json = questionAnchorIds;
    }
    if (typeof turnValue.cited_branch_id === 'string') {
      const citedBranchId = maps.branchIdMap.get(turnValue.cited_branch_id);
      if (citedBranchId) replayTurn.cited_branch_id = citedBranchId;
    }
    return [replayTurn];
  });

  const replaySnapshot: EndingRoomSnapshot = {
    id: 'oracle-replay-room',
    scenario_id: ORACLE_REPLAY_SCENARIO_ID,
    anchor_branch_id: typeof snapshot.anchor_branch_id === 'string'
      ? maps.branchIdMap.get(snapshot.anchor_branch_id) ?? null
      : null,
    room_type: snapshot.room_type,
    title: snapshot.title,
    language: snapshot.language,
    status: snapshot.status,
    current_phase: snapshot.current_phase,
    created_at: '',
    updated_at: '',
    participants,
    threads,
    turns,
    result_ready: snapshot.result_ready,
  };
  if (snapshot.discussion_format) {
    replaySnapshot.discussion_format = snapshot.discussion_format;
  }
  if (snapshot.cast_mode) {
    replaySnapshot.cast_mode = snapshot.cast_mode;
  }
  if (snapshot.selection_recipe) {
    replaySnapshot.selection_recipe = snapshot.selection_recipe;
  }
  return { snapshot: replaySnapshot, threadIdMap };
}

function sanitizeEndingRoomResultForReplay(
  result: EndingRoomResult | null,
): EndingRoomResult | null {
  if (!result) return null;
  const sanitized: EndingRoomResult = {
    summary: typeof result.summary === 'string' ? result.summary : '',
  };
  if (typeof result.next_move === 'string' || result.next_move === null) {
    sanitized.next_move = result.next_move;
  }
  if (typeof result.archivist_note === 'string' || result.archivist_note === null) {
    sanitized.archivist_note = result.archivist_note;
  }
  if (Array.isArray(result.phase_insights)) {
    sanitized.phase_insights = result.phase_insights.flatMap((insight) => {
      if (!isRecord(insight)) return [];
      if (
        typeof insight.phase !== 'string'
        || typeof insight.stakes !== 'string'
        || typeof insight.moderator_focus !== 'string'
        || typeof insight.commentary !== 'string'
      ) {
        return [];
      }
      return [{
        phase: insight.phase as NonNullable<EndingRoomResult['phase_insights']>[number]['phase'],
        stakes: insight.stakes,
        moderator_focus: insight.moderator_focus,
        commentary: insight.commentary,
        ...(typeof insight.insight_body === 'string' ? { insight_body: insight.insight_body } : {}),
      }];
    });
  }
  return sanitized;
}

export function normalizeOracleReplayPayload(
  payload: unknown,
  expectedKind?: OracleReplayKind,
): OracleReplayPayload | null {
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'ending_room_v1' && payload.kind !== 'worldline_roundtable_v1') {
    return null;
  }
  if (expectedKind && payload.kind !== expectedKind) {
    return null;
  }

  const scenarioReplay = payload.scenarioReplay == null
    ? null
    : normalizeScenarioResultReplayPayload(payload.scenarioReplay);
  if (!isEndingRoomSnapshot(payload.roomSnapshot)) return null;
  if (!isEndingRoomResult(payload.roomResult)) return null;
  if (payload.kind === 'worldline_roundtable_v1' && !scenarioReplay) return null;
  if (payload.branchId != null && typeof payload.branchId !== 'string') return null;
  if (payload.activeThreadId != null && typeof payload.activeThreadId !== 'string') return null;
  if (payload.selectedAgentIds != null && !isStringArray(payload.selectedAgentIds)) return null;
  if (payload.scenarioId != null && typeof payload.scenarioId !== 'string') return null;

  return sanitizeOracleReplayPayload({
    kind: payload.kind,
    scenarioReplay,
    scenarioId:
      typeof payload.scenarioId === 'string'
        ? payload.scenarioId
        : scenarioReplay?.scenario.id ?? payload.roomSnapshot.scenario_id,
    roomSnapshot: payload.roomSnapshot,
    roomResult: payload.roomResult,
    branchId: typeof payload.branchId === 'string' ? payload.branchId : null,
    selectedAgentIds: isStringArray(payload.selectedAgentIds) ? payload.selectedAgentIds : [],
    activeThreadId: typeof payload.activeThreadId === 'string' ? payload.activeThreadId : null,
  });
}

export function sanitizeOracleReplayPayload(payload: OracleReplayPayload): OracleReplayPayload {
  const scenarioReplayResult = payload.scenarioReplay
    ? sanitizeOracleScenarioReplay(payload.scenarioReplay)
    : null;
  const maps = scenarioReplayResult?.maps ?? {
    agentIdMap: new Map<string, string>(),
    branchIdMap: new Map<string, string>(),
    groupIdMap: new Map<string, string>(),
  };
  const { snapshot, threadIdMap } = sanitizeEndingRoomSnapshotForReplay(
    payload.roomSnapshot,
    maps,
  );
  return {
    kind: payload.kind,
    scenarioReplay: scenarioReplayResult?.payload ?? null,
    scenarioId: null,
    roomSnapshot: snapshot,
    roomResult: sanitizeEndingRoomResultForReplay(payload.roomResult),
    branchId: typeof payload.branchId === 'string'
      ? maps.branchIdMap.get(payload.branchId) ?? null
      : null,
    selectedAgentIds: (payload.selectedAgentIds ?? []).flatMap((agentId) => {
      const mapped = maps.agentIdMap.get(agentId);
      return mapped ? [mapped] : [];
    }),
    activeThreadId: typeof payload.activeThreadId === 'string'
      ? threadIdMap.get(payload.activeThreadId) ?? null
      : null,
  };
}

export function saveOracleReplayLocalCopy(payload: OracleReplayPayload): string {
  const sanitizedPayload = sanitizeOracleReplayPayload(payload);
  const id = createCompatUuid();
  const storage = getOracleReplayStorage();
  if (!storage) {
    oracleReplayMemoryCache[id] = sanitizedPayload;
    return id;
  }

  const raw = storage.getItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) as Record<string, OracleReplayPayload> : {};
  parsed[id] = sanitizedPayload;
  storage.setItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  return id;
}

export function loadOracleReplayLocalCopy(
  id: string,
  expectedKind?: OracleReplayKind,
): OracleReplayPayload | null {
  const memoryValue = normalizeOracleReplayPayload(oracleReplayMemoryCache[id], expectedKind);
  if (memoryValue) {
    return memoryValue;
  }
  try {
    const storage = getOracleReplayStorage();
    if (!storage) return null;
    const raw = storage.getItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeOracleReplayPayload(parsed[id], expectedKind);
  } catch {
    return null;
  }
}

export async function buildOracleReplayUrl(
  origin: string,
  payload: OracleReplayPayload,
): Promise<string> {
  const sanitizedPayload = sanitizeOracleReplayPayload(payload);
  const token = await encodeReplayEnvelope(sanitizedPayload.kind, sanitizedPayload);
  return `${normalizeReplayOrigin(origin)}${buildOracleReplayPath(sanitizedPayload, ORACLE_REPLAY_QUERY_KEY, token)}`;
}

export function buildOracleReplayShareUrl(
  origin: string,
  payload: OracleReplayPayload,
  shareId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildOracleReplayPath(payload, ORACLE_REPLAY_SHARE_QUERY_KEY, shareId)}`;
}

export function buildOracleReplayLocalUrl(
  origin: string,
  payload: OracleReplayPayload,
  localId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildOracleReplayPath(payload, ORACLE_REPLAY_LOCAL_QUERY_KEY, localId)}`;
}

export async function readOracleReplayPayload(
  searchParams: URLSearchParams,
  expectedKind?: OracleReplayKind,
): Promise<OracleReplayPayload | null> {
  const token = searchParams.get(ORACLE_REPLAY_QUERY_KEY);
  if (!token) {
    return null;
  }
  const decoded = await decodeReplayEnvelope<OracleReplayPayload>(
    token,
    expectedKind ?? 'ending_room_v1',
  );
  return normalizeOracleReplayPayload(decoded, expectedKind);
}
