/* ═══════════════════════════════════════════════════════════
   SwarmOracle — REST API Client
   ═══════════════════════════════════════════════════════════ */

import type {
  Scenario, Branch, StoryData, AgentInfo, AgentGroupDetail,
  InterventionPayload, InterventionResponse, RetrospectiveInterventionPayload,
  RetrospectiveInterventionResponse, BatchInterventionPayload, BatchInterventionResponse,
  PredictionInfo, LeaderboardEntry,
  DebatePrediction, DebatePredictionRequest, DebateResultPayload, DebateSnapshot,
  CampaignBadge, CampaignChallengeRotation, CampaignDailyChallengeStatus, CampaignFinalizeResult, CampaignMastery, CampaignProfileSummary, CampaignScenarioSummary, CampaignWeeklySummary,
  ScenarioDirectorState, ScenarioDirectorStateResponse, ScenarioGameplayState, ScenarioGameplayStateResponse,
} from '../types';

const BASE = '/api';

const DEFAULT_TIMEOUT = 30000; // M-5 fix: 30s default request timeout
const SOCIAL_COPY_TIMEOUT = 90000;

export interface RequestOptions {
  signal?: AbortSignal;
}

interface RequestRetryOptions {
  retryTransient?: boolean;
  retryAttempts?: number;
}

const RETRIABLE_RESPONSE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BACKOFF_MS = 400;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(`API ${status} ${code}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function parseJsonResponse<T>(res: Response, path: string): Promise<T> {
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) {
    const body = await res.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    throw new Error(
      `API returned non-JSON response for ${path} (${contentType || 'unknown'})${detail}`,
    );
  }
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `API returned invalid JSON for ${path}: ${error instanceof Error ? error.message : 'parse failed'}`,
    );
  }
}

async function parseErrorResponse(res: Response): Promise<Error> {
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await res.text().catch(() => '');

  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(body) as {
        detail?: string | { code?: string; message?: string };
      };
      if (typeof parsed.detail === 'object' && parsed.detail !== null) {
        const code = typeof parsed.detail.code === 'string' ? parsed.detail.code : 'UNKNOWN_ERROR';
        const message = typeof parsed.detail.message === 'string' ? parsed.detail.message : 'Request failed';
        return new ApiError(res.status, code, message);
      }
      if (typeof parsed.detail === 'string' && parsed.detail) {
        return new ApiError(res.status, 'UNSTRUCTURED_ERROR', parsed.detail);
      }
    } catch {
      // Fall through to the raw body text below.
    }
  }

  return new ApiError(res.status, 'UNSTRUCTURED_ERROR', body);
}

export interface LlmProviderRequestOptions {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  reasoningEffort?: string;
  temperature?: number;
  branchSensitivity?: number;
  forkPromptVariant?: 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
  forkDetectorActiveBranchLimit?: number;
  userId?: string;
  disableUserQuota?: boolean;
}

export interface CreateScenarioOptions extends LlmProviderRequestOptions {
  question: string;
  rounds?: number;
  numAgents?: number;
  mode?: 'raw' | 'blackboard';
  hierarchical?: boolean;
  visualizationEnabled?: boolean;
}

export interface LlmProbeResponse {
  status: string;
  model: string;
  local_provider: boolean;
  allow_disable_user_quota: boolean;
  estimated_parallelism: number;
  tested_parallelism: number;
  recommended: {
    agents_min: number;
    agents_max: number;
    rounds_min: number;
    rounds_max: number;
  };
  failure?: string | null;
}

async function fetchWithTimeout(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => {
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error(`API request aborted: ${path}`);
      }
      throw new Error(`API request timed out after ${timeoutMs}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT,
  retryOptions?: RequestRetryOptions,
): Promise<T> {
  // M-9 fix: only set Content-Type for requests with a body
  const headers: Record<string, string> = {};
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const retryTransient = retryOptions?.retryTransient ?? false;
  const retryAttempts = retryOptions?.retryAttempts ?? 0;

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchWithTimeout(path, {
      ...init,
      // H-3 fix: spread init.headers AFTER defaults so user overrides win
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    }, timeoutMs);
    if (res.ok) {
      return parseJsonResponse<T>(res, path);
    }

    const shouldRetry = (
      retryTransient
      && attempt < retryAttempts
      && RETRIABLE_RESPONSE_STATUSES.has(res.status)
    );
    if (!shouldRetry) {
      throw await parseErrorResponse(res);
    }

    await sleep(DEFAULT_RETRY_BACKOFF_MS * (attempt + 1));
  }
}

async function safeGet<T>(
  path: string,
  options?: RequestOptions,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<T> {
  return request(
    path,
    { signal: options?.signal },
    timeoutMs,
    { retryTransient: true, retryAttempts: DEFAULT_RETRY_ATTEMPTS },
  );
}

/** Fetch response as raw text (for Markdown export). */
async function requestText(path: string): Promise<string> {
  const res = await fetchWithTimeout(path, undefined, DEFAULT_TIMEOUT);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.text();
}

/** POST /api/health — server + LLM connectivity test */
export async function healthCheck(): Promise<{ server: string; llm: Record<string, unknown> }> {
  return request('/health', { method: 'POST' });
}

/** POST /api/health/test — test LLM connectivity with optional BYOK credentials */
export async function testLlmConnection(
  apiKey?: string,
  baseUrl?: string,
  model?: string,
): Promise<{ server: string; llm: { status: string; model: string; response?: string; error?: string }; probe?: LlmProbeResponse | null }> {
  return request('/health/test', {
    method: 'POST',
    body: JSON.stringify({
      ...(apiKey && { llm_api_key: apiKey }),
      ...(baseUrl && { llm_base_url: baseUrl }),
      ...(model && { llm_model: model }),
    }),
  });
}

/** POST /api/scenario — create a new "What If…" scenario */
export async function createScenario(
  options: CreateScenarioOptions,
): Promise<Scenario> {
  const {
    question,
    rounds,
    numAgents,
    mode,
    hierarchical,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    reasoningEffort,
    temperature,
    branchSensitivity,
    forkPromptVariant,
    forkDetectorActiveBranchLimit,
    visualizationEnabled,
    userId,
    disableUserQuota,
  } = options;
  return request('/scenario', {
    method: 'POST',
    body: JSON.stringify({
      question,
      ...(rounds != null && { rounds }),
      ...(numAgents != null && { num_agents: numAgents }),
      ...(mode != null && { mode }),
      ...(hierarchical != null && { hierarchical }),
      ...(llmApiKey && { llm_api_key: llmApiKey }),
      ...(llmBaseUrl && { llm_base_url: llmBaseUrl }),
      ...(llmModel && { llm_model: llmModel }),
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      ...(temperature != null && { temperature }),
      ...(branchSensitivity != null && { branch_sensitivity: branchSensitivity }),
      ...(forkPromptVariant && { fork_prompt_variant: forkPromptVariant }),
      ...(forkDetectorActiveBranchLimit != null && { fork_detector_active_branch_limit: forkDetectorActiveBranchLimit }),
      ...(visualizationEnabled != null && { visualization_enabled: visualizationEnabled }),
      ...(userId && { user_id: userId }),
      ...(disableUserQuota != null && { disable_user_quota: disableUserQuota }),
    }),
  });
}

/** POST /api/debate — create a new Debate Arena match */
export async function createDebate(
  question: string,
  profileHint?: string,
  options?: LlmProviderRequestOptions,
): Promise<DebateSnapshot> {
  return request('/debate', {
    method: 'POST',
    body: JSON.stringify({
      question,
      ...(profileHint ? { profile_hint: profileHint } : {}),
      ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
      ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
      ...(options?.llmModel && { llm_model: options.llmModel }),
      ...(options?.reasoningEffort && { reasoning_effort: options.reasoningEffort }),
      ...(options?.userId && { user_id: options.userId }),
    }),
  });
}

/** GET /api/debate/:id — get debate live snapshot */
export async function getDebate(id: string): Promise<DebateSnapshot> {
  return safeGet(`/debate/${id}`);
}

/** GET /api/debate/:id/result — get finalized debate result */
export async function getDebateResult(id: string): Promise<DebateResultPayload> {
  return safeGet(`/debate/${id}/result`);
}

/** POST /api/debate/import-replay — persist a replay snapshot as a local debate run */
export async function importReplayDebate(debate: DebateResultPayload): Promise<DebateSnapshot> {
  return request('/debate/import-replay', {
    method: 'POST',
    body: JSON.stringify({ debate }),
  });
}

/** POST /api/debate/:id/predict — submit a debate bet */
export async function predictDebate(
  debateId: string,
  payload: DebatePredictionRequest,
): Promise<DebatePrediction> {
  return request(`/debate/${debateId}/predict`, {
    method: 'POST',
    body: JSON.stringify({
      kind: payload.kind,
      target_value: payload.targetValue,
      confidence: payload.confidence,
      ...(payload.userId ? { user_id: payload.userId } : {}),
      ...(payload.userName ? { user_name: payload.userName } : {}),
      ...(payload.isCounterplay ? { is_counterplay: true } : {}),
      ...(payload.counterplayPhase ? { counterplay_phase: payload.counterplayPhase } : {}),
      ...(payload.counterplayVariant ? { counterplay_variant: payload.counterplayVariant } : {}),
    }),
  });
}

/** GET /api/scenario/:id — get scenario status + agents + branches */
export async function getScenario(id: string): Promise<Scenario> {
  return safeGet(`/scenario/${id}`);
}

/** POST /api/scenario/import-replay — persist a replay snapshot as a local scenario */
export async function importReplayScenario(scenario: Scenario): Promise<Scenario> {
  return request('/scenario/import-replay', {
    method: 'POST',
    body: JSON.stringify({ scenario }),
  });
}

export async function createReplayArtifact(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; kind: string; created_at: string }> {
  return request('/replay-artifact', {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}

export async function getReplayArtifact(
  artifactId: string,
): Promise<{ id: string; kind: string; payload: Record<string, unknown>; created_at: string }> {
  return safeGet(`/replay-artifact/${artifactId}`);
}

/** GET /api/scenario/:id/branches — get branch tree */
export async function getBranches(id: string): Promise<Branch[]> {
  return safeGet(`/scenario/${id}/branches`);
}

/** GET /api/scenario/:id/story — get narrated stories for completed branches */
export async function getStory(id: string): Promise<StoryData> {
  return safeGet(`/scenario/${id}/story`);
}

/** GET /api/scenario/:id/agents — get all agents for a scenario */
export async function getAgents(id: string): Promise<AgentInfo[]> {
  return safeGet(`/scenario/${id}/agents`);
}

/** POST /api/scenario/:id/intervene — butterfly effect intervention */
export async function intervene(
  scenarioId: string,
  payload: InterventionPayload,
): Promise<InterventionResponse> {
  return request(`/scenario/${scenarioId}/intervene`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/scenario/:id/intervene/retrospective — replay from a past round with an intervention */
export async function interveneRetrospective(
  scenarioId: string,
  payload: RetrospectiveInterventionPayload,
): Promise<RetrospectiveInterventionResponse> {
  return request(`/scenario/${scenarioId}/intervene/retrospective`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/scenario/:id/intervene/batch — inject the same type of intervention into multiple branches */
export async function interveneBatch(
  scenarioId: string,
  payload: BatchInterventionPayload,
): Promise<BatchInterventionResponse> {
  return request(`/scenario/${scenarioId}/intervene/batch`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** GET /api/scenario/:id/groups — get hierarchical groups (P3-A) */
export async function getGroups(scenarioId: string): Promise<AgentGroupDetail[]> {
  return safeGet(`/scenario/${scenarioId}/groups`);
}

// ── P5 API Wrappers ──────────────────────────────────────

/** Scenario list item returned by GET /api/scenarios */
export interface ScenarioListItem {
  id: string;
  question: string;
  status: string;
  created_at: string;
  agent_count: number;
}

export interface ScenarioListResponse {
  total: number;
  limit: number;
  offset: number;
  scenarios: ScenarioListItem[];
}

/** GET /api/scenarios — list scenarios with optional filtering & pagination (P5-A) */
export async function listScenarios(
  status?: string,
  limit = 20,
  offset = 0,
): Promise<ScenarioListResponse> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return safeGet(`/scenarios?${params.toString()}`);
}

/** DELETE /api/scenario/:id — cascade delete a scenario (P5-A) */
export async function deleteScenario(id: string): Promise<{ status: string; scenario_id: string }> {
  return request(`/scenario/${id}`, { method: 'DELETE' });
}

/** GET /api/scenario/:id/export — export scenario as Markdown text (P5-C) */
export async function exportScenario(id: string): Promise<string> {
  return requestText(`/scenario/${id}/export`);
}

/** Social copy generation — send provider policy in request body to avoid leaking keys in URLs. */
export async function generateSocialCopy(
  id: string,
  platform: string,
  options?: LlmProviderRequestOptions,
): Promise<{ platform: string; platform_name: string; copy: string }> {
  return request(`/scenario/${id}/social/${platform}`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
      ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
      ...(options?.llmModel && { llm_model: options.llmModel }),
      ...(options?.userId && { user_id: options.userId }),
    }),
  }, SOCIAL_COPY_TIMEOUT);
}

/** POST /api/scenario/:id/predict — submit a prediction (P5-B) */
export async function submitPrediction(
  scenarioId: string,
  predictionText: string,
  confidence: number,
  userName?: string,
  userId?: string,
): Promise<PredictionInfo> {
  return request(`/scenario/${scenarioId}/predict`, {
    method: 'POST',
    body: JSON.stringify({
      prediction_text: predictionText,
      confidence,
      ...(userId && { user_id: userId }),
      ...(userName && { user_name: userName }),
    }),
  });
}

/** GET /api/scenario/:id/predictions — list predictions for a scenario (P5-B) */
export async function listPredictions(scenarioId: string): Promise<PredictionInfo[]> {
  return safeGet(`/scenario/${scenarioId}/predictions`);
}

export async function scorePredictions(
  scenarioId: string,
  options?: LlmProviderRequestOptions,
): Promise<{ scored: number }> {
  return request(`/scenario/${scenarioId}/score-predictions`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
      ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
      ...(options?.llmModel && { llm_model: options.llmModel }),
      ...(options?.userId && { user_id: options.userId }),
    }),
  });
}

/** GET /api/leaderboard — global prediction leaderboard (P5-B) */
export async function getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
  return safeGet(`/leaderboard?limit=${limit}`);
}

export interface FinalizeCampaignPayload {
  user_id: string;
  user_name: string;
  profile_id: string;
  archive_grade?: string | null;
  profile_resonance?: string | null;
  betting_hit?: boolean | null;
  most_used_card?: string | null;
  completed_daily_challenge?: boolean;
  bet_count?: number;
  objective_completed_count?: number;
  objective_total_count?: number;
  commitment_outcome?: 'hit' | 'miss' | 'pending' | null;
}

export async function finalizeCampaign(
  scenarioId: string,
  payload: FinalizeCampaignPayload,
): Promise<CampaignFinalizeResult> {
  return request(`/campaign/scenario/${scenarioId}/finalize`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getCampaignProfile(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignProfileSummary> {
  return safeGet(`/campaign/profile/${userId}`, options);
}

export async function getCampaignMastery(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignMastery[]> {
  return safeGet(`/campaign/profile/${userId}/mastery`, options);
}

export async function getCampaignBadges(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignBadge[]> {
  return safeGet(`/campaign/profile/${userId}/badges`, options);
}

export async function getCampaignScenarioSummary(
  scenarioId: string,
): Promise<CampaignScenarioSummary> {
  return safeGet(`/campaign/scenario/${scenarioId}/summary`);
}

export async function upsertScenarioDirectorState(
  scenarioId: string,
  payload: ScenarioDirectorState,
): Promise<ScenarioDirectorStateResponse> {
  return request(`/campaign/scenario/${scenarioId}/director-state`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function getScenarioDirectorState(
  scenarioId: string,
): Promise<ScenarioDirectorStateResponse> {
  return safeGet(`/campaign/scenario/${scenarioId}/director-state`);
}

export async function upsertScenarioGameplayState(
  scenarioId: string,
  payload: ScenarioGameplayState,
): Promise<ScenarioGameplayStateResponse> {
  return request(`/campaign/scenario/${scenarioId}/gameplay-state`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function getScenarioGameplayState(
  scenarioId: string,
): Promise<ScenarioGameplayStateResponse> {
  return safeGet(`/campaign/scenario/${scenarioId}/gameplay-state`);
}

export async function getCampaignDailyChallengeStatus(
  userId: string,
  profileId: string,
  localDate: string,
  timezoneOffsetMinutes: number,
  options?: RequestOptions,
): Promise<CampaignDailyChallengeStatus> {
  const params = new URLSearchParams({
    profile_id: profileId,
    local_date: localDate,
    timezone_offset_minutes: String(timezoneOffsetMinutes),
  });
  return safeGet(`/campaign/profile/${userId}/daily-status?${params.toString()}`, options);
}

export async function getCampaignChallengeRotation(
  localDate: string,
  weeklyCount = 3,
  options?: RequestOptions,
): Promise<CampaignChallengeRotation> {
  const params = new URLSearchParams({
    local_date: localDate,
    weekly_count: String(weeklyCount),
  });
  return safeGet(`/campaign/challenges/rotation?${params.toString()}`, options);
}

export async function getCampaignWeeklySummary(
  userId: string,
  localDate: string,
  timezoneOffsetMinutes: number,
  options?: RequestOptions,
): Promise<CampaignWeeklySummary> {
  const params = new URLSearchParams({
    local_date: localDate,
    timezone_offset_minutes: String(timezoneOffsetMinutes),
  });
  return safeGet(`/campaign/profile/${userId}/weekly-summary?${params.toString()}`, options);
}

/** Intervention template from backend */
export interface InterventionTemplate {
  id: string;
  name: string;
  template: string;
  variables: string[];
}

/** GET /api/intervention-templates — pre-built intervention templates (P5-D) */
export async function getInterventionTemplates(): Promise<InterventionTemplate[]> {
  return safeGet('/intervention-templates');
}
