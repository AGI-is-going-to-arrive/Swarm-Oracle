/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TypeScript Interfaces
   ═══════════════════════════════════════════════════════════ */

export interface Scenario {
  id: string;
  question: string;
  status: 'parsing' | 'simulating' | 'narrating' | 'done' | 'error';
  created_at: string;
  total_rounds?: number;
  mode?: 'raw' | 'blackboard' | null;
  visualization_enabled?: boolean;
  scene_theme?: string | null;
  agents: AgentInfo[];
  branches: BranchInfo[];
  groups: GroupInfo[];  // P3-A
  hierarchical: boolean;  // P3-A
  messages?: AgentMessage[];  // Historical messages from DB
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  persona?: string;
  tier: 'CORE' | 'IMPORTANT' | 'CROWD';
  stance?: string;
  emotion: string;
  group_id?: string;  // P3-A
  group_name?: string;  // P3-A
}

// P3-A: Agent group info
export interface GroupInfo {
  id: string;
  name: string;
  leader_agent_id: string | null;
  member_count: number;
}

export interface AgentGroupDetail {
  id: string;
  name: string;
  parent_group_id: string | null;
  leader: { id: string; name: string; role: string } | null;
  members: Array<{ id: string; name: string; role: string; is_leader: boolean }>;
  member_count: number;
}

// P3-B: Predictions & Leaderboard
export interface PredictionInfo {
  id: string;
  scenario_id: string;
  user_name: string;
  prediction_text: string;
  confidence: number;
  score: number | null;
  score_reason: string | null;
  created_at: string;
}

export interface LeaderboardEntry {
  user_id: string;
  user_name: string;
  total_predictions: number;
  avg_score: number;
  best_score: number;
  win_streak: number;
}

export interface BranchInfo {
  id: string;
  parent_branch_id: string | null;
  fork_round: number;
  fork_reason: string;
  title: string;
  description?: string;
  summary: string;
  story: string;
  insight: string;
  key_moments: string[];
  probability: number;
  status: 'ACTIVE' | 'COMPLETED' | 'PRUNED';
}

export interface AgentMessage {
  agent: string;
  agent_id: string;
  message: string;
  emotion: string;
  branch: string;
  round: number;
  synthesized?: boolean;  // P3-A: true for Worker-synthesized messages
}

export interface InterventionPayload {
  branch_id: string;
  text: string;
}

export interface InterventionResponse {
  status: string;
  intervention_id: string;
  branch_id: string;
  round: number;
}

export interface StoryData {
  scenario_id: string;
  question: string;
  status: string;
  branches: StoryBranch[];
}

export interface StoryBranch {
  id: string;
  title: string;
  probability: number;
  status: string;
  story: string;
  insight: string;
  key_moments: string[];
  parent_branch_id: string | null;
  fork_reason: string;
}

// ── WebSocket Events ─────────────────────────────────────

export type WSEvent =
  | { type: 'status'; data: { status: string; hierarchical?: boolean } }
  | { type: 'agent_speak_start'; data: { agent: string; agent_id: string; branch: string; round: number } }
  | { type: 'agent_speak_delta'; data: { agent: string; agent_id: string; delta: string; branch: string; round: number } }
  | { type: 'agent_speak'; data: AgentMessage }
  | { type: 'round_summary'; data: { branch_id: string; round: number; summary: string } }
  | { type: 'branch_init'; data: { id: string; title: string; probability: number; status: string; parent_branch_id: string | null } }
  | { type: 'branch_fork'; data: { parent: string; children: Array<{ id: string; title: string; description?: string; probability: number }>; reason: string } }
  | { type: 'branch_prune'; data: { branch_id: string; reason: string } }
  | { type: 'branch_update'; data: { branch_id: string; status: string } }
  | { type: 'narration'; data: { branch_id: string; title: string; story: string; insight: string } }
  | { type: 'intervention_applied'; data: { branch_id: string; text: string; round: number; intervention_id: string } }
  | { type: 'intervention_injected'; data: { branch_id: string; round: number; text: string } }
  | { type: 'simulation_done' }
  | { type: 'simulation_error'; data: { error: string } };

// ── Type Aliases ─────────────────────────────────────────
export type BranchStatus = 'ACTIVE' | 'COMPLETED' | 'PRUNED';
export type Branch = BranchInfo;
