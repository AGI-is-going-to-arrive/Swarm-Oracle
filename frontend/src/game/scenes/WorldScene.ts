/**
 * WorldScene — Main simulation visualization scene (Phase 2 Enhanced).
 *
 * Renders:
 * - Themed procedural background with palette swap on scene_change
 * - Agent sprites arranged by faction/stance with smooth movement
 * - Dialogue bubbles on agent_speak events
 * - Emotion halos with pulsing animation
 * - Branch split animations with ripple effect
 * - Typed event animations (earthquake, fire, fog, tech, etc.)
 * - Ending overlay with story summary card
 *
 * Listens to EventBridge for viz:* events from the backend.
 */
import Phaser from 'phaser';
import i18next from 'i18next';
import { EventBridge, dispatchVizEvent } from '../managers/EventBridge';
import {
  CHARACTER_SPRITE_KEYS,
  getSceneTextureKey,
  getThemeAssetPath,
  isSceneThemeId,
} from '../../lib/themeRegistry';
import { getCharacterTextureRequest } from '../sceneAssetPlan';

interface AgentSpriteData {
  agent_id: string;
  name: string;
  sprite_id: string;
  x: number;
  y: number;
  originX: number;  // initial spawn X — wander anchor
  originY: number;  // initial spawn Y — wander anchor
  gameObject?: Phaser.GameObjects.Container;
  haloGraphics?: Phaser.GameObjects.Graphics;
  haloTween?: Phaser.Tweens.Tween;
  factionBar?: Phaser.GameObjects.Graphics;
  wanderTimer?: Phaser.Time.TimerEvent;
}

// ── Scene Theme Palettes ────────────────────────────────
const THEME_PALETTES: Record<string, { sky1: number; sky2: number; ground: number; accent: number; icon: string }> = {
  medieval_village:    { sky1: 0x87ceeb, sky2: 0x4a90d9, ground: 0x4a7c3f, accent: 0x8b6914, icon: '🏰' },
  ancient_empire:      { sky1: 0xffe4b5, sky2: 0xdaa520, ground: 0xc2b280, accent: 0x8b4513, icon: '🏛️' },
  industrial_city:     { sky1: 0x778899, sky2: 0x2f4f4f, ground: 0x696969, accent: 0xb22222, icon: '🏭' },
  modern_city:         { sky1: 0x6495ed, sky2: 0x4169e1, ground: 0x808080, accent: 0x00bfff, icon: '🌃' },
  switchboard_forum:   { sky1: 0x2b2441, sky2: 0x120f24, ground: 0x4f3f35, accent: 0xff66d9, icon: '🎛️' },
  switchboard_forum_variant:{ sky1: 0xcda979, sky2: 0x8d684b, ground: 0x7a5d4d, accent: 0xff66d9, icon: '🧭' },
  surveillance_megacity:{ sky1: 0x1a2140, sky2: 0x10172f, ground: 0x28304d, accent: 0xff4fd8, icon: '📡' },
  civic_chamber:       { sky1: 0xd8d1c3, sky2: 0x5d5a63, ground: 0x8e7358, accent: 0x8bc34a, icon: '🏛️' },
  law_court:           { sky1: 0xe8dcc3, sky2: 0x7c6a52, ground: 0xbba88f, accent: 0x2d4f7a, icon: '⚖️' },
  law_court_variant:   { sky1: 0xf2e1be, sky2: 0x8b6b48, ground: 0xcbb792, accent: 0xa54cff, icon: '⚖️' },
  imperial_forum:      { sky1: 0xf0e2be, sky2: 0x6ea5d8, ground: 0xd6c3a6, accent: 0xb22222, icon: '🦅' },
  dynastic_palace:     { sky1: 0xead7c1, sky2: 0x74494a, ground: 0xbf9a73, accent: 0xd8b24d, icon: '👑' },
  scifi_base:          { sky1: 0x191970, sky2: 0x0c0032, ground: 0x1a1a2e, accent: 0x00ffff, icon: '🚀' },
  power_grid_nexus:    { sky1: 0x234556, sky2: 0x0d1f29, ground: 0x3e5a4d, accent: 0xffcf70, icon: '⚡' },
  factory_foundry:     { sky1: 0xd78445, sky2: 0x4a2a1f, ground: 0x6a4938, accent: 0xffb347, icon: '⚙️' },
  frontier_colony:     { sky1: 0x2b2f55, sky2: 0xb36b53, ground: 0xa8674e, accent: 0x7cf0d7, icon: '🛰️' },
  post_apocalypse:     { sky1: 0x8b7d6b, sky2: 0x556b2f, ground: 0x3b3a30, accent: 0xff6347, icon: '☢️' },
  fantasy_kingdom:     { sky1: 0xe6e6fa, sky2: 0x9370db, ground: 0x228b22, accent: 0xffd700, icon: '🧙' },
  arcane_sanctum:      { sky1: 0x241f45, sky2: 0x0f1022, ground: 0x40375e, accent: 0x5ae1ff, icon: '✨' },
  faith_temple:        { sky1: 0x2e3653, sky2: 0x111827, ground: 0x3b4258, accent: 0x9c7cff, icon: '🔮' },
  faith_temple_variant:{ sky1: 0x332542, sky2: 0x171127, ground: 0x4a3a58, accent: 0xd987ff, icon: '🕯️' },
  refuge_compound:     { sky1: 0x70707a, sky2: 0x3f454d, ground: 0x756857, accent: 0xb4e197, icon: '⛺' },
  war_command:         { sky1: 0x243443, sky2: 0x0f1720, ground: 0x27313b, accent: 0xff6b57, icon: '🛰️' },
  logistics_hub:       { sky1: 0x6d7067, sky2: 0x3c413f, ground: 0x6f5d49, accent: 0x6ed2ff, icon: '🚚' },
  war_battlefield:     { sky1: 0x696969, sky2: 0x2f2f2f, ground: 0x3b3b3b, accent: 0xff4500, icon: '⚔️' },
  space_station:       { sky1: 0x0a0a2a, sky2: 0x000011, ground: 0x1c1c3c, accent: 0x7df9ff, icon: '🛸' },
  underwater_kingdom:  { sky1: 0x006994, sky2: 0x003366, ground: 0x004d4d, accent: 0x00ced1, icon: '🐠' },
  desert_outpost:      { sky1: 0xedc9af, sky2: 0xc4a35a, ground: 0xd2b48c, accent: 0xcd853f, icon: '🏜️' },
  trade_harbor:        { sky1: 0x55657d, sky2: 0xc97f4e, ground: 0x44505f, accent: 0x2ec8d9, icon: '⚓' },
  ecology_wasteland:   { sky1: 0xe5c69a, sky2: 0xb98c5c, ground: 0xb08a63, accent: 0x56b4aa, icon: '💧' },
};

const DEFAULT_PALETTE = THEME_PALETTES.medieval_village;
const CHARACTER_SPRITE_KEY_SET = new Set<string>(CHARACTER_SPRITE_KEYS);

// ── i18n helper for Phaser Canvas context ───────────────
/** Resolve a bilingual label based on current i18next language. */
function getLocalizedLabel(en: string, zh: string): string {
  return i18next.language === 'en' ? en : zh;
}

type BubbleMode = 'live' | 'replay';

function normalizeBubbleText(text: string, maxChars = BUBBLE_MAX_TEXT_CHARS): string {
  const compactText = text.replace(/\s+/g, ' ').trim();
  if (compactText.length <= maxChars) {
    return compactText;
  }

  return `${compactText.slice(0, maxChars - 1)}…`;
}

function getBubbleTiming(mode: BubbleMode, textLength: number): {
  charDelayMs: number;
  initialChars: number;
  lingerMs: number;
} {
  const charDelayMs = mode === 'replay'
    ? BUBBLE_TYPEWRITER_REPLAY_DELAY_MS
    : BUBBLE_TYPEWRITER_LIVE_DELAY_MS;
  const initialChars = Math.min(mode === 'replay' ? 4 : 8, textLength);
  const baseLingerMs = mode === 'replay' ? BUBBLE_REPLAY_LINGER_MS : BUBBLE_LIVE_LINGER_MS;

  return {
    charDelayMs,
    initialChars,
    lingerMs: Math.min(BUBBLE_LINGER_MAX_MS, baseLingerMs + textLength * BUBBLE_LINGER_PER_CHAR_MS),
  };
}



// ── Event Animation Configs (bilingual) ─────────────────
const EVENT_ANIM_CONFIGS: Record<string, { color: number; shake?: number; flash?: [number, number, number]; label_en: string; label_zh: string }> = {
  earthquake_shake:  { color: 0x8b4513,  shake: 0.015, label_en: '🌏 Earthquake',        label_zh: '🌏 地震' },
  fire_spread:       { color: 0xff4500,  shake: 0.008, flash: [255, 69, 0],  label_en: '🔥 Wildfire',  label_zh: '🔥 战火' },
  dark_fog_spread:   { color: 0x2f2f2f,  flash: [30, 30, 30],   label_en: '☠️ Plague',    label_zh: '☠️ 瘟疫' },
  tech_glow:         { color: 0xffd700,  label_en: '💡 Tech Breakthrough',   label_zh: '💡 技术突破' },
  lightbulb_flash:   { color: 0xffd700,  label_en: '💡 Discovery',           label_zh: '💡 发现' },
  treasure_sparkle:  { color: 0xffd700,  label_en: '✨ Resources',           label_zh: '✨ 资源' },
  handshake_glow:    { color: 0x00ff7f,  label_en: '🤝 Alliance',            label_zh: '🤝 联盟' },
  generic_flash:     { color: 0xffffff,  flash: [255, 255, 255], label_en: '⚡ Event',     label_zh: '⚡ 事件' },
  debate_spotlight:  { color: 0xff8c00,  label_en: '🗣️ Debate',              label_zh: '🗣️ 辩论' },
  shadow_reveal:     { color: 0x4b0082,  flash: [75, 0, 130],    label_en: '🕵️ Spy',      label_zh: '🕵️ 间谍' },
  backchannel_signal:{ color: 0x00d4ff,  flash: [0, 212, 255],   label_en: '🤝 Backchannel Pact', label_zh: '🤝 密约交易' },
  player_swap:       { color: 0x00bfff,  label_en: '🧑 Takeover',            label_zh: '🧑 接管' },
  portal_open:       { color: 0x9400d3,  shake: 0.005, label_en: '🌀 Space-Time Rift',    label_zh: '🌀 时空裂缝' },
  mandate_surge:     { color: 0xff4fb3,  flash: [255, 79, 179], label_en: '📣 Mandate Surge', label_zh: '📣 民意浪潮' },
  evacuation_alarm:  { color: 0xff7043,  flash: [255, 112, 67], label_en: '🚨 Evacuation Order', label_zh: '🚨 撤离令' },
  hearing_bell:      { color: 0xffd166,  flash: [255, 209, 102], label_en: '🏛️ Public Hearing', label_zh: '🏛️ 公开听证' },
};

// ── Faction Colors ──────────────────────────────────────
const FACTION_COLORS: Record<string, number> = {
  left:    0xF44336,  // Red
  right:   0x2196F3,  // Blue
  center:  0x4CAF50,  // Green
  unknown: 0x9C27B0,  // Purple
};

// ── Bubble Style Variants ───────────────────────────────
const BUBBLE_STYLES: Record<string, { bg: number; bgAlpha: number; borderColor: number; indicator?: string }> = {
  aggressive:  { bg: 0xffebee, bgAlpha: 0.95, borderColor: 0xF44336, indicator: '!' },
  angry:       { bg: 0xffebee, bgAlpha: 0.95, borderColor: 0xD32F2F, indicator: '!' },
  anxious:     { bg: 0xf3e5f5, bgAlpha: 0.9,  borderColor: 0x9C27B0, indicator: '?' },
  fearful:     { bg: 0xfbe9e7, bgAlpha: 0.9,  borderColor: 0xFF5722, indicator: '?' },
  cautious:    { bg: 0xfffde7, bgAlpha: 0.85, borderColor: 0xFFC107 },
  calm:        { bg: 0xe0f7fa, bgAlpha: 0.95, borderColor: 0x00BCD4 },
  hopeful:     { bg: 0xe1f5fe, bgAlpha: 0.95, borderColor: 0x03A9F4 },
  cooperative: { bg: 0xe3f2fd, bgAlpha: 0.95, borderColor: 0x2196F3 },
  confident:   { bg: 0xe8f5e9, bgAlpha: 0.95, borderColor: 0x4CAF50 },
  neutral:     { bg: 0xffffff, bgAlpha: 0.95, borderColor: 0x999999 },
};
const DEFAULT_BUBBLE_STYLE = BUBBLE_STYLES.neutral;
const BUBBLE_TEXT_FONT_STACK = '"Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const BUBBLE_TEXT_RESOLUTION = 3;
const BUBBLE_BASE_OFFSET_Y = -74;
const BUBBLE_MAX_STACK = 4;
const BUBBLE_MAX_VISIBLE = 2;
const BUBBLE_MAX_TEXT_CHARS = 72;
const BUBBLE_COMPACT_MAX_TEXT_CHARS = 48;
const BUBBLE_TEXT_WRAP_MIN_WIDTH = 180;
const BUBBLE_TEXT_WRAP_MAX_WIDTH = 240;
const BUBBLE_TYPEWRITER_LIVE_DELAY_MS = 14;
const BUBBLE_TYPEWRITER_REPLAY_DELAY_MS = 20;
const BUBBLE_LIVE_LINGER_MS = 1800;
const BUBBLE_REPLAY_LINGER_MS = 2800;
const BUBBLE_LINGER_PER_CHAR_MS = 18;
const BUBBLE_LINGER_MAX_MS = 4400;
const BUBBLE_WORLD_PADDING_X = 28;
const BUBBLE_WORLD_PADDING_Y = 18;
const BUBBLE_LAYOUT_SLOTS = [
  { x: 0, y: BUBBLE_BASE_OFFSET_Y },
  { x: -96, y: BUBBLE_BASE_OFFSET_Y - 30 },
  { x: 96, y: BUBBLE_BASE_OFFSET_Y - 30 },
  { x: -156, y: BUBBLE_BASE_OFFSET_Y - 84 },
  { x: 156, y: BUBBLE_BASE_OFFSET_Y - 84 },
  { x: 0, y: BUBBLE_BASE_OFFSET_Y - 124 },
] as const;

// ── Day/Night Tints ─────────────────────────────────────
const TIME_TINTS: Record<string, { color: number; alpha: number }> = {
  dawn:  { color: 0xff9800, alpha: 0.12 },
  noon:  { color: 0x000000, alpha: 0.0 },
  dusk:  { color: 0x9c27b0, alpha: 0.15 },
  night: { color: 0x0d47a1, alpha: 0.3 },
};

// ── Phase 4: Performance Constants ──────────────────────
const WEATHER_POOL_SIZE = 120;   // Max recycled weather particle Graphics
const AMBIENT_MOTE_POOL_SIZE = 24;
const VIEWPORT_MARGIN = 40;     // px outside viewport before culling agent

// ── Idle-Wander Constants ───────────────────────────────
const WANDER_RADIUS = 50;        // Max pixels from spawn origin
const WANDER_MIN_DELAY = 3000;   // Min ms between wander moves
const WANDER_MAX_DELAY = 7000;   // Max ms between wander moves
const WANDER_DURATION_MIN = 1500;
const WANDER_DURATION_MAX = 3500;

export class WorldScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSpriteData> = new Map();
  private bubbles: Map<string, Phaser.GameObjects.Container> = new Map();
  private unsubscribers: (() => void)[] = [];
  private sceneTheme: string = 'medieval_village';
  private bgGraphics: Phaser.GameObjects.Graphics | null = null;
  private groundGraphics: Phaser.GameObjects.Graphics | null = null;
  private bgImage: Phaser.GameObjects.Image | null = null;
  private themeLabel: Phaser.GameObjects.Text | null = null;
  private endingOverlay: Phaser.GameObjects.Container | null = null;
  private isThemeTransitioning = false;

  // Weather / lighting overlays
  private weatherParticles: Phaser.GameObjects.Graphics[] = [];
  private weatherTimer: Phaser.Time.TimerEvent | null = null;
  private currentWeather: string = 'clear';
  private lightingOverlay: Phaser.GameObjects.Graphics | null = null;
  private currentTimeOfDay: string = 'noon';

  // Phase 4: Object pools for performance
  private weatherPool: Phaser.GameObjects.Graphics[] = [];
  private ambientMotePool: Phaser.GameObjects.Graphics[] = [];
  private pendingSceneTextureLoads: Set<string> = new Set();
  private pendingSpriteTextureLoads: Set<string> = new Set();

  // Phase 3: MiniMap HUD
  private minimapContainer: Phaser.GameObjects.Container | null = null;
  private minimapDots: Map<string, Phaser.GameObjects.Graphics> = new Map();
  private minimapBg: Phaser.GameObjects.Graphics | null = null;
  private minimapSceneImg: Phaser.GameObjects.Image | null = null;
  private minimapGradient: Phaser.GameObjects.Graphics | null = null;

  // V3: Ambient particle system
  private ambientMotes: Phaser.GameObjects.Graphics[] = [];
  private ambientTimer: Phaser.Time.TimerEvent | null = null;
  private cloudGraphics: Phaser.GameObjects.Graphics[] = [];
  private terrainLayers: Phaser.GameObjects.Graphics[] = [];

  constructor() {
    super({ key: 'WorldScene' });
  }

  public getAutomationState(): Record<string, unknown> {
    const activeBubbles = [...this.bubbles.entries()].map(([agentId, bubble]) => ({
      agent_id: agentId,
      text: this.extractBubbleText(bubble),
      emotion: (bubble.getData('emotion') as string | undefined) || 'neutral',
      visible: bubble.visible,
    }));

    const agents = [...this.agentSprites.values()].map((agent) => ({
      agent_id: agent.agent_id,
      name: agent.name,
      sprite_id: agent.sprite_id,
      x: Math.round(agent.x),
      y: Math.round(agent.y),
      visible: agent.gameObject?.visible ?? false,
    }));

    return {
      scene: 'WorldScene',
      theme: this.sceneTheme,
      weather: this.currentWeather,
      time_of_day: this.currentTimeOfDay,
      agent_count: agents.length,
      agents,
      displayed_bubble_count: activeBubbles.length,
      is_transitioning: this.isThemeTransitioning,
      bubbles: activeBubbles,
    };
  }

  create(): void {
    const { width, height } = this.scale;
    const registryTheme = this.registry.get('initialSceneTheme') as string | undefined;
    if (registryTheme) {
      this.sceneTheme = registryTheme;
    }

    // Hook Phaser lifecycle: auto-cleanup on scene stop/restart
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);

    // Draw procedural background
    this.drawBackground(width, height);
    const requestedTheme = this.sceneTheme;
    if (isSceneThemeId(requestedTheme) && !this.textures.exists(getSceneTextureKey(requestedTheme))) {
      this.ensureSceneTexture(requestedTheme, () => {
        if (!this.sys.isActive() || this.sceneTheme !== requestedTheme) return;
        const palette = THEME_PALETTES[this.sceneTheme] || DEFAULT_PALETTE;
        this.applyThemeSwap(this.sceneTheme, getSceneTextureKey(requestedTheme), palette, width, height);
      });
    }

    // Phase 3: Draw MiniMap HUD (bottom-right floating overlay)
    this.drawMinimap(width, height);

    // Phase 3 Batch 2: BetPanel & Leaderboard HUD — now rendered by React HudOverlay

    // Register EventBridge listeners
    this.registerEventListeners();

    // B4: Mouse-move parallax for terrain layers
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const dx = (pointer.x - width / 2) / width;   // -0.5 to 0.5
      const dy = (pointer.y - height / 2) / height;
      this.terrainLayers.forEach((layer, i) => {
        const factor = (i + 1) * 2; // deeper layers move less
        layer.setX(dx * factor);
        layer.setY(dy * factor * 0.5);
      });
      // Also parallax clouds
      this.cloudGraphics.forEach((cloud, i) => {
        const factor = (i + 1) * 3;
        cloud.setX(cloud.getData('baseX') ?? cloud.x);
        if (!cloud.getData('baseX')) cloud.setData('baseX', cloud.x);
        cloud.x = (cloud.getData('baseX') as number) + dx * factor;
      });
    });

    console.log('[WorldScene] Created, waiting for viz:scene_init');

    // V2.1: Signal that WorldScene is ready to receive viz events
    // This lets PhaserGame.tsx know it can dispatch synthesized events
    dispatchVizEvent('viz:scene_ready', {});
  }

  // ── Background ────────────────────────────────────────

  private drawBackground(w: number, h: number): void {
    const palette = THEME_PALETTES[this.sceneTheme] || DEFAULT_PALETTE;
    const texKey = `scene_${this.sceneTheme}`;

    // Background image fills the entire canvas
    if (this.textures.exists(texKey)) {
      this.bgImage = this.add.image(w / 2, h / 2, texKey);
      this.bgImage.setDisplaySize(w, h).setDepth(0);
    } else {
      // V3 Enhanced fallback: multi-layer procedural background
      this.drawProceduralBackground(w, h, palette);
    }

    // Light pixel grid overlay for retro feel
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x000000, 0.03);
    for (let x = 0; x < w; x += 16) grid.lineBetween(x, 0, x, h);
    for (let y = 0; y < h; y += 16) grid.lineBetween(0, y, w, y);
    grid.setDepth(1);

    // Scene label with rounded pill style
    const display = this.sceneTheme.replace(/_/g, ' ');
    this.themeLabel = this.add.text(w / 2, 12, `${palette.icon} ${display}`, {
      fontSize: '11px',
      color: '#ffffff',
      fontFamily: 'monospace',
      backgroundColor: 'rgba(0,0,0,0.55)',
      padding: { x: 10, y: 4 },
    }).setOrigin(0.5, 0).setDepth(100).setAlpha(0.85);

    // V3: Start ambient particle system
    this.startAmbientMotes(w, h, palette);
  }

  private clearProceduralBackgroundLayers(): void {
    if (this.bgGraphics) {
      this.bgGraphics.destroy();
      this.bgGraphics = null;
    }
    if (this.groundGraphics) {
      this.groundGraphics.destroy();
      this.groundGraphics = null;
    }
    this.terrainLayers.forEach((layer) => layer.destroy());
    this.terrainLayers = [];
    this.cloudGraphics.forEach((cloud) => cloud.destroy());
    this.cloudGraphics = [];
  }

  /** V3: Rich procedural background with terrain, clouds, and horizon glow. */
  private drawProceduralBackground(w: number, h: number, palette: typeof DEFAULT_PALETTE): void {
    const horizonY = h * 0.55;

    // Sky gradient (top to horizon)
    this.bgGraphics = this.add.graphics();
    this.bgGraphics.fillGradientStyle(palette.sky1, palette.sky1, palette.sky2, palette.sky2, 1);
    this.bgGraphics.fillRect(0, 0, w, horizonY + 20);
    this.bgGraphics.setDepth(0);

    // Horizon glow line
    const horizonGlow = this.add.graphics();
    horizonGlow.fillStyle(palette.accent, 0.15);
    horizonGlow.fillEllipse(w / 2, horizonY, w * 1.5, 40);
    horizonGlow.setDepth(0);
    this.terrainLayers.push(horizonGlow);

    // Far terrain silhouette (mountains/hills)
    const farTerrain = this.add.graphics();
    farTerrain.fillStyle(this.darkenColor(palette.ground, 0.4), 0.6);
    farTerrain.beginPath();
    farTerrain.moveTo(0, horizonY);
    const segments = 16;
    for (let i = 0; i <= segments; i++) {
      const x = (i / segments) * w;
      const yOffset = Math.sin(i * 0.6 + 1.2) * 25 + Math.sin(i * 1.3) * 12;
      farTerrain.lineTo(x, horizonY - 30 - yOffset);
    }
    farTerrain.lineTo(w, horizonY);
    farTerrain.closePath();
    farTerrain.fill();
    farTerrain.setDepth(0);
    this.terrainLayers.push(farTerrain);

    // Mid terrain silhouette
    const midTerrain = this.add.graphics();
    midTerrain.fillStyle(this.darkenColor(palette.ground, 0.25), 0.7);
    midTerrain.beginPath();
    midTerrain.moveTo(0, horizonY + 10);
    for (let i = 0; i <= segments; i++) {
      const x = (i / segments) * w;
      const yOffset = Math.sin(i * 0.8 + 0.5) * 15 + Math.sin(i * 1.8 + 2) * 8;
      midTerrain.lineTo(x, horizonY - 5 - yOffset);
    }
    midTerrain.lineTo(w, horizonY + 10);
    midTerrain.closePath();
    midTerrain.fill();
    midTerrain.setDepth(0);
    this.terrainLayers.push(midTerrain);

    // Ground plane
    this.groundGraphics = this.add.graphics();
    this.groundGraphics.fillStyle(palette.ground, 1);
    this.groundGraphics.fillRect(0, horizonY, w, h - horizonY);
    this.groundGraphics.setDepth(0);

    // Ground texture dots (subtle)
    const textureDots = this.add.graphics();
    textureDots.setDepth(0);
    for (let i = 0; i < 60; i++) {
      const dx = Math.random() * w;
      const dy = horizonY + 10 + Math.random() * (h - horizonY - 10);
      const dotAlpha = 0.05 + Math.random() * 0.1;
      textureDots.fillStyle(0x000000, dotAlpha);
      textureDots.fillCircle(dx, dy, 1 + Math.random() * 1.5);
    }
    this.terrainLayers.push(textureDots);

    // Drifting clouds (only for lighter themes)
    this.createDriftingClouds(w, horizonY, palette);
  }

  /** V3: Simple drifting cloud shapes in the sky area. */
  private createDriftingClouds(w: number, maxY: number, _palette: typeof DEFAULT_PALETTE): void {
    // Skip clouds for dark/space themes
  const darkThemes = ['surveillance_megacity', 'scifi_base', 'power_grid_nexus', 'space_station', 'post_apocalypse', 'arcane_sanctum', 'faith_temple', 'faith_temple_variant', 'law_court', 'law_court_variant', 'war_command', 'refuge_compound', 'logistics_hub'];
    if (darkThemes.includes(this.sceneTheme)) return;

    for (let i = 0; i < 4; i++) {
      const cloud = this.add.graphics();
      const cloudY = 30 + Math.random() * (maxY * 0.5);
      const cloudX = Math.random() * w;
      const cloudW = 40 + Math.random() * 60;
      const alpha = 0.12 + Math.random() * 0.15;

      cloud.fillStyle(0xffffff, alpha);
      // Build cloud from overlapping ellipses
      cloud.fillEllipse(0, 0, cloudW, cloudW * 0.3);
      cloud.fillEllipse(cloudW * 0.25, -cloudW * 0.08, cloudW * 0.6, cloudW * 0.25);
      cloud.fillEllipse(-cloudW * 0.2, -cloudW * 0.05, cloudW * 0.5, cloudW * 0.22);

      cloud.setPosition(cloudX, cloudY);
      cloud.setDepth(0);

      // Slow horizontal drift
      this.tweens.add({
        targets: cloud,
        x: cloudX + 30 + Math.random() * 40,
        duration: 15000 + Math.random() * 10000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });

      this.cloudGraphics.push(cloud);
    }
  }

  /** V3: Ambient floating motes for atmosphere. */
  private startAmbientMotes(w: number, h: number, palette: typeof DEFAULT_PALETTE): void {
    // Spawn initial motes
    for (let i = 0; i < 15; i++) {
      this.spawnAmbientMote(w, h, palette.accent);
    }

    // Continuously spawn new motes
    this.ambientTimer = this.time.addEvent({
      delay: 2000,
      repeat: -1,
      callback: () => {
        if (this.ambientMotes.length < 20) {
          this.spawnAmbientMote(w, h, palette.accent);
        }
      },
    });
  }

  private spawnAmbientMote(w: number, h: number, accent: number): void {
    const mote = this.acquireAmbientMote();
    const size = 0.5 + Math.random() * 1.5;
    const alpha = 0.1 + Math.random() * 0.2;
    const color = Math.random() > 0.5 ? accent : 0xffffff;

    mote.clear();
    mote.fillStyle(color, alpha);
    mote.fillCircle(0, 0, size);
    if (size > 1) {
      mote.fillStyle(color, alpha * 0.3);
      mote.fillCircle(0, 0, size * 2.5);
    }

    const startX = Math.random() * w;
    const startY = h * 0.3 + Math.random() * h * 0.6;
    mote.setPosition(startX, startY);
    mote.setDepth(5);

    this.ambientMotes.push(mote);

    // Float and fade
    this.tweens.add({
      targets: mote,
      x: startX + (Math.random() - 0.5) * 60,
      y: startY - 20 - Math.random() * 40,
      alpha: 0,
      duration: 6000 + Math.random() * 4000,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        const idx = this.ambientMotes.indexOf(mote);
        if (idx >= 0) this.ambientMotes.splice(idx, 1);
        this.releaseAmbientMote(mote);
      },
    });
  }

  /** Acquire an ambient mote graphics object from pool or create a new one. */
  private acquireAmbientMote(): Phaser.GameObjects.Graphics {
    const pooled = this.ambientMotePool.pop();
    if (pooled && pooled.scene) {
      pooled.clear();
      pooled.setAlpha(1);
      pooled.setScale(1);
      pooled.setVisible(true);
      pooled.setDepth(5);
      return pooled;
    }
    const mote = this.add.graphics();
    mote.setDepth(5);
    return mote;
  }

  /** Return an ambient mote graphics object to the pool. */
  private releaseAmbientMote(mote: Phaser.GameObjects.Graphics): void {
    if (!mote.scene) return;
    mote.clear();
    mote.setVisible(false);
    mote.setAlpha(1);
    mote.setPosition(-100, -100);
    if (this.ambientMotePool.length < AMBIENT_MOTE_POOL_SIZE) {
      this.ambientMotePool.push(mote);
      return;
    }
    mote.destroy();
  }

  /** Darken a hex color by a factor (0=no change, 1=black). */
  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xFF) * (1 - factor));
    const g = Math.floor(((color >> 8) & 0xFF) * (1 - factor));
    const b = Math.floor((color & 0xFF) * (1 - factor));
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Transition background palette for a new scene theme.
   * B4: now uses a vertical-wipe reveal effect.
   */
  private transitionTheme(newTheme: string): void {
    const palette = THEME_PALETTES[newTheme] || DEFAULT_PALETTE;
    const { width, height } = this.scale;
    const texKey = isSceneThemeId(newTheme) ? getSceneTextureKey(newTheme) : `scene_${newTheme}`;

    // B4: Vertical wipe transition (black curtain slides down then back up)
    this.isThemeTransitioning = true;
    const wipe = this.add.graphics();
    wipe.fillStyle(0x000000, 1);
    wipe.fillRect(0, 0, width, height);
    wipe.setDepth(999);
    wipe.setPosition(0, -height);

    this.tweens.add({
      targets: wipe,
      y: 0,
      duration: 400,
      ease: 'Power2.easeIn',
      onComplete: () => {
        // Swap scene content while hidden
        this.applyThemeSwap(newTheme, texKey, palette, width, height);
        this.ensureSceneTexture(newTheme, () => {
          if (!this.sys.isActive() || this.sceneTheme !== newTheme) return;
          this.applyThemeSwap(newTheme, texKey, palette, this.scale.width, this.scale.height);
        });

        // Wipe back up to reveal
        this.tweens.add({
          targets: wipe,
          y: -height,
          duration: 400,
          ease: 'Power2.easeOut',
          delay: 100,
          onComplete: () => {
            this.isThemeTransitioning = false;
            wipe.destroy();
          },
        });
      },
    });

    this.sceneTheme = newTheme;
    console.log(`[WorldScene] Theme transitioned to: ${newTheme}`);
  }

  private ensureSceneTexture(themeId: string, onReady?: () => void): void {
    if (!isSceneThemeId(themeId)) return;

    const texKey = getSceneTextureKey(themeId);
    if (this.textures.exists(texKey)) {
      onReady?.();
      return;
    }
    if (this.pendingSceneTextureLoads.has(texKey)) {
      return;
    }

    this.pendingSceneTextureLoads.add(texKey);

    const cleanup = () => {
      this.pendingSceneTextureLoads.delete(texKey);
      this.load.off(`filecomplete-image-${texKey}`, handleFileComplete);
      this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    };

    const handleFileComplete = () => {
      cleanup();
      onReady?.();
    };

    const handleLoadError = (file: Phaser.Loader.File) => {
      if (file.key !== texKey) return;
      cleanup();
    };

    this.load.once(`filecomplete-image-${texKey}`, handleFileComplete);
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    this.load.image(texKey, getThemeAssetPath(themeId));
    if (!this.load.isLoading()) {
      this.load.start();
    }
  }

  /** Apply the actual theme swap (background + label). */
  private applyThemeSwap(
    newTheme: string, texKey: string,
    palette: typeof DEFAULT_PALETTE,
    width: number, height: number,
  ): void {
    const sceneH = height;

    // Try to swap to new scene image
    if (this.textures.exists(texKey)) {
      // Remove procedural fallback layers so the authored scene art is visible.
      this.clearProceduralBackgroundLayers();

      if (this.bgImage) {
        const oldImg = this.bgImage;
        this.bgImage = this.add.image(width / 2, sceneH / 2, texKey);
        this.bgImage.setDisplaySize(width, sceneH).setDepth(0);
        oldImg.destroy();
      } else {
        this.bgImage = this.add.image(width / 2, sceneH / 2, texKey);
        this.bgImage.setDisplaySize(width, sceneH).setDepth(0);
      }
    } else {
      // Fallback to gradient
      if (this.bgImage) { this.bgImage.destroy(); this.bgImage = null; }

      if (!this.bgGraphics) this.bgGraphics = this.add.graphics();
      this.bgGraphics.clear();
      this.bgGraphics.fillGradientStyle(palette.sky1, palette.sky1, palette.sky2, palette.sky2, 1);
      this.bgGraphics.fillRect(0, 0, width, sceneH * 0.6);

      if (!this.groundGraphics) this.groundGraphics = this.add.graphics();
      this.groundGraphics.clear();
      this.groundGraphics.fillStyle(palette.ground, 1);
      this.groundGraphics.fillRect(0, sceneH * 0.6, width, sceneH * 0.4);
    }

    // Update label
    if (this.themeLabel) {
      const display = newTheme.replace(/_/g, ' ');
      this.themeLabel.setText(`${palette.icon} ${display}`);
    }

    // Update minimap scene thumbnail
    this.updateMinimapScene(texKey, palette);
  }

  // ── Event Listeners ───────────────────────────────────

  private registerEventListeners(): void {
    // Scene initialization — set theme + spawn agents
    this.unsubscribers.push(
      EventBridge.on('viz:scene_init', (data) => {
        const nextTheme = (data.scene_theme as string) || 'medieval_village';
        const isInitialBootstrap = this.agentSprites.size === 0;
        const palette = THEME_PALETTES[nextTheme] || DEFAULT_PALETTE;
        const texKey = `scene_${nextTheme}`;
        if (nextTheme !== this.sceneTheme) {
          if (isInitialBootstrap) {
            this.applyThemeSwap(nextTheme, texKey, palette, this.scale.width, this.scale.height);
            this.sceneTheme = nextTheme;
          } else {
            this.transitionTheme(nextTheme);
          }
        } else if (isSceneThemeId(nextTheme) && !this.textures.exists(texKey)) {
          this.ensureSceneTexture(nextTheme, () => {
            if (!this.sys.isActive() || this.sceneTheme !== nextTheme) return;
            this.applyThemeSwap(nextTheme, texKey, palette, this.scale.width, this.scale.height);
          });
        }
        const agents = data.agents as Array<{
          agent_id: string; name: string; sprite_id: string; x: number; y: number;
        }>;
        if (agents) {
          for (const agent of agents) {
            this.spawnAgent(agent);
          }
        }
        console.log(`[WorldScene] Initialized: theme=${nextTheme}, agents=${agents?.length ?? 0}`);
      })
    );

    // Agent dialogue bubble
    this.unsubscribers.push(
      EventBridge.on('viz:bubble_show', (data) => {
        const spriteId = data.sprite_id as string;
        const text = data.bubble_text as string;
        const emotion = data.emotion as string | undefined;
        const haloColor = data.halo_color as string | undefined;
        const bubbleMode = data.bubble_mode === 'replay' ? 'replay' : 'live';
        this.showBubble(spriteId, text, emotion, haloColor, bubbleMode);
      })
    );

    this.unsubscribers.push(
      EventBridge.on('viz:clear_bubbles', () => {
        this.clearActiveBubbles();
      })
    );

    // Agent movement (stance-based positioning)
    this.unsubscribers.push(
      EventBridge.on('viz:agent_move', (data) => {
        const spriteId = data.sprite_id as string;
        const x = data.x as number;
        const y = data.y as number;
        const duration = (data.duration as number) || 800;
        const faction = data.faction as string | undefined;
        this.moveAgent(spriteId, x, y, duration, faction);
      })
    );

    // Branch split animation
    this.unsubscribers.push(
      EventBridge.on('viz:world_split', (data) => {
        const direction = data.split_direction as string;
        const reason = data.reason as string | undefined;
        this.playSplitAnimation(direction, reason);
      })
    );

    // Emotion change
    this.unsubscribers.push(
      EventBridge.on('viz:emotion_change', (data) => {
        const spriteId = data.sprite_id as string;
        const haloColor = data.halo_color as string;
        this.updateHalo(spriteId, haloColor);
      })
    );

    // Event animations (butterfly effect + card events)
    this.unsubscribers.push(
      EventBridge.on('viz:event_anim', (data) => {
        const animation = data.animation as string;
        const cardName = data.card_name_zh as string | undefined;
        this.playEventAnimation(animation, cardName);
      })
    );

    // Scene theme change
    this.unsubscribers.push(
      EventBridge.on('viz:scene_change', (data) => {
        const sceneId = data.scene_id as string;
        if (sceneId && sceneId !== this.sceneTheme) {
          this.transitionTheme(sceneId);
        }
      })
    );

    // Ending play — transition to EndingScene (Phase 3)
    this.unsubscribers.push(
      EventBridge.on('viz:ending_play', (data) => {
        const title = data.title as string || '';
        const storySummary = data.story_summary as string || '';
        const endingType = data.ending_type as string || 'neutral';
        const endingId = data.ending_id as string | undefined;
        this.scene.start('EndingScene', {
          ending_type: endingType,
          title,
          story_summary: storySummary,
          ending_id: endingId,
        });
      })
    );

    // Weather / time-of-day change
    this.unsubscribers.push(
      EventBridge.on('viz:weather_change', (data) => {
        const weatherType = data.weather_type as string || 'clear';
        const intensity = (data.intensity as number) ?? 0.5;
        const timeOfDay = data.time_of_day as string | undefined;
        this.setWeather(weatherType, intensity);
        if (timeOfDay) this.setTimeOfDay(timeOfDay);
      })
    );

    // Phase 3 Batch 2: Bet & Leaderboard updates — handled by React HudOverlay
  }

  // ── Agent Spawning ────────────────────────────────────

  private spawnAgent(agent: { agent_id: string; name: string; sprite_id: string; x: number; y: number }): void {
    const { width, height } = this.scale;
    const x = (agent.x / 800) * width;
    const y = (agent.y / 450) * height;

    const container = this.add.container(x, y);
    container.setDepth(10);

    // V3: Drop shadow (ellipse under sprite)
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.2);
    shadow.fillEllipse(0, 26, 28, 8);
    container.add(shadow);

    // Halo circle (behind sprite, initially invisible)
    const haloGfx = this.add.graphics();
    haloGfx.setAlpha(0);
    container.add(haloGfx);

    // Sprite
    const texKey = this.textures.exists(agent.sprite_id) ? agent.sprite_id : 'sprite_default';
    // Sprite PNGs are 640×640; shrink to pixel-art size
    const sprite = this.add.image(0, 0, texKey).setDisplaySize(32, 48);
    if (texKey === 'sprite_default' && agent.sprite_id !== 'sprite_default') {
      this.ensureSpriteTexture(agent.sprite_id, () => {
        if (!sprite.scene || sprite.scene !== this || !sprite.active) return;
        sprite.setTexture(agent.sprite_id);
      });
    }
    container.add(sprite);

    // V3: Subtle highlight glow behind sprite
    const palette = THEME_PALETTES[this.sceneTheme] || DEFAULT_PALETTE;
    const glowFx = this.add.graphics();
    glowFx.fillStyle(palette.accent, 0.06);
    glowFx.fillCircle(0, 0, 20);
    container.add(glowFx);
    container.sendToBack(glowFx);

    // Name label with rounded style
    const label = this.add.text(0, -32, agent.name, {
      fontSize: '9px',
      color: '#ffffff',
      fontFamily: 'monospace',
      backgroundColor: 'rgba(0,0,0,0.55)',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1);
    container.add(label);

    // Faction color bar (bottom of sprite)
    const factionBar = this.add.graphics();
    factionBar.fillStyle(FACTION_COLORS.unknown, 0.8);
    factionBar.fillRoundedRect(-8, 26, 16, 3, 1);
    container.add(factionBar);

    // Idle breathing animation
    this.tweens.add({
      targets: sprite,
      y: -2,
      duration: 1500 + Math.random() * 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // V3: Shadow breathing sync
    this.tweens.add({
      targets: shadow,
      scaleX: 0.9,
      scaleY: 0.85,
      duration: 1500 + Math.random() * 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // V3: Enhanced spawn — drop from above with bounce
    container.setScale(0.5);
    container.setAlpha(0);
    container.y = y - 30;
    this.tweens.add({
      targets: container,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
      y: y,
      duration: 500,
      ease: 'Bounce.easeOut',
      delay: Math.random() * 400,
    });

    const agentData: AgentSpriteData = {
      agent_id: agent.agent_id,
      name: agent.name,
      sprite_id: agent.sprite_id,
      x, y,
      originX: x,
      originY: y,
      gameObject: container,
      haloGraphics: haloGfx,
      factionBar,
    };
    this.agentSprites.set(agent.agent_id, agentData);

    // Start idle wandering for this agent
    this.startIdleWander(agent.agent_id);

    // Phase 3: Add initial minimap dot
    this.updateMinimapDot(agent.agent_id, x, y);
  }

  private ensureSpriteTexture(spriteKey: string, onReady?: () => void): void {
    if (!CHARACTER_SPRITE_KEY_SET.has(spriteKey) || this.textures.exists(spriteKey)) {
      onReady?.();
      return;
    }
    if (this.pendingSpriteTextureLoads.has(spriteKey)) {
      return;
    }

    const request = getCharacterTextureRequest(spriteKey);
    if (!request) return;

    this.pendingSpriteTextureLoads.add(spriteKey);

    const cleanup = () => {
      this.pendingSpriteTextureLoads.delete(spriteKey);
      this.load.off(`filecomplete-image-${spriteKey}`, handleFileComplete);
      this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    };

    const handleFileComplete = () => {
      cleanup();
      onReady?.();
    };

    const handleLoadError = (file: Phaser.Loader.File) => {
      if (file.key !== spriteKey) return;
      cleanup();
    };

    this.load.once(`filecomplete-image-${spriteKey}`, handleFileComplete);
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    this.load.image(request.spriteKey, request.assetPath);
    if (!this.load.isLoading()) {
      this.load.start();
    }
  }

  // ── Idle Wandering ─────────────────────────────────────

  /**
   * Schedule recurring random movement for an agent so the scene feels alive.
   * Each agent drifts within WANDER_RADIUS of its spawn origin.
   */
  private startIdleWander(agentId: string): void {
    const scheduleNext = () => {
      const agent = this.agentSprites.get(agentId);
      if (!agent?.gameObject) return;

      const delay = WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY);

      agent.wanderTimer = this.time.delayedCall(delay, () => {
        const a = this.agentSprites.get(agentId);
        if (!a?.gameObject) return;

        const { width, height } = this.scale;

        // Pick a random offset within the wander radius, constrained to canvas
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * WANDER_RADIUS;
        const targetX = Phaser.Math.Clamp(
          a.originX + Math.cos(angle) * dist,
          40, width - 40,
        );
        const targetY = Phaser.Math.Clamp(
          a.originY + Math.sin(angle) * dist * 0.5, // less vertical drift
          height * 0.45, height - 30,
        );

        const duration = WANDER_DURATION_MIN + Math.random() * (WANDER_DURATION_MAX - WANDER_DURATION_MIN);

        this.tweens.add({
          targets: a.gameObject,
          x: targetX,
          y: targetY,
          duration,
          ease: 'Sine.easeInOut',
          onComplete: () => {
            a.x = targetX;
            a.y = targetY;
            // Update minimap dot position
            this.updateMinimapDot(agentId, targetX, targetY);
          },
        });

        // Schedule next wander after this one finishes
        this.time.delayedCall(duration + 200, scheduleNext);
      });
    };

    // Start after a random initial delay so agents don't all move at once
    this.time.delayedCall(500 + Math.random() * 2000, scheduleNext);
  }

  // ── Dialogue Bubbles ──────────────────────────────────

  private dismissBubble(spriteId: string, bubble: Phaser.GameObjects.Container, duration = 220): void {
    if (!bubble.active) return;
    if (this.bubbles.get(spriteId) === bubble) {
      this.bubbles.delete(spriteId);
    }
    this.tweens.add({
      targets: bubble,
      alpha: 0,
      y: bubble.y - 10,
      duration,
      onComplete: () => bubble.destroy(),
    });
  }

  private showBubble(
    spriteId: string,
    text: string,
    emotion?: string,
    _haloColor?: string,
    bubbleMode: BubbleMode = 'live',
  ): void {
    const agent = this.agentSprites.get(spriteId);
    if (!agent?.gameObject) return;
    const renderedViewportWidth = this.scale.displaySize?.width ?? this.scale.width;
    const isCompactViewport = renderedViewportWidth < 560;
    const maxChars = isCompactViewport ? BUBBLE_COMPACT_MAX_TEXT_CHARS : BUBBLE_MAX_TEXT_CHARS;
    const maxVisibleBubbles = isCompactViewport ? 1 : BUBBLE_MAX_VISIBLE;
    const visibleText = isCompactViewport
      ? `${agent.name}：${normalizeBubbleText(text, maxChars)}`
      : normalizeBubbleText(text, maxChars);
    const { charDelayMs, initialChars, lingerMs } = getBubbleTiming(bubbleMode, visibleText.length);
    const initialText = visibleText.slice(0, initialChars);
    const bubbleWrapWidth = Phaser.Math.Clamp(
      Math.round(this.scale.width * (isCompactViewport ? 0.82 : 0.32)),
      isCompactViewport ? 220 : BUBBLE_TEXT_WRAP_MIN_WIDTH,
      isCompactViewport ? 320 : BUBBLE_TEXT_WRAP_MAX_WIDTH,
    );

    // Remove existing bubble for this agent
    const existing = this.bubbles.get(spriteId);
    if (existing) {
      this.dismissBubble(spriteId, existing, 180);
    }

    const visibleEntries = [...this.bubbles.entries()].filter(([, bubble]) => bubble.active);
    while (visibleEntries.length >= maxVisibleBubbles) {
      const [oldestSpriteId, oldestBubble] = visibleEntries.shift()!;
      this.dismissBubble(oldestSpriteId, oldestBubble, 160);
    }

    // Select bubble style variant based on emotion
    const style = (emotion && BUBBLE_STYLES[emotion]) ? BUBBLE_STYLES[emotion] : DEFAULT_BUBBLE_STYLE;
    const bubbleBgColor = isCompactViewport ? 0x151224 : style.bg;
    const bubbleBgAlpha = isCompactViewport ? 0.94 : style.bgAlpha;
    const bubbleBorderColor = isCompactViewport ? 0xf5d7ff : style.borderColor;

    const bubbleTextStyle = {
      fontSize: isCompactViewport
        ? (bubbleMode === 'replay' ? '14px' : '15px')
        : (bubbleMode === 'replay' ? '13px' : '14px'),
      color: isCompactViewport ? '#fff7ff' : '#1f2335',
      fontFamily: BUBBLE_TEXT_FONT_STACK,
      fontStyle: '700',
      align: 'left' as const,
      lineSpacing: 4,
      fixedWidth: bubbleWrapWidth,
      wordWrap: { width: bubbleWrapWidth, useAdvancedWrap: true },
      stroke: isCompactViewport ? '#120d1b' : '#f7f2ff',
      strokeThickness: isCompactViewport ? 0 : 1,
      shadow: {
        offsetX: 0,
        offsetY: isCompactViewport ? 0 : 1,
        color: isCompactViewport ? 'rgba(0, 0, 0, 0)' : 'rgba(8, 10, 22, 0.35)',
        blur: 0,
        stroke: false,
        fill: !isCompactViewport,
      },
    };

    const bubbleTextResolution = isCompactViewport ? 4 : BUBBLE_TEXT_RESOLUTION;

    // B4: Typewriter — keep a short prefix visible immediately so live updates do not feel delayed.
    const textObj = this.add.text(0, 0, initialText, bubbleTextStyle).setOrigin(0.5).setResolution(bubbleTextResolution);

    // Pre-measure full text for proper bubble size
    const measureText = this.add.text(0, 0, visibleText, bubbleTextStyle).setOrigin(0.5).setAlpha(0);
    measureText.setResolution(bubbleTextResolution);
    const bounds = measureText.getBounds();
    measureText.destroy();

    const pad = 12;
    const bubbleWidth = bounds.width + pad * 2;
    const bubbleHeight = bounds.height + pad * 2;

    let bubbleOffsetX = 0;
    let bubbleOffsetY = 0;
    let attachToAgent = true;

    if (isCompactViewport) {
      attachToAgent = false;
      bubbleOffsetX = Math.round(this.scale.width / 2);
      bubbleOffsetY = Math.round(
        this.scale.height - Math.max(104, bubbleHeight / 2 + 44),
      );
    } else {
      const overlapCount = new Map<number, number>();
      const selectedSlot = BUBBLE_LAYOUT_SLOTS.find((slot, slotIndex) => {
        const candidateWorldX = agent.gameObject!.x + slot.x;
        const candidateWorldY = agent.gameObject!.y + slot.y;
        let overlaps = 0;

        this.bubbles.forEach((otherBubble, otherId) => {
          if (otherId === spriteId || !otherBubble.active) return;
          const otherAgent = this.agentSprites.get(otherId);
          if (!otherAgent?.gameObject) return;

          const otherWidth = Number(otherBubble.getData('bubbleWidth') ?? bubbleWidth);
          const otherHeight = Number(otherBubble.getData('bubbleHeight') ?? bubbleHeight);
          const otherWorldX = otherAgent.gameObject.x + otherBubble.x;
          const otherWorldY = otherAgent.gameObject.y + otherBubble.y;

          const overlapsHorizontally =
            Math.abs(candidateWorldX - otherWorldX) < ((bubbleWidth + otherWidth) / 2 + BUBBLE_WORLD_PADDING_X);
          const overlapsVertically =
            Math.abs(candidateWorldY - otherWorldY) < ((bubbleHeight + otherHeight) / 2 + BUBBLE_WORLD_PADDING_Y);

          if (overlapsHorizontally && overlapsVertically) {
            overlaps += 1;
          }
        });

        overlapCount.set(slotIndex, overlaps);
        return overlaps === 0;
      }) ?? BUBBLE_LAYOUT_SLOTS[
        [...overlapCount.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? Math.min(BUBBLE_MAX_STACK, BUBBLE_LAYOUT_SLOTS.length - 1)
      ];

      bubbleOffsetX = selectedSlot.x;
      bubbleOffsetY = selectedSlot.y;
      const halfBubbleWidth = bubbleWidth / 2 + 12;
      const halfBubbleHeight = bubbleHeight / 2 + 12;

      const projectedLeft = agent.gameObject.x + bubbleOffsetX - halfBubbleWidth;
      const projectedRight = agent.gameObject.x + bubbleOffsetX + halfBubbleWidth;
      const projectedTop = agent.gameObject.y + bubbleOffsetY - halfBubbleHeight;

      if (projectedLeft < 12) {
        bubbleOffsetX += 12 - projectedLeft;
      } else if (projectedRight > this.scale.width - 12) {
        bubbleOffsetX -= projectedRight - (this.scale.width - 12);
      }

      if (projectedTop < 12) {
        bubbleOffsetY += 12 - projectedTop;
      }
    }

    const bubbleContainer = this.add.container(bubbleOffsetX, bubbleOffsetY);
    bubbleContainer.setDepth(isCompactViewport ? 120 : 50);

    // Bubble background with emotion-specific fill
    const bg = this.add.graphics();
    bg.fillStyle(bubbleBgColor, bubbleBgAlpha);
    bg.fillRoundedRect(
      -(bounds.width / 2 + pad), -(bounds.height / 2 + pad),
      bounds.width + pad * 2, bounds.height + pad * 2, 4,
    );
    // Emotion-specific border
    bg.lineStyle(emotion === 'anxious' || emotion === 'fearful' ? 1 : 1.5, bubbleBorderColor, 0.9);
    bg.strokeRoundedRect(
      -(bounds.width / 2 + pad), -(bounds.height / 2 + pad),
      bounds.width + pad * 2, bounds.height + pad * 2, 4,
    );

    // Emotion indicator badge (! or ?)
    if (!isCompactViewport && style.indicator) {
      const badge = this.add.text(
        bounds.width / 2 + pad + 2, -(bounds.height / 2 + pad) - 2,
        style.indicator,
        {
          fontSize: '12px',
          color: `#${bubbleBorderColor.toString(16).padStart(6, '0')}`,
          fontFamily: 'monospace',
          fontStyle: 'bold',
        }
      ).setOrigin(0.5);
      bubbleContainer.add(badge);
    } else if (!isCompactViewport && emotion && emotion !== 'neutral') {
      const emotionDot = this.add.graphics();
      emotionDot.fillStyle(bubbleBorderColor, 1);
      emotionDot.fillCircle(bounds.width / 2 + pad + 4, -(bounds.height / 2 + pad) + 4, 3);
      bubbleContainer.add(emotionDot);
    }

    bubbleContainer.add(bg);
    bubbleContainer.add(textObj);
    bubbleContainer.setAlpha(0);
    bubbleContainer.setData('fullText', visibleText);
    bubbleContainer.setData('emotion', emotion || 'neutral');
    bubbleContainer.setData('bubbleWidth', bubbleWidth);
    bubbleContainer.setData('bubbleHeight', bubbleHeight);
    bubbleContainer.setData('bubbleMode', bubbleMode);

    if (attachToAgent) {
      agent.gameObject.add(bubbleContainer);
    }

    // Animate in
    this.tweens.add({
      targets: bubbleContainer,
      alpha: 1,
      x: bubbleOffsetX,
      y: bubbleOffsetY - 5,
      duration: 300,
      ease: 'Back.easeOut',
    });

    // B4: Typewriter reveal
    let charIdx = initialChars;
    const remainingChars = Math.max(visibleText.length - initialChars, 0);
    let typewriterEvent: Phaser.Time.TimerEvent | null = null;

    if (remainingChars > 0) {
      typewriterEvent = this.time.addEvent({
        delay: charDelayMs,
        repeat: remainingChars - 1,
        callback: () => {
          if (!bubbleContainer.active || !textObj.active || !textObj.scene) {
            typewriterEvent?.remove(false);
            return;
          }
          charIdx += 1;
          try {
            textObj.setText(visibleText.slice(0, charIdx));
          } catch {
            typewriterEvent?.remove(false);
          }
        },
      });
    }

    this.bubbles.set(spriteId, bubbleContainer);

    const typingDurationMs = Math.max(0, remainingChars * charDelayMs);
    this.time.delayedCall(typingDurationMs + lingerMs, () => {
      if (this.bubbles.get(spriteId) === bubbleContainer) {
        typewriterEvent?.remove(false);
        this.dismissBubble(spriteId, bubbleContainer, 320);
      }
    });
  }

  private extractBubbleText(bubble: Phaser.GameObjects.Container): string {
    const fullText = bubble.getData('fullText');
    if (typeof fullText === 'string' && fullText.length > 0) {
      return fullText;
    }

    const textChild = bubble.list.find(
      (child): child is Phaser.GameObjects.Text => child instanceof Phaser.GameObjects.Text && !!child.text,
    );
    if (textChild?.text) {
      return textChild.text;
    }

    return (bubble.getData('fullText') as string | undefined) || '';
  }

  private clearActiveBubbles(): void {
    this.bubbles.forEach((bubble) => {
      if (!bubble.active) return;
      bubble.destroy();
    });
    this.bubbles.clear();
  }

  // ── Agent Movement (Phase 4: viewport culling) ────────

  private moveAgent(spriteId: string, x: number, y: number, duration: number, faction?: string): void {
    const agent = this.agentSprites.get(spriteId);
    if (!agent?.gameObject) return;

    const { width, height } = this.scale;
    const targetX = (x / 800) * width;
    const targetY = height * 0.6 + (y / 600) * (height * 0.35);

    // Trail particle effect with faction color
    const factionColor = FACTION_COLORS[faction || 'unknown'] ?? FACTION_COLORS.unknown;
    const trail = this.add.graphics();
    trail.fillStyle(factionColor, 0.4);
    trail.fillCircle(agent.gameObject.x, agent.gameObject.y, 4);
    this.tweens.add({
      targets: trail,
      alpha: 0,
      duration: 1000,
      onComplete: () => trail.destroy(),
    });

    // Update faction color bar on agent
    if (agent.factionBar && faction) {
      agent.factionBar.clear();
      agent.factionBar.fillStyle(factionColor, 0.8);
      agent.factionBar.fillRoundedRect(-8, 10, 16, 3, 1);
    }

    // Smooth movement with ease-out
    this.tweens.add({
      targets: agent.gameObject,
      x: targetX,
      y: targetY,
      duration,
      ease: 'Cubic.easeOut',
      onUpdate: () => this.cullAgent(agent, width, height),
    });

    agent.x = targetX;
    agent.y = targetY;

    // Phase 3: Update minimap dot
    this.updateMinimapDot(spriteId, targetX, targetY, faction);
  }

  /** Phase 4: Viewport culling — hide agents outside visible area. */
  private cullAgent(agent: AgentSpriteData, w: number, h: number): void {
    if (!agent.gameObject) return;
    const ax = agent.gameObject.x;
    const ay = agent.gameObject.y;
    const visible = ax > -VIEWPORT_MARGIN && ax < w + VIEWPORT_MARGIN
                 && ay > -VIEWPORT_MARGIN && ay < h + VIEWPORT_MARGIN;
    agent.gameObject.setVisible(visible);
  }

  // ── Emotion Halos ─────────────────────────────────────

  private updateHalo(spriteId: string, haloColor: string): void {
    const agent = this.agentSprites.get(spriteId);
    if (!agent?.gameObject) return;
    if (!haloColor || typeof haloColor !== 'string') return;

    const color = parseInt(haloColor.replace('#', ''), 16);
    if (isNaN(color)) return;

    // Stop previous halo tween
    if (agent.haloTween) {
      agent.haloTween.stop();
      agent.haloTween = undefined;
    }

    // Redraw halo circle
    const haloGfx = agent.haloGraphics;
    if (haloGfx) {
      haloGfx.clear();
      haloGfx.fillStyle(color, 0.25);
      haloGfx.fillCircle(0, 0, 22);
      haloGfx.lineStyle(1.5, color, 0.5);
      haloGfx.strokeCircle(0, 0, 22);
      haloGfx.setAlpha(1);

      // Pulsing animation
      agent.haloTween = this.tweens.add({
        targets: haloGfx,
        scaleX: 1.15,
        scaleY: 1.15,
        alpha: 0.6,
        duration: 800,
        yoyo: true,
        repeat: 3,
        ease: 'Sine.easeInOut',
        onComplete: () => {
          haloGfx.setAlpha(0.4);
          haloGfx.setScale(1);
        },
      });
    }

    // Emotion burst particles
    const burstCount = 6;
    for (let i = 0; i < burstCount; i++) {
      const angle = (Math.PI * 2 * i) / burstCount;
      const dot = this.add.graphics();
      dot.fillStyle(color, 0.8);
      dot.fillCircle(0, 0, 2);
      dot.setPosition(agent.gameObject.x, agent.gameObject.y);
      this.tweens.add({
        targets: dot,
        x: agent.gameObject.x + Math.cos(angle) * 30,
        y: agent.gameObject.y + Math.sin(angle) * 30,
        alpha: 0,
        duration: 600,
        ease: 'Power2',
        onComplete: () => dot.destroy(),
      });
    }
  }

  // ── World Split Animation ─────────────────────────────

  private playSplitAnimation(direction: string, reason?: string): void {
    const { width, height } = this.scale;

    // Screen shake
    this.cameras.main.shake(600, 0.008);

    // Split line with glow effect
    const splitGroup = this.add.container(0, 0).setDepth(90);

    if (direction === 'horizontal') {
      // Vertical split line in center
      const line = this.add.graphics();
      line.lineStyle(2, 0xffffff, 0);
      line.lineBetween(width / 2, 0, width / 2, height);
      splitGroup.add(line);

      // Animated glow line
      const glowLine = this.add.graphics();
      glowLine.lineStyle(4, 0x00ffff, 0.8);
      glowLine.lineBetween(width / 2, height / 2, width / 2, height / 2);
      splitGroup.add(glowLine);

      // Expand glow line from center
      this.tweens.add({
        targets: glowLine,
        scaleY: height,
        duration: 800,
        ease: 'Power3.easeOut',
      });

      // Ripple rings at split point
      this.createRipple(width / 2, height / 2, 0x00ffff);
    } else {
      // Quadrant split — two lines
      const vLine = this.add.graphics();
      vLine.lineStyle(3, 0x00ffff, 0.7);
      vLine.lineBetween(width / 2, 0, width / 2, height);
      splitGroup.add(vLine);

      const hLine = this.add.graphics();
      hLine.lineStyle(3, 0x00ffff, 0.7);
      hLine.lineBetween(0, height / 2, width, height / 2);
      splitGroup.add(hLine);

      this.createRipple(width / 2, height / 2, 0x00ffff);
    }

    // Reason text overlay
    if (reason) {
      const reasonText = this.add.text(width / 2, height / 2 - 40, `⚡ ${reason}`, {
        fontSize: '12px',
        color: '#ffffff',
        fontFamily: 'monospace',
        backgroundColor: 'rgba(0,0,0,0.7)',
        padding: { x: 12, y: 6 },
      }).setOrigin(0.5).setDepth(91);

      this.tweens.add({
        targets: reasonText,
        alpha: 0,
        y: reasonText.y - 20,
        duration: 3000,
        delay: 1500,
        onComplete: () => reasonText.destroy(),
      });
    }

    // Fade out split effect
    this.tweens.add({
      targets: splitGroup,
      alpha: 0,
      duration: 2000,
      delay: 1500,
      onComplete: () => splitGroup.destroy(),
    });
  }

  private createRipple(cx: number, cy: number, color: number): void {
    for (let i = 0; i < 3; i++) {
      const ring = this.add.graphics();
      ring.lineStyle(2, color, 0.6);
      ring.strokeCircle(cx, cy, 5);

      this.tweens.add({
        targets: ring,
        scaleX: 8 + i * 3,
        scaleY: 8 + i * 3,
        alpha: 0,
        duration: 1200,
        delay: i * 200,
        ease: 'Power2',
        onComplete: () => ring.destroy(),
      });
    }
  }

  // ── Event Animations ──────────────────────────────────

  private playEventAnimation(animation: string, cardLabel?: string): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;

    const config = EVENT_ANIM_CONFIGS[animation] || EVENT_ANIM_CONFIGS.generic_flash;
    const color = config.color;
    const label = cardLabel || getLocalizedLabel(config.label_en, config.label_zh);

    // Expanding ring effect
    const ring = this.add.graphics();
    ring.lineStyle(3, color, 1);
    ring.strokeCircle(cx, cy, 8);
    ring.setDepth(80);

    this.tweens.add({
      targets: ring,
      scaleX: 12,
      scaleY: 12,
      alpha: 0,
      duration: 1200,
      ease: 'Power2',
      onComplete: () => ring.destroy(),
    });

    // Secondary inner ring
    const ring2 = this.add.graphics();
    ring2.lineStyle(2, color, 0.6);
    ring2.strokeCircle(cx, cy, 5);
    ring2.setDepth(80);

    this.tweens.add({
      targets: ring2,
      scaleX: 8,
      scaleY: 8,
      alpha: 0,
      duration: 1000,
      delay: 200,
      ease: 'Power2',
      onComplete: () => ring2.destroy(),
    });

    // Particles burst
    const particleCount = animation === 'fire_spread' ? 20 : 12;
    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.PI * 2 * i) / particleCount;
      const dist = 60 + Math.random() * 80;
      const dot = this.add.graphics();
      dot.fillStyle(color, 0.9);
      dot.fillCircle(0, 0, 2 + Math.random() * 2);
      dot.setPosition(cx, cy);
      dot.setDepth(80);

      this.tweens.add({
        targets: dot,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0,
        duration: 600 + Math.random() * 600,
        ease: 'Power3',
        onComplete: () => dot.destroy(),
      });
    }

    // Overlay label
    if (label) {
      const labelText = this.add.text(cx, cy - 50, label, {
        fontSize: '16px',
        color: '#ffffff',
        fontFamily: 'monospace',
        fontStyle: 'bold',
        backgroundColor: 'rgba(0,0,0,0.6)',
        padding: { x: 12, y: 6 },
        stroke: `#${color.toString(16).padStart(6, '0')}`,
        strokeThickness: 1,
      }).setOrigin(0.5).setDepth(81);

      this.tweens.add({
        targets: labelText,
        y: labelText.y - 15,
        alpha: 0,
        duration: 2000,
        delay: 1000,
        ease: 'Power2',
        onComplete: () => labelText.destroy(),
      });
    }

    // Camera effects
    if (config.shake) {
      this.cameras.main.shake(800, config.shake);
    }
    if (config.flash) {
      const [r, g, b] = config.flash;
      this.cameras.main.flash(600, r, g, b, false, undefined, 0.3);
    } else if (!config.shake) {
      this.cameras.main.flash(300, 255, 255, 255, false, undefined, 0.15);
    }
  }

  // ── MiniMap HUD (Phase 3) ─────────────────────────────

  private drawMinimap(w: number, h: number): void {
    const mapW = 120;
    const mapH = 64;
    const padX = 12;
    const padY = 12;
    const x = w - mapW - padX;
    const y = h - mapH - padY;

    this.minimapContainer = this.add.container(x, y).setDepth(150);

    // Background — use current scene image as thumbnail
    const texKey = `scene_${this.sceneTheme}`;
    if (this.textures.exists(texKey)) {
      this.minimapSceneImg = this.add.image(mapW / 2, mapH / 2, texKey);
      this.minimapSceneImg.setDisplaySize(mapW, mapH);
      this.minimapSceneImg.setAlpha(0.7);
      this.minimapContainer.add(this.minimapSceneImg);
    } else {
      // Procedural gradient fallback using theme palette
      const palette = THEME_PALETTES[this.sceneTheme] || DEFAULT_PALETTE;
      this.minimapGradient = this.add.graphics();
      this.minimapGradient.fillGradientStyle(palette.sky1, palette.sky1, palette.sky2, palette.sky2, 0.7);
      this.minimapGradient.fillRect(0, 0, mapW, mapH * 0.6);
      this.minimapGradient.fillStyle(palette.ground, 0.7);
      this.minimapGradient.fillRect(0, mapH * 0.6, mapW, mapH * 0.4);
      this.minimapContainer.add(this.minimapGradient);
    }

    // Border
    const border = this.add.graphics();
    border.lineStyle(1, 0x6c5ce7, 0.5);
    border.strokeRoundedRect(0, 0, mapW, mapH, 4);
    this.minimapContainer.add(border);

    // Label
    const label = this.add.text(mapW / 2, 6, i18next.t('game.minimap_title'), {
      fontSize: '8px',
      color: '#aaaacc',
      fontFamily: 'monospace',
    }).setOrigin(0.5, 0);
    this.minimapContainer.add(label);

    // Dot canvas
    this.minimapBg = this.add.graphics();
    this.minimapContainer.add(this.minimapBg);
  }

  /** Update minimap background to reflect the current scene. */
  private updateMinimapScene(texKey: string, palette: typeof DEFAULT_PALETTE): void {
    if (!this.minimapContainer) return;
    const mapW = 120;
    const mapH = 64;

    // Remove old scene image / gradient
    if (this.minimapSceneImg) {
      this.minimapSceneImg.destroy();
      this.minimapSceneImg = null;
    }
    if (this.minimapGradient) {
      this.minimapGradient.destroy();
      this.minimapGradient = null;
    }

    if (this.textures.exists(texKey)) {
      this.minimapSceneImg = this.add.image(mapW / 2, mapH / 2, texKey);
      this.minimapSceneImg.setDisplaySize(mapW, mapH);
      this.minimapSceneImg.setAlpha(0.7);
      this.minimapContainer.addAt(this.minimapSceneImg, 0); // behind dots & label
    } else {
      this.minimapGradient = this.add.graphics();
      this.minimapGradient.fillGradientStyle(palette.sky1, palette.sky1, palette.sky2, palette.sky2, 0.7);
      this.minimapGradient.fillRect(0, 0, mapW, mapH * 0.6);
      this.minimapGradient.fillStyle(palette.ground, 0.7);
      this.minimapGradient.fillRect(0, mapH * 0.6, mapW, mapH * 0.4);
      this.minimapContainer.addAt(this.minimapGradient, 0);
    }
  }

  /** Update minimap dot for an agent. */
  private updateMinimapDot(agentId: string, worldX: number, worldY: number, faction?: string): void {
    if (!this.minimapContainer) return;
    const { width, height } = this.scale;
    const mapW = 120;
    const mapH = 64;

    // Scale world coordinates to minimap
    const dotX = (worldX / width) * (mapW - 8) + 4;
    const dotY = (worldY / height) * (mapH - 18) + 14; // offset for label

    const color = faction ? (FACTION_COLORS[faction] ?? FACTION_COLORS.unknown) : 0x6c5ce7;

    // Reuse or create dot
    let dot = this.minimapDots.get(agentId);
    if (dot) {
      dot.clear();
    } else {
      dot = this.add.graphics();
      this.minimapContainer.add(dot);
      this.minimapDots.set(agentId, dot);
    }
    dot.fillStyle(color, 0.9);
    dot.fillCircle(dotX, dotY, 2);
  }


  // ── Weather System (Phase 4: object pool) ─────────────

  /** Acquire a Graphics object from pool or create new one. */
  private acquireWeatherDot(): Phaser.GameObjects.Graphics {
    const pooled = this.weatherPool.pop();
    if (pooled && pooled.scene) {
      pooled.clear();
      pooled.setAlpha(1);
      pooled.setScale(1);
      pooled.setVisible(true);
      return pooled;
    }
    const dot = this.add.graphics();
    dot.setDepth(95);
    return dot;
  }

  /** Return a Graphics object to the pool (hide instead of destroy). */
  private releaseWeatherDot(dot: Phaser.GameObjects.Graphics): void {
    if (!dot.scene) return; // already destroyed externally
    dot.setVisible(false);
    dot.setPosition(-100, -100);
    if (this.weatherPool.length < WEATHER_POOL_SIZE) {
      this.weatherPool.push(dot);
    } else {
      dot.destroy();
    }
  }

  private setWeather(weatherType: string, intensity: number): void {
    if (weatherType === this.currentWeather) return;
    // Clear previous weather
    this.clearWeather();
    this.currentWeather = weatherType;
    if (weatherType === 'clear') return;

    const { width, height } = this.scale;
    const particleCount = Math.floor(intensity * 40);

    this.weatherTimer = this.time.addEvent({
      delay: weatherType === 'snow' ? 200 : 80,
      repeat: -1,
      callback: () => {
        for (let i = 0; i < particleCount; i++) {
          const dot = this.acquireWeatherDot();

          const startX = Math.random() * width;
          const startY = -5;

          switch (weatherType) {
            case 'rain': {
              dot.lineStyle(1, 0x6ec6ff, 0.5 + intensity * 0.3);
              dot.lineBetween(0, 0, -2, 8);
              dot.setPosition(startX, startY);
              this.tweens.add({
                targets: dot, y: height + 10, x: startX - 20,
                duration: 400 + Math.random() * 200,
                onComplete: () => this.releaseWeatherDot(dot),
              });
              break;
            }
            case 'snow': {
              dot.fillStyle(0xffffff, 0.6 + Math.random() * 0.3);
              dot.fillCircle(0, 0, 1.5 + Math.random() * 1.5);
              dot.setPosition(startX, startY);
              this.tweens.add({
                targets: dot,
                y: height + 10,
                x: startX + (Math.random() - 0.5) * 60,
                duration: 2000 + Math.random() * 1500,
                onComplete: () => this.releaseWeatherDot(dot),
              });
              break;
            }
            case 'sandstorm': {
              dot.fillStyle(0xd2b48c, 0.3 + intensity * 0.3);
              dot.fillCircle(0, 0, 1 + Math.random() * 2);
              dot.setPosition(-5, Math.random() * height);
              this.tweens.add({
                targets: dot,
                x: width + 10,
                y: dot.y + (Math.random() - 0.5) * 40,
                duration: 500 + Math.random() * 300,
                onComplete: () => this.releaseWeatherDot(dot),
              });
              break;
            }
            case 'thunder': {
              // Random lightning flash
              if (Math.random() < 0.02 * intensity) {
                this.cameras.main.flash(100, 255, 255, 255, false, undefined, 0.6);
                this.cameras.main.shake(200, 0.003);
              }
              // Plus rain
              dot.lineStyle(1, 0x4a90d9, 0.4);
              dot.lineBetween(0, 0, -2, 8);
              dot.setPosition(startX, startY);
              this.tweens.add({
                targets: dot, y: height + 10, x: startX - 20,
                duration: 350 + Math.random() * 200,
                onComplete: () => this.releaseWeatherDot(dot),
              });
              break;
            }
          }
          this.weatherParticles.push(dot);
        }
      },
    });

    // Sandstorm orange overlay
    if (weatherType === 'sandstorm') {
      const overlay = this.add.graphics();
      overlay.fillStyle(0xd2b48c, 0.12 * intensity);
      overlay.fillRect(0, 0, width, height);
      overlay.setDepth(94);
      this.weatherParticles.push(overlay);
    }

    console.log(`[WorldScene] Weather set to: ${weatherType} (intensity=${intensity})`);
  }

  private clearWeather(): void {
    if (this.weatherTimer) {
      this.weatherTimer.destroy();
      this.weatherTimer = null;
    }
    for (const p of this.weatherParticles) {
      if (p && !p.scene) continue; // already destroyed
      this.releaseWeatherDot(p);
    }
    this.weatherParticles = [];
    this.currentWeather = 'clear';
  }

  // ── Day/Night Lighting ────────────────────────────────

  private setTimeOfDay(phase: string): void {
    if (phase === this.currentTimeOfDay) return;
    this.currentTimeOfDay = phase;

    const { width, height } = this.scale;
    const tint = TIME_TINTS[phase] || TIME_TINTS.noon;

    if (this.lightingOverlay) {
      // Crossfade
      const old = this.lightingOverlay;
      this.tweens.add({
        targets: old, alpha: 0, duration: 800,
        onComplete: () => old.destroy(),
      });
    }

    if (tint.alpha > 0) {
      this.lightingOverlay = this.add.graphics();
      this.lightingOverlay.fillStyle(tint.color, tint.alpha);
      this.lightingOverlay.fillRect(0, 0, width, height);
      this.lightingOverlay.setDepth(93);
      this.lightingOverlay.setAlpha(0);
      this.tweens.add({
        targets: this.lightingOverlay, alpha: 1, duration: 800,
      });
    } else {
      this.lightingOverlay = null;
    }

    console.log(`[WorldScene] Time of day set to: ${phase}`);
  }

  // ── Cleanup ───────────────────────────────────────────

  shutdown(): void {
    // 1. Remove all EventBridge listeners
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // 2. Destroy agent GameObjects (containers, halo tweens) to prevent memory leak
    this.agentSprites.forEach((agentData) => {
      if (agentData.haloTween) {
        agentData.haloTween.stop();
        agentData.haloTween = undefined;
      }
      if (agentData.gameObject) {
        agentData.gameObject.destroy();
      }
    });
    this.agentSprites.clear();

    // 3. Destroy bubble containers
    this.bubbles.forEach((bubble) => bubble.destroy());
    this.bubbles.clear();

    // 4. Stop all scene tweens and timers to prevent post-shutdown callbacks
    this.tweens.killAll();
    this.time.removeAllEvents();

    // 5. Cleanup weather
    this.clearWeather();
    if (this.lightingOverlay) {
      this.lightingOverlay.destroy();
      this.lightingOverlay = null;
    }
    if (this.endingOverlay) {
      this.endingOverlay.destroy();
      this.endingOverlay = null;
    }

    // 5b. Phase 4: Destroy object pools
    for (const p of this.weatherPool) { if (p.scene) p.destroy(); }
    this.weatherPool = [];
    for (const m of this.ambientMotePool) { if (m.scene) m.destroy(); }
    this.ambientMotePool = [];

    // 5c. V3: Cleanup ambient motes
    if (this.ambientTimer) {
      this.ambientTimer.destroy();
      this.ambientTimer = null;
    }
    for (const m of this.ambientMotes) { if (m.scene) m.destroy(); }
    this.ambientMotes = [];
    for (const c of this.cloudGraphics) { if (c.scene) c.destroy(); }
    this.cloudGraphics = [];
    for (const t of this.terrainLayers) { if (t.scene) t.destroy(); }
    this.terrainLayers = [];

    // 6. Phase 3: cleanup minimap (destroy dots before clearing)
    this.minimapDots.forEach((dot) => dot.destroy());
    this.minimapDots.clear();
    if (this.minimapSceneImg) { this.minimapSceneImg.destroy(); this.minimapSceneImg = null; }
    if (this.minimapGradient) { this.minimapGradient.destroy(); this.minimapGradient = null; }
    if (this.minimapContainer) {
      this.minimapContainer.destroy();
      this.minimapContainer = null;
    }
    this.minimapBg = null;

    // 7–8. Phase 3 Batch 2: bet panel & leaderboard — now in React HudOverlay

    // 9. Unhook from Phaser lifecycle to prevent double-fire
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);

    console.log('[WorldScene] Shutdown: all resources cleaned up');
  }
}
