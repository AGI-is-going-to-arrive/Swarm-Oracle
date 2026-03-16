/* ═══════════════════════════════════════════════════════════
   SwarmOracle — REST API Client
   ═══════════════════════════════════════════════════════════ */

import type {
  Scenario, Branch, StoryData, AgentInfo, AgentGroupDetail,
  InterventionPayload, InterventionResponse,
  PredictionInfo, LeaderboardEntry,
} from '../types';

const BASE = '/api';

const DEFAULT_TIMEOUT = 30000; // M-5 fix: 30s default request timeout

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // M-9 fix: only set Content-Type for requests with a body
  const headers: Record<string, string> = {};
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }
  // M-5 fix: AbortController-based timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      // H-3 fix: spread init.headers AFTER defaults so user overrides win
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${body}`);
    }
    return res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`API request timed out after ${DEFAULT_TIMEOUT}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Fetch response as raw text (for Markdown export). */
async function requestText(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`);
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
): Promise<{ server: string; llm: { status: string; model: string; response?: string; error?: string } }> {
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
  question: string,
  rounds?: number,
  numAgents?: number,
  mode?: 'raw' | 'blackboard',
  hierarchical?: boolean,
  llmApiKey?: string,
  llmBaseUrl?: string,
  llmModel?: string,
  reasoningEffort?: string,
  visualizationEnabled?: boolean,
): Promise<Scenario> {
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
      ...(visualizationEnabled != null && { visualization_enabled: visualizationEnabled }),
    }),
  });
}

/** GET /api/scenario/:id — get scenario status + agents + branches */
export async function getScenario(id: string): Promise<Scenario> {
  return request(`/scenario/${id}`);
}

/** GET /api/scenario/:id/branches — get branch tree */
export async function getBranches(id: string): Promise<Branch[]> {
  return request(`/scenario/${id}/branches`);
}

/** GET /api/scenario/:id/story — get narrated stories for completed branches */
export async function getStory(id: string): Promise<StoryData> {
  return request(`/scenario/${id}/story`);
}

/** GET /api/scenario/:id/agents — get all agents for a scenario */
export async function getAgents(id: string): Promise<AgentInfo[]> {
  return request(`/scenario/${id}/agents`);
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

/** GET /api/scenario/:id/groups — get hierarchical groups (P3-A) */
export async function getGroups(scenarioId: string): Promise<AgentGroupDetail[]> {
  return request(`/scenario/${scenarioId}/groups`);
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
  return request(`/scenarios?${params.toString()}`);
}

/** DELETE /api/scenario/:id — cascade delete a scenario (P5-A) */
export async function deleteScenario(id: string): Promise<{ status: string; scenario_id: string }> {
  return request(`/scenario/${id}`, { method: 'DELETE' });
}

/** GET /api/scenario/:id/export — export scenario as Markdown text (P5-C) */
export async function exportScenario(id: string): Promise<string> {
  return requestText(`/scenario/${id}/export`);
}

/** GET /api/scenario/:id/social/:platform — generate social media copy (P6) */
export async function generateSocialCopy(
  id: string,
  platform: string,
): Promise<{ platform: string; platform_name: string; copy: string }> {
  return request(`/scenario/${id}/social/${platform}`);
}

/** POST /api/scenario/:id/predict — submit a prediction (P5-B) */
export async function submitPrediction(
  scenarioId: string,
  predictionText: string,
  confidence: number,
  userName?: string,
): Promise<PredictionInfo> {
  return request(`/scenario/${scenarioId}/predict`, {
    method: 'POST',
    body: JSON.stringify({
      prediction_text: predictionText,
      confidence,
      ...(userName && { user_name: userName }),
    }),
  });
}

/** GET /api/scenario/:id/predictions — list predictions for a scenario (P5-B) */
export async function listPredictions(scenarioId: string): Promise<PredictionInfo[]> {
  return request(`/scenario/${scenarioId}/predictions`);
}

/** POST /api/scenario/:id/score-predictions — trigger LLM scoring (P5-B) */
export async function scorePredictions(scenarioId: string): Promise<{ scored: number }> {
  return request(`/scenario/${scenarioId}/score-predictions`, { method: 'POST' });
}

/** GET /api/leaderboard — global prediction leaderboard (P5-B) */
export async function getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
  return request(`/leaderboard?limit=${limit}`);
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
  return request('/intervention-templates');
}
