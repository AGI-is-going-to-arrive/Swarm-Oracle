/**
 * EndingScene — Premium ending presentation (V3.0).
 *
 * Displays one of 6 pixel art endings with cinematic transitions:
 *   prosperity, peace, war, ruin, tyranny, revolution
 *
 * V3.0 Enhancements:
 *   - Dynamic particle system matched to ending type
 *   - Vignette overlay for cinematic feel
 *   - Animated divider with glow pulse
 *   - Enhanced card with glassmorphism-style background
 *   - Return hint with localization
 */
import Phaser from 'phaser';
import i18next from 'i18next';
import { getEndingTextureRequest } from '../sceneAssetPlan';

/** Maps ending_type (positive/negative/neutral) → specific ending_id. */
const ENDING_TYPE_MAP: Record<string, string[]> = {
  positive: ['prosperity', 'peace'],
  negative: ['war', 'ruin', 'tyranny'],
  neutral:  ['revolution'],
};

/** Visual config per ending. */
const ENDING_CONFIGS: Record<string, {
  textureKey: string;
  i18nKey: string;
  particleColor: number;
  particleColor2: number;
  accentColor: number;
  bgTint: number;
  icon: string;
}> = {
  prosperity: {
    textureKey: 'ending_prosperity',
    i18nKey: 'game.ending_prosperity',
    particleColor: 0xffd700,
    particleColor2: 0xffec8b,
    accentColor: 0x00ff7f,
    bgTint: 0x0a1a0a,
    icon: '🌟',
  },
  peace: {
    textureKey: 'ending_peace',
    i18nKey: 'game.ending_peace',
    particleColor: 0x87ceeb,
    particleColor2: 0xb0e0e6,
    accentColor: 0x4fc3f7,
    bgTint: 0x0a0a1a,
    icon: '🕊️',
  },
  war: {
    textureKey: 'ending_war',
    i18nKey: 'game.ending_war',
    particleColor: 0xff4500,
    particleColor2: 0xff6347,
    accentColor: 0xff4444,
    bgTint: 0x1a0a0a,
    icon: '⚔️',
  },
  ruin: {
    textureKey: 'ending_ruin',
    i18nKey: 'game.ending_ruin',
    particleColor: 0x8b4513,
    particleColor2: 0xa0522d,
    accentColor: 0x999999,
    bgTint: 0x0a0a0a,
    icon: '💀',
  },
  tyranny: {
    textureKey: 'ending_tyranny',
    i18nKey: 'game.ending_tyranny',
    particleColor: 0x4b0082,
    particleColor2: 0x7b2fbe,
    accentColor: 0x9c27b0,
    bgTint: 0x0a0510,
    icon: '👑',
  },
  revolution: {
    textureKey: 'ending_revolution',
    i18nKey: 'game.ending_revolution',
    particleColor: 0xff6347,
    particleColor2: 0xffa500,
    accentColor: 0xff8c00,
    bgTint: 0x1a0d05,
    icon: '✊',
  },
};

/** All valid ending IDs. */
const ALL_ENDINGS = Object.keys(ENDING_CONFIGS);

export interface EndingSceneData {
  ending_type: string;   // 'positive' | 'negative' | 'neutral'
  title?: string;
  story_summary?: string;
  ending_id?: string;    // Direct ending ID override
}

export class EndingScene extends Phaser.Scene {
  private particleTimer: Phaser.Time.TimerEvent | null = null;
  private returnTimer: Phaser.Time.TimerEvent | null = null;
  private currentEndingId = 'revolution';
  private currentTitle = '';
  private currentStorySummary = '';
  private backgroundImage: Phaser.GameObjects.Image | null = null;
  private pendingEndingTextureLoads: Set<string> = new Set();
  // Accessibility: skip decorative motion when user prefers reduced motion
  private reducedMotion = false;

  constructor() {
    super({ key: 'EndingScene' });
  }

  public getAutomationState(): Record<string, unknown> {
    return {
      scene: 'EndingScene',
      ending_id: this.currentEndingId,
      title: this.currentTitle,
      story_summary: this.currentStorySummary,
    };
  }

  create(data: EndingSceneData): void {
    // Detect reduced-motion preference (skip decorative cinematic effects)
    this.reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const { width, height } = this.scale;

    // Resolve which ending to show
    const endingId = this.resolveEndingId(data);
    const config = ENDING_CONFIGS[endingId] || ENDING_CONFIGS.revolution;
    this.currentEndingId = endingId;

    // ── 1. Tinted backdrop ──────────────────────────────
    const backdrop = this.add.graphics();
    backdrop.fillStyle(config.bgTint, 1);
    backdrop.fillRect(0, 0, width, height);
    backdrop.setDepth(0);

    // ── 2. Ending background image ──────────────────────
    if (this.textures.exists(config.textureKey)) {
      this.attachEndingBackground(config.textureKey, width, height);
    } else {
      this.ensureEndingTextureLoaded(endingId, () => {
        if (!this.sys.isActive() || this.currentEndingId !== endingId) return;
        this.attachEndingBackground(config.textureKey, width, height);
      });
    }

    // ── 3. Vignette overlay for cinematic feel ──────────
    const vignette = this.add.graphics();
    vignette.setDepth(2);
    // Radial darkening from edges
    const vignetteRadius = Math.max(width, height) * 0.7;
    for (let i = 8; i >= 0; i--) {
      const r = vignetteRadius * (1 + i * 0.12);
      const alpha = 0.02 * (i + 1);
      vignette.fillStyle(0x000000, alpha);
      vignette.fillCircle(width / 2, height / 2, r);
    }
    // Edge darkening
    vignette.fillStyle(0x000000, 0.4);
    vignette.fillRect(0, 0, width, 40);  // top
    vignette.fillRect(0, height - 40, width, 40);  // bottom

    // ── 4. Story card overlay ───────────────────────────
    const cardContainer = this.add.container(width / 2, height / 2).setDepth(10);
    cardContainer.setAlpha(0);

    const cardW = Math.min(width * 0.78, 420);
    const cardH = Math.min(height * 0.52, 280);

    // Glassmorphism card background
    const cardBg = this.add.graphics();
    // Shadow layer
    cardBg.fillStyle(0x000000, 0.3);
    cardBg.fillRoundedRect(-cardW / 2 + 3, -cardH / 2 + 3, cardW, cardH, 12);
    // Main background
    cardBg.fillStyle(0x0a0a1e, 0.85);
    cardBg.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 12);
    // Accent border
    cardBg.lineStyle(1.5, config.accentColor, 0.7);
    cardBg.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 12);
    // Inner glow line at top
    cardBg.fillStyle(config.accentColor, 0.15);
    cardBg.fillRoundedRect(-cardW / 2 + 1, -cardH / 2 + 1, cardW - 2, 3, { tl: 12, tr: 12, bl: 0, br: 0 });
    cardContainer.add(cardBg);

    // Ending title
    const titleStr = data.title
      || `${config.icon} ${i18next.t(config.i18nKey)}`;
    this.currentTitle = titleStr;
    const titleText = this.add.text(0, -cardH / 2 + 32, titleStr, {
      fontSize: '18px',
      color: '#ffffff',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: cardW - 40 },
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5);
    cardContainer.add(titleText);

    // Animated divider with glow
    const dividerY = -cardH / 2 + 60;
    const divider = this.add.graphics();
    const dividerGradientW = cardW - 40;
    divider.fillStyle(config.accentColor, 0.6);
    divider.fillRect(-dividerGradientW / 2, dividerY, dividerGradientW, 1);
    // Glow dots at ends
    divider.fillStyle(config.accentColor, 0.8);
    divider.fillCircle(-dividerGradientW / 2, dividerY, 2);
    divider.fillCircle(dividerGradientW / 2, dividerY, 2);
    cardContainer.add(divider);

    // Divider pulse (decorative — skip under reduced motion)
    if (!this.reducedMotion) {
      this.tweens.add({
        targets: divider,
        alpha: 0.4,
        duration: 1500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Story text
    const storyStr = data.story_summary
      || (i18next.language === 'en' ? '(No description)' : '(无描述)');
    this.currentStorySummary = storyStr;
    const storyText = this.add.text(0, 15, storyStr, {
      fontSize: '10px',
      color: '#ccccdd',
      fontFamily: 'monospace',
      wordWrap: { width: cardW - 40 },
      lineSpacing: 5,
      align: 'center',
    }).setOrigin(0.5);
    cardContainer.add(storyText);

    // Return hint at bottom of card
    const returnHint = i18next.language === 'en'
      ? '▸ Click or wait to return ◂'
      : '▸ 点击或等待自动返回 ◂';
    const hintText = this.add.text(0, cardH / 2 - 18, returnHint, {
      fontSize: '8px',
      color: '#666688',
      fontFamily: 'monospace',
    }).setOrigin(0.5);
    cardContainer.add(hintText);

    // Hint pulsing (decorative — skip under reduced motion)
    if (!this.reducedMotion) {
      this.tweens.add({
        targets: hintText,
        alpha: 0.3,
        duration: 1000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Animate card entrance (instant under reduced motion — card must appear)
    if (this.reducedMotion) {
      cardContainer.setScale(1);
      cardContainer.setAlpha(1);
      cardContainer.y = height / 2;
    } else {
      cardContainer.setScale(0.7);
      cardContainer.y = height / 2 + 20;
      this.tweens.add({
        targets: cardContainer,
        alpha: 1,
        scaleX: 1,
        scaleY: 1,
        y: height / 2,
        duration: 900,
        ease: 'Back.easeOut',
        delay: 1500,
      });
    }

    // ── 5. Dual-color particle effects (decorative — skip under reduced motion) ──
    if (!this.reducedMotion) {
      this.particleTimer = this.time.addEvent({
        delay: 120,
        repeat: -1,
        callback: () => this.emitParticle(width, height, config),
      });

      // ── 6. Initial burst particles ──────────────────────
      this.time.delayedCall(1800, () => {
        for (let i = 0; i < 20; i++) {
          this.emitBurstParticle(width / 2, height / 2, config.accentColor);
        }
      });
    }

    // ── 7. Auto-return ──────────────────────────────────
    this.input.once('pointerdown', () => this.returnToWorld());
    this.input.keyboard?.once('keydown', () => this.returnToWorld());

    this.returnTimer = this.time.delayedCall(8000, () => {
      this.returnToWorld();
    });

    // Avoid camera fade animations when the user requests reduced motion.
    if (this.reducedMotion) {
      this.cameras.main.setAlpha(1);
    } else {
      this.cameras.main.fadeIn(800, 0, 0, 0);
    }

    console.log(`[EndingScene] V3 showing ending: ${endingId}`);
  }

  private attachEndingBackground(textureKey: string, width: number, height: number): void {
    if (this.backgroundImage) {
      this.backgroundImage.destroy();
      this.backgroundImage = null;
    }

    this.backgroundImage = this.add.image(width / 2, height / 2, textureKey);
    this.backgroundImage.setDisplaySize(width, height);
    this.backgroundImage.setDepth(1);

    // Background must remain visible — under reduced motion show final state immediately
    if (this.reducedMotion) {
      this.backgroundImage.setAlpha(0.85);
      this.backgroundImage.setScale(1.0);
    } else {
      this.backgroundImage.setAlpha(0);
      this.backgroundImage.setScale(1.05);
      this.tweens.add({
        targets: this.backgroundImage,
        alpha: 0.85,
        scaleX: 1.0,
        scaleY: 1.0,
        duration: 3000,
        ease: 'Power2',
        delay: 400,
      });
    }
  }

  private ensureEndingTextureLoaded(endingId: string, onReady?: () => void): void {
    const request = getEndingTextureRequest(endingId);
    if (!request) return;
    if (this.textures.exists(request.textureKey)) {
      onReady?.();
      return;
    }
    if (this.pendingEndingTextureLoads.has(request.textureKey)) {
      return;
    }

    this.pendingEndingTextureLoads.add(request.textureKey);

    const cleanup = () => {
      this.pendingEndingTextureLoads.delete(request.textureKey);
      this.load.off(`filecomplete-image-${request.textureKey}`, handleFileComplete);
      this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    };

    const handleFileComplete = () => {
      cleanup();
      onReady?.();
    };

    const handleLoadError = (file: Phaser.Loader.File) => {
      if (file.key !== request.textureKey) return;
      cleanup();
    };

    this.load.once(`filecomplete-image-${request.textureKey}`, handleFileComplete);
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, handleLoadError);
    this.load.image(request.textureKey, request.assetPath);
    if (!this.load.isLoading()) {
      this.load.start();
    }
  }

  /** Resolve ending_type → specific ending_id. */
  private resolveEndingId(data: EndingSceneData): string {
    if (data.ending_id && ALL_ENDINGS.includes(data.ending_id)) {
      return data.ending_id;
    }
    const candidates = ENDING_TYPE_MAP[data.ending_type] || ENDING_TYPE_MAP.neutral;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Emit a single decorative particle (dual-color system). */
  private emitParticle(w: number, h: number, config: { particleColor: number; particleColor2: number }): void {
    const dot = this.add.graphics();
    dot.setDepth(5);

    const useAlt = Math.random() > 0.6;
    const color = useAlt ? config.particleColor2 : config.particleColor;
    const size = 1 + Math.random() * 2.5;

    dot.fillStyle(color, 0.5 + Math.random() * 0.4);
    dot.fillCircle(0, 0, size);
    // Glow for larger particles
    if (size > 2) {
      dot.fillStyle(color, 0.15);
      dot.fillCircle(0, 0, size * 2.5);
    }

    const startX = Math.random() * w;
    dot.setPosition(startX, h + 5);

    this.tweens.add({
      targets: dot,
      y: -10,
      x: startX + (Math.random() - 0.5) * 100,
      alpha: 0,
      scaleX: 0.3,
      scaleY: 0.3,
      duration: 2200 + Math.random() * 1800,
      ease: 'Sine.easeOut',
      onComplete: () => dot.destroy(),
    });
  }

  /** Burst particle from a center point. */
  private emitBurstParticle(cx: number, cy: number, color: number): void {
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 80;
    const dot = this.add.graphics();
    dot.setDepth(8);
    dot.fillStyle(color, 0.7);
    dot.fillCircle(0, 0, 1.5 + Math.random() * 1.5);
    dot.setPosition(cx, cy);

    this.tweens.add({
      targets: dot,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      alpha: 0,
      duration: 600 + Math.random() * 400,
      ease: 'Power3',
      onComplete: () => dot.destroy(),
    });
  }

  /** Fade out and return to WorldScene. */
  private returnToWorld(): void {
    if (this.returnTimer) {
      this.returnTimer.destroy();
      this.returnTimer = null;
    }
    if (this.particleTimer) {
      this.particleTimer.destroy();
      this.particleTimer = null;
    }

    if (this.reducedMotion) {
      this.scene.start('WorldScene');
    } else {
      this.cameras.main.fadeOut(800, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.start('WorldScene');
      });
    }
  }
}
