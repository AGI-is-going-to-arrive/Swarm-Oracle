import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readCss(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('legacy CSS color fallbacks', () => {
  it('declares sRGB fallback tokens before OKLCH globals', () => {
    const css = readCss('src/index.css');

    expect(css).toMatch(/--color-primary:\s*#c61583;[\s\S]*?--color-primary:\s*oklch\(55% 0\.22 350\);/);
    expect(css).toMatch(/--bg-base:\s*#faf8f5;[\s\S]*?--bg-base:\s*oklch\(98% 0\.005 80\);/);
    expect(css).toMatch(/--oracle-bg-dark:\s*#080503;[\s\S]*?--oracle-bg-dark:\s*oklch\(12% 0\.01 60\);/);
    expect(css).toMatch(/--action-band-bg:\s*#faf5f6;[\s\S]*?--action-band-bg:\s*color-mix\(in oklab, var\(--color-primary\) 3%, var\(--bg-surface\)\);/);
  });

  it('keeps result page critical surfaces readable without color-mix support', () => {
    const css = readCss('src/pages/ResultView.css');

    expect(css).toMatch(/\.insight-quote\s*\{[\s\S]*?background:\s*#faf5f6;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-primary\) 3%, var\(--bg-surface\)\);/);
    expect(css).toMatch(/\.ending-room-picker-overlay\s*\{[\s\S]*?background:\s*rgba\(15, 12, 10, 0\.84\);[\s\S]*?background:\s*color-mix\(in oklab, var\(--bg-overlay\) 84%, black\);/);
    expect(css).toMatch(/\.archive-chip--primary\s*\{[\s\S]*?background:\s*#f6daeb;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-primary\) 16%, white\);/);
  });

  it('keeps simulation header surfaces readable without OKLCH mixing', () => {
    const css = readCss('src/pages/SimulationView.css');

    expect(css).toMatch(/\.sim-header\s*\{[\s\S]*?background:\s*linear-gradient\(180deg, #faf9f6, #faf8f5\);/);
    expect(css).toMatch(/@keyframes subtlePulse\s*\{[\s\S]*?box-shadow:\s*0 0 0 0 rgba\(198, 21, 131, 0\.3\);/);
    expect(css).not.toContain('oklch(');
    expect(css).not.toContain('color-mix(');
  });

  it('declares worldline oracle skin fallbacks before OKLCH overrides', () => {
    const css = readCss('src/pages/WorldlineRoundtable.css');

    expect(css).toMatch(/\.worldline-roundtable-view\.oracle-skin\s*\{[\s\S]*?--oracle-accent:\s*#a35e16;[\s\S]*?--oracle-accent:\s*oklch\(55% 0\.12 60\);/);
    expect(css).toMatch(/\.worldline-roundtable-view\.oracle-skin--law\s*\{[\s\S]*?--oracle-accent:\s*#0465af;[\s\S]*?--oracle-accent:\s*oklch\(50% 0\.14 250\);/);
    expect(css).toMatch(/\.worldline-roundtable-view \.archive-chip--profile\s*\{[\s\S]*?background:\s*#f3ece3;[\s\S]*?background:\s*color-mix\(in oklab, var\(--oracle-accent\) 10%, var\(--bg-surface\)\);/);
  });

  it('keeps prediction advanced disclosure readable without color-mix support', () => {
    const css = readCss('src/components/PredictionModal.css');

    expect(css).toMatch(/\.pred-advanced__toggle:hover:not\(:disabled\),[\s\S]*?\.pred-advanced__toggle:focus-visible:not\(:disabled\)\s*\{[\s\S]*?background:\s*#fff4fa;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-primary\) 8%, var\(--bg-elevated\)\);/);
    expect(css).toMatch(/\.pred-advanced__body\s*\{[\s\S]*?background:\s*#f7f4f6;[\s\S]*?background:\s*color-mix\(in oklab, var\(--bg-elevated\) 92%, var\(--text-muted\) 8%\);/);
  });

  it('keeps gameplay cards modal v2 surfaces readable without color-mix support', () => {
    const css = readCss('src/components/GameplayCardsModal.css');

    expect(css).toMatch(/\.gameplay-modal-v2__section--primary\s*\{[\s\S]*?border:\s*1px solid rgba\(198, 21, 131, 0\.22\);[\s\S]*?border:\s*1px solid color-mix\(in oklab, var\(--color-primary\) 22%, var\(--border-default\)\);/);
    expect(css).toMatch(/\.gameplay-card-v2--selected\s*\{[\s\S]*?background:\s*linear-gradient\(180deg, #fff4fa, var\(--bg-surface\)\);[\s\S]*?background:\s*linear-gradient\(180deg, color-mix\(in oklab, var\(--color-primary-glow\) 70%, var\(--bg-elevated\)\), var\(--bg-surface\)\);/);
    expect(css).toMatch(/\.gameplay-card-v2__badge--counter\s*\{[\s\S]*?background:\s*#fff1cc;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-warning\) 16%, var\(--bg-surface\)\);/);
    expect(css).toMatch(/\.gameplay-modal-v2__preview\s*\{[\s\S]*?background:\s*#fbfaf7;[\s\S]*?background:\s*color-mix\(in oklab, var\(--bg-surface\) 88%, var\(--bg-elevated\)\);/);
    expect(css).toMatch(/\.gameplay-modal__stat\s*\{[\s\S]*?border:\s*1px solid rgba\(198, 21, 131, 0\.12\);[\s\S]*?border:\s*1px solid color-mix\(in oklab, var\(--color-primary\) 12%, var\(--border-default\)\);[\s\S]*?background:\s*#fbf7fb;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-primary-glow\) 40%, var\(--bg-surface\) 60%\);/);
    expect(css).toMatch(/\.gameplay-modal__availability\s*\{[\s\S]*?border:\s*1px solid rgba\(186, 111, 18, 0\.20\);[\s\S]*?border:\s*1px solid color-mix\(in oklab, var\(--color-warning\) 20%, var\(--border-default\)\);[\s\S]*?background:\s*#fff9ed;[\s\S]*?background:\s*color-mix\(in oklab, var\(--color-warning\) 8%, var\(--bg-surface\)\);/);
  });

  it('keeps intervention receipt accents and long names resilient', () => {
    const css = readCss('src/components/InterventionReceiptCard.css');

    expect(css).toMatch(/\.intervention-receipt-card\s*\{[\s\S]*?border-left:\s*3px solid #3a6cd6;[\s\S]*?@supports \(border-left-color: oklch\(58% 0\.16 250\)\)/);
    expect(css).toMatch(/\.intervention-receipt-card__affected-line\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/);
  });

  it('keeps LLM configuration banner and hint surfaces readable without OKLCH support', () => {
    const bannerCss = readCss('src/components/LlmNotConfiguredBanner.css');
    expect(bannerCss).toMatch(/\.llm-not-configured-banner\s*\{[\s\S]*?background-color:\s*#faf6f0;[\s\S]*?background-color:\s*oklch\(96% 0\.02 85\);/);

    const hintCss = readCss('src/components/LlmErrorHint.css');
    expect(hintCss).toMatch(/\.llm-error-hint\s*\{[\s\S]*?background-color:\s*#f9f3f3;[\s\S]*?background-color:\s*oklch\(96% 0\.02 25\);/);
  });

  it('keeps pipeline stepper dots readable without OKLCH support', () => {
    const css = readCss('src/components/PipelineStepper.css');
    expect(css).toMatch(/\.pipeline-stepper__dot\s*\{[\s\S]*?background:\s*#60606b;[\s\S]*?background:\s*oklch\(0\.4 0\.01 260\);/);
    expect(css).toMatch(/\.pipeline-stepper__step--active \.pipeline-stepper__dot\s*\{[\s\S]*?background:\s*#76c0e6;[\s\S]*?background:\s*oklch\(0\.75 0\.14 200\);/);
  });

  it('keeps share modal platforms and context chips readable without OKLCH support', () => {
    const css = readCss('src/components/ShareModal.css');
    expect(css).toMatch(/\.share-modal__hint\s*\{[\s\S]*?color:\s*#8c8c8c;[\s\S]*?color:\s*oklch\(55% 0 0\);/);
    expect(css).toMatch(/\.share-context__chip\s*\{[\s\S]*?background:\s*#faf5f4;[\s\S]*?background:\s*oklch\(96% 0\.02 25\);/);
  });

  it('keeps agent panel cards and mention badges readable without OKLCH support', () => {
    const css = readCss('src/components/AgentPanel.css');
    expect(css).toMatch(/\.agent-card--active\s*\{[\s\S]*?background:\s*rgba\(198, 21, 131, 0\.06\);[\s\S]*?background:\s*oklch\(55% 0\.22 350 \/ 0\.06\);/);
    expect(css).toMatch(/\.agent-mention\s*\{[\s\S]*?background:\s*rgba\(197, 132, 197, 0\.18\);[\s\S]*?background:\s*oklch\(65% 0\.18 300 \/ 0\.18\);/);
  });
});

