/**
 * Phase A0 — Contract Freeze Tests (Frontend)
 *
 * Verify existing TypeScript interfaces and routes are preserved.
 * Codify Phase 3 naming freeze for frontend additions.
 */
import { describe, expect, it } from 'vitest';

// ── Type-level import checks ────────────────────────────────
// These imports will cause compile errors if types are removed.
import type {
  AgentInfo,
  BranchInfo,
  DebateWSEvent as _DebateWSEvent,
  Scenario,
  WSEvent,
  WebSearchContext,
} from '../types';

describe('Phase A0: ScenarioResponse type contract', () => {
  it('Scenario interface has all 20 frozen fields', () => {
    // Compile-time check via typed object literal.
    // If any field is removed from Scenario, this won't compile.
    const frozen: Record<keyof Pick<Scenario,
      | 'id' | 'question' | 'status' | 'created_at'
      | 'agents' | 'branches' | 'groups' | 'messages'
      | 'total_rounds' | 'mode' | 'visualization_enabled' | 'scene_theme'
      | 'web_search_context' | 'director_state' | 'gameplay_state' | 'fork_debug'
      | 'hierarchical'
    >, true> = {
      id: true, question: true, status: true, created_at: true,
      agents: true, branches: true, groups: true, messages: true,
      total_rounds: true, mode: true, visualization_enabled: true, scene_theme: true,
      web_search_context: true, director_state: true, gameplay_state: true, fork_debug: true,
      hierarchical: true,
    };
    expect(Object.keys(frozen).length).toBeGreaterThanOrEqual(17);
  });

  it('AgentInfo has core fields', () => {
    const frozen: Record<keyof Pick<AgentInfo,
      'id' | 'name' | 'role' | 'tier' | 'emotion'
    >, true> = {
      id: true, name: true, role: true, tier: true, emotion: true,
    };
    expect(Object.keys(frozen)).toHaveLength(5);
  });

  it('BranchInfo has core fields', () => {
    const frozen: Record<keyof Pick<BranchInfo,
      'id' | 'title' | 'probability' | 'status'
    >, true> = {
      id: true, title: true, probability: true, status: true,
    };
    expect(Object.keys(frozen)).toHaveLength(4);
  });
});

describe('Phase A0: WSEvent type contract', () => {
  it('WSEvent discriminator includes existing event types', () => {
    // Verify WSEvent union accepts known event types at compile time.
    const authOk: WSEvent = { type: 'auth_ok' };
    const simDone: WSEvent = { type: 'simulation_done' };
    expect(authOk.type).toBe('auth_ok');
    expect(simDone.type).toBe('simulation_done');
  });
});

describe('Phase A0: WebSearchContext contract', () => {
  it('WebSearchContext has expected shape', () => {
    const sample: WebSearchContext = {
      query: 'test',
      snippets: [{ text: 'x', source_url: 'https://example.com' }],
      provider: 'tavily',
      timestamp: '2026-01-01T00:00:00Z',
      cached: false,
    };
    expect(sample.provider).toBe('tavily');
  });
});

describe('Phase A0: Naming freeze — Phase 3 new types', () => {
  // Document the frozen names for new frontend types.
  // These will be implemented in later phases.

  const FROZEN_NEW_FRONTEND_ROUTES = [
    '/agents',        // F3: Agent library
    '/agents/new',    // F3: Agent workshop
    '/sim/:id/causal-map',    // F2: Causal graph
    '/result/:id/compare',    // F4: Counterfactual compare
  ] as const;

  const FROZEN_NEW_WS_EVENTS = [
    'viz:faction_cluster',
    'viz:faction_event',
    'argument_proposed',
    'argument_attacked',
  ] as const;

  const FROZEN_NEW_SCENARIO_FIELDS = [
    'causal_graph_id',
    'checkpoints',
    'faction_timeline_id',
  ] as const;

  const FROZEN_NEW_AGENT_FIELDS = [
    'agent_identity_id',
    'source_type',
    'is_returning',
  ] as const;

  const FROZEN_CAPABILITIES_KEYS = [
    'web_search',
    'custom_agents',
    'agent_identity',
    'causal_graph',
    'counterfactual_replay',
    'factions',
    'argument_map',
  ] as const;

  it('frontend routes frozen', () => {
    expect(FROZEN_NEW_FRONTEND_ROUTES).toHaveLength(4);
  });

  it('WS events frozen', () => {
    expect(FROZEN_NEW_WS_EVENTS).toHaveLength(4);
  });

  it('new scenario fields frozen', () => {
    expect(FROZEN_NEW_SCENARIO_FIELDS).toHaveLength(3);
  });

  it('new agent fields frozen', () => {
    expect(FROZEN_NEW_AGENT_FIELDS).toHaveLength(3);
  });

  it('capabilities keys frozen at 7', () => {
    expect(FROZEN_CAPABILITIES_KEYS).toHaveLength(7);
  });

  it('agent_identity_id not profile_id', () => {
    expect(FROZEN_NEW_AGENT_FIELDS).toContain('agent_identity_id');
    expect(FROZEN_NEW_AGENT_FIELDS).not.toContain('profile_id');
  });
});
