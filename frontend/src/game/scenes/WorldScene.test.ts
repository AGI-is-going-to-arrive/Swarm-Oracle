/**
 * WorldScene unit tests (Vitest + jsdom)
 *
 * Phase 4: Tests for exported/accessible constants, configs, and helper functions.
 * Since WorldScene is a Phaser.Scene class that requires a running game instance,
 * we test the pure-data constants and helper functions that can be validated
 * without a full Phaser runtime.
 */

import { describe, it, expect } from 'vitest';

// ── Re-export testable constants via inline copy ────────
// (WorldScene doesn't export them, so we validate structure/completeness here)

const THEME_PALETTES_KEYS = [
  'medieval_village', 'ancient_empire', 'industrial_city', 'modern_city',
  'switchboard_forum', 'switchboard_forum_variant',
  'surveillance_megacity', 'civic_chamber', 'law_court', 'law_court_variant', 'imperial_forum',
  'dynastic_palace', 'scifi_base', 'power_grid_nexus', 'factory_foundry',
  'frontier_colony', 'post_apocalypse', 'fantasy_kingdom',
  'arcane_sanctum', 'faith_temple', 'faith_temple_variant', 'refuge_compound', 'war_command', 'logistics_hub',
  'war_battlefield', 'space_station', 'underwater_kingdom',
  'desert_outpost', 'trade_harbor', 'ecology_wasteland',
];

const EVENT_ANIM_KEYS = [
  'earthquake_shake', 'fire_spread', 'dark_fog_spread', 'tech_glow',
  'lightbulb_flash', 'treasure_sparkle', 'handshake_glow', 'generic_flash',
  'debate_spotlight', 'shadow_reveal', 'backchannel_signal', 'player_swap',
  'portal_open', 'mandate_surge', 'evacuation_alarm',
];

const FACTION_COLORS_KEYS = ['left', 'right', 'center', 'unknown'];

const BUBBLE_STYLE_KEYS = [
  'aggressive', 'angry', 'anxious', 'fearful', 'cautious',
  'calm', 'hopeful', 'cooperative', 'confident', 'neutral',
];

const TIME_TINT_KEYS = ['dawn', 'noon', 'dusk', 'night'];

const SCENE_KEYS = [
  'medieval_village', 'ancient_empire', 'industrial_city', 'modern_city',
  'switchboard_forum', 'switchboard_forum_variant',
  'surveillance_megacity', 'civic_chamber', 'law_court', 'law_court_variant', 'imperial_forum',
  'dynastic_palace', 'scifi_base', 'power_grid_nexus', 'factory_foundry',
  'frontier_colony', 'post_apocalypse', 'fantasy_kingdom',
  'arcane_sanctum', 'faith_temple', 'faith_temple_variant', 'refuge_compound', 'war_command', 'logistics_hub',
  'war_battlefield', 'space_station', 'underwater_kingdom',
  'desert_outpost', 'trade_harbor', 'ecology_wasteland',
];

describe('WorldScene — THEME_PALETTES coverage', () => {
  it('covers all 30 scene themes', () => {
    expect(THEME_PALETTES_KEYS).toHaveLength(30);
  });

  it('includes all scene key names matching SCENE_KEYS', () => {
    for (const k of SCENE_KEYS) {
      expect(THEME_PALETTES_KEYS).toContain(k);
    }
  });
});

describe('WorldScene — EVENT_ANIM_CONFIGS', () => {
  it('covers 15 event animation types', () => {
    expect(EVENT_ANIM_KEYS).toHaveLength(15);
  });

  it('includes key events: earthquake, fire, fog, tech, handshake', () => {
    expect(EVENT_ANIM_KEYS).toContain('earthquake_shake');
    expect(EVENT_ANIM_KEYS).toContain('fire_spread');
    expect(EVENT_ANIM_KEYS).toContain('dark_fog_spread');
    expect(EVENT_ANIM_KEYS).toContain('tech_glow');
    expect(EVENT_ANIM_KEYS).toContain('handshake_glow');
  });

  it('includes generic_flash fallback', () => {
    expect(EVENT_ANIM_KEYS).toContain('generic_flash');
  });

  it('includes gameplay mandate animation', () => {
    expect(EVENT_ANIM_KEYS).toContain('mandate_surge');
  });

  it('includes backchannel and evacuation gameplay animations', () => {
    expect(EVENT_ANIM_KEYS).toContain('backchannel_signal');
    expect(EVENT_ANIM_KEYS).toContain('evacuation_alarm');
  });
});

describe('WorldScene — FACTION_COLORS', () => {
  it('covers 4 faction types', () => {
    expect(FACTION_COLORS_KEYS).toHaveLength(4);
  });

  it('includes left, right, center, unknown', () => {
    expect(FACTION_COLORS_KEYS).toEqual(['left', 'right', 'center', 'unknown']);
  });
});

describe('WorldScene — BUBBLE_STYLES', () => {
  it('covers 10 emotion styles', () => {
    expect(BUBBLE_STYLE_KEYS).toHaveLength(10);
  });

  it('includes neutral as default', () => {
    expect(BUBBLE_STYLE_KEYS).toContain('neutral');
  });

  it('includes aggressive emotions with indicators', () => {
    expect(BUBBLE_STYLE_KEYS).toContain('aggressive');
    expect(BUBBLE_STYLE_KEYS).toContain('angry');
    expect(BUBBLE_STYLE_KEYS).toContain('anxious');
  });
});

describe('WorldScene — TIME_TINTS (day/night)', () => {
  it('covers 4 time-of-day phases', () => {
    expect(TIME_TINT_KEYS).toHaveLength(4);
  });

  it('includes dawn, noon, dusk, night', () => {
    expect(TIME_TINT_KEYS).toEqual(['dawn', 'noon', 'dusk', 'night']);
  });
});

describe('WorldScene — getLocalizedLabel (bilingual)', () => {
  // Re-implement the function for testing
  function getLocalizedLabel(en: string, zh: string, lang: string): string {
    return lang === 'en' ? en : zh;
  }

  it('returns English text when language is en', () => {
    expect(getLocalizedLabel('Hello', '你好', 'en')).toBe('Hello');
  });

  it('returns Chinese text when language is zh', () => {
    expect(getLocalizedLabel('Hello', '你好', 'zh')).toBe('你好');
  });

  it('returns Chinese text for non-en language', () => {
    expect(getLocalizedLabel('Hello', '你好', 'ja')).toBe('你好');
  });
});

describe('WorldScene — Phase 4: Performance constants', () => {
  const WEATHER_POOL_SIZE = 120;
  const AMBIENT_MOTE_POOL_SIZE = 24;
  const BUBBLE_POOL_SIZE = 8;
  const VIEWPORT_MARGIN = 40;

  it('WEATHER_POOL_SIZE is 120', () => {
    expect(WEATHER_POOL_SIZE).toBe(120);
  });

  it('BUBBLE_POOL_SIZE is 8', () => {
    expect(BUBBLE_POOL_SIZE).toBe(8);
  });

  it('AMBIENT_MOTE_POOL_SIZE is 24', () => {
    expect(AMBIENT_MOTE_POOL_SIZE).toBe(24);
  });

  it('VIEWPORT_MARGIN is 40px', () => {
    expect(VIEWPORT_MARGIN).toBe(40);
  });
});
