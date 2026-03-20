import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOOT_THEME_ID,
  DEFAULT_BOOT_SPRITE_KEY,
  getBootScenePreloadSpriteKeys,
  getBootScenePreloadThemes,
  getCharacterTextureRequest,
  getEndingTextureRequest,
  getSceneTextureRequest,
  resolveBootSceneThemeId,
} from './sceneAssetPlan';

describe('sceneAssetPlan', () => {
  it('falls back to the default boot theme when the initial theme is missing', () => {
    expect(resolveBootSceneThemeId(undefined)).toBe(DEFAULT_BOOT_THEME_ID);
    expect(resolveBootSceneThemeId('unknown_theme')).toBe(DEFAULT_BOOT_THEME_ID);
  });

  it('keeps a valid initial theme for boot preloading', () => {
    expect(resolveBootSceneThemeId('ancient_empire')).toBe('ancient_empire');
    expect(getBootScenePreloadThemes('ancient_empire')).toEqual(['ancient_empire']);
  });

  it('builds a scene texture request for the initial theme only', () => {
    expect(getSceneTextureRequest('law_court_variant')).toEqual({
      themeId: 'law_court_variant',
      textureKey: 'scene_law_court_variant',
      assetPath: '/assets/scenes/law_court_variant.png',
    });
  });

  it('keeps boot sprite preload focused on default plus known initial sprites', () => {
    expect(getBootScenePreloadSpriteKeys(undefined)).toEqual([DEFAULT_BOOT_SPRITE_KEY]);
    expect(getBootScenePreloadSpriteKeys(['sprite_knight', 'sprite_knight', 'unknown'])).toEqual([
      DEFAULT_BOOT_SPRITE_KEY,
      'sprite_knight',
    ]);
  });

  it('builds character texture requests for known sprite keys only', () => {
    expect(getCharacterTextureRequest('sprite_knight')).toEqual({
      spriteKey: 'sprite_knight',
      assetPath: '/assets/characters/sprite_knight.png',
    });
    expect(getCharacterTextureRequest('unknown')).toBeNull();
  });

  it('builds ending texture requests for known endings only', () => {
    expect(getEndingTextureRequest('peace')).toEqual({
      endingId: 'peace',
      textureKey: 'ending_peace',
      assetPath: '/assets/endings/peace.png',
    });
    expect(getEndingTextureRequest('unknown')).toBeNull();
  });
});
