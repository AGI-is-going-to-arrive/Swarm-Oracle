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

    expect(css).toMatch(/\.sim-header\s*\{[\s\S]*?background:\s*linear-gradient\(180deg, #faf9f6, #faf8f5\);[\s\S]*?background:\s*linear-gradient\(180deg, color-mix\(in oklab, var\(--bg-base\) 92%, white\), var\(--bg-base\)\);/);
    expect(css).toMatch(/@keyframes subtlePulse\s*\{[\s\S]*?box-shadow:\s*0 0 0 0 rgba\(198, 21, 131, 0\.3\);[\s\S]*?box-shadow:\s*0 0 0 0 oklch\(55% 0\.22 350 \/ 0\.3\);/);
  });

  it('declares worldline oracle skin fallbacks before OKLCH overrides', () => {
    const css = readCss('src/pages/WorldlineRoundtable.css');

    expect(css).toMatch(/\.worldline-roundtable-view\.oracle-skin\s*\{[\s\S]*?--oracle-accent:\s*#a35e16;[\s\S]*?--oracle-accent:\s*oklch\(55% 0\.12 60\);/);
    expect(css).toMatch(/\.worldline-roundtable-view\.oracle-skin--law\s*\{[\s\S]*?--oracle-accent:\s*#0465af;[\s\S]*?--oracle-accent:\s*oklch\(50% 0\.14 250\);/);
    expect(css).toMatch(/\.worldline-roundtable-view \.archive-chip--profile\s*\{[\s\S]*?background:\s*#f3ece3;[\s\S]*?background:\s*color-mix\(in oklab, var\(--oracle-accent\) 10%, var\(--bg-surface\)\);/);
  });
});
