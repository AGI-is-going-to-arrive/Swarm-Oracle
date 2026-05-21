/**
 * BootScene — Phaser entry point scene.
 *
 * Responsible for:
 * 1. Preloading the first-view Theater assets needed to avoid a blank first scene
 * 2. Falling back to procedural generation if any asset fails to load
 * 3. Transitioning to TitleScene once assets are ready
 */
import Phaser from 'phaser';
import {
  CHARACTER_SPRITE_KEYS,
  getSceneTextureKey,
} from '../../lib/themeRegistry';
import {
  getBootScenePreloadSpriteKeys,
  getBootScenePreloadThemes,
  getCharacterTextureRequest,
  getSceneTextureRequest,
} from '../sceneAssetPlan';

type SpriteKey = typeof CHARACTER_SPRITE_KEYS[number];

/** Fallback color per sprite role (used when PNG fails to load). */
const SPRITE_FALLBACK: Record<string, { body: number; accent: number }> = {
  sprite_king:       { body: 0xffd700, accent: 0xb8860b },
  sprite_warrior:    { body: 0xdc143c, accent: 0x8b0000 },
  sprite_scholar:    { body: 0x4169e1, accent: 0x191970 },
  sprite_merchant:   { body: 0x228b22, accent: 0x006400 },
  sprite_priest:     { body: 0xdda0dd, accent: 0x8b008b },
  sprite_spy:        { body: 0x2f4f4f, accent: 0x1a1a2e },
  sprite_explorer:   { body: 0xd2691e, accent: 0x8b4513 },
  sprite_scientist:  { body: 0x00ced1, accent: 0x008b8b },
  sprite_general:    { body: 0x8b0000, accent: 0x4a0000 },
  sprite_diplomat:   { body: 0x4682b4, accent: 0x2e5a88 },
  sprite_rebel:      { body: 0xff6347, accent: 0xcc3311 },
  sprite_artist:     { body: 0xda70d6, accent: 0x9932cc },
  sprite_bard:       { body: 0xff9ff3, accent: 0xc56cf0 },
  sprite_alchemist:  { body: 0xfeca57, accent: 0xff9f43 },
  sprite_assassin:   { body: 0x576574, accent: 0x222f3e },
  sprite_farmer:     { body: 0x8fbc8f, accent: 0x556b2f },
  sprite_engineer:   { body: 0x708090, accent: 0x2f4f4f },
  sprite_knight:     { body: 0x7f8fa6, accent: 0x487eb0 },
  sprite_monk:       { body: 0xf6e58d, accent: 0xb7791f },
  sprite_noble:      { body: 0x9370db, accent: 0x4b0082 },
  sprite_healer:     { body: 0x98fb98, accent: 0x2e8b57 },
  sprite_thief:      { body: 0x353b48, accent: 0x718093 },
  sprite_witch:      { body: 0x6c5ce7, accent: 0x341f97 },
  sprite_default:    { body: 0x808080, accent: 0x555555 },
  sprite_villager:   { body: 0xa0a0a0, accent: 0x666666 },
};

export class BootScene extends Phaser.Scene {
  private failedSprites: Set<string> = new Set();
  private failedScenes: Set<string> = new Set();
  private bootSceneKeys = getBootScenePreloadThemes(undefined);
  private bootSpriteKeys: SpriteKey[] = getBootScenePreloadSpriteKeys(undefined);

  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    this.bootSceneKeys = getBootScenePreloadThemes(this.registry.get('initialSceneTheme') as string | undefined);
    const initialSpriteKeys = this.registry.get('initialSpriteKeys');
    this.bootSpriteKeys = getBootScenePreloadSpriteKeys(
      Array.isArray(initialSpriteKeys)
        ? initialSpriteKeys.filter((value): value is string => typeof value === 'string')
        : null,
    );

    // ── Loading bar ──────────────────────────────────────
    const { width, height } = this.scale;
    const barW = width * 0.4;
    const barH = 12;
    const barX = (width - barW) / 2;
    const barY = height / 2;

    const bg = this.add.rectangle(barX + barW / 2, barY, barW, barH, 0x333333);
    bg.setOrigin(0.5);
    const fill = this.add.rectangle(barX, barY, 0, barH, 0x6c5ce7);
    fill.setOrigin(0, 0.5);

    this.load.on('progress', (v: number) => { fill.width = barW * v; });
    this.load.on('complete', () => { bg.destroy(); fill.destroy(); });

    // ── Track load failures so we can fallback ──────────
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      const key = file.key;
      if (this.bootSpriteKeys.includes(key as SpriteKey)) {
        this.failedSprites.add(key);
      } else {
        const failedTheme = this.bootSceneKeys.find((themeId) => getSceneTextureKey(themeId) === key);
        if (failedTheme) {
          this.failedScenes.add(failedTheme);
        }
      }
    });

    // ── Load character PNGs ──────────────────────────────
    for (const key of this.bootSpriteKeys) {
      const request = getCharacterTextureRequest(key);
      if (request) {
        this.load.image(request.spriteKey, request.assetPath);
      }
    }

    // ── Load scene background PNGs ───────────────────────
    for (const key of this.bootSceneKeys) {
      const request = getSceneTextureRequest(key);
      this.load.image(request.textureKey, request.assetPath);
    }
  }

  create(): void {
    const dpr = this.game.registry.get('devicePixelRatio') || 1;

    // Generate procedural fallback for any sprites that failed to load
    for (const key of this.failedSprites) {
      this.createFallbackSprite(key);
    }
    // Any scene backgrounds that failed get no fallback —
    // WorldScene falls back to its gradient drawing automatically.

    // Always ensure bubble_bg texture exists (procedural)
    if (!this.textures.exists('bubble_bg')) {
      const px = (value: number) => value * dpr;
      const textureW = Math.round(120 * dpr);
      const textureH = Math.round(40 * dpr);
      const g = this.add.graphics();
      g.fillStyle(0xffffff, 0.9);
      g.fillRoundedRect(0, 0, textureW, textureH, px(6));
      g.lineStyle(px(1), 0x333333, 0.5);
      g.strokeRoundedRect(0, 0, textureW, textureH, px(6));
      g.generateTexture('bubble_bg', textureW, textureH);
      g.destroy();
    }

    const totalBootAssets = this.bootSpriteKeys.length + this.bootSceneKeys.length;
    const loaded = totalBootAssets - this.failedSprites.size - this.failedScenes.size;
    console.log(`[BootScene] ${loaded}/${totalBootAssets} first-view assets loaded, ${this.failedSprites.size} sprite fallbacks, ${this.failedScenes.size} scene fallbacks`);

    // Phase 3: Route to TitleScene first, then TitleScene → WorldScene
    this.scene.start('TitleScene');
  }

  /** Generate a procedural colored-rectangle texture as fallback. */
  private createFallbackSprite(name: string): void {
    if (this.textures.exists(name)) return;
    const colors = SPRITE_FALLBACK[name] ?? SPRITE_FALLBACK.sprite_default;
    const dpr = this.game.registry.get('devicePixelRatio') || 1;
    const px = (value: number) => value * dpr;
    const textureW = Math.round(16 * dpr);
    const textureH = Math.round(24 * dpr);

    const g = this.add.graphics();
    g.fillStyle(colors.body, 1);
    g.fillRoundedRect(0, px(4), px(16), px(20), px(2));
    g.fillStyle(colors.body, 1);
    g.fillRoundedRect(px(2), 0, px(12), px(12), px(3));
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(px(5), px(5), px(2));
    g.fillCircle(px(11), px(5), px(2));
    g.fillStyle(0x000000, 0.8);
    g.fillCircle(px(6), px(5), px(1));
    g.fillCircle(px(12), px(5), px(1));
    g.fillStyle(colors.accent, 1);
    g.fillRect(0, px(21), px(16), px(3));
    g.generateTexture(name, textureW, textureH);
    g.destroy();
  }
}
