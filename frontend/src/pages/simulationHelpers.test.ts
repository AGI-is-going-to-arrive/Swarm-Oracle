import { describe, it, expect } from 'vitest';
import {
  formatTheaterLabel,
  THEATER_SCENE_LABELS,
  THEATER_WEATHER_LABELS,
  THEATER_TIME_LABELS,
} from './simulationHelpers';

describe('simulationHelpers', () => {
  describe('formatTheaterLabel', () => {
    const t = (key: string) => {
      const translations: Record<string, string> = {
        'sim.theater_scene.boot': 'Boot',
        'sim.theater_scene.world': 'World',
        'sim.theater_weather.rain': 'Rain',
      };
      return translations[key] ?? key;
    };

    it('returns null for null/undefined key', () => {
      expect(formatTheaterLabel(null, THEATER_SCENE_LABELS, t)).toBeNull();
      expect(formatTheaterLabel(undefined, THEATER_SCENE_LABELS, t)).toBeNull();
    });

    it('translates known scene labels', () => {
      expect(formatTheaterLabel('BootScene', THEATER_SCENE_LABELS, t)).toBe('Boot');
      expect(formatTheaterLabel('WorldScene', THEATER_SCENE_LABELS, t)).toBe('World');
    });

    it('translates known weather labels', () => {
      expect(formatTheaterLabel('rain', THEATER_WEATHER_LABELS, t)).toBe('Rain');
    });

    it('falls back to formatted key for unknown labels', () => {
      expect(formatTheaterLabel('custom_scene', THEATER_SCENE_LABELS, t)).toBe('custom scene');
    });

    it('falls back when translation returns the key itself', () => {
      const noopT = (key: string) => key;
      expect(formatTheaterLabel('BootScene', THEATER_SCENE_LABELS, noopT)).toBe('BootScene');
    });
  });

  describe('constant maps', () => {
    it('has expected scene entries', () => {
      expect(Object.keys(THEATER_SCENE_LABELS)).toContain('BootScene');
      expect(Object.keys(THEATER_SCENE_LABELS)).toContain('WorldScene');
      expect(Object.keys(THEATER_SCENE_LABELS)).toContain('EndingScene');
    });

    it('has expected weather entries', () => {
      expect(Object.keys(THEATER_WEATHER_LABELS)).toContain('clear');
      expect(Object.keys(THEATER_WEATHER_LABELS)).toContain('storm');
    });

    it('has expected time entries', () => {
      expect(Object.keys(THEATER_TIME_LABELS)).toContain('dawn');
      expect(Object.keys(THEATER_TIME_LABELS)).toContain('night');
    });
  });
});
