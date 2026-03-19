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
  director_state?: ScenarioDirectorState | null;
  gameplay_state?: ScenarioGameplayState | null;
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

export interface CampaignBadge {
  id: string;
  badge_id: string;
  unlocked_at: string;
  source_profile_id?: string | null;
  source_scenario_id?: string | null;
}

export interface CampaignProfileSummary {
  user_id: string;
  user_name: string;
  total_runs: number;
  completed_challenges: number;
  total_bets: number;
  hit_bets: number;
  highest_archive_grade: string | null;
  created_at: string;
  updated_at: string;
  last_daily_challenge_completed_at?: string | null;
  last_daily_challenge_profile_id?: string | null;
  last_daily_challenge_scenario_id?: string | null;
}

export interface CampaignMastery {
  profile_id: string;
  runs: number;
  challenge_completions: number;
  signature_hits: number;
  aligned_hits: number;
  campaign_score: number;
  level: number;
  best_archive_grade: string | null;
  favorite_card_id?: string | null;
  next_level_score: number | null;
  score_to_next_level: number | null;
}

export interface CampaignFinalizeResult {
  scenario_id: string;
  already_finalized: boolean;
  campaign_score_delta: number;
  profile: CampaignProfileSummary;
  mastery: CampaignMastery;
  newly_unlocked_badges: CampaignBadge[];
  badges: CampaignBadge[];
}

export interface CampaignScenarioSummary {
  scenario_id: string;
  profile_id: string;
  archive_grade: string;
  profile_resonance: 'signature' | 'aligned' | 'offbeat';
  betting_hit?: boolean | null;
  most_used_card?: string | null;
  completed_daily_challenge: boolean;
  objective_completed_count?: number;
  objective_total_count?: number;
  commitment_outcome?: 'hit' | 'miss' | 'pending' | null;
  campaign_score_delta: number;
  finalized_at?: string | null;
}

export interface ScenarioDirectorObjective {
  id: string;
  kind: 'signature_arc_step' | 'branch_commitment';
  target_card_id?: string | null;
  reward_label?: string | null;
  created_at: string;
}

export interface ScenarioDirectorObjectivesState {
  generated_for_question?: string | null;
  generated_for_profile?: string | null;
  goals: ScenarioDirectorObjective[];
  last_updated_at?: string | null;
}

export interface ScenarioDirectorCommitmentState {
  active: boolean;
  branch_id?: string | null;
  branch_title?: string | null;
  committed_at_round?: number | null;
  committed_at?: string | null;
  outcome?: 'hit' | 'miss' | 'pending' | null;
}

export interface ScenarioDirectorState {
  objectives: ScenarioDirectorObjectivesState;
  commitment: ScenarioDirectorCommitmentState;
}

export interface ScenarioDirectorStateResponse extends ScenarioDirectorState {
  scenario_id: string;
}

export interface ScenarioGameplayCardUsage {
  card_id: string;
  profile_id: string;
  branch_id: string;
  branch_title: string;
  round: number;
  cost: number;
  directive: string;
  used_at: string;
}

export interface ScenarioGameplayCardsState {
  usage_log: ScenarioGameplayCardUsage[];
}

export interface ScenarioGameplayBet {
  bet_id: string;
  kind: 'branch_winner' | 'ending_tone' | 'profile_resonance';
  target_id?: string | null;
  target_label: string;
  confidence: number;
  user_name?: string | null;
  placed_at_round: number;
  placed_at: string;
  resolved: boolean;
}

export interface ScenarioGameplayBettingState {
  bets: ScenarioGameplayBet[];
}

export interface ScenarioGameplayArchiveBranchSnapshot {
  branch_id: string;
  title: string;
  probability: number;
}

export interface ScenarioGameplayArchiveState {
  key_moments: string[];
  branch_snapshots: ScenarioGameplayArchiveBranchSnapshot[];
}

export interface ScenarioGameplayState {
  cards: ScenarioGameplayCardsState;
  betting: ScenarioGameplayBettingState;
  archive: ScenarioGameplayArchiveState;
}

export interface ScenarioGameplayStateResponse extends ScenarioGameplayState {
  scenario_id: string;
}

export interface CampaignDailyChallengeStatus {
  user_id: string;
  profile_id: string;
  local_date: string;
  timezone_offset_minutes: number;
  completed: boolean;
  scenario_id?: string | null;
  completed_at?: string | null;
  most_used_card?: string | null;
  betting_hit?: boolean | null;
  profile_resonance?: 'signature' | 'aligned' | 'offbeat' | null;
  campaign_score_delta?: number | null;
}

export interface CampaignWeeklySummary {
  user_id: string;
  week_start: string;
  week_end: string;
  timezone_offset_minutes: number;
  total_runs: number;
  completed_daily_challenges: number;
  campaign_score_delta: number;
  hit_bets: number;
  top_profile_id?: string | null;
  best_archive_grade?: string | null;
  profile_runs: Record<string, number>;
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

export interface RetrospectiveInterventionPayload extends InterventionPayload {
  round_number: number;
}

export interface BatchInterventionPayload {
  interventions: InterventionPayload[];
}

export interface InterventionResponse {
  status: string;
  intervention_id: string;
  branch_id: string;
  round: number;
}

export interface RetrospectiveInterventionResponse {
  status: string;
  intervention_id: string;
  new_branch_id: string;
  source_branch_id: string;
  from_round: number;
}

export interface BatchInterventionEntry {
  branch_id: string;
  text: string;
  round: number;
  intervention_id: string;
}

export interface BatchInterventionResponse {
  status: string;
  count: number;
  interventions: BatchInterventionEntry[];
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

// ── Debate Arena ───────────────────────────────────────

export type DebatePhase =
  | 'opening'
  | 'crossfire'
  | 'rebuttal'
  | 'closing'
  | 'verdict';

export type DebateSide = 'proposition' | 'opposition' | 'judge';
export type DebatePredictionKind = 'winner' | 'verdict_tone';
export type DebateVerdictTone = 'order' | 'balance' | 'rupture';

export interface DebateParticipant {
  side: DebateSide;
  name: string;
  role: string;
}

export interface DebateScore {
  proposition: number;
  opposition: number;
  audience_meter: number;
}

export interface DebateTurn {
  id: string;
  sequence: number;
  phase: DebatePhase;
  speaker_side: DebateSide;
  speaker_name: string;
  content: string;
  score_delta?: Partial<Record<'proposition' | 'opposition', number>> | null;
  created_at: string;
}

export interface DebatePrediction {
  id: string;
  debate_id: string;
  kind: DebatePredictionKind;
  target_value: string;
  confidence: number;
  user_id: string;
  user_name: string;
  is_counterplay?: boolean;
  counterplay_phase?: DebatePhase | null;
  counterplay_variant?: 'balanced' | 'reversal' | null;
  score: number | null;
  score_reason: string | null;
  created_at: string;
  scored_at: string | null;
}

export interface DebatePhaseInsight {
  phase: DebatePhase;
  stakes: string;
  judge_focus: string;
  commentary: string;
  pressure_side: 'balanced' | 'proposition' | 'opposition';
  pressure_margin: number;
  turn_count: number;
  confidence_drift: {
    direction: 'balanced' | 'proposition' | 'opposition';
    phase_margin: number;
    cumulative_margin: number;
  };
}

export interface DebateResultSummary {
  winner: 'proposition' | 'opposition';
  verdict_tone: DebateVerdictTone;
  adjudication_mode?: 'deterministic' | 'llm_hybrid';
  score: DebateScore;
  breakdown: Record<string, { proposition: number; opposition: number }>;
  best_argument: string;
  best_rebuttal: string;
  judge_summary: string;
  judge_rationale?: {
    winner_reason?: string | null;
    loser_gap?: string | null;
    swing_factor?: string | null;
    closing_note?: string | null;
    dimension_rationales?: Record<string, string>;
    supporting_turns?: Array<{
      id: string;
      phase: DebatePhase;
      speaker_side: DebateSide;
      speaker_name: string;
      quote: string;
      why_it_matters: string;
    }>;
  } | null;
  replay: Array<{
    phase: DebatePhase;
    speaker_side: DebateSide;
    speaker_name: string;
    quote: string;
  }>;
}

export interface DebateVerdictEventPayload extends DebateResultSummary {
  phase_insights?: DebatePhaseInsight[];
}

export interface DebateCounterplayResult {
  debate_id: string;
  kind: DebatePredictionKind;
  target_value: string;
  confidence: number;
  phase: DebatePhase;
  variant: 'balanced' | 'reversal';
  outcome: 'hit' | 'miss';
  phase_score?: {
    proposition: number;
    opposition: number;
  } | null;
  explanation?: string | null;
  user_name: string;
  created_at: string;
}

export interface DebateSnapshot {
  id: string;
  question: string;
  motion: string;
  language: 'zh' | 'en';
  profile_id: string;
  scene_theme: string;
  status: 'queued' | 'live' | 'done' | 'error';
  current_phase: DebatePhase;
  created_at: string;
  updated_at: string;
  participants: DebateParticipant[];
  score: DebateScore;
  turns: DebateTurn[];
  available_prediction_options: {
    winner: string[];
    verdict_tone: string[];
  };
  phase_insights?: DebatePhaseInsight[];
  counterplay?: DebateCounterplayResult | null;
  result_ready: boolean;
}

export interface DebateResultPayload extends DebateSnapshot {
  result: DebateResultSummary;
  counterplay?: DebateCounterplayResult | null;
  predictions: DebatePrediction[];
}

export interface DebatePredictionRequest {
  kind: DebatePredictionKind;
  targetValue: string;
  confidence: number;
  userId?: string;
  userName?: string;
  isCounterplay?: boolean;
  counterplayPhase?: DebatePhase;
  counterplayVariant?: 'balanced' | 'reversal';
}

export type DebateWSEvent =
  | { type: 'status'; data: { status: DebateSnapshot['status']; error?: string } }
  | { type: 'agent_speak'; data: Omit<DebateTurn, 'created_at'> & { created_at?: string } }
  | { type: 'debate_phase_change'; data: { phase: DebatePhase } }
  | { type: 'debate_score_update'; data: { score: Omit<DebateScore, 'audience_meter'>; audience_meter: number } }
  | { type: 'debate_counterplay'; data: DebateCounterplayResult }
  | { type: 'debate_verdict'; data: DebateVerdictEventPayload };

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
  | { type: 'retrospective_start'; data: { branch_id: string; source_branch_id: string; from_round: number; text: string; intervention_id: string } }
  | { type: 'batch_intervention_applied'; data: { interventions: BatchInterventionEntry[] } }
  | { type: 'simulation_done' }
  | { type: 'simulation_error'; data: { error: string } };

// ── Type Aliases ─────────────────────────────────────────
export type BranchStatus = 'ACTIVE' | 'COMPLETED' | 'PRUNED';
export type Branch = BranchInfo;
