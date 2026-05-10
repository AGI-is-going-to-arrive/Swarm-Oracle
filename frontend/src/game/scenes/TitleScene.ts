/**
 * TitleScene — Premium pixel art title screen.
 *
 * V3.0: Full visual overhaul with particle systems, animated title,
 * parallax starfield, and atmospheric effects. Auto-transitions to
 * WorldScene after the intro sequence completes.
 */
import Phaser from 'phaser';
import i18next from 'i18next';

// ── Color Palette (unified GBC-inspired) ──────────────────
const PALETTE = {
  deepSpace:     0x06061a,
  nebulaDark:    0x0d0d2b,
  nebulaAccent:  0x1a1a4e,
  nebulaBright:  0x2d1b69,
  starGold:      0xffd700,
  starWhite:     0xe8e4f0,
  accentPurple:  0x9b59ff,
  accentCyan:    0x00e5ff,
  textGold:      '#ffd700',
  textSilver:    '#c0c0dd',
  textDim:       '#6a6a9a',
};

// ── Particle configuration ────────────────────────────────
const STAR_LAYERS = [
  { count: 40, sizeMin: 0.3, sizeMax: 0.8, speedMin: 0.05, speedMax: 0.15, alpha: 0.4 },  // far
  { count: 25, sizeMin: 0.8, sizeMax: 1.5, speedMin: 0.2,  speedMax: 0.5,  alpha: 0.6 },  // mid
  { count: 10, sizeMin: 1.5, sizeMax: 2.5, speedMin: 0.5,  speedMax: 1.0,  alpha: 0.8 },  // near
];

export class TitleScene extends Phaser.Scene {
  private particles: Phaser.GameObjects.Graphics[] = [];
  private nebulaOverlay: Phaser.GameObjects.Graphics | null = null;
  private canSkip = false;
  private isTransitioning = false;
  // Accessibility: skip decorative motion when user prefers reduced motion
  private reducedMotion = false;

  constructor() {
    super({ key: 'TitleScene' });
  }

  public getAutomationState(): Record<string, unknown> {
    return {
      scene: 'TitleScene',
      can_skip: this.canSkip,
      is_transitioning: this.isTransitioning,
      language: i18next.language,
      title: 'SwarmOracle',
      auto_transition_ms: 4000,
    };
  }

  create(): void {
    // Detect reduced-motion preference (skip decorative atmospheric effects)
    this.reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const { width, height } = this.scale;

    // ── 1. Deep space background with nebula gradient ─────
    this.createNebulaBackground(width, height);

    // ── 2. Parallax starfield (3 layers) ─────────────────
    this.createStarfield(width, height);

    // ── 3. Nebula cloud overlay (subtle animated opacity) ─
    this.createNebulaOverlay(width, height);

    // ── 4. Animated title with letter-by-letter reveal ───
    this.createAnimatedTitle(width, height);

    // ── 5. Floating orbs (ambient particles) ────────────
    this.createFloatingOrbs(width, height);

    // ── 6. Bottom scan line effect ──────────────────────
    this.createScanLines(width, height);

    // ── 7. Shimmer scanline (atmospheric light sweep) ────
    this.createShimmerScanline(width, height);

    // ── 8. Auto-transition sequence (click to skip) ──────
    if (this.reducedMotion) {
      this.cameras.main.setAlpha(1);
    } else {
      this.cameras.main.fadeIn(800, 0, 0, 0);
    }

    // Reduced motion users should not wait on the decorative title reveal.
    if (this.reducedMotion) {
      this.canSkip = true;
    } else {
      this.time.delayedCall(1500, () => { this.canSkip = true; });
    }

    // Click/tap to skip
    this.input.on('pointerdown', () => {
      if (this.canSkip && !this.isTransitioning) {
        this.doTransition();
      }
    });

    // Auto-transition fallback after 4s
    this.time.delayedCall(4000, () => {
      if (!this.isTransitioning) {
        this.doTransition();
      }
    });

    console.log('[TitleScene] V3.1 title screen — click to skip or auto-transition in 4s');
  }

  // ── Background Gradient ───────────────────────────────
  private createNebulaBackground(w: number, h: number): void {
    const bg = this.add.graphics();
    // Three-layer gradient: deep space → nebula → space
    bg.fillGradientStyle(
      PALETTE.deepSpace, PALETTE.deepSpace,
      PALETTE.nebulaDark, PALETTE.nebulaAccent,
      1,
    );
    bg.fillRect(0, 0, w, h);

    // Secondary gradient overlay for depth
    const overlay = this.add.graphics();
    overlay.fillStyle(PALETTE.nebulaBright, 0.08);
    overlay.fillEllipse(w * 0.3, h * 0.4, w * 0.8, h * 0.6);
    overlay.fillStyle(PALETTE.accentPurple, 0.04);
    overlay.fillEllipse(w * 0.7, h * 0.6, w * 0.5, h * 0.4);
    overlay.setDepth(1);
  }

  // ── Parallax Starfield ────────────────────────────────
  private createStarfield(w: number, h: number): void {
    for (const layer of STAR_LAYERS) {
      for (let i = 0; i < layer.count; i++) {
        const star = this.add.graphics();
        const size = layer.sizeMin + Math.random() * (layer.sizeMax - layer.sizeMin);
        const brightness = 0.5 + Math.random() * 0.5;

        // Star core
        star.fillStyle(PALETTE.starWhite, layer.alpha * brightness);
        star.fillCircle(0, 0, size);

        // Subtle glow for larger stars
        if (size > 1.2) {
          star.fillStyle(PALETTE.accentCyan, 0.15 * brightness);
          star.fillCircle(0, 0, size * 2.5);
        }

        const x = Math.random() * w;
        const y = Math.random() * h;
        star.setPosition(x, y);
        star.setDepth(2);

        // Twinkling animation — phase-shifted (decorative — skip under reduced motion)
        if (!this.reducedMotion) {
          this.tweens.add({
            targets: star,
            alpha: layer.alpha * 0.2,
            duration: 1500 + Math.random() * 3000,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
            delay: Math.random() * 2500,
          });

          // Slow parallax drift (decorative)
          if (layer.speedMax > 0.1) {
            this.tweens.add({
              targets: star,
              y: y + (10 + Math.random() * 20) * layer.speedMax,
              x: x + (Math.random() - 0.5) * 8,
              duration: 8000 + Math.random() * 4000,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.easeInOut',
            });
          }
        }

        this.particles.push(star);
      }
    }
  }

  // ── Nebula Overlay ────────────────────────────────────
  private createNebulaOverlay(w: number, h: number): void {
    this.nebulaOverlay = this.add.graphics();
    // Soft radial gradient effect
    this.nebulaOverlay.fillStyle(PALETTE.accentPurple, 0.06);
    this.nebulaOverlay.fillEllipse(w * 0.5, h * 0.35, w * 1.2, h * 0.5);
    this.nebulaOverlay.setDepth(3);

    // Decorative pulse — skip under reduced motion
    if (!this.reducedMotion) {
      this.tweens.add({
        targets: this.nebulaOverlay,
        alpha: 0.4,
        scaleX: 1.05,
        scaleY: 1.05,
        duration: 6000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  // ── Animated Title ────────────────────────────────────
  private createAnimatedTitle(w: number, h: number): void {
    const titleStr = 'SwarmOracle';
    const letters = titleStr.split('');
    const charWidth = 24; // approximate width per character at 32px
    const totalWidth = letters.length * charWidth;
    const startX = (w - totalWidth) / 2 + charWidth / 2;

    // Letter-by-letter reveal with bounce
    letters.forEach((char, i) => {
      const letter = this.add.text(startX + i * charWidth, h * 0.33, char, {
        fontSize: '32px',
        color: PALETTE.textGold,
        fontFamily: 'monospace',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3,
        shadow: {
          offsetX: 0, offsetY: 0,
          color: '#ffd700', blur: 8, fill: false, stroke: true,
        },
      }).setOrigin(0.5).setDepth(20);

      // Title must remain readable — under reduced motion show letters instantly
      if (this.reducedMotion) {
        letter.setAlpha(1).setScale(1);
      } else {
        letter.setAlpha(0).setScale(0.3);
        // Bounce-in animation with stagger
        this.tweens.add({
          targets: letter,
          alpha: 1,
          scaleX: 1,
          scaleY: 1,
          y: h * 0.33,
          duration: 400,
          delay: 200 + i * 80,
          ease: 'Back.easeOut',
        });

        // After reveal: gentle floating animation (decorative)
        this.time.delayedCall(200 + i * 80 + 500, () => {
          this.tweens.add({
            targets: letter,
            y: letter.y - 3 + Math.sin(i * 0.8) * 2,
            duration: 2000 + Math.random() * 500,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
            delay: i * 100,
          });
        });
      }
    });

    // Subtitle — typewriter effect (appears after title animation)
    const subtitle = i18next.language === 'en'
      ? 'Micro AI Civilization Simulator'
      : '微型 AI 文明推演器';

    const subtitleText = this.add.text(w / 2, h * 0.44, '', {
      fontSize: '11px',
      color: PALETTE.textSilver,
      fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20).setAlpha(0);

    // Typewriter cursor character
    const cursor = this.add.text(w / 2, h * 0.44, '▊', {
      fontSize: '11px',
      color: PALETTE.textGold,
      fontFamily: 'monospace',
    }).setOrigin(0, 0.5).setDepth(20).setAlpha(0);

    const typewriterDelay = 200 + letters.length * 80 + 300;
    let charIdx = 0;

    if (this.reducedMotion) {
      subtitleText.setAlpha(1);
      subtitleText.setText(subtitle);
      cursor.setAlpha(0);
    } else {
      this.time.delayedCall(typewriterDelay, () => {
        subtitleText.setAlpha(1);

        cursor.setAlpha(1);

        // Cursor blink
        this.tweens.add({
          targets: cursor,
          alpha: 0,
          duration: 400,
          yoyo: true,
          repeat: -1,
          ease: 'Stepped',
        });

        // Reveal one character at a time
        this.time.addEvent({
          delay: i18next.language === 'en' ? 50 : 80,
          repeat: subtitle.length - 1,
          callback: () => {
            charIdx++;
            subtitleText.setText(subtitle.slice(0, charIdx));
            // Reposition cursor after text
            const bounds = subtitleText.getBounds();
            cursor.setX(bounds.right + 2);
          },
          callbackScope: this,
        });

        // Hide cursor after typing completes
        this.time.delayedCall(
          (i18next.language === 'en' ? 50 : 80) * subtitle.length + 600,
          () => {
            this.tweens.killTweensOf(cursor);
            this.tweens.add({ targets: cursor, alpha: 0, duration: 300 });
          },
        );
      });
    }

    // Decorative line under subtitle
    const lineWidth = 120;
    const lineY = h * 0.49;
    const lineLeft = this.add.graphics().setDepth(20);
    lineLeft.fillGradientStyle(0x000000, PALETTE.accentPurple, 0x000000, PALETTE.accentPurple, 0, 1, 0, 1);
    lineLeft.fillRect(w / 2 - lineWidth, lineY, lineWidth, 1);

    const lineRight = this.add.graphics().setDepth(20);
    lineRight.fillGradientStyle(PALETTE.accentPurple, 0x000000, PALETTE.accentPurple, 0x000000, 1, 0, 1, 0);
    lineRight.fillRect(w / 2, lineY, lineWidth, 1);

    if (this.reducedMotion) {
      lineLeft.setAlpha(0.7);
      lineRight.setAlpha(0.7);
    } else {
      lineLeft.setAlpha(0);
      lineRight.setAlpha(0);
      this.tweens.add({
        targets: [lineLeft, lineRight],
        alpha: 0.7,
        duration: 600,
        delay: 200 + letters.length * 80 + 600,
        ease: 'Power2',
      });
    }

    // Loading indicator
    const loadingStr = i18next.language === 'en'
      ? '◈ Initializing World ◈'
      : '◈ 世界初始化中 ◈';
    const loadingText = this.add.text(w / 2, h * 0.82, loadingStr, {
      fontSize: '10px',
      color: PALETTE.textDim,
      fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);

    if (this.reducedMotion) {
      // Loading hint must remain visible — show without fade/pulse
      loadingText.setAlpha(1);
    } else {
      loadingText.setAlpha(0);
      this.tweens.add({
        targets: loadingText,
        alpha: 1,
        duration: 500,
        delay: 2000,
        ease: 'Power2',
        onComplete: () => {
          // Pulse after appearing (decorative)
          this.tweens.add({
            targets: loadingText,
            alpha: 0.3,
            duration: 700,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          });
        },
      });
    }

    // Version tag
    this.add.text(w - 8, h - 8, 'v3.0', {
      fontSize: '8px',
      color: '#333355',
      fontFamily: 'monospace',
    }).setOrigin(1, 1).setDepth(20);
  }

  // ── Floating Orbs (ambient particles) ─────────────────
  private createFloatingOrbs(w: number, h: number): void {
    // Floating orbs are purely decorative — skip entirely under reduced motion
    if (this.reducedMotion) return;

    const orbColors = [PALETTE.accentPurple, PALETTE.accentCyan, PALETTE.starGold];

    for (let i = 0; i < 8; i++) {
      const orb = this.add.graphics();
      const color = orbColors[i % orbColors.length];
      const size = 3 + Math.random() * 5;

      // Soft glow circle
      orb.fillStyle(color, 0.08);
      orb.fillCircle(0, 0, size * 4);
      orb.fillStyle(color, 0.15);
      orb.fillCircle(0, 0, size * 2);
      orb.fillStyle(color, 0.3);
      orb.fillCircle(0, 0, size);

      const x = Math.random() * w;
      const y = h * 0.2 + Math.random() * h * 0.6;
      orb.setPosition(x, y);
      orb.setDepth(4);

      // Slow floating path
      this.tweens.add({
        targets: orb,
        x: x + (Math.random() - 0.5) * 80,
        y: y + (Math.random() - 0.5) * 40,
        alpha: 0.3 + Math.random() * 0.3,
        duration: 5000 + Math.random() * 5000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: Math.random() * 3000,
      });

      this.particles.push(orb);
    }
  }

  // ── Scan Lines (CRT effect) ───────────────────────────
  private createScanLines(w: number, h: number): void {
    const scanlines = this.add.graphics();
    scanlines.setDepth(50);
    scanlines.setAlpha(0.03);

    for (let y = 0; y < h; y += 3) {
      scanlines.fillStyle(0x000000, 1);
      scanlines.fillRect(0, y, w, 1);
    }
  }

  // ── Shimmer Scanline (moving bright line) ─────────────
  private createShimmerScanline(w: number, h: number): void {
    // Shimmer sweep is purely decorative — skip entirely under reduced motion
    if (this.reducedMotion) return;

    const shimmer = this.add.graphics();
    shimmer.setDepth(45);
    shimmer.setAlpha(0);

    // Draw a thin horizontal gradient line
    shimmer.fillStyle(0xffffff, 0.08);
    shimmer.fillRect(0, -1, w, 1);
    shimmer.fillStyle(0xffffff, 0.15);
    shimmer.fillRect(0, 0, w, 1);
    shimmer.fillStyle(0xffffff, 0.08);
    shimmer.fillRect(0, 1, w, 1);

    // Sweep from top to bottom every ~5 seconds
    shimmer.setPosition(0, -3);
    this.tweens.add({
      targets: shimmer,
      y: h + 3,
      duration: 3000,
      delay: 1000,
      repeat: -1,
      repeatDelay: 4000,
      ease: 'Sine.easeInOut',
    });

    // Fade in when moving
    this.tweens.add({
      targets: shimmer,
      alpha: 1,
      duration: 500,
      delay: 1000,
    });
  }

  // ── Transition to WorldScene ──────────────────────────
  private doTransition(): void {
    this.isTransitioning = true;
    if (this.reducedMotion) {
      this.cleanup();
      this.scene.start('WorldScene');
      return;
    }

    this.cameras.main.fadeOut(600, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.cleanup();
      this.scene.start('WorldScene');
    });
  }

  // ── Cleanup ───────────────────────────────────────────
  private cleanup(): void {
    this.tweens.killAll();
    this.particles = [];
    this.nebulaOverlay = null;
  }
}
