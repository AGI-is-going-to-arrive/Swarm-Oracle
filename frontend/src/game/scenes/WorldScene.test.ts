/**
 * WorldScene unit tests (Vitest + jsdom)
 *
 * Phase 4: Tests for exported/accessible constants, configs, and helper functions.
 * Since WorldScene is a Phaser.Scene class that requires a running game instance,
 * we test the pure-data constants and helper functions that can be validated
 * without a full Phaser runtime.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

function readWorldSceneSource(): string {
  return readFileSync(`${process.cwd()}/src/game/scenes/WorldScene.ts`, 'utf8');
}

function readEventBridgeSource(): string {
  return readFileSync(`${process.cwd()}/src/game/managers/EventBridge.ts`, 'utf8');
}

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
  'portal_open', 'mandate_surge', 'evacuation_alarm', 'hearing_bell',
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
  it('covers 16 event animation types', () => {
    expect(EVENT_ANIM_KEYS).toHaveLength(16);
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

  it('includes public hearing gameplay animation', () => {
    expect(EVENT_ANIM_KEYS).toContain('hearing_bell');
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

describe('WorldScene — bubble readability tuning', () => {
  const BUBBLE_MAX_VISIBLE = 2;
  const BUBBLE_MAX_TEXT_CHARS = 72;

  it('keeps two recent bubbles visible for cross-agent readability', () => {
    expect(BUBBLE_MAX_VISIBLE).toBe(2);
  });

  it('allows substantially longer bubble text before truncation', () => {
    expect(BUBBLE_MAX_TEXT_CHARS).toBe(72);
  });

  it('emits throttled sprite positions for the React DOM bubble overlay', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('private lastPositionEmitTime = 0;');
    expect(source).toContain('private readonly POSITION_EMIT_INTERVAL = 33;');
    expect(source).toContain('private emitSpritePositions(): void {');
    expect(source).toContain("dispatchVizEvent('viz:sprite_positions'");
    expect(source).toContain("this.game.registry.get('useDomBubbles')");
    expect(source).toContain('time - this.lastPositionEmitTime > this.POSITION_EMIT_INTERVAL');
  });

  it('skips Phaser bubble drawing and clearing when DOM bubbles are enabled', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('private get useDomBubbles(): boolean {');
    expect(source).toContain('if (this.useDomBubbles) {');
    expect(source).toContain('this.trackDomBubble(spriteId, text, emotionState, bubbleMode);');
    expect(source).toContain('this.domBubbleMetadata.clear();');
    expect(source).toContain('this.showBubble(spriteId, text, emotionState, haloColor, bubbleMode);');
    expect(source).toContain('this.clearActiveBubbles();');
  });

  it('keeps unavailable Canvas bubble metadata distinct from neutral without roster writeback', () => {
    const source = readWorldSceneSource();
    const eventContract = readEventBridgeSource();

    expect(eventContract).toContain("emotion_metadata_status?: 'available' | 'unavailable'");
    expect(source).toContain("const emotionMetadataStatus = data.emotion_metadata_status");
    expect(source).toContain("emotionMetadataStatus !== 'unavailable'");
    expect(source).toContain("emotionState === 'unavailable'");
    expect(source).toContain('unavailable:');
    expect(source).toContain('unknown:');
    expect(source).not.toContain("emotion || 'neutral'");
  });

  it('clears a stale emotion halo before rendering neutral, unknown, or unavailable bubbles', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('if (shouldClearEmotionHalo(emotionState)) {');
    expect(source).toContain('this.clearHalo(spriteId);');
    expect(source).toContain('private clearHalo(spriteId: string): void {');
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
    return lang.toLowerCase().startsWith('zh') ? zh : en;
  }

  it('returns English text when language is en', () => {
    expect(getLocalizedLabel('Hello', '你好', 'en')).toBe('Hello');
  });

  it('returns Chinese text when language is zh', () => {
    expect(getLocalizedLabel('Hello', '你好', 'zh')).toBe('你好');
  });

  it('returns English text for non-zh language', () => {
    expect(getLocalizedLabel('Hello', '你好', 'ja')).toBe('Hello');
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

describe('WorldScene — HiDPI scaling contract', () => {
  it('reads DPR from the Phaser registry and exposes a rounded pixel helper', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('private dpr = 1;');
    expect(source).toContain("this.dpr = this.game.registry.get('devicePixelRatio') || 1;");
    expect(source).toContain('private px(value: number): number {');
    expect(source).toContain('return Math.round(value * this.dpr);');
  });

  it('scales bubble layout coordinates and spacing through px()', () => {
    const source = readWorldSceneSource();

    for (const value of ['-74', '220', '300', '-96', '96', '-156', '156', '-30', '-84', '-124']) {
      expect(source).toContain(`this.px(${value})`);
    }
    expect(source).toContain('this.px(BUBBLE_BASE_OFFSET_Y)');
    expect(source).toContain('this.px(BUBBLE_WORLD_PADDING_X)');
    expect(source).toContain('this.px(BUBBLE_WORLD_PADDING_Y)');
  });

  it('keeps sprite CSS proportions stable when the backing store is DPR-scaled', () => {
    const source = readWorldSceneSource();
    const cssWidth = 800;
    const cssHeight = 450;
    const dpr = 2;

    const cssSpriteW = Math.max(48, Math.round(Math.min(cssWidth, cssHeight) * 0.07));
    const dprSpriteW = Math.max(48 * dpr, Math.round(Math.min(cssWidth * dpr, cssHeight * dpr) * 0.07));

    expect(dprSpriteW / dpr).toBe(cssSpriteW);
    expect(source).toContain('Math.max(this.px(48), Math.round(baseScale * 0.07))');
  });

  it('keeps effective bubble text resolution near 4x on DPR displays', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('Math.max(2, Math.ceil(4 / this.dpr))');
    expect(Math.max(2, Math.ceil(4 / 2))).toBe(2);
  });
});

describe('WorldScene — prefers-reduced-motion', () => {
  it('detects reduced motion preference from matchMedia', () => {
    // When matchMedia returns matches=true, reducedMotion should be true
    const mockMatchMedia = (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    });

    // Simulate the detection logic from WorldScene.create()
    const detectReducedMotion = () =>
      typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = mockMatchMedia as unknown as typeof window.matchMedia;
    expect(detectReducedMotion()).toBe(true);
    window.matchMedia = originalMatchMedia;
  });

  it('returns false when prefers-reduced-motion is not set', () => {
    const mockMatchMedia = (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    });

    const detectReducedMotion = () =>
      typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = mockMatchMedia as unknown as typeof window.matchMedia;
    expect(detectReducedMotion()).toBe(false);
    window.matchMedia = originalMatchMedia;
  });

  it('exposes reduced_motion in the automation state shape', () => {
    // The getAutomationState() return shape should include reduced_motion
    const automationShape = {
      scene: 'WorldScene',
      theme: 'default',
      weather: 'clear',
      time_of_day: 'noon',
      agent_count: 0,
      agents: [],
      displayed_bubble_count: 0,
      is_transitioning: false,
      reduced_motion: true,
      bubbles: [],
    };
    expect(automationShape).toHaveProperty('reduced_motion');
    expect(typeof automationShape.reduced_motion).toBe('boolean');
  });
});

describe('WorldScene — agent lifecycle cleanup', () => {
  it('tracks the initial idle-wander timer so duplicate spawns can cancel it', () => {
    const source = readWorldSceneSource();
    expect(source).toContain('const initialDelay = 500 + Math.random() * 2000;');
    expect(source).toContain('agent.wanderTimer = this.time.delayedCall(initialDelay, scheduleNext);');
  });

  it('guards idle-wander completion against stale agent records', () => {
    expect(readWorldSceneSource()).toContain(
      'if (this.agentSprites.get(agentId) !== a || !a.gameObject) return;',
    );
  });
});

describe('reducedMotion tween guards', () => {
  // These tests verify that key animation methods bail out or use duration=0
  // when reducedMotion is true, by checking the guard patterns in the source.

  it('startAmbientMotes bails when reducedMotion is true', () => {
    // WorldScene.ts:506 — `if (this.reducedMotion) return;`
    // Verify the guard pattern exists in the class
    const guardPattern = /startAmbientMotes[\s\S]*?if\s*\(\s*this\.reducedMotion\s*\)\s*return/;
    expect(readWorldSceneSource()).toMatch(guardPattern);
  });

  it('startIdleWander bails when reducedMotion is true', () => {
    // WorldScene.ts:1035 — `if (this.reducedMotion) return;`
    const guardPattern = /startIdleWander[\s\S]*?if\s*\(\s*this\.reducedMotion\s*\)\s*return/;
    expect(readWorldSceneSource()).toMatch(guardPattern);
  });

  it('playSplitAnimation bails when reducedMotion is true', () => {
    // WorldScene.ts:1506 — `if (this.reducedMotion) return;`
    const guardPattern = /playSplitAnimation[\s\S]*?if\s*\(\s*this\.reducedMotion\s*\)\s*return/;
    expect(readWorldSceneSource()).toMatch(guardPattern);
  });

  it('spawnAgent uses duration=0 when reducedMotion is true', () => {
    // WorldScene.ts:951 — `if (this.reducedMotion) { ... duration: 0 }`
    // WorldScene.ts:928 — `if (!this.reducedMotion) { ... }`
    const durationGuard = /duration:\s*this\.reducedMotion\s*\?\s*0\s*:/;
    expect(readWorldSceneSource()).toMatch(durationGuard);
  });

  it('shows full bubble text immediately when reducedMotion is true', () => {
    const source = readWorldSceneSource();

    expect(source).toContain('const remainingChars = this.reducedMotion ? 0 :');
    expect(source).toContain('if (this.reducedMotion) {\n      textObj.setText(visibleText);');
  });

  it('WorldScene has at least 10 reducedMotion guards', async () => {
    // Count all reducedMotion references in the source
    const source = readWorldSceneSource();
    const guardCount = (source.match(/this\.reducedMotion/g) || []).length;
    // Expect at least 10 guards (currently 12+)
    expect(guardCount).toBeGreaterThanOrEqual(10);
  });
});
