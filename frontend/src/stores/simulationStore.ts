/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Zustand Simulation Store
   ═══════════════════════════════════════════════════════════ */

const MAX_MESSAGES = 5000; // H-3 fix: prevent unbounded memory growth

import i18n from '../i18n/config';
import { create } from 'zustand';
import {
  createScenario,
  getScenario,
  type CreateScenarioOptions,
  type RequestOptions,
} from '../api/client';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import type { Scenario, AgentMessage, BranchInfo, AgentInfo, GroupInfo, WSEvent } from '../types';

let seenMessageKeys = new Set<string>();
let _seenScenarioId: string | null = null;

function messageDedupKey(
  message: Pick<AgentMessage, 'agent_id' | 'branch' | 'round' | 'message'>,
  scenarioId: string | null | undefined,
): string {
  return `${scenarioId ?? ''}::${message.agent_id}::${message.branch}::${message.round}::${message.message}`;
}

function rebuildSeenMessageKeys(messages: AgentMessage[], scenarioId?: string | null) {
  seenMessageKeys = new Set(messages.map((message) => messageDedupKey(message, scenarioId)));
  _seenScenarioId = scenarioId ?? null;
}

const STATUS_RANK: Record<SimulationState['status'], number> = {
  idle: 0,
  parsing: 1,
  simulating: 2,
  narrating: 3,
  done: 4,
  error: 4,
  cancelled: 4,
};

const BRANCH_STATUS_RANK: Record<BranchInfo['status'], number> = {
  ACTIVE: 0,
  COMPLETED: 1,
  PRUNED: 1,
};

/** Agent currently thinking (waiting for LLM response). */
export interface ThinkingAgent {
  agent: string;
  agent_id: string;
  branch: string;
  round: number;
}

export type InterventionLifecycleState = 'queued' | 'injected' | 'observed' | 'receipt_ready';

type ActiveSimulationStatus = Exclude<SimulationState['status'], 'idle'>;

export interface SimulationState {
  // Data
  scenario: Scenario | null;
  agents: AgentInfo[];
  branches: BranchInfo[];
  messages: AgentMessage[];
  groups: GroupInfo[];  // P3-A
  hierarchical: boolean;  // P3-A
  status: 'idle' | 'parsing' | 'simulating' | 'narrating' | 'done' | 'error' | 'cancelled';
  error: string | null;
  errorCode: string | null;
  cancelReason: string | null;

  // V2: Pixel visualization
  visualizationEnabled: boolean;
  viewMode: 'classic' | 'theater';

  // Real-time indicators
  thinkingAgents: ThinkingAgent[];

  // Progress tracking
  currentRound: number;
  simStartTime: number | null;        // timestamp when simulation started
  roundCompleteTimes: number[];       // timestamps when each round completed
  lastContentEventAt: number;         // ms timestamp of the last content activity signal
  turnProgress: {
    branch_id: string;
    round: number;
    completed: number;
    total: number;
  } | null;
  activeRoundProgress: {
    round: number;
    active_branches: number;
  } | null;

  // Intervention
  interventionLog: Array<{ branch_id: string; text: string; round: number }>;
  interventionLifecycle: Map<string, InterventionLifecycleState>;
  isSimulationComplete: boolean;

  // Actions
  startSimulation: (options: CreateScenarioOptions) => Promise<string>;
  abortStartSimulation: () => void;
  setScenario: (s: Scenario, options?: { forceClassicForDone?: boolean; replayMode?: boolean }) => void;
  loadScenario: (id: string) => Promise<void>;
  handleWSEvent: (event: WSEvent) => void;
  toggleViewMode: () => void;
  setCancelled: (reason?: string) => void;
  reset: () => void;
}

interface InterventionLogEntry {
  branch_id: string;
  text: string;
  round: number;
}

const initialState = {
  scenario: null,
  agents: [] as AgentInfo[],
  branches: [] as BranchInfo[],
  messages: [] as AgentMessage[],
  groups: [] as GroupInfo[],
  hierarchical: false,
  status: 'idle' as const,
  error: null as string | null,
  errorCode: null as string | null,
  cancelReason: null as string | null,
  // V2: Pixel visualization
  visualizationEnabled: false,
  viewMode: 'classic' as const,
  thinkingAgents: [] as ThinkingAgent[],
  currentRound: 0,
  simStartTime: null as number | null,
  roundCompleteTimes: [] as number[],
  lastContentEventAt: 0,
  turnProgress: null as {
    branch_id: string;
    round: number;
    completed: number;
    total: number;
  } | null,
  activeRoundProgress: null as {
    round: number;
    active_branches: number;
  } | null,
  interventionLog: [] as InterventionLogEntry[],
  interventionLifecycle: new Map<string, InterventionLifecycleState>(),
  isSimulationComplete: false,
};

let activeStartSimulationController: AbortController | null = null;

function appendInterventionLog(
  current: InterventionLogEntry[],
  next: InterventionLogEntry[],
): InterventionLogEntry[] {
  return [...current, ...next];
}

function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options as never) as unknown as string;
}

function mergeMessages(
  current: AgentMessage[],
  incoming: AgentMessage[],
  scenarioId: string | null | undefined,
): AgentMessage[] {
  if (current.length === 0) return incoming.slice(-MAX_MESSAGES);
  if (incoming.length === 0) return current.slice(-MAX_MESSAGES);

  const merged = [...incoming];
  const seen = new Set(incoming.map((message) => messageDedupKey(message, scenarioId)));
  for (const message of current) {
    const key = messageDedupKey(message, scenarioId);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged.slice(-MAX_MESSAGES);
}

function mergeBranch(current: BranchInfo, incoming: BranchInfo): BranchInfo {
  const nextStatus = BRANCH_STATUS_RANK[current.status] >= BRANCH_STATUS_RANK[incoming.status]
    ? current.status
    : incoming.status;
  return {
    ...current,
    ...incoming,
    status: nextStatus,
  };
}

function mergeBranches(current: BranchInfo[], incoming: BranchInfo[]): BranchInfo[] {
  if (current.length === 0) return incoming;
  if (incoming.length === 0) return current;

  const currentById = new Map(current.map((branch) => [branch.id, branch]));
  const merged = incoming.map((branch) => {
    const existing = currentById.get(branch.id);
    if (!existing) return branch;
    currentById.delete(branch.id);
    return mergeBranch(existing, branch);
  });
  return [...merged, ...currentById.values()];
}

function mergeScenarioStatus(
  current: SimulationState['status'],
  incoming: ActiveSimulationStatus,
): ActiveSimulationStatus {
  // S1-1: cancelled is a terminal state and must not be regressed by stale
  // snapshots/events arriving after the cancel WS frame.
  if (current === 'cancelled') return current as ActiveSimulationStatus;
  if (current === 'done' && incoming !== 'error') return current;
  if (current === 'error' && incoming !== 'done') return current;
  return STATUS_RANK[current] > STATUS_RANK[incoming] ? (current as ActiveSimulationStatus) : incoming;
}

function shouldIgnoreCancelledEvent(status: SimulationState['status'], eventType: string): boolean {
  return status === 'cancelled' && eventType !== 'heartbeat' && eventType !== 'simulation_cancelled';
}

function applyScenarioSnapshot(
  state: SimulationState,
  scenario: Scenario,
  options?: { forceClassicForDone?: boolean; replayMode?: boolean },
): Partial<SimulationState> {
  const incomingStatus = scenario.status as ActiveSimulationStatus;
  const sameScenario = state.scenario?.id === scenario.id;
  const forceClassicForDone = options?.forceClassicForDone ?? false;
  const replayMode = options?.replayMode ?? false;
  const mergedMessages = sameScenario
    ? mergeMessages(state.messages, (scenario.messages || []) as AgentMessage[], scenario.id)
    : ((scenario.messages || []) as AgentMessage[]);
  const mergedBranches = sameScenario
    ? mergeBranches(state.branches, scenario.branches as BranchInfo[])
    : (scenario.branches as BranchInfo[]);
  const mergedStatus = sameScenario
    ? mergeScenarioStatus(state.status, incomingStatus)
    : incomingStatus;
  const highestRound = Math.max(0, ...mergedMessages.map((message) => message.round ?? 0));

  rebuildSeenMessageKeys(mergedMessages, scenario.id);

  const nextScenarioStatus = mergedStatus as Scenario['status'];

  const nextLifecycle = sameScenario
    ? new Map(state.interventionLifecycle)
    : new Map<string, InterventionLifecycleState>();
  if (mergedStatus === 'done') {
    for (const key of nextLifecycle.keys()) {
      nextLifecycle.set(key, 'receipt_ready');
    }
  }

  return {
    scenario: {
      ...scenario,
      status: nextScenarioStatus,
      branches: mergedBranches,
      messages: mergedMessages,
    },
    agents: scenario.agents as AgentInfo[],
    branches: mergedBranches,
    groups: (scenario.groups || []) as GroupInfo[],
    hierarchical: scenario.hierarchical ?? false,
    visualizationEnabled: scenario.visualization_enabled ?? false,
    viewMode: mergedStatus === 'done' && !replayMode
      ? (sameScenario && !forceClassicForDone ? state.viewMode : 'classic')
      : (scenario.visualization_enabled ? 'theater' : 'classic'),
    messages: mergedMessages,
    // Snapshot resync is authoritative for durable state, but does not carry
    // in-flight speaker progress. Clear stale thinking indicators and let the
    // next websocket frame repopulate them if the stream is still active.
    thinkingAgents: [],
    status: mergedStatus,
    currentRound: sameScenario ? Math.max(state.currentRound, highestRound) : highestRound,
    simStartTime: sameScenario ? state.simStartTime : null,
    roundCompleteTimes: sameScenario ? state.roundCompleteTimes : [],
    // Snapshot/re-poll must NOT count as content progress: a same-scenario resync
    // (including the watchdog's own stuck re-poll) keeps the prior signal so a true
    // orphan's stuck banner stays visible instead of self-clearing. Genuine progress
    // only arrives via incremental WS frames (agent_speak / round_summary / narration / ...).
    lastContentEventAt: sameScenario ? state.lastContentEventAt : Date.now(),
    turnProgress: sameScenario ? state.turnProgress : null,
    activeRoundProgress: sameScenario ? state.activeRoundProgress : null,
    isSimulationComplete: mergedStatus === 'done',
    interventionLog: sameScenario ? state.interventionLog : [],
    interventionLifecycle: nextLifecycle,
    error: mergedStatus === 'error' ? (state.error ?? translate('simulation.runtime_failed')) : null,
    errorCode: mergedStatus === 'error' ? (state.errorCode ?? 'RUNTIME_ERROR') : null,
  };
}

export const useSimulationStore = create<SimulationState>((set) => ({
  ...initialState,

  startSimulation: async (options: CreateScenarioOptions) => {
    activeStartSimulationController?.abort();
    const controller = new AbortController();
    activeStartSimulationController = controller;
    const requestOptions: RequestOptions = { signal: controller.signal };
    const isCurrentStart = () => activeStartSimulationController === controller && !controller.signal.aborted;
    set({
      status: 'parsing',
      error: null,
      errorCode: null,
      interventionLog: [],
      interventionLifecycle: new Map<string, InterventionLifecycleState>(),
      thinkingAgents: [],
      currentRound: 0,
      simStartTime: null,
      roundCompleteTimes: [],
      lastContentEventAt: Date.now(),
      turnProgress: null,
      activeRoundProgress: null,
      isSimulationComplete: false,
    });
    try {
      const scenario = await createScenario(options, requestOptions);
      if (!isCurrentStart()) {
        throw new DOMException('Start simulation request was aborted', 'AbortError');
      }
      const resolvedVisualizationEnabled = scenario.visualization_enabled ?? options.visualizationEnabled ?? false;
      set({
        scenario,
        agents: scenario.agents as AgentInfo[],
        branches: scenario.branches as BranchInfo[],
        groups: (scenario.groups || []) as GroupInfo[],
        hierarchical: scenario.hierarchical ?? false,
        visualizationEnabled: resolvedVisualizationEnabled,
        viewMode: resolvedVisualizationEnabled ? 'theater' : 'classic',
        status: scenario.status as SimulationState['status'],
        error: null,
        errorCode: null,
        thinkingAgents: [],
        currentRound: Math.max(0, ...((scenario.messages || []) as AgentMessage[]).map((message) => message.round ?? 0)),
        simStartTime: null,
        roundCompleteTimes: [],
        lastContentEventAt: Date.now(),
        turnProgress: null,
        activeRoundProgress: null,
        interventionLog: [],
        interventionLifecycle: new Map<string, InterventionLifecycleState>(),
        isSimulationComplete: scenario.status === 'done',
      });
      rebuildSeenMessageKeys((scenario.messages || []) as AgentMessage[], scenario.id);
      return scenario.id;
    } catch (err) {
      if (!isCurrentStart()) {
        throw err;
      }
      set({
        status: 'error',
        errorCode: getApiErrorCode(err),
        error: getLocalizedApiErrorMessage(
          err,
          translate,
          translate('common.api_errors.simulation_start_failed'),
        ),
      });
      throw err;
    } finally {
      if (activeStartSimulationController === controller) {
        activeStartSimulationController = null;
      }
    }
  },

  abortStartSimulation: () => {
    activeStartSimulationController?.abort();
    activeStartSimulationController = null;
  },

  setScenario: (s: Scenario, options?: { forceClassicForDone?: boolean; replayMode?: boolean }) => {
    set((state) => applyScenarioSnapshot(state, s, options));
  },

  loadScenario: async (id: string) => {
    try {
      const s = await getScenario(id);
      set((state) => applyScenarioSnapshot(state, s));
    } catch (err) {
      set({
        errorCode: getApiErrorCode(err),
        error: getLocalizedApiErrorMessage(
          err,
          translate,
          translate('common.api_errors.scenario_load_failed'),
        ),
      });
    }
  },

  handleWSEvent: (event: WSEvent) => {
    const currentScenarioId = useSimulationStore.getState().scenario?.id ?? null;
    if (currentScenarioId && currentScenarioId !== _seenScenarioId) {
      seenMessageKeys = new Set<string>();
      _seenScenarioId = currentScenarioId;
    }
    if (shouldIgnoreCancelledEvent(useSimulationStore.getState().status, event.type)) {
      return;
    }
    switch (event.type) {
      case 'heartbeat':
        break;

      case 'status':
        set((state) => {
          const mergedStatus = mergeScenarioStatus(
            state.status,
            event.data.status as ActiveSimulationStatus,
          );
          return {
            status: mergedStatus,
            isSimulationComplete: mergedStatus === 'done',
            simStartTime: event.data.status === 'simulating' && !state.simStartTime
              ? Date.now()
              : state.simStartTime,
            lastContentEventAt: Date.now(),
            turnProgress: mergedStatus === 'done' || mergedStatus === 'error' || mergedStatus === 'cancelled'
              ? null
              : state.turnProgress,
            activeRoundProgress: mergedStatus === 'done' || mergedStatus === 'error' || mergedStatus === 'cancelled'
              ? null
              : state.activeRoundProgress,
          };
        });
        break;

      case 'agent_speak_start':
        // Agent begins thinking — show "thinking" indicator
        set((state) => ({
          lastContentEventAt: Date.now(),
          thinkingAgents: [
            ...state.thinkingAgents.filter(
              (t) => !(t.agent_id === event.data.agent_id && t.branch === event.data.branch && t.round === event.data.round)
            ),
            {
              agent: event.data.agent,
              agent_id: event.data.agent_id,
              branch: event.data.branch,
              round: event.data.round,
            },
          ],
        }));
        break;

      case 'agent_speak_delta':
        // Ignored — we no longer use token-level streaming
        set(() => ({
          lastContentEventAt: Date.now(),
        }));
        break;

      case 'agent_speak': {
        // Final message — add to messages (with dedup + cap), remove from thinking
        const preState = useSimulationStore.getState();
        const agentsEmpty = preState.agents.length === 0;
        set((state) => {
          const d = event.data;
          const dedupKey = messageDedupKey(d, state.scenario?.id);
          const isDuplicate = seenMessageKeys.has(dedupKey);
          if (isDuplicate) {
            return {
              lastContentEventAt: Date.now(),
              thinkingAgents: state.thinkingAgents.filter(
                (t) => !(t.agent_id === d.agent_id && t.branch === d.branch && t.round === d.round),
              ),
            };
          }
          // H-3 fix: cap messages to prevent memory leak
          let newMessages = [...state.messages, d];
          seenMessageKeys.add(dedupKey);
          if (newMessages.length > MAX_MESSAGES) {
            newMessages = newMessages.slice(newMessages.length - MAX_MESSAGES);
            rebuildSeenMessageKeys(newMessages, state.scenario?.id);
          }
          return {
            lastContentEventAt: Date.now(),
            messages: newMessages,
            thinkingAgents: state.thinkingAgents.filter(
              (t) => !(t.agent_id === d.agent_id && t.branch === d.branch && t.round === d.round),
            ),
            agents: state.agents.map((a) =>
              a.id === d.agent_id ? { ...a, emotion: d.emotion } : a,
            ),
          };
        });
        if (agentsEmpty && preState.scenario?.id) {
          void useSimulationStore.getState().loadScenario(preState.scenario.id);
        }
        break;
      }

      case 'round_summary':
        set((state) => {
          const roundNum = event.data.round;
          const newRound = Math.max(state.currentRound, roundNum);
          // Record completion time for this round (only once per round number)
          const times = [...state.roundCompleteTimes];
          if (times.length < roundNum) {
            times.push(Date.now());
          }
          return {
            currentRound: newRound,
            roundCompleteTimes: times,
            lastContentEventAt: Date.now(),
            turnProgress: state.turnProgress?.round && state.turnProgress.round <= newRound
              ? null
              : state.turnProgress,
            activeRoundProgress: state.activeRoundProgress?.round && state.activeRoundProgress.round <= newRound
              ? null
              : state.activeRoundProgress,
          };
        });
        break;

      case 'branch_init':
        // Root branch created — add to store so tree renders before agent_speak
        set((state) => {
          // If the branch already exists (e.g. provisional root branch loaded from
          // createScenario), refresh its display fields instead of discarding the
          // newer branch_init payload from the simulator.
          if (state.branches.some((b) => b.id === event.data.id)) {
            return {
              lastContentEventAt: Date.now(),
              branches: state.branches.map((b) =>
                b.id === event.data.id
                  ? {
                      ...b,
                      title: event.data.title,
                      probability: event.data.probability,
                      status: event.data.status as 'ACTIVE',
                      parent_branch_id: event.data.parent_branch_id,
                    }
                  : b,
              ),
            };
          }
          return {
            lastContentEventAt: Date.now(),
            branches: [
              ...state.branches,
              {
                id: event.data.id,
                parent_branch_id: event.data.parent_branch_id,
                fork_round: 0,
                fork_reason: '',
                title: event.data.title,
                description: '',
                summary: '',
                story: '',
                insight: '',
                key_moments: [],
                probability: event.data.probability,
                status: event.data.status as 'ACTIVE',
              },
            ],
          };
        });
        break;

      case 'branch_fork':
        set((state) => ({
          lastContentEventAt: Date.now(),
          branches: [
            // Mark parent as COMPLETED (it forked into children)
            ...state.branches.map((b) =>
              b.id === event.data.parent ? { ...b, status: 'COMPLETED' as const } : b,
            ),
            // Add children
            ...event.data.children.map((c) => ({
              id: c.id,
              parent_branch_id: event.data.parent,
              fork_round: c.fork_round ?? 0,
              fork_reason: event.data.reason,
              title: c.title,
              description: c.description || '',
              summary: '',
              story: '',
              insight: '',
              key_moments: [],
              probability: c.probability,
              status: 'ACTIVE' as const,
            })),
          ],
        }));
        break;

      case 'branch_prune':
        set((state) => ({
          branches: state.branches.map((b) =>
            b.id === event.data.branch_id ? { ...b, status: 'PRUNED' as const } : b,
          ),
        }));
        break;

      case 'branch_update':
        set((state) => ({
          lastContentEventAt: Date.now(),
          branches: state.branches.map((b) =>
            b.id === event.data.branch_id
              ? mergeBranch(b, {
                  ...b,
                  status: event.data.status as 'ACTIVE' | 'COMPLETED' | 'PRUNED',
                })
              : b,
          ),
        }));
        break;

      case 'narration':
        set((state) => ({
          lastContentEventAt: Date.now(),
          branches: state.branches.map((b) =>
            b.id === event.data.branch_id
              ? {
                  ...b,
                  title: event.data.title || b.title,
                  story: event.data.story,
                  insight: event.data.insight,
                  status: 'COMPLETED' as const,
                }
              : b,
          ),
        }));
        break;

      case 'intervention_applied':
        set((state) => {
          const nextLifecycle = new Map(state.interventionLifecycle);
          if (event.data.intervention_id) {
            nextLifecycle.set(event.data.intervention_id, 'queued');
          }
          return {
            interventionLog: appendInterventionLog(state.interventionLog, [
              {
                branch_id: event.data.branch_id,
                text: event.data.text,
                round: event.data.round,
              },
            ]),
            interventionLifecycle: nextLifecycle,
          };
        });
        break;

      case 'intervention_injected':
        set((state) => {
          const nextLifecycle = new Map(state.interventionLifecycle);
          if (event.data.intervention_id) {
            nextLifecycle.set(event.data.intervention_id, 'injected');
          }
          return {
            interventionLifecycle: nextLifecycle,
          };
        });
        break;

      case 'retrospective_start':
        set((state) => {
          const sourceBranch = state.branches.find((branch) => branch.id === event.data.source_branch_id);
          const hasBranch = state.branches.some((branch) => branch.id === event.data.branch_id);
          const nextLifecycle = new Map(state.interventionLifecycle);
          if (event.data.intervention_id) {
            nextLifecycle.set(event.data.intervention_id, 'queued');
          }
          const nextBranches = hasBranch
            ? state.branches
            : [
                ...state.branches,
                {
                  id: event.data.branch_id,
                  parent_branch_id: event.data.source_branch_id,
                  fork_round: event.data.from_round,
                  fork_reason: event.data.text,
                  title: translate('intervention.retrospective_title', { round: event.data.from_round }),
                  description: '',
                  summary: '',
                  story: '',
                  insight: '',
                  key_moments: [],
                  probability: sourceBranch ? Math.max(sourceBranch.probability * 0.8, 0.01) : 0.5,
                  status: 'ACTIVE' as const,
                },
              ];

          return {
            branches: nextBranches,
            interventionLog: appendInterventionLog(state.interventionLog, [
              {
                branch_id: event.data.branch_id,
                text: event.data.text,
                round: event.data.from_round,
              },
            ]),
            interventionLifecycle: nextLifecycle,
          };
        });
        break;

      case 'batch_intervention_applied':
        set((state) => {
          const nextLifecycle = new Map(state.interventionLifecycle);
          event.data.interventions.forEach((intervention) => {
            if (intervention.intervention_id) {
              nextLifecycle.set(intervention.intervention_id, 'queued');
            }
          });
          return {
            interventionLog: appendInterventionLog(
              state.interventionLog,
              event.data.interventions.map((intervention) => ({
                branch_id: intervention.branch_id,
                text: intervention.text,
                round: intervention.round,
              })),
            ),
            interventionLifecycle: nextLifecycle,
          };
        });
        break;

      case 'turn_progress':
        set((state) => {
          if (event.data.round <= state.currentRound) {
            return {
              lastContentEventAt: Date.now(),
              turnProgress: null,
            };
          }
          return {
            lastContentEventAt: Date.now(),
            activeRoundProgress: state.activeRoundProgress?.round === event.data.round
              ? state.activeRoundProgress
              : {
                  round: event.data.round,
                  active_branches: 1,
                },
            turnProgress: {
              branch_id: event.data.branch_id,
              round: event.data.round,
              completed: event.data.completed,
              total: event.data.total,
            },
          };
        });
        break;

      case 'round_progress':
        set((state) => ({
          lastContentEventAt: Date.now(),
          activeRoundProgress: event.data.round > state.currentRound
            ? {
                round: event.data.round,
                active_branches: event.data.active_branches,
              }
            : null,
          turnProgress: null,
        }));
        break;

      case 'kg:delta':
      case 'kg:snapshot_invalidated':
        break;

      case 'simulation_done':
        // H4 fix: cancelled is terminal — late simulation_done must not regress it.
        set((state) => {
          if (state.status === 'cancelled') {
            return {
              thinkingAgents: [],
              turnProgress: null,
              activeRoundProgress: null,
            };
          }
          const nextLifecycle = new Map(state.interventionLifecycle);
          for (const key of nextLifecycle.keys()) {
            nextLifecycle.set(key, 'receipt_ready');
          }
          return {
            status: 'done',
            isSimulationComplete: true,
            thinkingAgents: [],
            turnProgress: null,
            activeRoundProgress: null,
            interventionLifecycle: nextLifecycle,
          };
        });
        break;

      case 'simulation_cancelled':
        set((state) => ({
          status: 'cancelled',
          cancelReason: event.reason ?? 'user_cancelled',
          isSimulationComplete: state.isSimulationComplete,
          thinkingAgents: [],
          turnProgress: null,
          activeRoundProgress: null,
          error: null,
          errorCode: null,
        }));
        break;

      case 'simulation_error':
        // H4 fix: cancelled is terminal — late simulation_error must not regress it.
        set((state) => {
          if (state.status === 'cancelled') {
            return {
              thinkingAgents: [],
              turnProgress: null,
              activeRoundProgress: null,
            };
          }
          return {
            status: 'error',
            errorCode: getApiErrorCode(event.data.error),
            error: getLocalizedApiErrorMessage(
              event.data.error,
              translate,
              translate('common.api_errors.simulation_start_failed'),
            ),
            thinkingAgents: [],
            turnProgress: null,
            activeRoundProgress: null,
          };
        });
        break;

      // M-6 fix: Log unrecognized event types instead of silently dropping
      default: {
        const unhandled = event as { type: string; data?: unknown };
        console.warn(`[WS] Unhandled event type: ${unhandled.type}`, unhandled.data);
        break;
      }
    }
  },

  toggleViewMode: () =>
    set((state) => {
      if (state.viewMode === 'classic' && !state.visualizationEnabled) {
        return state;
      }

      const newMode = state.viewMode === 'classic' ? 'theater' : 'classic';
      return {
        viewMode: newMode,
      };
    }),

  setCancelled: (reason?: string) =>
    set(() => ({
      status: 'cancelled',
      cancelReason: reason ?? 'user_cancelled',
      thinkingAgents: [],
      error: null,
      errorCode: null,
    })),

  reset: () => {
    seenMessageKeys = new Set<string>();
    _seenScenarioId = null;
    set(initialState);
  },
}));
