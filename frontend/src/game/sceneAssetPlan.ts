import {
  CHARACTER_SPRITE_KEYS,
  ENDING_ASSET_KEYS,
  getEndingAssetPath,
  getEndingTextureKey,
  getSceneTextureKey,
  getThemeAssetPath,
  type SceneThemeId,
  isEndingAssetId,
  isSceneThemeId,
} from '../lib/themeRegistry';

export const DEFAULT_BOOT_THEME_ID: SceneThemeId = 'switchboard_forum';
export const DEFAULT_BOOT_SPRITE_KEY = 'sprite_default' as const;

type CharacterSpriteKey = typeof CHARACTER_SPRITE_KEYS[number];

function isCharacterSpriteKey(value: string): value is CharacterSpriteKey {
  return CHARACTER_SPRITE_KEYS.includes(value as CharacterSpriteKey);
}

export function resolveBootSceneThemeId(themeId: string | null | undefined): SceneThemeId {
  if (themeId && isSceneThemeId(themeId)) {
    return themeId;
  }
  return DEFAULT_BOOT_THEME_ID;
}

export function getBootScenePreloadThemes(themeId: string | null | undefined): SceneThemeId[] {
  return [resolveBootSceneThemeId(themeId)];
}

export function getBootScenePreloadSpriteKeys(
  initialSpriteKeys: readonly string[] | null | undefined,
): CharacterSpriteKey[] {
  const normalized = [...new Set(
    (initialSpriteKeys ?? [])
      .filter((value): value is string => typeof value === 'string')
      .filter(isCharacterSpriteKey),
  )];

  return normalized.length > 0
    ? ([DEFAULT_BOOT_SPRITE_KEY, ...normalized.filter((value) => value !== DEFAULT_BOOT_SPRITE_KEY)] as CharacterSpriteKey[])
    : [DEFAULT_BOOT_SPRITE_KEY];
}

export function getCharacterTextureRequest(spriteKey: string | null | undefined) {
  if (!spriteKey || !isCharacterSpriteKey(spriteKey)) {
    return null;
  }

  return {
    spriteKey,
    assetPath: `/assets/characters/${spriteKey}.png`,
  };
}

export function getSceneTextureRequest(themeId: string | null | undefined) {
  const resolvedThemeId = resolveBootSceneThemeId(themeId);
  return {
    themeId: resolvedThemeId,
    textureKey: getSceneTextureKey(resolvedThemeId),
    assetPath: getThemeAssetPath(resolvedThemeId),
  };
}

export function getEndingTextureRequest(endingId: string | null | undefined) {
  if (!endingId || !isEndingAssetId(endingId)) {
    return null;
  }

  return {
    endingId,
    textureKey: getEndingTextureKey(endingId),
    assetPath: getEndingAssetPath(endingId),
  };
}

export function getKnownEndingIds(): readonly string[] {
  return ENDING_ASSET_KEYS;
}
