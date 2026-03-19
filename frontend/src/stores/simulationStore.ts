/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Zustand Simulation Store
   ═══════════════════════════════════════════════════════════ */

const MAX_MESSAGES = 5000; // H-3 fix: prevent unbounded memory growth

import { create } from 'zustand';
import { createScenario, getScenario } from '../api/client';
import type { Scenario, AgentMessage, BranchInfo, AgentInfo, GroupInfo, WSEvent } from '../types';

/** Agent currently thinking (waiting for LLM response). */
export interface ThinkingAgent {
  agent: string;
  agent_id: string;
  branch: string;
  round: number;
}

export interface SimulationState {
  // Data
  scenario: Scenario | null;
  agents: AgentInfo[];
  branches: BranchInfo[];
  messages: AgentMessage[];
  groups: GroupInfo[];  // P3-A
  hierarchical: boolean;  // P3-A
  status: 'idle' | 'parsing' | 'simulating' | 'narrating' | 'done' | 'error';
  error: string | null;

  // V2: Pixel visualization
  visualizationEnabled: boolean;
  viewMode: 'classic' | 'theater';

  // Real-time indicators
  thinkingAgents: ThinkingAgent[];

  // Progress tracking
  currentRound: number;
  simStartTime: number | null;        // timestamp when simulation started
  roundCompleteTimes: number[];       // timestamps when each round completed

  // Intervention
  interventionLog: Array<{ branch_id: string; text: string; round: number }>;
  isSimulationComplete: boolean;

  // Actions
  startSimulation: (question: string, rounds?: number, numAgents?: number, mode?: 'raw' | 'blackboard', hierarchical?: boolean, llmApiKey?: string, llmBaseUrl?: string, llmModel?: string, reasoningEffort?: string, visualizationEnabled?: boolean, userId?: string) => Promise<string>;
  setScenario: (s: Scenario) => void;
  loadScenario: (id: string) => Promise<void>;
  handleWSEvent: (event: WSEvent) => void;
  toggleViewMode: () => void;
  reset: () => void;
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
  // V2: Pixel visualization
  visualizationEnabled: false,
  viewMode: 'classic' as const,
  thinkingAgents: [] as ThinkingAgent[],
  currentRound: 0,
  simStartTime: null as number | null,
  roundCompleteTimes: [] as number[],
  interventionLog: [] as Array<{ branch_id: string; text: string; round: number }>,
  isSimulationComplete: false,
};

export const useSimulationStore = create<SimulationState>((set) => ({
  ...initialState,

  startSimulation: async (question: string, rounds?: number, numAgents?: number, mode?: 'raw' | 'blackboard', hierarchical?: boolean, llmApiKey?: string, llmBaseUrl?: string, llmModel?: string, reasoningEffort?: string, visualizationEnabled?: boolean, userId?: string) => {
    set({ status: 'parsing', error: null });
    try {
      const scenario = await createScenario(question, rounds, numAgents, mode, hierarchical, llmApiKey, llmBaseUrl, llmModel, reasoningEffort, visualizationEnabled, userId);
      set({
        scenario,
        agents: scenario.agents as AgentInfo[],
        branches: scenario.branches as BranchInfo[],
        groups: (scenario.groups || []) as GroupInfo[],
        hierarchical: scenario.hierarchical ?? false,
        visualizationEnabled: visualizationEnabled ?? false,
        viewMode: visualizationEnabled ? 'theater' : 'classic',
        status: scenario.status as SimulationState['status'],
        error: null,
      });
      return scenario.id;
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to start simulation',
      });
      throw err;
    }
  },

  setScenario: (s: Scenario) =>
    set({
      scenario: s,
      agents: s.agents as AgentInfo[],
      branches: s.branches as BranchInfo[],
      groups: (s.groups || []) as GroupInfo[],
      hierarchical: s.hierarchical ?? false,
      visualizationEnabled: s.visualization_enabled ?? false,
      viewMode: s.visualization_enabled ? 'theater' : 'classic',
      messages: (s.messages || []) as AgentMessage[],
      status: s.status as SimulationState['status'],
      currentRound: Math.max(0, ...((s.messages || []).map((message) => message.round ?? 0))),
      isSimulationComplete: s.status === 'done',
      error: null,
    }),

  loadScenario: async (id: string) => {
    try {
      const s = await getScenario(id);
      set({
        scenario: s,
        agents: s.agents as AgentInfo[],
        branches: s.branches as BranchInfo[],
        groups: (s.groups || []) as GroupInfo[],
        hierarchical: s.hierarchical ?? false,
        visualizationEnabled: s.visualization_enabled ?? false,
        viewMode: s.visualization_enabled ? 'theater' : 'classic',
        messages: (s.messages || []) as AgentMessage[],
        status: s.status as SimulationState['status'],
        currentRound: Math.max(0, ...((s.messages || []).map((message) => message.round ?? 0))),
        isSimulationComplete: s.status === 'done',
        error: null,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load scenario' });
    }
  },

  handleWSEvent: (event: WSEvent) => {
    switch (event.type) {
      case 'status':
        set((state) => ({
          status: event.data.status as SimulationState['status'],
          isSimulationComplete: event.data.status === 'done',
          simStartTime: event.data.status === 'simulating' && !state.simStartTime
            ? Date.now()
            : state.simStartTime,
        }));
        break;

      case 'agent_speak_start':
        // Agent begins thinking — show "thinking" indicator
        set((state) => ({
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
        break;

      case 'agent_speak':
        // Final message — add to messages (with dedup + cap), remove from thinking
        set((state) => {
          const d = event.data;
          // Dedup guard: reject if identical (agent_id + branch + round + message) already exists
          const isDuplicate = state.messages.some(
            (m) =>
              m.agent_id === d.agent_id &&
              m.branch === d.branch &&
              m.round === d.round &&
              m.message === d.message,
          );
          if (isDuplicate) {
            return {
              thinkingAgents: state.thinkingAgents.filter(
                (t) => !(t.agent_id === d.agent_id && t.branch === d.branch && t.round === d.round),
              ),
            };
          }
          // H-3 fix: cap messages to prevent memory leak
          let newMessages = [...state.messages, d];
          if (newMessages.length > MAX_MESSAGES) {
            newMessages = newMessages.slice(newMessages.length - MAX_MESSAGES);
          }
          return {
            messages: newMessages,
            thinkingAgents: state.thinkingAgents.filter(
              (t) => !(t.agent_id === d.agent_id && t.branch === d.branch && t.round === d.round),
            ),
            agents: state.agents.map((a) =>
              a.id === d.agent_id ? { ...a, emotion: d.emotion } : a,
            ),
          };
        });
        break;

      case 'round_summary':
        set((state) => {
          const roundNum = event.data.round;
          const newRound = Math.max(state.currentRound, roundNum);
          // Record completion time for this round (only once per round number)
          const times = [...state.roundCompleteTimes];
          if (times.length < roundNum) {
            times.push(Date.now());
          }
          return { currentRound: newRound, roundCompleteTimes: times };
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
          branches: [
            // Mark parent as COMPLETED (it forked into children)
            ...state.branches.map((b) =>
              b.id === event.data.parent ? { ...b, status: 'COMPLETED' as const } : b,
            ),
            // Add children
            ...event.data.children.map((c) => ({
              id: c.id,
              parent_branch_id: event.data.parent,
              fork_round: 0,
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
          branches: state.branches.map((b) =>
            b.id === event.data.branch_id
              ? { ...b, status: event.data.status as 'ACTIVE' | 'COMPLETED' | 'PRUNED' }
              : b,
          ),
        }));
        break;

      case 'narration':
        set((state) => ({
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
        set((state) => ({
          interventionLog: [
            ...state.interventionLog,
            {
              branch_id: event.data.branch_id,
              text: event.data.text,
              round: event.data.round,
            },
          ],
        }));
        break;

      case 'intervention_injected':
        break;

      case 'simulation_done':
        set({
          status: 'done',
          isSimulationComplete: true,
          thinkingAgents: [],
        });
        break;

      case 'simulation_error':
        set({
          status: 'error',
          error: event.data.error || 'Simulation failed',
          thinkingAgents: [],
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

  reset: () => set(initialState),
}));
