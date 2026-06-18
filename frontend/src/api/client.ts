/* ═══════════════════════════════════════════════════════════
   SwarmOracle — REST API Client
   ═══════════════════════════════════════════════════════════ */

import type {
  Scenario, Branch, StoryData, AgentInfo, AgentGroupDetail,
  InterventionPayload, InterventionResponse, RetrospectiveInterventionPayload,
  RetrospectiveInterventionResponse, BatchInterventionPayload, BatchInterventionResponse,
  PredictionInfo, LeaderboardEntry,
  DebatePrediction, DebatePredictionRequest, DebateResultPayload, DebateSnapshot,
  AppendEndingRoomUserTurnRequest, CreateEndingRoomRequest, CreateEndingRoomThreadRequest, EndingRoomResultPayload, EndingRoomSnapshot, EndingRoomThreadSnapshot, EndingRoomType,
  CampaignContext, CampaignBadge, CampaignBadgeDefinition, CampaignChallengeRotation, CampaignDailyChallengeStatus, CampaignFinalizeResult, CampaignMastery, CampaignProfileSummary, CampaignScenarioSummaryResponse, CampaignWeeklySummary,
  ScenarioDirectorState, ScenarioDirectorStateResponse, ScenarioGameplayState, ScenarioGameplayStateResponse,
  WebSearchFamily,
  ReplayTraceResponse,
  PublicArtifact,
  WorldContext,
  DocumentSeedResponse,
  ListPacksResponse, LocalPack, RefreshPacksResponse, DiagnosticsResponse,
  MultiRunResponse, RunGroupDistributionResponse,
  ScorePredictionResultItem,
  SocialFeedResponse,
  ModelProfile, ModelProfileInput, ModelProfilePatchInput,
} from '../types';
import { getOrgId } from '../lib/orgContext';

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
  const orgId = getOrgId();
  if (orgId && !merged.has('X-Org-Id')) {
    merged.set('X-Org-Id', orgId);
  }
  return merged;
}

function userIdQuery(userId?: string | null): string {
  return `user_id=${encodeURIComponent(getSessionBoundUserId(userId))}`;
}

function withUserIdQuery(path: string, userId?: string | null): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${userIdQuery(userId)}`;
}

function userIdHeader(userId?: string | null): Record<string, string> {
  return { 'X-User-Id': getSessionBoundUserId(userId) };
}

function sanitizeErrorText(text: string): string {
  if (!text || text.length > 200) return 'Server error';
  if (/Traceback|at\s+\S+\s+\(|<html|<\/div>/i.test(text)) return 'Server error';
  return text;
}

const DEFAULT_TIMEOUT = 30000; // M-5 fix: 30s default request timeout
const SOCIAL_COPY_TIMEOUT = 90000;
const ENDING_ROOM_USER_TURN_TIMEOUT = 90000;

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
  if (res.status === 204) {
    return undefined as T;
  }
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
  propositionModelProfileId?: string;
  oppositionModelProfileId?: string;
  judgeModelProfileId?: string;
}

export interface CreateScenarioOptions extends LlmProviderRequestOptions {
  question: string;
  rounds?: number;
  numAgents?: number;
  mode?: 'raw' | 'blackboard';
  hierarchical?: boolean;
  visualizationEnabled?: boolean;
  webSearchEnabled?: boolean;
  webSearchFamilies?: WebSearchFamily[];
  webSearchProvider?: 'tavily' | 'exa' | 'firecrawl' | 'xai' | 'searxng';
  webSearchApiKey?: string;
  webSearchBaseUrl?: string;
  webSearchIntensity?: 'light' | 'standard' | 'deep';
  customAgentIdentityIds?: string[];
  continuityOverrides?: ContinuityOverride[];
  campaignContext?: CampaignContext;
  worldContext?: WorldContext;
  modelProfileId?: string;
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

function buildScenarioRequestBody(
  options: CreateScenarioOptions,
  opts?: { preflightMode?: boolean },
): Record<string, unknown> {
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
    webSearchFamilies,
    webSearchProvider,
    webSearchApiKey,
    webSearchBaseUrl,
    webSearchIntensity,
    userId,
    disableUserQuota,
    customAgentIdentityIds,
    continuityOverrides,
    campaignContext,
    worldContext,
    modelProfileId,
  } = options;

  const preflightMode = opts?.preflightMode === true;

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
    ...(webSearchEnabled && { web_search_families: webSearchFamilies ?? [] }),
    ...(webSearchEnabled && { web_search_intensity: webSearchIntensity ?? 'standard' }),
    ...(webSearchEnabled && !preflightMode && webSearchProvider && { web_search_provider: webSearchProvider }),
    ...(webSearchEnabled && !preflightMode && webSearchApiKey && { web_search_api_key: webSearchApiKey }),
    ...(webSearchEnabled && !preflightMode && webSearchBaseUrl && { web_search_base_url: webSearchBaseUrl }),
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
    ...(campaignContext && { campaign_context: campaignContext }),
    ...(worldContext && { world_context: worldContext }),
    ...(modelProfileId && { model_profile_id: modelProfileId }),
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
    throw await parseErrorResponse(res);
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

/** P1-6: provider-level domain-filter capability for the currently configured provider. */
export type WebSearchDomainFilterMode = 'api' | 'query' | 'prompt' | 'none';

export interface WebSearchProviderCapability {
  supports_domain_filter: boolean;
  supports_sources: boolean;
  domain_filter_mode: WebSearchDomainFilterMode;
}

/** P1-6: per-family capability nested under each provider entry (FEATURE_NEW_SOURCES). */
export interface WebSearchFamilyCapability {
  supports_domain_filter: boolean;
  domain_filter_mode: WebSearchDomainFilterMode;
  max_domains: number | null;
}

/** Phase 3 / FE-1: per-provider nested entry under web_search.providers */
export interface WebSearchProviderEntry {
  enabled: boolean;
  configured_host: string;
  rate_limit_rps: number;
  ttl_seconds: number;
  byok_allowed: boolean;
  /** P1-6: per-family capability (only set when FEATURE_NEW_SOURCES=true). */
  capability?: WebSearchFamilyCapability;
}

/** Phase 3 / FE-1: web_search.providers block (only populated when FEATURE_NEW_SOURCES=true) */
export interface WebSearchProvidersBlock {
  polymarket?: WebSearchProviderEntry;
  finance?: WebSearchProviderEntry;
  academic?: WebSearchProviderEntry;
  news_deep?: WebSearchProviderEntry;
}

/** Phase 3: full capabilities registry response */
export interface CapabilitiesResponse {
  llm_configured?: boolean & { enabled?: never };
  llm_static_configured?: boolean;
  llm_profile_configured?: boolean;
  web_search: CapabilityEntry & {
    scope: 'server';
    server_enabled: boolean;
    method: string;
    provider: string | null;
    providers?: WebSearchProvidersBlock;
    /** P1-6: capability info for the currently configured server-side provider. */
    provider_capability?: WebSearchProviderCapability;
  };
  custom_agents: CapabilityEntry & { max_custom_agents?: number };
  agent_identity: CapabilityEntry;
  causal_graph: CapabilityEntry;
  counterfactual_replay: CapabilityEntry;
  factions: CapabilityEntry;
  argument_map: CapabilityEntry;
  agent_conversation: CapabilityEntry;
  kg_explorer: CapabilityEntry;
  replay_trace: CapabilityEntry;
  graph_analysis: CapabilityEntry;
  roundtable_survey: CapabilityEntry;
  roundtable_analyst: CapabilityEntry;
  snapshot_export?: CapabilityEntry;
  education_templates?: CapabilityEntry;
  persona_export?: CapabilityEntry;
  prediction_journal?: CapabilityEntry;
  result_verdict?: CapabilityEntry;
  result_report?: CapabilityEntry;
  public_artifacts?: CapabilityEntry;
  document_seed?: CapabilityEntry;
  local_packs?: CapabilityEntry;
  multi_run?: CapabilityEntry & { default_count: number; max_count: number };
  you_vs_oracle?: CapabilityEntry;
  social_headlines?: CapabilityEntry;
  model_profiles?: CapabilityEntry;
}

/** Persona export/import payload — schema_version 1 contract. */
export interface PersonaExportPayload {
  schema_version: number;
  exported_at: string;
  persona: {
    name: string;
    role: string;
    persona_text: string;
    decision_bias: Record<string, number>;
    tags: string[];
  };
}

/** Education template type — pre-built classroom scenarios with suggested config. */
export type EducationTemplate = {
  id: string;
  category: string;
  title_zh: string;
  title_en: string;
  description_zh: string;
  description_en: string;
  difficulty: string;
  suggested_agents: number;
  suggested_rounds: number;
  tags: string[];
  default_config: Record<string, unknown>;
};

/** GET /api/scenario/templates — list available education templates with optional filters. */
export async function listEducationTemplates(
  params?: { category?: string; difficulty?: string },
): Promise<{ templates: EducationTemplate[] }> {
  const query: string[] = [];
  if (params?.category) query.push(`category=${encodeURIComponent(params.category)}`);
  if (params?.difficulty) query.push(`difficulty=${encodeURIComponent(params.difficulty)}`);
  const suffix = query.length > 0 ? `?${query.join('&')}` : '';
  return safeGet(`/scenario/templates${suffix}`);
}

/** GET /api/scenario/templates/:id — fetch a single education template. */
export async function getEducationTemplate(id: string): Promise<EducationTemplate> {
  return safeGet(`/scenario/templates/${encodeURIComponent(id)}`);
}

/** GET /api/capabilities — lightweight server capability hints (no LLM calls) */
export async function getCapabilities(): Promise<CapabilitiesResponse> {
  return safeGet('/capabilities');
}

/**
 * S3-6: Export a scenario as a self-contained ZIP snapshot.
 * Returns a Blob (application/zip). Caller is responsible for triggering
 * the browser download (e.g. URL.createObjectURL + anchor.click).
 */
export async function exportScenarioSnapshot(
  scenarioId: string,
  includePrivate = false,
  options?: RequestOptions,
): Promise<Blob> {
  const path = `/scenario/${encodeURIComponent(scenarioId)}/snapshot?include_private=${includePrivate ? 'true' : 'false'}`;
  const res = await fetchWithTimeout(path, {
    method: 'GET',
    headers: buildSessionHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return res.blob();
}

/**
 * S3-6: Import a scenario snapshot ZIP into a new scenario.
 * Returns the newly created scenario id.
 */
export async function importScenarioSnapshot(
  file: File,
  options?: RequestOptions,
): Promise<{ scenario_id: string; status?: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetchWithTimeout('/scenario/import-snapshot', {
    method: 'POST',
    headers: buildSessionHeaders(),
    body: form,
    signal: options?.signal,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return parseJsonResponse<{ scenario_id: string; status?: string }>(
    res,
    '/scenario/import-snapshot',
  );
}

/** Native-search static probe result for a model profile's base_url + override.
 *  Distinct from `web_search` (which is a server-level external-search hint). */
export interface NativeSearchProbe {
  would_inject_tools: boolean;
  blocking_reasons: string[];
  message: string;
  detail: {
    provider: string;
    is_proxy: boolean;
    api_form: 'chat' | 'responses';
    adapter: string;
    supports_native_search: boolean;
    native_search_upstream?: string;
    inferred_upstream?: boolean;
  };
  live_result?: {
    status: 'ok' | 'error';
    citations_found?: number;
    response_preview?: string;
    error?: string;
  };
}

/** POST /api/health/test — test LLM connectivity with optional BYOK credentials */
export async function testLlmConnection(
  apiKey?: string,
  baseUrl?: string,
  model?: string,
  requestsPerMinute?: number,
  tokensPerMinute?: number,
  includeProbe?: boolean,
  includeNativeProbe?: boolean,
  nativeSearchUpstream?: string,
  supportsNativeSearchOverride?: boolean | null,
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
  /** Per-profile native-search static probe (present only when includeNativeProbe). */
  native_search?: NativeSearchProbe | null;
}> {
  return request('/health/test', {
    method: 'POST',
    body: JSON.stringify({
      ...(apiKey && { llm_api_key: apiKey }),
      ...(baseUrl && { llm_base_url: baseUrl }),
      ...(model && { llm_model: model }),
      ...(requestsPerMinute != null && { llm_requests_per_minute: requestsPerMinute }),
      ...(tokensPerMinute != null && { llm_tokens_per_minute: tokensPerMinute }),
      ...(includeProbe === false ? { include_probe: false } : {}),
      ...(includeNativeProbe ? { include_native_probe: true } : {}),
      ...(nativeSearchUpstream && { native_search_upstream_override: nativeSearchUpstream }),
      ...(supportsNativeSearchOverride !== undefined ? { supports_native_search_override: supportsNativeSearchOverride } : {}),
    }),
  });
}

/** POST /api/health/test — test native search static probe only (quick probe) */
export async function probeNativeSearch(
  apiKey?: string,
  baseUrl?: string,
  model?: string,
  nativeSearchUpstream?: string,
  supportsNativeSearchOverride?: boolean | null,
  liveTest?: boolean,
): Promise<NativeSearchProbe | null> {
  const payload = await request<{ native_search?: NativeSearchProbe | null }>('/health/test', {
    method: 'POST',
    body: JSON.stringify({
      native_probe_only: true,
      include_native_probe: true,
      ...(apiKey && { llm_api_key: apiKey }),
      ...(baseUrl && { llm_base_url: baseUrl }),
      ...(model && { llm_model: model }),
      ...(nativeSearchUpstream && { native_search_upstream_override: nativeSearchUpstream }),
      ...(supportsNativeSearchOverride !== undefined ? { supports_native_search_override: supportsNativeSearchOverride } : {}),
      ...(liveTest && { live_native_test: true }),
    }),
  });
  return payload?.native_search ?? null;
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

export interface MultiRunRequest extends CreateScenarioOptions {
  runCount?: number;
  verdictOnlyRuns?: boolean;
}

/** POST /api/scenario/multi-run — create a new multi-run scenario group */
export async function createMultiRun(
  options: MultiRunRequest,
): Promise<MultiRunResponse> {
  const { runCount, verdictOnlyRuns, ...scenarioOptions } = options;
  const baseBody = buildScenarioRequestBody(scenarioOptions);
  return request('/scenario/multi-run', {
    method: 'POST',
    body: JSON.stringify({
      ...baseBody,
      ...(runCount != null && { run_count: runCount }),
      ...(verdictOnlyRuns != null && { verdict_only_runs: verdictOnlyRuns }),
    }),
  });
}

/** GET /api/scenario/run-groups/:runGroupId — get multi-run distribution */
export async function getRunGroupDistribution(
  runGroupId: string,
): Promise<RunGroupDistributionResponse> {
  return safeGet(`/scenario/run-groups/${encodeURIComponent(runGroupId)}`);
}


export async function identityContinuityPreflight(
  options: CreateScenarioOptions,
): Promise<IdentityContinuityPreflightResponse> {
  return request('/agents/identities/preflight', {
    method: 'POST',
    body: JSON.stringify(buildScenarioRequestBody(options, { preflightMode: true })),
  });
}

/** POST /api/debate — create a new Debate Arena match */
export async function createDebate(
  question: string,
  profileHint?: string,
  options?: LlmProviderRequestOptions,
  customAgentIds?: { proposition?: string; opposition?: string },
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
      ...(options?.propositionModelProfileId && { proposition_model_profile_id: options.propositionModelProfileId }),
      ...(options?.oppositionModelProfileId && { opposition_model_profile_id: options.oppositionModelProfileId }),
      ...(options?.judgeModelProfileId && { judge_model_profile_id: options.judgeModelProfileId }),
      ...(customAgentIds && {
        custom_agent_ids: [customAgentIds.proposition, customAgentIds.opposition].filter(Boolean),
      }),
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
      ...(payload.discussionFormat ? { discussion_format: payload.discussionFormat } : {}),
      ...(payload.castMode ? { cast_mode: payload.castMode } : {}),
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
      ...(payload.roomModelProfileId ? { room_model_profile_id: payload.roomModelProfileId } : {}),
    }),
  });
}

/**
 * GET /api/scenario/:id/ending-room/active — resolve an EXISTING ending room for a scenario.
 *
 * Read-only: the backend resolves a persisted room (no insert/commit, no LLM run). Used to
 * rehydrate a completed worldline_roundtable when revisiting `/roundtable/:id` after the live
 * session ended. Returns the same `EndingRoomSnapshot` shape as `getEndingRoom`, or `null` when
 * no matching room exists (HTTP 404 `ENDING_ROOM_NOT_FOUND`) — including cross-user requests that
 * fail the scenario-ownership guard (404 `SCENARIO_NOT_FOUND`). Non-404 errors still propagate.
 */
export async function getActiveEndingRoom(
  scenarioId: string,
  roomType: EndingRoomType = 'worldline_roundtable',
  options?: RequestOptions,
): Promise<EndingRoomSnapshot | null> {
  try {
    return await safeGet<EndingRoomSnapshot>(
      `/scenario/${encodeURIComponent(scenarioId)}/ending-room/active?room_type=${encodeURIComponent(roomType)}`,
      options,
    );
  } catch (err) {
    if (isApiError(err) && err.status === 404) {
      return null;
    }
    throw err;
  }
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
      ...(payload.followupModelProfileId ? { followup_model_profile_id: payload.followupModelProfileId } : {}),
    }),
  }, ENDING_ROOM_USER_TURN_TIMEOUT);
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
      ...(payload.followupModelProfileId ? { followup_model_profile_id: payload.followupModelProfileId } : {}),
    }),
  }, ENDING_ROOM_USER_TURN_TIMEOUT);
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

/** POST /api/scenario/:id/report:generate — generate a detailed report (HTTP SSE) */
export async function generateReport(
  id: string,
  options?: LlmProviderRequestOptions,
  signal?: AbortSignal,
  timeoutMs = 35 * 60_000,
): Promise<Response> {
  const res = await fetchWithTimeout(
    `/scenario/${encodeURIComponent(id)}/report:generate`,
    {
      method: 'POST',
      headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ...(options?.llmApiKey && { llm_api_key: options.llmApiKey }),
        ...(options?.llmBaseUrl && { llm_base_url: options.llmBaseUrl }),
        ...(options?.llmModel && { llm_model: options.llmModel }),
        ...(options?.temperature != null && { temperature: options.temperature }),
        ...(options?.llmRequestsPerMinute != null && { llm_requests_per_minute: options.llmRequestsPerMinute }),
        ...(options?.llmTokensPerMinute != null && { llm_tokens_per_minute: options.llmTokensPerMinute }),
      }),
      signal,
    },
    timeoutMs,
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return res;
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

/** GET /api/scenario/{id}/graph-analysis — server-side graph metrics */
export interface GraphAnalysisResponse {
  god_nodes: { node_id: string; label: string; type: string; in_degree: number; out_degree: number; total_degree: number; centrality_rank: number }[];
  degree_distribution: Record<string, number>;
  cross_branch_edges: { source_branch: string; target_branch: string; edge_count: number; primary_type: string }[];
  summary: { total_nodes: number; total_edges: number; avg_degree: number; max_degree: number; connected_components: number; density: number };
}

export async function getGraphAnalysis(scenarioId: string, branchId?: string): Promise<GraphAnalysisResponse> {
  const params = branchId ? `?branch_id=${encodeURIComponent(branchId)}` : '';
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/graph-analysis${params}`);
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

/** POST /api/scenario/:id/cancel — request user-initiated cancellation (S1-1) */
export async function cancelScenario(scenarioId: string): Promise<{ status: string }> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/cancel`, { method: 'POST' });
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
  requestOptions?: RequestOptions,
): Promise<{ platform: string; platform_name: string; copy: string }> {
  return request(`/scenario/${encodeURIComponent(id)}/social/${encodeURIComponent(platform)}`, {
    method: 'POST',
    signal: requestOptions?.signal,
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
): Promise<{ scored: number; results?: ScorePredictionResultItem[] }> {
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

export type LeaderboardScenarioType = 'debate' | 'simulation' | 'roundtable';

export interface LeaderboardSegmentFilters {
  scenarioType?: LeaderboardScenarioType | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  minAgents?: number | null;
  maxAgents?: number | null;
}

export interface LeaderboardSegmentMetadata {
  active_filters: Record<string, unknown>;
  total_count: number;
  filtered_count: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  segment_metadata?: LeaderboardSegmentMetadata;
}

/** GET /api/leaderboard — global prediction leaderboard (P5-B) with optional segment filters */
export async function getLeaderboard(
  limit = 20,
  filters?: LeaderboardSegmentFilters,
): Promise<LeaderboardResponse | LeaderboardEntry[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (filters?.scenarioType) params.set('scenario_type', filters.scenarioType);
  if (filters?.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters?.dateTo) params.set('date_to', filters.dateTo);
  if (filters?.minAgents != null) params.set('min_agents', String(filters.minAgents));
  if (filters?.maxAgents != null) params.set('max_agents', String(filters.maxAgents));
  return safeGet(`/leaderboard?${params.toString()}`);
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

/**
 * GET /api/campaign/badge-definitions — static badge registry.
 *
 * Returns the full catalog of badges (name_key + description_key + category)
 * used by `BadgeCabinet` to render locked + unlocked tiles side by side.
 * This endpoint is not user-scoped; the campaign router may still require a
 * session token when SESSION_SECRET is enabled.
 */
export async function getCampaignBadgeDefinitions(
  options?: RequestOptions,
): Promise<CampaignBadgeDefinition[]> {
  return safeGet(`/campaign/badge-definitions`, options);
}

export async function getCampaignScenarioSummary(
  scenarioId: string,
): Promise<CampaignScenarioSummaryResponse | null> {
  try {
    return await safeGet(`/campaign/scenario/${encodeURIComponent(scenarioId)}/summary`);
  } catch (err) {
    if (isApiError(err) && err.status === 404) {
      return null;
    }
    throw err;
  }
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
export interface InterventionTemplateVariable {
  key: string;
  label_en: string;
  label_zh: string;
  examples: string[];
}

export interface InterventionTemplate {
  id: string;
  name_en?: string;
  name_zh?: string;
  name: string;
  description_en?: string;
  description_zh?: string;
  template_en?: string;
  template_zh?: string;
  template: string;
  variables?: InterventionTemplateVariable[];
  intervention_kind?: string;
  suggested_targets?: string | null;
}

/** GET /api/intervention-templates — pre-built intervention templates (P5-D) */
export async function getInterventionTemplates(): Promise<InterventionTemplate[]> {
  return safeGet('/intervention-templates');
}

// ── Phase 3 P1-1/P1-2: Agent Identity Memory & Growth ──

import type {
  AgentMemoryEntry,
  AgentGrowthEvent,
  AgentIdentityProfile,
  ScenarioAgentProfileResponse,
} from '../types';

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

export async function getAgentIdentityProfile(
  identityId: string,
  userId?: string,
  options?: RequestOptions,
): Promise<AgentIdentityProfile> {
  return safeGet(
    withUserIdQuery(`/agents/identities/${encodeURIComponent(identityId)}/profile`, userId),
    options,
  );
}

export function normalizeScenarioAgentSource(
  source: string | null | undefined,
): 'generated' | 'custom' | 'replay' | 'unknown' {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (normalized === 'generated' || normalized === 'custom' || normalized === 'replay') return normalized;
  return normalized ? 'unknown' : 'generated';
}

export async function getAgentProfileData(
  agent: { agent_identity_id?: string | null; source_type?: string | null },
  userId?: string,
): Promise<ScenarioAgentProfileResponse> {
  const source = normalizeScenarioAgentSource(agent.source_type);
  if (!agent.agent_identity_id) {
    return { source, identity_id: null, profile: null, memories: [], growth_events: [] };
  }
  const id = agent.agent_identity_id;
  const [profile, mem, gr] = await Promise.all([
    getAgentIdentityProfile(id, userId),
    getIdentityMemory(id, userId).catch((err: unknown) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
      return { identity_id: id, memories: [] as AgentMemoryEntry[] };
    }),
    getIdentityGrowthEvents(id, userId).catch((err: unknown) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
      return { identity_id: id, events: [] as AgentGrowthEvent[] };
    }),
  ]);
  return {
    source,
    identity_id: id,
    profile,
    memories: mem.memories ?? [],
    growth_events: gr.events ?? [],
  };
}

// ── Identity Memory Inspector ───────────────────────────
export interface IdentityMemoryMetadata {
  scenario_id?: string | null;
  round?: number | string | null;
  type?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface IdentityMemoryEntry {
  document: string;
  metadata: IdentityMemoryMetadata;
  timestamp: string | null;
  confidence: number | string | null;
  is_compacted: boolean;
  memory_id?: string;
  source_scenario_id?: string | null;
  pinned?: boolean;
  remembered?: boolean;
}

export interface IdentityMemoriesResponse {
  memories: IdentityMemoryEntry[];
  total: number;
  error?: string;
  diagnostics?: { code: string; message: string } | null;
}

/** GET /api/agents/identities/:id/memories — inspector endpoint with full entry shape */
export async function getIdentityMemories(
  identityId: string,
  queryOrOptions?: string | RequestOptions,
  options?: RequestOptions,
): Promise<IdentityMemoriesResponse> {
  let query: string | undefined;
  let requestOpts: RequestOptions | undefined;
  if (typeof queryOrOptions === 'string') {
    query = queryOrOptions;
    requestOpts = options;
  } else {
    requestOpts = queryOrOptions;
  }

  let path = `/agents/identities/${encodeURIComponent(identityId)}/memories`;
  if (query) {
    path += `?query=${encodeURIComponent(query)}`;
  }
  return safeGet(
    withUserIdQuery(path),
    requestOpts,
  );
}

export async function pinIdentityMemory(
  identityId: string,
  memoryId: string,
  options?: RequestOptions,
): Promise<{
  identity_id: string;
  memory_id: string;
  pinned: boolean;
  pin_count: number;
  cap: number;
}> {
  return request(
    withUserIdQuery(`/agents/identities/${encodeURIComponent(identityId)}/memories/${encodeURIComponent(memoryId)}/pin`),
    {
      method: 'POST',
      signal: options?.signal,
    },
  );
}

export async function unpinIdentityMemory(
  identityId: string,
  memoryId: string,
  options?: RequestOptions,
): Promise<{
  identity_id: string;
  memory_id: string;
  pinned: boolean;
  pin_count: number;
  cap: number;
}> {
  return request(
    withUserIdQuery(`/agents/identities/${encodeURIComponent(identityId)}/memories/${encodeURIComponent(memoryId)}/pin`),
    {
      method: 'DELETE',
      signal: options?.signal,
    },
  );
}

/** PUT /api/agents/workshop/:identityId — update a custom agent */
export async function updateAgent(
  identityId: string,
  data: {
    display_name?: string;
    role?: string;
    persona?: string | null;
    knowledge_domains?: string[];
    preferred_tier?: 'IMPORTANT' | 'CROWD';
    decision_bias?: Record<string, number> | null;
  },
): Promise<{ detail: string }> {
  return request(withUserIdQuery(`/agents/workshop/${encodeURIComponent(identityId)}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** GET /api/scenario/:id/replay-trace — P1-1 replay lineage for a scenario (paginated) */
export async function getReplayTrace(
  scenarioId: string,
  opts?: { cursor?: string; limit?: number; branch_id?: string },
  options?: RequestOptions,
): Promise<ReplayTraceResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('after', opts.cursor);
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.branch_id) params.set('root_branch_id', opts.branch_id);
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return safeGet(
    `/scenario/${encodeURIComponent(scenarioId)}/replay-trace${suffix}`,
    options,
  );
}

/** GET /api/scenario/:id/faction-timeline — P1-8 faction overlay data */
export async function getFactionTimeline(
  scenarioId: string,
  branchId: string,
): Promise<Array<{
  round: number;
  factions: Array<{
    key: string;
    label: string | null;
    members: string[];
    stance_center?: number;
    confidence?: number;
  }>;
  events: Array<{
    type: string;
    actor_agent_id: string;
    faction_key: string;
  }>;
}>> {
  return safeGet(
    `/scenario/${encodeURIComponent(scenarioId)}/faction-timeline?branch_id=${encodeURIComponent(branchId)}`,
  );
}

/** GET /api/scenario/:id/social-feed — F11 Social Feed + Headline Cards data */
export async function getSocialFeed(scenarioId: string): Promise<SocialFeedResponse> {
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/social-feed`);
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

// ── S3-3: Personality Drift ──

export type PersonalityDriftSeverity = 'low' | 'medium' | 'high';

export interface PersonalityDriftDimension {
  dimension: string;
  initial: number;
  current: number;
  delta: number;
}

export interface PersonalityDriftResult {
  agent_id: string;
  agent_name: string;
  drift_score: number;
  drift_dimensions: PersonalityDriftDimension[];
  severity: PersonalityDriftSeverity;
  evidence: string[];
}

/** GET /api/scenario/:id/personality-drift — S3-3 per-Agent personality drift analysis */
export async function getPersonalityDrift(
  scenarioId: string,
): Promise<PersonalityDriftResult[]> {
  return safeGet<PersonalityDriftResult[]>(
    `/scenario/${encodeURIComponent(scenarioId)}/personality-drift`,
  );
}

// ── P2-2: Faction Relations (force graph) ──

export interface FactionRelationEdge {
  id: string;
  round: number;
  source_agent_id: string;
  target_agent_id: string;
  relation_type: 'trust' | 'opposition';
  weight: number;
  trust_score: number;
  opposition_score: number;
  evidence_summary: string | null;
}

export interface FactionRelationsResponse {
  edges: FactionRelationEdge[];
  truncated: boolean;
  threshold: number;
  top_k: number;
  total_before_filter: number;
}

/** GET /api/graphs/scenario/:id/faction-relations — P2-2 force graph edges */
export async function getFactionRelations(
  scenarioId: string,
  branchId: string,
  opts?: { roundMax?: number; threshold?: number; topK?: number },
): Promise<FactionRelationsResponse> {
  const params = new URLSearchParams();
  params.set('branch_id', branchId);
  if (opts?.roundMax != null) params.set('round_max', String(opts.roundMax));
  if (opts?.threshold != null) params.set('threshold', String(opts.threshold));
  if (opts?.topK != null) params.set('top_k', String(opts.topK));
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/faction-relations?${params}`);
}

// ── P1-3: Checkpoint picker for ResumePanel ──

import type { CheckpointInfo } from '../types';

/** GET /api/scenario/:id/checkpoints — list compressed checkpoints (P1-3) */
export async function getCheckpoints(
  scenarioId: string,
  branchId?: string,
): Promise<CheckpointInfo[]> {
  const params = branchId ? `?branch_id=${encodeURIComponent(branchId)}` : '';
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/checkpoints${params}`);
}

// ── S1-3 C2: Direct-fetch consolidation ──

/** GET /api/scenario/:id/causal-graph — full causal DAG (optionally branch-filtered) */
export async function getCausalGraph<T = unknown>(
  scenarioId: string,
  branchId?: string,
  options?: RequestOptions,
): Promise<T> {
  const params = branchId ? `?branch_id=${encodeURIComponent(branchId)}` : '';
  return safeGet(
    `/scenario/${encodeURIComponent(scenarioId)}/causal-graph${params}`,
    options,
  );
}

/** GET /api/debate/:id/argument-map — debate argument tree */
export async function getArgumentMap<T = unknown>(
  debateId: string,
  options?: RequestOptions,
): Promise<T> {
  return safeGet(`/debate/${encodeURIComponent(debateId)}/argument-map`, options);
}

/** GET /api/scenario/:id/compare — counterfactual branch comparison */
export async function getCounterfactualCompare<T = unknown>(
  scenarioId: string,
  branchA: string,
  branchB: string,
  options?: RequestOptions,
): Promise<T> {
  const sid = encodeURIComponent(scenarioId);
  const a = encodeURIComponent(branchA);
  const b = encodeURIComponent(branchB);
  return safeGet(`/scenario/${sid}/compare?branch_a=${a}&branch_b=${b}`, options);
}

/** POST /api/scenario/:id/counterfactual — submit counterfactual replay */
export async function submitCounterfactual<T = unknown>(
  scenarioId: string,
  body: {
    source_branch_id: string;
    round_number: number;
    agent_id: string;
    source_message_content?: string | null;
    replacement_content: string;
  },
): Promise<T> {
  return request(`/scenario/${encodeURIComponent(scenarioId)}/counterfactual`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /api/agents/identities — list custom agent identities for a user */
export async function listAgentIdentities<T = unknown>(
  userId: string,
  options?: RequestOptions,
): Promise<T> {
  return safeGet(`/agents/identities?user_id=${encodeURIComponent(userId)}`, options);
}

/** POST /api/agents/workshop — create a custom agent identity */
export async function createAgent<T = unknown>(
  body: {
    user_id: string;
    display_name: string;
    role: string;
    persona: string | null;
    knowledge_domains: string[];
    preferred_tier: 'IMPORTANT' | 'CROWD';
    decision_bias?: Record<string, number> | null;
  },
): Promise<T> {
  return request('/agents/workshop', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** DELETE /api/agents/workshop/:identityId — delete a custom agent */
export async function deleteAgent(identityId: string): Promise<void> {
  await request<void>(withUserIdQuery(`/agents/workshop/${encodeURIComponent(identityId)}`), {
    method: 'DELETE',
  });
}

// ── Document-driven Agent Generation ─────────────────────

/** Identity created by document-driven extraction. */
export interface DocumentAgentIdentity {
  id: string;
  name: string;
  role: string;
}

/** Response shape of `POST /api/agents/from-document`. */
export interface DocumentAgentResult {
  agents_created: number;
  entities_extracted: number;
  agents_failed?: number;
  identities: DocumentAgentIdentity[];
}

const DOCUMENT_AGENT_UPLOAD_TIMEOUT_MS = 480_000;

/**
 * POST /api/agents/from-document — multipart upload of a PDF that the
 * backend mines for entities and converts into custom agent identities.
 *
 * Throws `ApiError` for documented HTTP error codes:
 * - 413 (FILE_TOO_LARGE)
 * - 415 (UNSUPPORTED_MEDIA_TYPE)
 * - 422 (EXTRACTION_FAILED)
 * Other failures throw a regular `Error` with a sanitized message.
 */
export async function uploadDocumentForAgents(
  file: File,
  signal?: AbortSignal,
): Promise<DocumentAgentResult> {
  const form = new FormData();
  form.append('file', file, file.name);

  const res = await fetchWithTimeout(
    withUserIdQuery('/agents/from-document'),
    {
      method: 'POST',
      headers: buildSessionHeaders(),
      body: form,
      signal,
    },
    // Document parsing + entity extraction can be slow; lift the default
    // 30s ceiling. Caller can still cancel via AbortSignal.
    DOCUMENT_AGENT_UPLOAD_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return parseJsonResponse<DocumentAgentResult>(res, '/agents/from-document');
}

/**
 * POST /api/agents/document-seed
 * Upload a document (.pdf/.txt/.md/.markdown) to extract world_context and agents_preview.
 * Can be cancelled via AbortSignal.
 */
export async function uploadDocumentSeed(
  file: File,
  signal?: AbortSignal,
): Promise<DocumentSeedResponse> {
  const form = new FormData();
  form.append('file', file, file.name);

  const res = await fetchWithTimeout(
    withUserIdQuery('/agents/document-seed'),
    {
      method: 'POST',
      headers: buildSessionHeaders(),
      body: form,
      signal,
    },
    DOCUMENT_AGENT_UPLOAD_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return parseJsonResponse<DocumentSeedResponse>(res, '/agents/document-seed');
}

// ── Agent Favorites ──────────────────────────────────────

/** GET /api/agents/identities/favorites — list favorite agent identities */
export async function getAgentFavorites<T = unknown>(
  options?: RequestOptions,
): Promise<T> {
  return safeGet(withUserIdQuery('/agents/identities/favorites'), options);
}

/** POST /api/agents/identities/:id/favorite — mark an agent identity as favorite */
export async function markAgentFavorite<T = unknown>(
  identityId: string,
): Promise<T> {
  return request(withUserIdQuery(`/agents/identities/${encodeURIComponent(identityId)}/favorite`), {
    method: 'POST',
  });
}

/** DELETE /api/agents/identities/:id/favorite — unmark an agent identity favorite */
export async function unmarkAgentFavorite(identityId: string): Promise<void> {
  const res = await fetchWithTimeout(
    withUserIdQuery(`/agents/identities/${encodeURIComponent(identityId)}/favorite`),
    {
      method: 'DELETE',
      headers: buildSessionHeaders(),
    },
  );
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
}

// ── Persona Export / Import ──────────────────────────────

/** GET /api/agents/identities/:id/export — export a single persona as JSON. */
export async function exportPersona(
  identityId: number | string,
): Promise<PersonaExportPayload> {
  return safeGet(
    withUserIdQuery(`/agents/identities/${encodeURIComponent(String(identityId))}/export`),
  );
}

/** POST /api/agents/export-bulk — export multiple personas at once. */
export async function exportPersonasBulk(
  ids: Array<number | string>,
): Promise<{ personas: PersonaExportPayload[] }> {
  return request(withUserIdQuery('/agents/export-bulk'), {
    method: 'POST',
    body: JSON.stringify({ identity_ids: ids.map((id) => String(id)) }),
  });
}

/** POST /api/agents/import — import a persona payload, returns new identity id. */
export async function importPersona(
  payload: PersonaExportPayload,
): Promise<{ success: boolean; identity_id: string }> {
  return request(withUserIdQuery('/agents/import'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/admin/test-llm — admin LLM connection probe */
export async function adminTestLlm<T = unknown>(
  body: { base_url: string; api_key: string },
): Promise<T> {
  return request('/admin/test-llm', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ListModelsResponse {
  models: string[];
  provider: string;
  supported: boolean;
  reason?: string;
}

/** POST /api/admin/list-models — list available models for base_url and api_key */
export async function listModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ListModelsResponse> {
  return request('/admin/list-models', {
    method: 'POST',
    body: JSON.stringify({
      base_url: baseUrl,
      ...(apiKey ? { api_key: apiKey } : {}),
    }),
  });
}

// ── S2-1: Conversation thread reload ──────────────────────

/** Single conversation thread item for the scenario list view. */
export interface ConversationListItem {
  thread_id: string;
  scenario_id: string;
  agent_identity_id?: string | null;
  owner_user_id: string;
  origin_branch_id?: string | null;
  origin_round_number?: number | null;
  origin_node_id?: string | null;
  origin_node_type?: string | null;
  last_turn_sequence: number;
  latest_status: string;
  active_turn_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Cursor-paginated response for `GET /api/scenario/{id}/conversations`. */
export interface ConversationListResponse {
  items: ConversationListItem[];
  cursor: number;
  has_more: boolean;
}

/** Single turn returned by `GET /api/conversation/{thread_id}` playback. */
export interface ConversationTurnDetail {
  id: string;
  thread_id: string;
  role: string;
  sequence: number;
  status: string;
  content: string;
  error_code?: string | null;
  error_message?: string | null;
  model?: string | null;
  source_branch_id?: string | null;
  source_round_number?: number | null;
  source_node_id?: string | null;
  source_node_type?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

/** Full thread view returned by `GET /api/conversation/{thread_id}`. */
export interface ConversationDetail extends ConversationListItem {
  user_turn_id?: string | null;
  assistant_turn_id?: string | null;
  sequence_range?: number[] | null;
  turns: ConversationTurnDetail[];
}

/** GET /api/scenario/:id/conversations — list reloadable conversation threads (S2-1) */
export async function getScenarioConversations(
  scenarioId: string,
  cursor = 0,
  limit = 20,
  options?: RequestOptions,
): Promise<ConversationListResponse> {
  const params = new URLSearchParams();
  params.set('cursor', String(cursor));
  params.set('limit', String(limit));
  return safeGet(
    `/scenario/${encodeURIComponent(scenarioId)}/conversations?${params.toString()}`,
    options,
  );
}

/** GET /api/conversation/:thread_id — load full thread + ordered turn history (S2-1) */
export async function getConversation(
  threadId: string,
  options?: RequestOptions,
): Promise<ConversationDetail> {
  return safeGet(`/conversation/${encodeURIComponent(threadId)}`, options);
}

// ── S2-3: Quota summary ───────────────────────────────────

/** A single quota bucket returned by /api/quota/summary. */
export interface QuotaBucket {
  used: number;
  limit: number;
  remaining: number;
  enforced: boolean;
  scope: 'local' | 'user' | 'org' | 'scenario';
  window_seconds: number | null;
}

/** Response shape of `GET /api/quota/summary`. */
export interface QuotaSummaryResponse {
  conversation: QuotaBucket;
  replay: QuotaBucket;
}

/** GET /api/quota/summary — fetch conversation + replay branch quota usage (S2-3). */
export async function getQuotaSummary(
  scenarioId?: string,
  options?: RequestOptions,
): Promise<QuotaSummaryResponse> {
  const id = scenarioId?.trim();
  const path = id
    ? `/quota/summary?scenario_id=${encodeURIComponent(id)}`
    : '/quota/summary';
  return safeGet(path, options);
}

/* ─── Personal Prediction Journal ───────────────────────────
   Server-side endpoints under /api/me/* deliver per-user
   forecast records and calibration aggregates. All endpoints
   are user-scoped via the shared session token.
   ──────────────────────────────────────────────────────── */

export interface JournalEntry {
  id: number;
  user_id: string;
  scenario_id: string | null;
  question: string;
  predicted_probability: number;
  actual_outcome: boolean | null;
  resolved_at: string | null;
  created_at: string;
  brier_score: number | null;
}

export interface JournalListResponse {
  items: JournalEntry[];
  limit: number;
  offset: number;
}

export interface CalibrationBin {
  range: [number, number];
  predicted_avg: number | null;
  actual_frequency: number | null;
  count: number;
}

export interface CalibrationResponse {
  bins: CalibrationBin[];
}

export interface CreateJournalEntryRequest {
  question: string;
  predicted_probability: number;
  scenario_id?: string | null;
}

export interface ResolveJournalEntryRequest {
  actual_outcome: boolean;
}

/** GET /api/me/journal — list the current user's prediction journal entries. */
export async function listJournalEntries(options?: RequestOptions): Promise<JournalListResponse> {
  return request(
    '/me/journal',
    {
      signal: options?.signal,
      headers: userIdHeader(),
    },
    DEFAULT_TIMEOUT,
    { retryTransient: true, retryAttempts: DEFAULT_RETRY_ATTEMPTS },
  );
}

/** GET /api/me/calibration — calibration histogram for the current user. */
export async function getJournalCalibration(options?: RequestOptions): Promise<CalibrationResponse> {
  return request(
    '/me/calibration',
    {
      signal: options?.signal,
      headers: userIdHeader(),
    },
    DEFAULT_TIMEOUT,
    { retryTransient: true, retryAttempts: DEFAULT_RETRY_ATTEMPTS },
  );
}

/** POST /api/me/journal — log a new forecast in the current user's journal. */
export async function createJournalEntry(
  body: CreateJournalEntryRequest,
): Promise<JournalEntry> {
  return request('/me/journal', {
    method: 'POST',
    headers: userIdHeader(),
    body: JSON.stringify(body),
  });
}

/** PATCH /api/me/journal/:id/resolve — record the actual outcome for a journal entry. */
export async function resolveJournalEntry(
  id: number | string,
  body: ResolveJournalEntryRequest,
): Promise<JournalEntry> {
  return request(`/me/journal/${encodeURIComponent(id)}/resolve`, {
    method: 'PATCH',
    headers: userIdHeader(),
    body: JSON.stringify(body),
  });
}

/** Phase 4: intervention effect receipt payload (newest first). */
export interface InterventionEffectAffectedAgent {
  agent_id: string;
  display_name: string;
}

export interface InterventionEffectExcerpt {
  agent_id: string;
  excerpt: string;
}

export interface InterventionEffect {
  intervention_log_id: string;
  card_id: string | null;
  card_label: string | null;
  round_number: number;
  affected_agents: InterventionEffectAffectedAgent[];
  response_excerpts: InterventionEffectExcerpt[];
  confidence: number;
  no_response_detected: boolean;
  created_at: string;
}

export interface InterventionEffectsResponse {
  effects: InterventionEffect[];
}

/** GET /api/scenario/:id/intervention-effects — Phase 4 effect receipts. */
export async function getInterventionEffects(
  scenarioId: string,
): Promise<InterventionEffectsResponse> {
  return safeGet(`/scenario/${encodeURIComponent(scenarioId)}/intervention-effects`);
}

/** POST /api/scenario/:id/public-artifact — Generate public artifact. */
export async function buildPublicArtifact(
  scenarioId: string,
  options?: RequestOptions,
): Promise<PublicArtifact> {
  return request<PublicArtifact>(
    `/scenario/${encodeURIComponent(scenarioId)}/public-artifact`,
    { method: 'POST', signal: options?.signal },
  );
}

/** GET /api/packs — List local packs summaries */
export async function listLocalPacks(): Promise<ListPacksResponse> {
  return safeGet('/packs');
}

/** GET /api/packs/:id — Fetch a single local pack detail */
export async function getLocalPack(id: string): Promise<LocalPack> {
  return safeGet(`/packs/${encodeURIComponent(id)}`);
}

/** POST /api/packs/refresh — Refresh all local packs from disk */
export async function refreshLocalPacks(): Promise<RefreshPacksResponse> {
  return request('/packs/refresh', { method: 'POST' });
}

/** GET /api/packs/diagnostics — Get current pack diagnostics */
export async function getLocalPackDiagnostics(): Promise<DiagnosticsResponse> {
  return safeGet('/packs/diagnostics');
}

/** GET /api/model-profiles — List model profiles */
export async function listModelProfiles(
  params?: { user_id?: string },
  options?: RequestOptions,
): Promise<{ profiles: ModelProfile[]; count: number }> {
  const path = withUserIdQuery('/model-profiles', params?.user_id);
  return safeGet<{ profiles: ModelProfile[]; count: number }>(path, options);
}

/** POST /api/model-profiles — Create model profile */
export async function createModelProfile(
  input: ModelProfileInput,
  options?: RequestOptions,
): Promise<ModelProfile> {
  const body = { ...input, user_id: getSessionBoundUserId(input.user_id) };
  return request<ModelProfile>('/model-profiles', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: options?.signal,
  });
}

/** GET /api/model-profiles/{profile_id} — Get model profile */
export async function getModelProfile(
  id: string,
  params?: { user_id?: string },
  options?: RequestOptions,
): Promise<ModelProfile> {
  const path = withUserIdQuery(`/model-profiles/${encodeURIComponent(id)}`, params?.user_id);
  return safeGet<ModelProfile>(path, options);
}

/** PATCH /api/model-profiles/{profile_id} — Patch model profile */
export async function patchModelProfile(
  id: string,
  input: ModelProfilePatchInput,
  params?: { user_id?: string },
  options?: RequestOptions,
): Promise<ModelProfile> {
  const path = withUserIdQuery(`/model-profiles/${encodeURIComponent(id)}`, params?.user_id);
  return request<ModelProfile>(path, {
    method: 'PATCH',
    body: JSON.stringify(input),
    signal: options?.signal,
  });
}

/** DELETE /api/model-profiles/{profile_id} — Delete model profile */
export async function deleteModelProfile(
  id: string,
  params?: { user_id?: string },
  options?: RequestOptions,
): Promise<void> {
  const path = withUserIdQuery(`/model-profiles/${encodeURIComponent(id)}`, params?.user_id);
  await request<void>(path, {
    method: 'DELETE',
    signal: options?.signal,
  });
}
