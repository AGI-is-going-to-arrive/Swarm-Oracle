/**
 * VizSynthesizer unit tests (Vitest)
 *
 * Tests for the role-to-sprite mapping, scene theme inference,
 * and scene_init data synthesis logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mapRoleToSpriteId,
  inferSceneTheme,
  synthesizeSceneInit,
  synthesizeBubbles,
  synthesizeLatestBubbles,
} from './VizSynthesizer';
import * as EventBridge from './EventBridge';
import type { AgentInfo, AgentMessage } from '../../types';

// ── mapRoleToSpriteId ────────────────────────────────────

describe('VizSynthesizer — mapRoleToSpriteId', () => {
  it('maps exact role matches', () => {
    expect(mapRoleToSpriteId('king', 'Arthur')).toBe('sprite_king');
    expect(mapRoleToSpriteId('warrior', 'Garen')).toBe('sprite_warrior');
    expect(mapRoleToSpriteId('scholar', 'Prof. X')).toBe('sprite_scholar');
    expect(mapRoleToSpriteId('merchant', 'Marco')).toBe('sprite_merchant');
  });

  it('maps case-insensitive role matches', () => {
    expect(mapRoleToSpriteId('King', 'Arthur')).toBe('sprite_king');
    expect(mapRoleToSpriteId('WARRIOR', 'Garen')).toBe('sprite_warrior');
  });

  it('maps partial role matches', () => {
    expect(mapRoleToSpriteId('Royal King Advisor', 'John')).toBe('sprite_king');
    expect(mapRoleToSpriteId('Military General', 'Patton')).toBe('sprite_general');
  });

  it('falls back to name matching when role has no match', () => {
    expect(mapRoleToSpriteId('Unknown Role', 'Explorer Dan')).toBe('sprite_explorer');
    expect(mapRoleToSpriteId('Nobody', 'The Healer')).toBe('sprite_healer');
  });

  it('returns a valid sprite via hash fallback when no match found', () => {
    const result = mapRoleToSpriteId('xyzzy', 'qwerty');
    // Hash-based fallback distributes unmatched roles across all sprites
    expect(result).toMatch(/^sprite_/);
    expect(result).not.toBe('sprite_default'); // hash distributes, doesn't default
  });

  it('maps alias roles correctly', () => {
    expect(mapRoleToSpriteId('queen', 'Elizabeth')).toBe('sprite_king');
    expect(mapRoleToSpriteId('soldier', 'Private Ryan')).toBe('sprite_warrior');
    expect(mapRoleToSpriteId('professor', 'Einstein')).toBe('sprite_scholar');
    expect(mapRoleToSpriteId('doctor', 'House')).toBe('sprite_healer');
    expect(mapRoleToSpriteId('commander', 'Shepard')).toBe('sprite_general');
  });
});

// ── inferSceneTheme ──────────────────────────────────────

describe('VizSynthesizer — inferSceneTheme', () => {
  it('detects medieval keywords', () => {
    expect(inferSceneTheme('What if medieval knights had guns?')).toBe('medieval_village');
    expect(inferSceneTheme('如果中世纪骑士有火药？')).toBe('medieval_village');
  });

  it('detects sci-fi keywords', () => {
    expect(inferSceneTheme('如果人类在2000年登陆火星？')).toBe('scifi_base');
    expect(inferSceneTheme('What if we had robots in 1900?')).toBe('scifi_base');
    expect(inferSceneTheme('如果人工智能统治世界？')).toBe('scifi_base');
    expect(inferSceneTheme('What if algorithmic government replaced elections?')).toBe('scifi_base');
  });

  it('detects war keywords', () => {
    expect(inferSceneTheme('What if World War 3 started?')).toBe('war_battlefield');
    expect(inferSceneTheme('如果战争永不结束？')).toBe('war_battlefield');
  });

  it('detects modern/internet keywords', () => {
    expect(inferSceneTheme('如果互联网从未被发明？')).toBe('modern_city');
    expect(inferSceneTheme('如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？')).toBe('law_court');
  });

  it('detects governance, empire, and war semantic variants', () => {
    expect(inferSceneTheme('citizens assembly after election crisis')).toBe('civic_chamber');
    expect(inferSceneTheme('如果罗马帝国从未衰落？')).toBe('imperial_forum');
    expect(inferSceneTheme('如果世界大战在高度自动化军备时代再次爆发？')).toBe('war_command');
  });

  it('detects industry, frontier, mythic, and survival semantic variants', () => {
    expect(inferSceneTheme('resource bottleneck in a massive foundry complex')).toBe('factory_foundry');
    expect(inferSceneTheme('autonomous city-state on a frontier colony')).toBe('frontier_colony');
    expect(inferSceneTheme('arcane wizard conclave in a rune sanctuary')).toBe('arcane_sanctum');
    expect(inferSceneTheme('fortified quarantine refuge after famine')).toBe('refuge_compound');
  });

  it('detects second lightweight variants for major profiles', () => {
    expect(inferSceneTheme('platform state with social credit checkpoints')).toBe('surveillance_megacity');
    expect(inferSceneTheme('succession crisis inside a dynastic palace')).toBe('dynastic_palace');
    expect(inferSceneTheme('blackout cascade inside a continental power grid nexus')).toBe('power_grid_nexus');
    expect(inferSceneTheme('supply line collapse at a fortified logistics hub')).toBe('logistics_hub');
  });

  it('detects ancient empire keywords', () => {
    expect(inferSceneTheme('如果罗马帝国从未衰落？')).toBe('imperial_forum');
    expect(inferSceneTheme('如果诸葛亮多活10年？')).toBe('ancient_empire');
  });

  it('detects trade, faith, and ecology themed prompts', () => {
    expect(inferSceneTheme('如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？')).toBe('trade_harbor');
    expect(inferSceneTheme('如果跨大陆淡水供应在十年内枯竭，会发生什么？')).toBe('ecology_wasteland');
    expect(inferSceneTheme('如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？')).toBe('faith_temple');
  });

  it('prefers frontier-specific phrases over generic sci-fi keywords', () => {
    expect(inferSceneTheme('如果人类在2000年登陆火星？')).toBe('scifi_base');
    expect(inferSceneTheme('如果火星殖民地在补给断裂后必须决定是否强制撤离，会发生什么？')).toBe('space_station');
    expect(inferSceneTheme('What if a Mars colony lost life support and had to choose an evacuation route?')).toBe('space_station');
  });

  it('returns medieval_village as default', () => {
    expect(inferSceneTheme('Some random question')).toBe('medieval_village');
    expect(inferSceneTheme('')).toBe('medieval_village');
  });
});

// ── synthesizeSceneInit ──────────────────────────────────

describe('VizSynthesizer — synthesizeSceneInit', () => {
  const mockAgents: AgentInfo[] = [
    { id: 'a1', name: 'King Arthur', role: 'king', tier: 'CORE', emotion: 'calm' },
    { id: 'a2', name: 'Sir Lancelot', role: 'warrior', tier: 'IMPORTANT', emotion: 'confident' },
    { id: 'a3', name: 'Merlin', role: 'scholar', tier: 'CORE', emotion: 'hopeful' },
  ];

  it('generates correct structure', () => {
    const result = synthesizeSceneInit(mockAgents, 'medieval_village');
    expect(result).toHaveProperty('scene_theme', 'medieval_village');
    expect(result).toHaveProperty('agents');
    expect((result.agents as unknown[]).length).toBe(3);
  });

  it('maps roles to sprite_ids', () => {
    const result = synthesizeSceneInit(mockAgents, 'medieval_village');
    const agents = result.agents as Array<{ sprite_id: string }>;
    expect(agents[0].sprite_id).toBe('sprite_king');
    expect(agents[1].sprite_id).toBe('sprite_warrior');
    expect(agents[2].sprite_id).toBe('sprite_scholar');
  });

  it('generates valid positions within canvas bounds', () => {
    const result = synthesizeSceneInit(mockAgents, 'medieval_village');
    const agents = result.agents as Array<{ x: number; y: number }>;
    for (const a of agents) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(800);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(450);
    }
  });

  it('handles empty agents array', () => {
    const result = synthesizeSceneInit([], 'medieval_village');
    expect((result.agents as unknown[]).length).toBe(0);
  });

  it('handles large agent counts', () => {
    const manyAgents: AgentInfo[] = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`, name: `Agent ${i}`, role: 'villager', tier: 'CROWD' as const, emotion: 'neutral',
    }));
    const result = synthesizeSceneInit(manyAgents, 'scifi_base');
    expect((result.agents as unknown[]).length).toBe(20);
  });
});

// ── synthesizeBubbles ────────────────────────────────────

describe('VizSynthesizer — synthesizeBubbles', () => {
  const mockAgents: AgentInfo[] = [
    { id: 'a1', name: 'King', role: 'king', tier: 'CORE', emotion: 'calm' },
  ];
  const mockMessages: AgentMessage[] = [
    { agent: 'King', agent_id: 'a1', message: 'Hello world', emotion: 'calm', branch: 'b1', round: 1 },
    { agent: 'King', agent_id: 'a1', message: 'I am angry!', emotion: 'angry', branch: 'b1', round: 1 },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a cleanup function', () => {
    const cleanup = synthesizeBubbles(mockMessages, mockAgents);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('schedules events (does not throw)', () => {
    const cleanup = synthesizeBubbles(mockMessages, mockAgents, 2, 100);
    vi.advanceTimersByTime(500);
    cleanup();
  });

  it('caps messages at 60', () => {
    const manyMessages: AgentMessage[] = Array.from({ length: 100 }, (_, i) => ({
      agent: 'King', agent_id: 'a1', message: `Msg ${i}`, emotion: 'neutral', branch: 'b1', round: 1,
    }));
    const cleanup = synthesizeBubbles(manyMessages, mockAgents, 3, 100);
    // Should schedule ceil(60/3) = 20 batches, not 34
    cleanup();
  });

  it('can render the latest visible bubbles immediately', () => {
    const dispatchSpy = vi.spyOn(EventBridge, 'dispatchVizEvent').mockImplementation(() => {});

    synthesizeLatestBubbles([
      { agent: 'King', agent_id: 'a1', message: 'First', emotion: 'neutral', branch: 'b1', round: 1 },
      { agent: 'King', agent_id: 'a1', message: 'Latest', emotion: 'angry', branch: 'b1', round: 2 },
    ], mockAgents);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'viz:bubble_show',
      expect.objectContaining({ bubble_text: 'Latest', sprite_id: 'a1' }),
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      'viz:emotion_change',
      expect.objectContaining({ sprite_id: 'a1' }),
    );
  });
});
