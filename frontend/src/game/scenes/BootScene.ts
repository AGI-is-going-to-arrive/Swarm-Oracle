/**
 * BootScene — Phaser entry point scene.
 *
 * Responsible for:
 * 1. Preloading pixel art character sprites, scene backgrounds, endings, and UI assets
 * 2. Falling back to procedural generation if any asset fails to load
 * 3. Transitioning to TitleScene once assets are ready
 */
import Phaser from 'phaser';

/** All sprite keys that the game expects to be registered as textures. */
const SPRITE_KEYS = [
  'sprite_king', 'sprite_warrior', 'sprite_scholar', 'sprite_merchant',
  'sprite_farmer', 'sprite_priest', 'sprite_rebel', 'sprite_diplomat',
  'sprite_villager', 'sprite_spy', 'sprite_explorer', 'sprite_scientist',
  'sprite_general', 'sprite_artist', 'sprite_engineer', 'sprite_noble',
  'sprite_healer', 'sprite_default',
] as const;

/** Scene background keys matching THEME_PALETTES in WorldScene. */
const SCENE_KEYS = [
  'medieval_village', 'ancient_empire', 'industrial_city', 'modern_city',
  'switchboard_forum',
  'surveillance_megacity', 'civic_chamber', 'law_court', 'imperial_forum',
  'dynastic_palace', 'scifi_base', 'power_grid_nexus', 'factory_foundry',
  'frontier_colony', 'post_apocalypse', 'fantasy_kingdom', 'arcane_sanctum',
  'faith_temple', 'refuge_compound', 'war_command', 'logistics_hub',
  'war_battlefield', 'space_station', 'underwater_kingdom', 'desert_outpost',
  'trade_harbor', 'ecology_wasteland',
] as const;

/** Phase 3: Ending scene keys. */
const ENDING_KEYS = [
  'prosperity', 'peace', 'war', 'ruin', 'tyranny', 'revolution',
] as const;

/** Phase 3: UI asset keys. */
const UI_KEYS = [
  'title_screen', 'minimap_frame', 'bet_panel', 'leaderboard',
] as const;

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
  sprite_farmer:     { body: 0x8fbc8f, accent: 0x556b2f },
  sprite_engineer:   { body: 0x708090, accent: 0x2f4f4f },
  sprite_noble:      { body: 0x9370db, accent: 0x4b0082 },
  sprite_healer:     { body: 0x98fb98, accent: 0x2e8b57 },
  sprite_default:    { body: 0x808080, accent: 0x555555 },
  sprite_villager:   { body: 0xa0a0a0, accent: 0x666666 },
};

export class BootScene extends Phaser.Scene {
  private failedSprites: Set<string> = new Set();
  private failedScenes: Set<string> = new Set();

  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
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
      if (SPRITE_KEYS.includes(key as typeof SPRITE_KEYS[number])) {
        this.failedSprites.add(key);
      } else if (SCENE_KEYS.includes(key as typeof SCENE_KEYS[number])) {
        this.failedScenes.add(key);
      }
      // Endings and UI assets silently degrade — no fallback needed
    });

    // ── Load character PNGs ──────────────────────────────
    for (const key of SPRITE_KEYS) {
      this.load.image(key, `/assets/characters/${key}.png`);
    }

    // ── Load scene background PNGs ───────────────────────
    for (const key of SCENE_KEYS) {
      this.load.image(`scene_${key}`, `/assets/scenes/${key}.png`);
    }

    // ── Phase 3: Load ending scene backgrounds ──────────
    for (const key of ENDING_KEYS) {
      this.load.image(`ending_${key}`, `/assets/endings/${key}.png`);
    }

    // ── Phase 3: Load UI assets ─────────────────────────
    for (const key of UI_KEYS) {
      this.load.image(key, `/assets/ui/${key}.png`);
    }
  }

  create(): void {
    // Generate procedural fallback for any sprites that failed to load
    for (const key of this.failedSprites) {
      this.createFallbackSprite(key);
    }
    // Any scene backgrounds that failed get no fallback —
    // WorldScene falls back to its gradient drawing automatically.

    // Always ensure bubble_bg texture exists (procedural)
    if (!this.textures.exists('bubble_bg')) {
      const g = this.add.graphics();
      g.fillStyle(0xffffff, 0.9);
      g.fillRoundedRect(0, 0, 120, 40, 6);
      g.lineStyle(1, 0x333333, 0.5);
      g.strokeRoundedRect(0, 0, 120, 40, 6);
      g.generateTexture('bubble_bg', 120, 40);
      g.destroy();
    }

    const totalBase = SPRITE_KEYS.length + SCENE_KEYS.length;
    const totalP3 = ENDING_KEYS.length + UI_KEYS.length;
    const loaded = totalBase + totalP3 - this.failedSprites.size - this.failedScenes.size;
    console.log(`[BootScene] ${loaded}/${totalBase + totalP3} assets loaded, ${this.failedSprites.size} sprite fallbacks, ${this.failedScenes.size} scene fallbacks`);

    // Phase 3: Route to TitleScene first, then TitleScene → WorldScene
    this.scene.start('TitleScene');
  }

  /** Generate a procedural colored-rectangle texture as fallback. */
  private createFallbackSprite(name: string): void {
    if (this.textures.exists(name)) return;
    const colors = SPRITE_FALLBACK[name] ?? SPRITE_FALLBACK.sprite_default;

    const g = this.add.graphics();
    g.fillStyle(colors.body, 1);
    g.fillRoundedRect(0, 4, 16, 20, 2);
    g.fillStyle(colors.body, 1);
    g.fillRoundedRect(2, 0, 12, 12, 3);
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(5, 5, 2);
    g.fillCircle(11, 5, 2);
    g.fillStyle(0x000000, 0.8);
    g.fillCircle(6, 5, 1);
    g.fillCircle(12, 5, 1);
    g.fillStyle(colors.accent, 1);
    g.fillRect(0, 21, 16, 3);
    g.generateTexture(name, 16, 24);
    g.destroy();
  }
}
