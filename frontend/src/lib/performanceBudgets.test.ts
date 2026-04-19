import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

import { resolveManualChunk } from './manualChunks';
// @ts-expect-error Test-only import from Node-executed script helper.
import { FILE_BUDGETS } from '../../scripts/lib/performanceBudgetConfig.mjs';

function expectedChunkBudget(chunkName: string, {
  label,
  maxBytes,
  maxGzipBytes,
  variant = 'modern',
}: {
  label: string;
  maxBytes: number;
  maxGzipBytes: number;
  variant?: 'modern' | 'legacy';
}) {
  return {
    chunkName,
    label: variant === 'legacy' ? `${label} legacy` : label,
    maxBytes,
    maxGzipBytes,
    pattern: variant === 'legacy'
      ? `^${chunkName}-legacy-.*\\.js$`
      : `^${chunkName}-(?!legacy).*\\.js$`,
  };
}

describe('performance budget config', () => {
  it('covers every explicitly named manual chunk, the shared vendor chunk, and React Flow auto-split chunks', () => {
    const phaserChunk = resolveManualChunk('/repo/frontend/node_modules/phaser/dist/phaser.js');
    const captureHtmlChunk = resolveManualChunk('/repo/frontend/node_modules/html2canvas/dist/html2canvas.js');
    const captureGifChunk = resolveManualChunk('/repo/frontend/node_modules/gif.js/dist/gif.js');
    const g6VendorChunk = resolveManualChunk('/repo/frontend/node_modules/@antv/g6/lib/index.js');
    const radixVendorChunk = resolveManualChunk('/repo/frontend/node_modules/@radix-ui/react-dialog/dist/index.js');
    const dndVendorChunk = resolveManualChunk('/repo/frontend/node_modules/@dnd-kit/core/dist/core.esm.js');
    const iconVendorChunk = resolveManualChunk('/repo/frontend/node_modules/lucide-react/dist/esm/icons/x.js');
    const pretextChunk = resolveManualChunk('/repo/frontend/node_modules/@chenglou/pretext/dist/index.js');
    const i18nVendorChunk = resolveManualChunk('/repo/frontend/node_modules/react-i18next/dist/index.js');

    const expectedBudgets = [
      expectedChunkBudget('vendor', { label: 'vendor chunk', maxBytes: 700 * 1024, maxGzipBytes: 230 * 1024 }),
      expectedChunkBudget('vendor', { label: 'vendor chunk', maxBytes: 700 * 1024, maxGzipBytes: 230 * 1024, variant: 'legacy' }),
      expectedChunkBudget(phaserChunk!, { label: 'phaser chunk', maxBytes: 760 * 1024, maxGzipBytes: 215 * 1024 }),
      expectedChunkBudget(phaserChunk!, { label: 'phaser chunk', maxBytes: 830 * 1024, maxGzipBytes: 215 * 1024, variant: 'legacy' }),
      expectedChunkBudget(captureHtmlChunk!, { label: 'capture-html chunk', maxBytes: 220 * 1024, maxGzipBytes: 55 * 1024 }),
      expectedChunkBudget(captureHtmlChunk!, { label: 'capture-html chunk', maxBytes: 220 * 1024, maxGzipBytes: 55 * 1024, variant: 'legacy' }),
      expectedChunkBudget(captureGifChunk!, { label: 'capture-gif chunk', maxBytes: 40 * 1024, maxGzipBytes: 15 * 1024 }),
      expectedChunkBudget(captureGifChunk!, { label: 'capture-gif chunk', maxBytes: 40 * 1024, maxGzipBytes: 15 * 1024, variant: 'legacy' }),
      expectedChunkBudget(g6VendorChunk!, { label: 'g6-vendor chunk', maxBytes: 1280 * 1024, maxGzipBytes: 380 * 1024 }),
      expectedChunkBudget(g6VendorChunk!, { label: 'g6-vendor chunk', maxBytes: 1280 * 1024, maxGzipBytes: 380 * 1024, variant: 'legacy' }),
      expectedChunkBudget(i18nVendorChunk!, { label: 'i18n-vendor chunk', maxBytes: 80 * 1024, maxGzipBytes: 25 * 1024 }),
      expectedChunkBudget(i18nVendorChunk!, { label: 'i18n-vendor chunk', maxBytes: 80 * 1024, maxGzipBytes: 25 * 1024, variant: 'legacy' }),
      expectedChunkBudget('style', { label: 'React Flow runtime chunk', maxBytes: 260 * 1024, maxGzipBytes: 80 * 1024 }),
      expectedChunkBudget('style', { label: 'React Flow runtime chunk', maxBytes: 280 * 1024, maxGzipBytes: 80 * 1024, variant: 'legacy' }),
      expectedChunkBudget('GraphNodeCard', { label: 'React Flow graph card chunk', maxBytes: 24 * 1024, maxGzipBytes: 8 * 1024 }),
      expectedChunkBudget('GraphNodeCard', { label: 'React Flow graph card chunk', maxBytes: 24 * 1024, maxGzipBytes: 8 * 1024, variant: 'legacy' }),
      expectedChunkBudget('graphTokens', { label: 'React Flow graph tokens chunk', maxBytes: 4 * 1024, maxGzipBytes: 2 * 1024 }),
      expectedChunkBudget('graphTokens', { label: 'React Flow graph tokens chunk', maxBytes: 4 * 1024, maxGzipBytes: 2 * 1024, variant: 'legacy' }),
      expectedChunkBudget('utils', { label: 'React Flow utils chunk', maxBytes: 2 * 1024, maxGzipBytes: 1 * 1024 }),
      expectedChunkBudget('utils', { label: 'React Flow utils chunk', maxBytes: 2 * 1024, maxGzipBytes: 1 * 1024, variant: 'legacy' }),
      expectedChunkBudget(radixVendorChunk!, { label: 'radix-vendor chunk', maxBytes: 240 * 1024, maxGzipBytes: 65 * 1024 }),
      expectedChunkBudget(radixVendorChunk!, { label: 'radix-vendor chunk', maxBytes: 260 * 1024, maxGzipBytes: 65 * 1024, variant: 'legacy' }),
      expectedChunkBudget(dndVendorChunk!, { label: 'dnd-vendor chunk', maxBytes: 90 * 1024, maxGzipBytes: 28 * 1024 }),
      expectedChunkBudget(dndVendorChunk!, { label: 'dnd-vendor chunk', maxBytes: 95 * 1024, maxGzipBytes: 28 * 1024, variant: 'legacy' }),
      expectedChunkBudget(iconVendorChunk!, { label: 'icon-vendor chunk', maxBytes: 140 * 1024, maxGzipBytes: 40 * 1024 }),
      expectedChunkBudget(iconVendorChunk!, { label: 'icon-vendor chunk', maxBytes: 145 * 1024, maxGzipBytes: 40 * 1024, variant: 'legacy' }),
      expectedChunkBudget(pretextChunk!, { label: 'pretext chunk', maxBytes: 120 * 1024, maxGzipBytes: 35 * 1024 }),
      expectedChunkBudget(pretextChunk!, { label: 'pretext chunk', maxBytes: 125 * 1024, maxGzipBytes: 35 * 1024, variant: 'legacy' }),
    ];

    const configuredBudgets = FILE_BUDGETS.map((budget: {
      chunkName: string;
      label: string;
      maxBytes: number;
      maxGzipBytes: number;
      pattern: RegExp;
    }) => ({
      chunkName: budget.chunkName,
      label: budget.label,
      maxBytes: budget.maxBytes,
      maxGzipBytes: budget.maxGzipBytes,
      pattern: budget.pattern.source,
    }));

    expect(configuredBudgets).toEqual(expectedBudgets);
  });

  it('runs perf budget checks as part of the default build script', () => {
    expect(packageJson.scripts.build).toContain('perf:budgets:check');
  });
});
