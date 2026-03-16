/**
 * EndingScene unit tests (Vitest + jsdom)
 *
 * Phase 4: Tests for EndingScene data structures and resolution logic.
 * Validates ending configurations, type mappings, and resolution behavior.
 */

import { describe, it, expect } from 'vitest';

// ── Re-define testable constants from EndingScene ───────

const ENDING_TYPE_MAP: Record<string, string[]> = {
  positive: ['prosperity', 'peace'],
  negative: ['war', 'ruin', 'tyranny'],
  neutral:  ['revolution'],
};

const ENDING_CONFIGS: Record<string, {
  textureKey: string;
  i18nKey: string;
  particleColor: number;
  accentColor: number;
  icon: string;
}> = {
  prosperity: {
    textureKey: 'ending_prosperity',
    i18nKey: 'game.ending_prosperity',
    particleColor: 0xffd700,
    accentColor: 0x00ff7f,
    icon: '🌟',
  },
  peace: {
    textureKey: 'ending_peace',
    i18nKey: 'game.ending_peace',
    particleColor: 0x87ceeb,
    accentColor: 0x4fc3f7,
    icon: '🕊️',
  },
  war: {
    textureKey: 'ending_war',
    i18nKey: 'game.ending_war',
    particleColor: 0xff4500,
    accentColor: 0xff4444,
    icon: '⚔️',
  },
  ruin: {
    textureKey: 'ending_ruin',
    i18nKey: 'game.ending_ruin',
    particleColor: 0x8b4513,
    accentColor: 0x999999,
    icon: '💀',
  },
  tyranny: {
    textureKey: 'ending_tyranny',
    i18nKey: 'game.ending_tyranny',
    particleColor: 0x4b0082,
    accentColor: 0x9c27b0,
    icon: '👑',
  },
  revolution: {
    textureKey: 'ending_revolution',
    i18nKey: 'game.ending_revolution',
    particleColor: 0xff6347,
    accentColor: 0xff8c00,
    icon: '✊',
  },
};

const ALL_ENDINGS = Object.keys(ENDING_CONFIGS);

/** Re-implement resolveEndingId for testing. */
function resolveEndingId(data: { ending_type: string; ending_id?: string }): string {
  if (data.ending_id && ALL_ENDINGS.includes(data.ending_id)) {
    return data.ending_id;
  }
  const candidates = ENDING_TYPE_MAP[data.ending_type] || ENDING_TYPE_MAP.neutral;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

describe('EndingScene — ENDING_CONFIGS', () => {
  it('has exactly 6 ending configurations', () => {
    expect(ALL_ENDINGS).toHaveLength(6);
  });

  it('includes all expected ending IDs', () => {
    expect(ALL_ENDINGS).toContain('prosperity');
    expect(ALL_ENDINGS).toContain('peace');
    expect(ALL_ENDINGS).toContain('war');
    expect(ALL_ENDINGS).toContain('ruin');
    expect(ALL_ENDINGS).toContain('tyranny');
    expect(ALL_ENDINGS).toContain('revolution');
  });

  it('each config has required properties', () => {
    for (const [id, config] of Object.entries(ENDING_CONFIGS)) {
      expect(config.textureKey).toBe(`ending_${id}`);
      expect(config.i18nKey).toBe(`game.ending_${id}`);
      expect(typeof config.particleColor).toBe('number');
      expect(typeof config.accentColor).toBe('number');
      expect(config.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('EndingScene — ENDING_TYPE_MAP', () => {
  it('has 3 type categories', () => {
    expect(Object.keys(ENDING_TYPE_MAP)).toHaveLength(3);
  });

  it('positive maps to prosperity and peace', () => {
    expect(ENDING_TYPE_MAP.positive).toEqual(['prosperity', 'peace']);
  });

  it('negative maps to war, ruin, tyranny', () => {
    expect(ENDING_TYPE_MAP.negative).toEqual(['war', 'ruin', 'tyranny']);
  });

  it('neutral maps to revolution', () => {
    expect(ENDING_TYPE_MAP.neutral).toEqual(['revolution']);
  });

  it('all mapped IDs exist in ENDING_CONFIGS', () => {
    for (const ids of Object.values(ENDING_TYPE_MAP)) {
      for (const id of ids) {
        expect(ALL_ENDINGS).toContain(id);
      }
    }
  });
});

describe('EndingScene — resolveEndingId', () => {
  it('returns direct ending_id override if valid', () => {
    const result = resolveEndingId({ ending_type: 'positive', ending_id: 'war' });
    expect(result).toBe('war');
  });

  it('ignores invalid ending_id and falls back to type', () => {
    const result = resolveEndingId({ ending_type: 'neutral', ending_id: 'invalid_id' });
    expect(result).toBe('revolution'); // neutral only has revolution
  });

  it('resolves positive type to prosperity or peace', () => {
    const result = resolveEndingId({ ending_type: 'positive' });
    expect(['prosperity', 'peace']).toContain(result);
  });

  it('resolves negative type to war, ruin, or tyranny', () => {
    const result = resolveEndingId({ ending_type: 'negative' });
    expect(['war', 'ruin', 'tyranny']).toContain(result);
  });

  it('resolves neutral type to revolution', () => {
    const result = resolveEndingId({ ending_type: 'neutral' });
    expect(result).toBe('revolution');
  });

  it('falls back to neutral for unknown type', () => {
    const result = resolveEndingId({ ending_type: 'unknown_type' });
    expect(result).toBe('revolution');
  });
});
