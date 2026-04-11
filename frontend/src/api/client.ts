/* ═══════════════════════════════════════════════════════════
   SwarmOracle — REST API Client
   ═══════════════════════════════════════════════════════════ */

import type {
  Scenario, Branch, StoryData, AgentInfo, AgentGroupDetail,
  InterventionPayload, InterventionResponse, RetrospectiveInterventionPayload,
  RetrospectiveInterventionResponse, BatchInterventionPayload, BatchInterventionResponse,
  PredictionInfo, LeaderboardEntry,
  DebatePrediction, DebatePredictionRequest, DebateResultPayload, DebateSnapshot,
  AppendEndingRoomUserTurnRequest, CreateEndingRoomRequest, CreateEndingRoomThreadRequest, EndingRoomResultPayload, EndingRoomSnapshot, EndingRoomThreadSnapshot,
  CampaignBadge, CampaignChallengeRotation, CampaignDailyChallengeStatus, CampaignFinalizeResult, CampaignMastery, CampaignProfileSummary, CampaignScenarioSummary, CampaignWeeklySummary,
  ScenarioDirectorState, ScenarioDirectorStateResponse, ScenarioGameplayState, ScenarioGameplayStateResponse,
} from '../types';

const BASE = '/api';

/**
 * Session token for optional server-side auth gate (SESSION_SECRET).
 * Read from localStorage; empty string means auth is disabled.
 */
export function getSessionToken(): string {
  try {
    return localStorage.getItem('swarmoracle_session_token') ?? '';
  } catch {
    return '';
  }
}

export function setSessionToken(token: string): void {
  try {
    if (token) {
      localStorage.setItem('swarmoracle_session_token', token);
    } else {
      localStorage.removeItem('swarmoracle_session_token');
    }
  } catch { /* ignore */ }
}

function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return atob(`${normalized}${padding}`);
  } catch {
    return null;
  }
}

export function getSessionPrincipalSubject(token: string = getSessionToken()): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const decoded = decodeBase64Url(parts[1]);
  if (!decoded) return null;
  try {
    const payload = JSON.parse(decoded) as { sub?: unknown };
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    return subject || null;
  } catch {
    return null;
  }
}

export function getSessionBoundUserId(fallback?: string | null): string {
  const subject = getSessionPrincipalSubject();
  if (subject) return subject;
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback) return normalizedFallback;
  try {
    const stored = localStorage.getItem('swarmoracle_user_id')?.trim();
    if (stored) return stored;
  } catch {
    // ignore
  }
  return 'default_user';
}

export function buildSessionHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers ?? {});
  const sessionToken = getSessionToken();
  if (sessionToken && !merged.has('X-Session-Token')) {
    merged.set('X-Session-Token', sessionToken);
  }
  return merged;
}

function sanitizeErrorText(text: string): string {
  if (!text || text.length > 200) return 'Server error';
  if (/Traceback|at\s+\S+\s+\(|<html|<\/div>/i.test(text)) return 'Server error';
  return text;
}

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
        return new ApiError(res.status, 'UNSTRUCTURED_ERROR', sanitizeErrorText(parsed.detail));
      }
    } catch {
      // Fall through to the raw body text below.
    }
  }

  return new ApiError(res.status, 'UNSTRUCTURED_ERROR', sanitizeErrorText(body));
}

export interface LlmProviderRequestOptions {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmRequestsPerMinute?: number;
  llmTokensPerMinute?: number;
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
  webSearchEnabled?: boolean;
  customAgentIdentityIds?: string[];
  continuityOverrides?: ContinuityOverride[];
}

export interface ContinuityOverride {
  continuityKey: string;
  action: 'reuse_existing' | 'create_new';
  identityId?: string;
  agentName?: string;
  agentRole?: string;
}

export interface IdentityContinuityMatch {
  name: string;
  role: string;
  persona?: string | null;
  continuity_key: string;
  match_kind: 'l2_candidate' | 'l1_exact' | 'new';
  needs_confirmation: boolean;
  candidate_identity: {
    id: string;
    display_name: string;
    role: string;
    persona?: string | null;
    kind: string;
    continuity_key: string;
    similarity?: number;
  } | null;
}

export interface IdentityContinuityPreflightResponse {
  needs_confirmation: boolean;
  matches: IdentityContinuityMatch[];
  summary: {
    agent_count: number;
    exact_match_count: number;
    candidate_count: number;
    new_identity_count: number;
  };
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

function buildScenarioRequestBody(options: CreateScenarioOptions): Record<string, unknown> {
  const {
    question,
    rounds,
    numAgents,
    mode,
    hierarchical,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    llmRequestsPerMinute,
    llmTokensPerMinute,
    reasoningEffort,
    temperature,
    branchSensitivity,
    forkPromptVariant,
    forkDetectorActiveBranchLimit,
    visualizationEnabled,
    webSearchEnabled,
    userId,
    disableUserQuota,
    customAgentIdentityIds,
    continuityOverrides,
  } = options;

  return {
    question,
    ...(rounds != null && { rounds }),
    ...(numAgents != null && { num_agents: numAgents }),
    ...(mode != null && { mode }),
    ...(hierarchical != null && { hierarchical }),
    ...(llmApiKey && { llm_api_key: llmApiKey }),
    ...(llmBaseUrl && { llm_base_url: llmBaseUrl }),
    ...(llmModel && { llm_model: llmModel }),
    ...(llmRequestsPerMinute != null && { llm_requests_per_minute: llmRequestsPerMinute }),
    ...(llmTokensPerMinute != null && { llm_tokens_per_minute: llmTokensPerMinute }),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    ...(temperature != null && { temperature }),
    ...(branchSensitivity != null && { branch_sensitivity: branchSensitivity }),
    ...(forkPromptVariant && { fork_prompt_variant: forkPromptVariant }),
    ...(forkDetectorActiveBranchLimit != null && { fork_detector_active_branch_limit: forkDetectorActiveBranchLimit }),
    ...(visualizationEnabled != null && { visualization_enabled: visualizationEnabled }),
    ...(webSearchEnabled && { web_search_enabled: true }),
    ...(userId && { user_id: userId }),
    ...(disableUserQuota != null && { disable_user_quota: disableUserQuota }),
    ...(customAgentIdentityIds?.length && { custom_agent_identity_ids: customAgentIdentityIds }),
    ...(continuityOverrides?.length && {
      continuity_overrides: continuityOverrides.map((override) => ({
        continuity_key: override.continuityKey,
        action: override.action,
        ...(override.identityId && { identity_id: override.identityId }),
        ...(override.agentName && { agent_name: override.agentName }),
        ...(override.agentRole && { agent_role: override.agentRole }),
      })),
    }),
  };
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
      headers: buildSessionHeaders({ ...headers, ...(init?.headers as Record<string, string>) }),
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
  const res = await fetchWithTimeout(
    path,
    { headers: buildSessionHeaders() },
    DEFAULT_TIMEOUT,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.text();
}

/** POST /api/health — server + LLM connectivity test */
export async function healthCheck(): Promise<{
  server: string;
  llm: Record<string, unknown>;
  web_search?: { scope: 'server'; server_enabled: boolean; method: string; provider: string | null };
}> {
  return request('/health', { method: 'POST' });
}

/** Phase 3: per-capability entry in the registry */
export interface CapabilityEntry {
  enabled: boolean;
  version: string;
  server_only: boolean;
  degraded_mode: string | null;
}

/** Phase 3: full capabilities registry response */
export interface CapabilitiesResponse {
  web_search: CapabilityEntry & { scope: 'server'; server_enabled: boolean; method: string; provider: string | null };
  custom_agents: CapabilityEntry;
  agent_identity: CapabilityEntry;
  causal_graph: CapabilityEntry;
  counterfactual_replay: CapabilityEntry;
  factions: CapabilityEntry;
  argument_map: CapabilityEntry;
}

/** GET /api/capabilities — lightweight server capability hints (no LLM calls) */
export async function getCapabilities(): Promise<CapabilitiesResponse> {
  return safeGet('/capabilities');
}

/** POST /api/health/test — test LLM connectivity with optional BYOK credentials */
export async function testLlmConnection(
  apiKey?: string,
  baseUrl?: string,
  model?: string,
  requestsPerMinute?: number,
  tokensPerMinute?: number,
): Promise<{
  server: string;
  llm: { status: string; model: string; response?: string; error?: string };
  probe?: LlmProbeResponse | null;
  /** Server-level web search config hint (NOT per-provider capability). */
  web_search?: {
    scope: 'server';
    server_enabled: boolean;
    method: string;
    provider: string | null;
  } | null;
}> {
  return request('/health/test', {
    method: 'POST',
    body: JSON.stringify({
      ...(apiKey && { llm_api_key: apiKey }),
      ...(baseUrl && { llm_base_url: baseUrl }),
      ...(model && { llm_model: model }),
      ...(requestsPerMinute != null && { llm_requests_per_minute: requestsPerMinute }),
      ...(tokensPerMinute != null && { llm_tokens_per_minute: tokensPerMinute }),
    }),
  });
}

/** POST /api/scenario — create a new "What If…" scenario */
export async function createScenario(
  options: CreateScenarioOptions,
): Promise<Scenario> {
  return request('/scenario', {
    method: 'POST',
    body: JSON.stringify(buildScenarioRequestBody(options)),
  });
}

export async function identityContinuityPreflight(
  options: CreateScenarioOptions,
): Promise<IdentityContinuityPreflightResponse> {
  return request('/agents/identities/preflight', {
    method: 'POST',
    body: JSON.stringify(buildScenarioRequestBody(options)),
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
      ...(options?.llmRequestsPerMinute != null && { llm_requests_per_minute: options.llmRequestsPerMinute }),
      ...(options?.llmTokensPerMinute != null && { llm_tokens_per_minute: options.llmTokensPerMinute }),
      ...(options?.reasoningEffort && { reasoning_effort: options.reasoningEffort }),
      ...(options?.userId && { user_id: options.userId }),
    }),
  });
}

/** GET /api/debate/:id — get debate live snapshot */
export async function getDebate(id: string): Promise<DebateSnapshot> {
  return safeGet(`/debate/${encodeURIComponent(id)}`);
}

/** GET /api/debate/:id/result — get finalized debate result */
export async function getDebateResult(id: string): Promise<DebateResultPayload> {
  return safeGet(`/debate/${encodeURIComponent(id)}/result`);
}

/** POST /api/scenario/:id/ending-room — create or reuse an ending room scope */
export async function createEndingRoom(
  scenarioId: string,
  payload: CreateEndingRoomRequest,
): Promise<EndingRoomSnapshot> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/ending-room`, {
    method: 'POST',
    body: JSON.stringify({
      room_type: payload.roomType,
      ...(payload.anchorBranchId ? { anchor_branch_id: payload.anchorBranchId } : {}),
      selected_branch_ids: payload.selectedBranchIds,
      ...(payload.selectedAgentIds?.length ? { selected_agent_ids: payload.selectedAgentIds } : {}),
      ...(payload.selectedRepresentatives?.length
        ? {
            selected_representatives: payload.selectedRepresentatives.map((selection) => ({
              branch_id: selection.branchId,
              agent_id: selection.agentId,
            })),
          }
        : {}),
      ...(payload.selectedWitness
        ? {
            selected_witness: {
              branch_id: payload.selectedWitness.branchId,
              agent_id: payload.selectedWitness.agentId,
            },
          }
        : {}),
      ...(payload.selectionRecipe ? { selection_recipe: payload.selectionRecipe } : {}),
      ...(payload.language ? { language: payload.language } : {}),
    }),
  });
}

/** GET /api/ending-room/:id — get ending room live snapshot */
export async function getEndingRoom(roomId: string): Promise<EndingRoomSnapshot> {
  return safeGet(`/ending-room/${encodeURIComponent(roomId)}`);
}

/** GET /api/ending-room/:id/result — get finalized ending room payload */
export async function getEndingRoomResult(roomId: string): Promise<EndingRoomResultPayload> {
  return safeGet(`/ending-room/${encodeURIComponent(roomId)}/result`);
}

/** POST /api/ending-room/:id/thread — create a follow-up thread inside an ending room */
export async function createEndingRoomThread(
  roomId: string,
  payload: CreateEndingRoomThreadRequest,
): Promise<EndingRoomThreadSnapshot> {
  return request(`/ending-room/${encodeURIComponent(roomId)}/thread`, {
    method: 'POST',
    body: JSON.stringify({
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.addressedAgentIds?.length ? { addressed_agent_ids: payload.addressedAgentIds } : {}),
      ...(payload.questionAnchorIds?.length ? { question_anchor_ids: payload.questionAnchorIds } : {}),
      ...(payload.interactionMode ? { interaction_mode: payload.interactionMode } : {}),
    }),
  });
}

/** GET /api/ending-room/thread/:id — fetch a single follow-up thread snapshot */
export async function getEndingRoomThread(threadId: string): Promise<EndingRoomThreadSnapshot> {
  return safeGet(`/ending-room/thread/${encodeURIComponent(threadId)}`);
}

/** POST /api/ending-room/:id/user-turn — append a follow-up turn on the room transcript */
export async function appendEndingRoomUserTurn(
  roomId: string,
  payload: AppendEndingRoomUserTurnRequest,
): Promise<{ room_id: string; thread_id: string; memory_partition_id: string; turns: EndingRoomSnapshot['turns'] }> {
  return request(`/ending-room/${encodeURIComponent(roomId)}/user-turn`, {
    method: 'POST',
    body: JSON.stringify({
      content: payload.content,
      ...(payload.addressedAgentIds?.length ? { addressed_agent_ids: payload.addressedAgentIds } : {}),
      ...(payload.questionAnchorIds?.length ? { question_anchor_ids: payload.questionAnchorIds } : {}),
      ...(payload.interactionMode ? { interaction_mode: payload.interactionMode } : {}),
      ...(payload.citedBranchId ? { cited_branch_id: payload.citedBranchId } : {}),
      ...(payload.citedRefsJson ? { cited_refs_json: payload.citedRefsJson } : {}),
    }),
  });
}

/** POST /api/ending-room/thread/:id/user-turn — append a follow-up turn inside a thread */
export async function appendEndingRoomThreadUserTurn(
  threadId: string,
  payload: AppendEndingRoomUserTurnRequest,
): Promise<{ room_id: string; thread_id: string; memory_partition_id: string; turns: EndingRoomSnapshot['turns'] }> {
  return request(`/ending-room/thread/${encodeURIComponent(threadId)}/user-turn`, {
    method: 'POST',
    body: JSON.stringify({
      content: payload.content,
      ...(payload.addressedAgentIds?.length ? { addressed_agent_ids: payload.addressedAgentIds } : {}),
      ...(payload.questionAnchorIds?.length ? { question_anchor_ids: payload.questionAnchorIds } : {}),
      ...(payload.interactionMode ? { interaction_mode: payload.interactionMode } : {}),
      ...(payload.citedBranchId ? { cited_branch_id: payload.citedBranchId } : {}),
      ...(payload.citedRefsJson ? { cited_refs_json: payload.citedRefsJson } : {}),
    }),
  });
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
  return request(`/debate/${encodeURIComponent(debateId)}/predict`, {
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
  return safeGet(`/scenario/${encodeURIComponent(id)}`);
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
  return safeGet(`/replay-artifact/${encodeURIComponent(artifactId)}`);
}

/** GET /api/scenario/:id/branches — get branch tree */
export async function getBranches(id: string): Promise<Branch[]> {
  return safeGet(`/scenario/${encodeURIComponent(id)}/branches`);
}

/** GET /api/scenario/:id/story — get narrated stories for completed branches */
export async function getStory(id: string): Promise<StoryData> {
  return safeGet(`/scenario/${encodeURIComponent(id)}/story`);
}

/** GET /api/scenario/:id/agents — get all agents for a scenario */
export async function getAgents(id: string): Promise<AgentInfo[]> {
  return safeGet(`/scenario/${encodeURIComponent(id)}/agents`);
}

/** POST /api/scenario/:id/intervene — butterfly effect intervention */
export async function intervene(
  scenarioId: string,
  payload: InterventionPayload,
): Promise<InterventionResponse> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/intervene`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/scenario/:id/intervene/retrospective — replay from a past round with an intervention */
export async function interveneRetrospective(
  scenarioId: string,
  payload: RetrospectiveInterventionPayload,
): Promise<RetrospectiveInterventionResponse> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/intervene/retrospective`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/scenario/:id/intervene/batch — inject the same type of intervention into multiple branches */
export async function interveneBatch(
  scenarioId: string,
  payload: BatchInterventionPayload,
): Promise<BatchInterventionResponse> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/intervene/batch`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** GET /api/scenario/:id/groups — get hierarchical groups (P3-A) */
export async function getGroups(scenarioId: string): Promise<AgentGroupDetail[]> {
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/groups`);
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
  return request(`/scenario/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** GET /api/scenario/:id/export — export scenario as Markdown text (P5-C) */
export async function exportScenario(id: string): Promise<string> {
  return requestText(`/scenario/${encodeURIComponent(id)}/export`);
}

/** Social copy generation — send provider policy in request body to avoid leaking keys in URLs. */
export async function generateSocialCopy(
  id: string,
  platform: string,
  options?: LlmProviderRequestOptions,
): Promise<{ platform: string; platform_name: string; copy: string }> {
  return request(`/scenario/${encodeURIComponent(id)}/social/${encodeURIComponent(platform)}`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
      ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
      ...(options?.llmModel && { llm_model: options.llmModel }),
      ...(options?.llmRequestsPerMinute != null && { llm_requests_per_minute: options.llmRequestsPerMinute }),
      ...(options?.llmTokensPerMinute != null && { llm_tokens_per_minute: options.llmTokensPerMinute }),
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
  return request(`/scenario/${encodeURIComponent(scenarioId)}/predict`, {
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
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/predictions`);
}

export async function scorePredictions(
  scenarioId: string,
  options?: LlmProviderRequestOptions,
): Promise<{ scored: number }> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/score-predictions`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
      ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
      ...(options?.llmModel && { llm_model: options.llmModel }),
      ...(options?.llmRequestsPerMinute != null && { llm_requests_per_minute: options.llmRequestsPerMinute }),
      ...(options?.llmTokensPerMinute != null && { llm_tokens_per_minute: options.llmTokensPerMinute }),
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
  return request(`/campaign/scenario/${encodeURIComponent(scenarioId)}/finalize`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getCampaignProfile(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignProfileSummary> {
  return safeGet(`/campaign/profile/${encodeURIComponent(userId)}`, options);
}

export async function getCampaignMastery(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignMastery[]> {
  return safeGet(`/campaign/profile/${encodeURIComponent(userId)}/mastery`, options);
}

export async function getCampaignBadges(
  userId: string,
  options?: RequestOptions,
): Promise<CampaignBadge[]> {
  return safeGet(`/campaign/profile/${encodeURIComponent(userId)}/badges`, options);
}

export async function getCampaignScenarioSummary(
  scenarioId: string,
): Promise<CampaignScenarioSummary> {
  return safeGet(`/campaign/scenario/${encodeURIComponent(scenarioId)}/summary`);
}

export async function upsertScenarioDirectorState(
  scenarioId: string,
  payload: ScenarioDirectorState,
): Promise<ScenarioDirectorStateResponse> {
  return request(`/campaign/scenario/${encodeURIComponent(scenarioId)}/director-state`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function getScenarioDirectorState(
  scenarioId: string,
): Promise<ScenarioDirectorStateResponse> {
  return safeGet(`/campaign/scenario/${encodeURIComponent(scenarioId)}/director-state`);
}

export async function upsertScenarioGameplayState(
  scenarioId: string,
  payload: ScenarioGameplayState,
): Promise<ScenarioGameplayStateResponse> {
  return request(`/campaign/scenario/${encodeURIComponent(scenarioId)}/gameplay-state`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function getScenarioGameplayState(
  scenarioId: string,
): Promise<ScenarioGameplayStateResponse> {
  return safeGet(`/campaign/scenario/${encodeURIComponent(scenarioId)}/gameplay-state`);
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
  return safeGet(`/campaign/profile/${encodeURIComponent(userId)}/daily-status?${params.toString()}`, options);
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
  return safeGet(`/campaign/profile/${encodeURIComponent(userId)}/weekly-summary?${params.toString()}`, options);
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

// ── Phase 3 P1-1/P1-2: Agent Identity Memory & Growth ──

import type { AgentMemoryEntry, AgentGrowthEvent } from '../types';

/** GET /api/agents/identities/:id/memory */
export async function getIdentityMemory(
  identityId: string,
  userId?: string,
): Promise<{ identity_id: string; memories: AgentMemoryEntry[] }> {
  const uid = getSessionBoundUserId(userId);
  return safeGet(
    `/agents/identities/${encodeURIComponent(identityId)}/memory?user_id=${encodeURIComponent(uid)}`,
  );
}

/** GET /api/agents/identities/:id/growth-events */
export async function getIdentityGrowthEvents(
  identityId: string,
  userId?: string,
): Promise<{ identity_id: string; events: AgentGrowthEvent[] }> {
  const uid = getSessionBoundUserId(userId);
  return safeGet(
    `/agents/identities/${encodeURIComponent(identityId)}/growth-events?user_id=${encodeURIComponent(uid)}`,
  );
}

/** GET /api/scenario/:id/faction-timeline — P1-8 faction overlay data */
export async function getFactionTimeline(
  scenarioId: string,
  branchId: string,
): Promise<Array<{ round: number; factions: Array<{ key: string; label: string | null; members: string[] }>; events: unknown[] }>> {
  return safeGet(
    `/scenario/${encodeURIComponent(scenarioId)}/faction-timeline?branch_id=${encodeURIComponent(branchId)}`,
  );
}

/** POST /api/scenario/:id/resume — P1-9 resume simulation from a round */
export async function resumeFromRound(
  scenarioId: string,
  body: { source_branch_id: string; round_number: number },
): Promise<{ branch_id: string; message: string }> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/resume`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
