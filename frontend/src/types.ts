/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TypeScript Interfaces
   ═══════════════════════════════════════════════════════════ */

export type WebSearchFamily = 'polymarket' | 'finance' | 'academic' | 'news_deep';

export type WebSearchFamilyState =
  | 'loading'
  | 'empty'
  | 'rate_limited'
  | 'network_error'
  | 'ready'
  | 'failed'
  | 'unsupported_provider'
  | 'fallback_unconstrained'
  | 'search_skipped';

export type WebSearchFamilyDomainFilterMode = 'api' | 'query' | 'prompt' | 'none';
export type WebSearchFamilyDomainCoverage = 'full' | 'partial' | 'none';
export type WebSearchFamilyStatusReasonCode =
  | 'provider_no_domain_filter'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_body_error'
  | 'unsupported_provider'
  | 'fallback_unconstrained'
  | 'search_skipped'
  | 'family_search_error'
  | 'provider_unexpected_error';

interface WebSearchFamilyMetadata {
  state?: WebSearchFamilyState;
  disabled_reason?: string;
  status_reason?: string;
  status_reason_code?: WebSearchFamilyStatusReasonCode;
  domain_filter_mode?: WebSearchFamilyDomainFilterMode;
  domain_coverage?: WebSearchFamilyDomainCoverage;
  optimized_query?: string;
  search_pass?: 1 | 2;
}

type WebSearchFamilyEntry<TItem> = WebSearchFamilyMetadata & {
  items: TItem[];
};

export interface WebSearchContext {
  query: string;
  snippets: Array<{ text: string; source_url: string }>;
  provider: string;
  timestamp: string;
  cached: boolean;
  family_context?: {
    polymarket?: WebSearchFamilyEntry<{
      id: string;
      question: string;
      probability?: number;
      url?: string;
    }> & {
      configured_host?: string;
      geo_gated?: boolean;
    };
    finance?: WebSearchFamilyEntry<{
      id: string;
      title: string;
      summary?: string;
      source?: string;
      url?: string;
    }>;
    academic?: WebSearchFamilyEntry<{
      id: string;
      title: string;
      authors?: string[];
      citationCount?: number;
      abstract?: string;
      url?: string;
    }>;
    news_deep?: WebSearchFamilyEntry<{
      id: string;
      title: string;
      source?: string;
      publishedAt?: string;
      description?: string;
      url?: string;
    }>;
  } | null;
  native_citations?: Array<{ text: string; source_url: string }>;
}

export interface Scenario {
  id: string;
  question: string;
  language?: 'zh' | 'en';
  status: 'parsing' | 'simulating' | 'narrating' | 'done' | 'error' | 'cancelled';
  created_at: string;
  total_rounds?: number;
  mode?: 'raw' | 'blackboard' | null;
  visualization_enabled?: boolean;
  scene_theme?: string | null;
  web_search_context?: WebSearchContext | null;
  agents: AgentInfo[];
  branches: BranchInfo[];
  groups: GroupInfo[];  // P3-A
  hierarchical: boolean;  // P3-A
  messages?: AgentMessage[];  // Historical messages from DB
  director_state?: ScenarioDirectorState | null;
  gameplay_state?: ScenarioGameplayState | null;
  fork_debug?: ScenarioForkDebug | null;
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
  // Phase 3 F1: identity + memory
  agent_identity_id?: string | null;
  source_type?: 'generated' | 'custom' | 'replay' | null;
  is_returning?: boolean;
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

export interface CampaignContext {
  challenge_id?: string;
  challenge_local_date?: string;
  week_key?: string;
  weekly_track_id?: string;
  profile_id?: string;
  difficulty_tier?: 'easy' | 'normal' | 'hard' | 'expert';
  is_daily_challenge?: boolean;
  is_weekly_track?: boolean;
}

export interface CampaignBadge {
  id: string;
  badge_id: string;
  unlocked_at: string;
  source_profile_id?: string | null;
  source_scenario_id?: string | null;
}

export interface CampaignBadgeDefinition {
  id: string;
  name_key: string;
  description_key: string;
  category: string;
  one_time?: boolean;
}

export interface CampaignScoreBreakdownItem {
  id: string;
  label_key: string;
  points: number;
  applied: boolean;
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
  score_breakdown?: CampaignScoreBreakdownItem[];
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
  score_breakdown?: CampaignScoreBreakdownItem[];
  finalized_at?: string | null;
}

/** Backend response for the per-scenario campaign summary endpoint.
 *  - Explicit `{ has_campaign: false }` => the scenario has no campaign (suppress all campaign UI + finalize).
 *  - A full summary (optionally tagged `has_campaign: true`) => render campaign UI.
 *  - Older backends may omit the field and return either a full summary or null.
 */
export type CampaignScenarioSummaryResponse =
  | { has_campaign: false }
  | (CampaignScenarioSummary & { has_campaign?: true });

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
  revision?: number;
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
  revision?: number;
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
  current_streak?: number;
  next_refresh_at?: string;
  recent_daily_completion_days?: number;
}

export interface WeeklyTrack {
  id: string;
  title_zh: string;
  title_en: string;
  subtitle_zh: string;
  subtitle_en: string;
  profile_ids: string[];
  recommended_params?: {
    num_agents?: number;
    rounds?: number;
    mode?: 'blackboard' | 'raw';
    hierarchical?: boolean;
    visualization_enabled?: boolean;
    difficulty_tier?: string;
  };
  bonus_rules?: string;
  bonus_rules_zh?: string;
  bonus_rules_en?: string;
}

export interface WeeklyLeaderboardEntry {
  user_name: string;
  score: number;
  rank: number;
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
  weekly_track_id?: string;
  weekly_bonus_delta?: number;
  rank?: number;
  leaderboard_entries?: WeeklyLeaderboardEntry[];
}

export interface CampaignChallengeDefinition {
  id: string;
  question: string;
  question_en?: string | null;
  subtitle_zh: string;
  subtitle_en: string;
  profile_id: string;
  rounds: number;
  num_agents: number;
  mode: 'blackboard' | 'raw';
  visualization_enabled: boolean;
  difficulty_tier?: 'easy' | 'normal' | 'hard' | 'expert' | string;
}

export interface CampaignChallengeRotation {
  local_date: string;
  week_key: string;
  today_challenge: CampaignChallengeDefinition;
  weekly_challenges: CampaignChallengeDefinition[];
  weekly_track?: WeeklyTrack | null;
  iso_week_key?: string;
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
  replay_kind?: string | null;
  replay_source_branch_id?: string | null;
}

export interface AgentMessage {
  agent: string;
  agent_id: string;
  message: string;
  emotion: string;
  diverge?: string | null;
  branch: string;
  branch_title?: string;
  round: number;
  synthesized?: boolean;  // P3-A: true for Worker-synthesized messages
}

export interface ScenarioForkDebugEvent {
  parent_branch_id: string;
  parent_branch_title: string;
  fork_round: number;
  fork_reason: string;
  child_titles: string[];
  child_branch_ids: string[];
}

export interface ScenarioForkDebugBranchProposal {
  title: string;
  probability: number;
  description_excerpt?: string;
}

export interface ScenarioForkDebugRoundResult {
  should_fork: boolean;
  reason: string;
  branches: ScenarioForkDebugBranchProposal[];
}

export interface ScenarioForkDebugRoundCheck {
  branch_id: string;
  branch_title?: string;
  round: number;
  active_branch_count: number;
  max_branches: number;
  fork_detector_active_branch_limit?: number | null;
  detector_branch_rank?: number | null;
  detector_branch_budget_eligible?: boolean;
  sim_rounds: number;
  sensitivity: number;
  temperature?: number | null;
  prompt_variant?: 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
  diverge_signal_count: number;
  diverge_signals: string[];
  recent_summary_excerpt: string;
  detector_invoked: boolean;
  skip_reason?: string | null;
  decision: 'pending' | 'skipped' | 'no_fork' | 'fork_created';
  detector_result?: ScenarioForkDebugRoundResult | null;
  created_branch_count?: number;
  created_branch_ids?: string[];
  created_branch_titles?: string[];
}

export interface ScenarioForkDebug {
  message_count: number;
  diverge_message_count: number;
  diverge_rounds: number[];
  fork_event_count: number;
  forked_branch_count: number;
  fork_events: ScenarioForkDebugEvent[];
  round_checks?: ScenarioForkDebugRoundCheck[];
}

export interface InterventionPayload {
  branch_id: string;
  text: string;
  card_id?: string;
  profile_id?: string;
  directive?: string;
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
  pending_count?: number;
  queued_ahead?: number;
  gameplay_state?: ScenarioGameplayState | null;
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
  gameplay_state?: ScenarioGameplayState | null;
}

export interface StoryData {
  scenario_id: string;
  question: string;
  status: string;
  branches: StoryBranch[];
  verdict?: string | null;
  verdict_confidence?: 'high' | 'medium' | 'low' | null;
  full_report?: FullReport | FullReportTruncatedMarker | null;
}

export type StoryResponse = StoryData;

// ── Result Report Upgrade (Sprint S0 Contract Freeze) ──

export interface ReportVerdict {
  headline_answer: string;
  likelihood: {
    probability: number;
    interval: [number, number];
    wep: string;
  };
  analytic_confidence: {
    level: 'high' | 'medium' | 'low';
    basis: string;
    basis_i18n?: { zh?: string; en?: string };
  };
  disclaimer: string | null;
}

export type KnownChartType = 'probability_bar' | 'faction_share';

export interface ProbabilityBarBranch {
  branch_id: string;
  label: string;
  probability: number;
  dominant: boolean;
  status: string;
}

export interface ProbabilityBarChartData {
  status: 'available' | 'partial' | 'missing';
  reason: string | null;
  sort: string[];
  branches: ProbabilityBarBranch[];
}

export interface FactionShareFaction {
  faction_key: string;
  label: string;
  member_count: number;
  share: number;
  stance_center: number;
  confidence: number;
}

export interface FactionShareChartData {
  status: 'available' | 'partial' | 'missing';
  reason: string | null;
  factions: FactionShareFaction[];
  relation_edge_count: number;
  avg_opposition: number | null;
}

export interface ReportChartBase {
  kind: string;
  type: string;
}

export type ReportChart =
  | (ReportChartBase & { type: 'probability_bar'; data: ProbabilityBarChartData })
  | (ReportChartBase & { type: 'faction_share'; data: FactionShareChartData })
  | (ReportChartBase & { type: Exclude<string, 'probability_bar' | 'faction_share'>; data: Record<string, unknown> });


export interface ReportSection {
  id: string;
  title: string;
  title_i18n: { zh: string; en: string };
  intent: string;
  body_md_i18n: { zh: string; en: string };
  evidence_refs: string[];
  charts: ReportChart[];
}

export interface ReportEvidence {
  id: string;
  branch_id: string;
  round_id: string;
  round_number: number;
  agent_id: string;
  agent_name: string;
  message_id: string;
  quote: string;
  kind: 'utterance' | 'causal_fact' | 'faction_event' | 'interview';
}

export interface IndicatorToWatch {
  signal: string;
  direction: 'up' | 'down';
  note: string;
  // S4 enrichment — optional so pre-S4 persisted reports (which lack these) still type-check.
  threshold?: string;
  observation?: string;
  time_horizon?: string;
  rationale?: string;
  evidence_refs?: string[];
}

export interface DissentingView {
  runner_up_branch_id: string;
  why_verdict_could_be_wrong: string;
  what_almost_won: string;
}

export interface FullReport {
  version: string;
  generated_at: string;
  generation_mode: 'generation' | 'rewrite' | 'static';
  target_branch_id: string;
  target_branch_sort: string[];
  language: 'zh' | 'en';
  available_languages: ('zh' | 'en')[];
  title: string;
  title_i18n: { zh: string; en: string };
  summary: string;
  summary_i18n: { zh: string; en: string };
  status: 'complete' | 'partial' | 'failed' | 'skipped' | 'generating';
  tier: 'generation' | 'rewrite' | 'static';
  verdict: ReportVerdict;
  sections: ReportSection[];
  evidence: ReportEvidence[];
  indicators_to_watch: IndicatorToWatch[];
  // Nullable: the Reducer returns `null` for single-branch / missing-result scenarios
  // (backend schema: `DissentingView | None`). Consumers must null-check.
  dissenting: DissentingView | null;
  key_participants: Array<{
    agent_name: string;
    impact_score: number;
    key_moment_hits: number;
  }>;
  follow_ups: string[];
  limitations: string;
  interview_evidence: Record<string, unknown>[];
  premortem: Record<string, unknown>[];
  language_status: { zh: 'available' | 'missing'; en: 'available' | 'missing' } | null;
}

export interface FullReportTruncatedMarker {
  status: 'partial';
  truncated: true;
}

export interface ToolTraceSummary {
  tool: string;
  query: string;
  item_count: number;
  elapsed_ms: number;
}

export interface ResultReportSSEEvent {
  event: 'report_started' | 'report_section_delta' | 'report_section_complete' | 'report_failed' | 'report_complete' | string;
  data: {
    report_id?: string;
    section_id?: string;
    status: 'pending' | 'generating' | 'complete' | 'partial' | 'failed' | 'skipped' | string;
    message?: string;
    tool_trace: ToolTraceSummary[];
    error_code?: string;
  };
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
  replay_kind?: string | null;
  replay_source_branch_id?: string | null;
  question_answer?: string | null;
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
  persona?: string;
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
  /**
   * LLM-generated description of the core strategic clash this phase
   * (what each side is trying to do and why). Empty string when the
   * LLM enhancement step did not run or did not return a usable value.
   */
  strategy?: string;
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

// Phase A contract freeze: Oracle Chambers / Worldline Roundtable
export type RoundtableDiscussionFormat = 'deep_dive' | 'quick_review' | 'clash_mode';
export type RoundtableCastMode = 'smart_pick' | 'custom';

export interface EndingRoomPlanningData {
  room_id: string;
  discussion_format: RoundtableDiscussionFormat;
  cast_mode: RoundtableCastMode;
  planned_turn_count: number;
  phase: string;
}

export type EndingRoomType =
  | 'ending_chamber'
  | 'worldline_roundtable'
  | 'one_move_only'
  | 'crossline_gallery';

export type EndingRoomStatus = 'draft' | 'live' | 'done' | 'error';
export type EndingRoomPhase = 'opening' | 'crossfire' | 'rebuttal' | 'closing' | 'verdict';
export type EndingRoomRoleSlot = 'agent' | 'representative' | 'archivist' | 'critic' | 'observer' | 'user';
export type EndingRoomThreadMode = 'room' | 'followup';
export type EndingRoomInteractionMode =
  | 'auto_recap'
  | 'archivist_route'
  | 'hotseat'
  | 'all_present'
  | 'thread_followup'
  | 'epilogue'
  | 'evidence_card';
export type EndingRoomTurnSource = 'auto_recap' | 'user_turn' | 'assistant_followup';

export interface EndingRoomScope {
  scenario_id: string;
  anchor_branch_id: string | null;
  room_type: EndingRoomType;
  participant_set_hash: string;
  language: 'zh' | 'en';
}

export interface EndingRoomParticipant {
  id: string;
  room_id: string;
  source_branch_id?: string | null;
  source_agent_id?: string | null;
  role_slot: EndingRoomRoleSlot;
  display_name: string;
  worldline_echo_key?: string | null;
  persona_snapshot_json?: Record<string, unknown> | null;
  visibility_scope_json?: Record<string, unknown> | null;
}

export interface EndingRoomTurn {
  id: string;
  room_id: string;
  thread_id?: string | null;
  sequence: number;
  phase: EndingRoomPhase;
  participant_id: string;
  content: string;
  emotion: string;
  source?: EndingRoomTurnSource;
  interaction_mode?: EndingRoomInteractionMode;
  memory_partition_id?: string | null;
  addressed_agent_ids_json?: string[] | null;
  question_anchor_ids_json?: string[] | null;
  cited_branch_id?: string | null;
  cited_refs_json?: Record<string, unknown> | null;
  created_at: string;
}

export interface EndingRoomThread {
  id: string;
  room_id: string;
  title: string;
  mode: EndingRoomThreadMode;
  interaction_mode: EndingRoomInteractionMode;
  participant_set_hash: string;
  memory_partition_id: string;
  addressed_agent_ids_json?: string[] | null;
  question_anchor_ids_json?: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface EndingRoomThreadSnapshot extends EndingRoomThread {
  room_type: EndingRoomType;
  room_title: string;
  room_status: EndingRoomStatus;
  language: 'zh' | 'en';
  turns: EndingRoomTurn[];
}

export interface EndingRoomPhaseInsight {
  phase: EndingRoomPhase;
  stakes: string;
  moderator_focus: string;
  commentary: string;
  insight_body?: string;
}

export interface EndingRoomSupportingTurn {
  turn_id: string | null;
  phase: EndingRoomPhase;
  participant_id: string;
  label: string;
  explanation: string;
}

export interface EndingRoomResult {
  summary: string;
  next_move?: string | null;
  archivist_note?: string | null;
  phase_insights?: EndingRoomPhaseInsight[];
  supporting_turns?: EndingRoomSupportingTurn[];
  scope?: Record<string, unknown> | null;
  error?: StructuredWsError | null;
}

export interface EndingRoomSnapshot {
  id: string;
  scenario_id: string;
  anchor_branch_id: string | null;
  room_type: EndingRoomType;
  discussion_format?: RoundtableDiscussionFormat;
  cast_mode?: RoundtableCastMode;
  title: string;
  language: 'zh' | 'en';
  status: EndingRoomStatus;
  current_phase: EndingRoomPhase;
  created_at: string;
  updated_at: string;
  memory_partition_version?: number;
  memory_partition_id?: string | null;
  selection_recipe?: RoundtableSelectionRecipe | null;
  participants: EndingRoomParticipant[];
  threads: EndingRoomThread[];
  turns: EndingRoomTurn[];
  result_ready: boolean;
}

export interface EndingRoomResultPayload extends EndingRoomSnapshot {
  result: EndingRoomResult;
}

export interface RoundtableRepresentativeSelection {
  branchId: string;
  agentId: string;
}

export interface RoundtableWitnessSelection {
  branchId: string;
  agentId: string;
}

export type RoundtableSelectionRecipe =
  | 'representative'
  | 'manual_shortlist'
  | 'expert_witness'
  | 'trait_mix'
  | 'fault_line_first'
  | 'witness_augmented';

export interface CreateEndingRoomRequest {
  roomType: EndingRoomType;
  discussionFormat?: RoundtableDiscussionFormat;
  castMode?: RoundtableCastMode;
  anchorBranchId?: string | null;
  selectedBranchIds: string[];
  selectedAgentIds?: string[];
  selectedRepresentatives?: RoundtableRepresentativeSelection[];
  selectedWitness?: RoundtableWitnessSelection | null;
  selectionRecipe?: RoundtableSelectionRecipe;
  language?: 'zh' | 'en';
}

export interface CreateEndingRoomThreadRequest {
  title?: string | null;
  addressedAgentIds?: string[];
  questionAnchorIds?: string[];
  interactionMode?: EndingRoomInteractionMode;
}

export interface AppendEndingRoomUserTurnRequest {
  content: string;
  addressedAgentIds?: string[];
  questionAnchorIds?: string[];
  interactionMode?: EndingRoomInteractionMode | null;
  citedBranchId?: string | null;
  citedRefsJson?: Record<string, unknown> | null;
}

export interface StructuredWsError {
  code?: string;
  message?: string;
}

export interface WsEventMeta {
  stream_id?: string;
  sequence?: number;
  event_id?: string;
  manager_instance_id?: string;
  emitted_at?: string;
}

export type DebateWSEvent =
  (
    | { type: 'auth_ok' }
    | { type: 'heartbeat'; data: { ts: string } }
    | {
      type: 'status';
      data: {
        status: DebateSnapshot['status'];
        error?: string | StructuredWsError;
      };
      }
    | { type: 'agent_speak'; data: Omit<DebateTurn, 'created_at'> & { created_at?: string } }
    | { type: 'debate_phase_change'; data: { phase: DebatePhase } }
    | { type: 'debate_score_update'; data: { score: Omit<DebateScore, 'audience_meter'>; audience_meter: number } }
    | { type: 'debate_participants_update'; data: { participants: DebateParticipant[] } }
    | { type: 'debate_counterplay'; data: DebateCounterplayResult }
    | { type: 'debate_verdict'; data: DebateVerdictEventPayload }
  ) & { meta?: WsEventMeta };

export type AgentConversationWSEvent =
  | { type: 'auth_ok'; request_id?: string }
  | { type: 'turn_started'; thread_id: string; turn_id: string; sequence: number; request_id?: string; model?: string }
  | { type: 'turn_token_delta'; turn_id: string; delta: string; sequence?: number; model?: string }
  | { type: 'turn_completed'; turn_id: string; thread_id?: string; sequence: number; status: 'committed' | 'aborted'; model?: string }
  | { type: 'turn_error'; turn_id: string; thread_id?: string; sequence?: number; code: string; message?: string; status?: string; model?: string; request_id?: string };

export type EndingRoomWSEvent =
  (
    | { type: 'auth_ok' }
    | { type: 'heartbeat'; data: { ts: string } }
    | { type: 'status'; data: { status: EndingRoomStatus; error?: string | StructuredWsError } }
    | { type: 'ending_room_planning'; data: EndingRoomPlanningData }
    | { type: 'ending_room_turn_start'; data: { room_id: string; thread_id?: string | null; turn_id: string; participant_id: string; phase: EndingRoomPhase; sequence: number } }
    | { type: 'ending_room_turn_delta'; data: { room_id: string; thread_id?: string | null; turn_id: string; participant_id: string; delta: string; chunk_index: number } }
    | { type: 'ending_room_turn_commit'; data: EndingRoomTurn }
    | {
      type: 'ending_room_turn_error';
      data: {
        room_id: string;
        thread_id?: string | null;
        turn_id: string;
        participant_id?: string;
        message?: string;
        error?: string;
        code?: string;
        recoverable?: boolean;
      };
    }
    | { type: 'ending_room_phase_change'; data: { phase: EndingRoomPhase } }
    | { type: 'ending_room_result_ready'; data: { result: EndingRoomResult } }
    | { type: 'ending_room_thread_created'; data: EndingRoomThreadSnapshot }
    | { type: 'ending_room_scope_notice'; data: { thread_id: string; memory_partition_id: string } }
  ) & { meta?: WsEventMeta };

// ── Roundtable SSE Events ────────────────────────────────

export type AnalystSSEEvent =
  | { type: 'analyst_thinking'; action: string; params: Record<string, unknown>; iteration: number }
  | { type: 'analyst_tool_result'; action: string; summary: string; iteration: number; elapsed_ms: number }
  | { type: 'analyst_response'; answer: string; iterations: number; stopped_reason?: string; error?: string };

export type SurveySSEEvent = {
  type: 'survey_response';
  participant_id: string;
  display_name: string;
  role: string;
  source_agent_id: string | null;
  source_branch_id: string | null;
  agent_identity_id: string | null;
  answer: string;
  elapsed_ms: number;
  error?: string;
};

// ── WebSocket Events ─────────────────────────────────────

export type WSEvent =
  (
    | { type: 'auth_ok' }
    | { type: 'heartbeat'; data: { ts: string } }
    | { type: 'status'; data: { status: string; hierarchical?: boolean } }
    | { type: 'agent_speak_start'; data: { agent: string; agent_id: string; branch: string; round: number } }
    | { type: 'agent_speak_delta'; data: { agent: string; agent_id: string; delta: string; branch: string; round: number } }
    | { type: 'agent_speak'; data: AgentMessage }
    | { type: 'round_summary'; data: { branch_id: string; round: number; summary: string } }
    | { type: 'branch_init'; data: { id: string; title: string; probability: number; status: string; parent_branch_id: string | null } }
    | { type: 'branch_fork'; data: { parent: string; children: Array<{ id: string; title: string; description?: string; fork_round: number; probability: number }>; reason: string } }
    | { type: 'branch_prune'; data: { branch_id: string; reason: string } }
    | { type: 'branch_update'; data: { branch_id: string; status: string } }
    | { type: 'narration'; data: { branch_id: string; title: string; story: string; insight: string } }
    | {
      type: 'intervention_applied';
      data: {
        branch_id: string;
        text: string;
        round: number;
        intervention_id: string;
        status?: string;
        pending_count?: number;
        queued_ahead?: number;
      };
    }
    | { type: 'intervention_injected'; data: { branch_id: string; round: number; text: string; intervention_id?: string; status?: string; card_id?: string; mode?: string } }
    | { type: 'retrospective_start'; data: { branch_id: string; source_branch_id: string; from_round: number; text: string; intervention_id: string } }
    | { type: 'batch_intervention_applied'; data: { interventions: BatchInterventionEntry[] } }
    | {
      type: 'kg:delta';
      data: {
        scenario_id: string;
        version: number;
        added: unknown[];
        updated: unknown[];
        deleted: string[];
        snapshot_invalidated: boolean;
      };
    }
    | {
      type: 'kg:snapshot_invalidated';
      data: {
        scenario_id: string;
        version: number;
      };
    }
    | { type: 'simulation_done' }
    | {
      type: 'simulation_error';
      data: { error: string | StructuredWsError };
      }
    | { type: 'simulation_cancelled'; reason: string }
  ) & { meta?: WsEventMeta };

// ── Phase 3: Agent Identity (F1/F3) ─────────────────────

export interface AgentIdentityInfo {
  id: string;
  user_id: string;
  kind: 'generated' | 'custom';
  display_name: string;
  role: string;
  persona?: string | null;
  decision_bias?: Record<string, unknown> | null;
  decision_bias_json?: string | null;
  knowledge_domains?: KnowledgeDomain[] | string[] | null;
  knowledge_domain_json?: string | null;
  preferred_tier?: 'IMPORTANT' | 'CROWD' | null;
  continuity_key: string;
  created_at: string;
  updated_at: string;
}

export type KnowledgeDomain =
  | 'economics' | 'politics' | 'technology' | 'science' | 'military'
  | 'culture' | 'environment' | 'health' | 'education' | 'law'
  | 'philosophy' | 'history' | 'psychology' | 'sociology' | 'religion';

// ── Phase 3: Agent Memory & Growth (P1-1/P1-2) ─────────

export interface AgentMemoryEntry {
  summary: string;
  scenario_id: string | null;
  created_at: string | null;
}

export interface AgentGrowthEvent {
  id: string;
  scenario_id: string | null;
  branch_id: string | null;
  round_number: number | null;
  event_type: string; // stance_shift | alliance | betrayal | alliance_formed | alliance_broken
  summary: string;
  metrics_json: string | null;
  created_at: string | null;
}

export interface AgentIdentityProfile extends Omit<AgentIdentityInfo, 'created_at' | 'updated_at'> {
  decision_bias?: Record<string, unknown> | null;
  knowledge_domains?: KnowledgeDomain[] | string[] | null;
  preferred_tier?: 'IMPORTANT' | 'CROWD' | null;
  is_favorite?: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ScenarioAgentProfileResponse {
  source: 'generated' | 'custom' | 'replay' | 'unknown';
  identity_id: string | null;
  profile: AgentIdentityProfile | null;
  memories: AgentMemoryEntry[];
  growth_events: AgentGrowthEvent[];
}

// ── Replay Trace (P1-1) ─────────────────────────────────
export interface ReplayTraceNode {
  branch_id: string;
  parent_branch_id: string | null;
  replay_source_branch_id: string | null;
  origin_round: number;
  replay_kind: string;
  status: string;
  created_at: string;
}

export interface ReplayTraceResponse {
  nodes: ReplayTraceNode[];
  next_cursor: string | null;
}

// ── Phase 3: Checkpoints (P1-3 / counterfactual replay) ──

export interface CheckpointInfo {
  id: string;
  scenario_id: string;
  branch_id: string;
  round_number: number;
  compressed_summary: string | null;
  blackboard_json: string | null;
  created_at: string | null;
}

// ── Type Aliases ─────────────────────────────────────────
export type BranchStatus = 'ACTIVE' | 'COMPLETED' | 'PRUNED';
export type Branch = BranchInfo;

// ── Public Artifact Export (F1 Gallery) ─────────────────
export const PUBLIC_ARTIFACT_SCHEMA_VERSION = 'public_artifact.v1' as const;
export type PublicArtifactConfidence = 'high' | 'medium' | 'low';

export interface PublicArtifactBranchVerdict {
  branch_index: number;
  title: string;
  verdict: string;
  confidence: PublicArtifactConfidence;
}

export interface PublicArtifactProbabilityBar {
  branch_index: number;
  label: string;
  probability: number;
}

export interface PublicArtifactTranscriptExcerpt {
  branch_index: number;
  agent_name: string;
  text: string;
}

export interface PublicArtifactSourceDomain {
  domain: string;
  source_count: number;
}

export interface PublicArtifactSourceSummary {
  domains: PublicArtifactSourceDomain[];
}

export interface PublicArtifact {
  schema_version: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION;
  question: string;
  language: string;
  display_agent_names: string[];
  branch_verdicts: PublicArtifactBranchVerdict[];
  probability_bars: PublicArtifactProbabilityBar[];
  transcript_excerpts: PublicArtifactTranscriptExcerpt[];
  source_summary: PublicArtifactSourceSummary;
}

// ── Document Seed (F3 DocumentSeedPanel) ─────────────────
export interface WorldContextEntity {
  name: string;
  role: string;
  traits: string[];
  perspective: string;
}

export interface WorldContextSourceMetadata {
  filename: string;
  content_type: string;
  suffix: string;
  byte_count: number;
  char_count: number;
  extraction_method: 'pdf' | 'text' | 'markdown';
}

export interface WorldContext {
  title: string;
  summary: string;
  key_entities: WorldContextEntity[];
  constraints: string[];
  evidence_snippets: string[];
  source_metadata: WorldContextSourceMetadata;
  warnings: string[];
}

export interface DocumentSeedAgentPreview {
  name: string;
  role: string;
  persona: string;
}

export interface DocumentSeedResponse {
  world_context: WorldContext;
  agents_preview: DocumentSeedAgentPreview[];
  entities_extracted: number;
  agents_failed: number;
  source: WorldContextSourceMetadata;
  warnings: string[];
}
