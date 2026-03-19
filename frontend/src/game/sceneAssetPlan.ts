import {
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

export function resolveBootSceneThemeId(themeId: string | null | undefined): SceneThemeId {
  if (themeId && isSceneThemeId(themeId)) {
    return themeId;
  }
  return DEFAULT_BOOT_THEME_ID;
}

export function getBootScenePreloadThemes(themeId: string | null | undefined): SceneThemeId[] {
  return [resolveBootSceneThemeId(themeId)];
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
