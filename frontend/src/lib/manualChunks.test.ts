import { describe, expect, it } from 'vitest';

import { resolveManualChunk } from './manualChunks';

describe('resolveManualChunk', () => {
  it('keeps react packages in the shared vendor chunk to avoid circular imports', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/react/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react/jsx-runtime.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react-dom/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react-dom/client.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/scheduler/index.js')).toBe('vendor');
  });

  it('keeps the entire React Flow stack in the shared vendor chunk', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@xyflow/react/dist/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/d3-selection/src/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/dagre/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/graphlib/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react-i18next/dist/index.js')).toBe('i18n-vendor');
  });

  it('keeps special heavy assets isolated', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/phaser/dist/phaser.js')).toBe('phaser');
    expect(resolveManualChunk('/repo/frontend/node_modules/html2canvas/dist/html2canvas.js')).toBe('capture-html');
    expect(resolveManualChunk('/repo/frontend/node_modules/gif.js/dist/gif.js')).toBe('capture-gif');
  });

  it('routes @antv/g6 into g6-vendor, and the rule fires before @xyflow detection', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@antv/g6/lib/index.js')).toBe('g6-vendor');
    // Sanity check: a path that contains both markers (unlikely in practice) still
    // lands in g6-vendor because the g6 rule is evaluated first.
    expect(resolveManualChunk('/repo/frontend/node_modules/@antv/g6/node_modules/@xyflow-shim/index.js')).toBe('g6-vendor');
  });

  it('defaults unmatched node_modules packages to the shared vendor chunk', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/lodash-es/chunk.js')).toBe('vendor');
  });

  it('returns undefined for app source files outside node_modules', () => {
    expect(resolveManualChunk('/repo/frontend/src/main.tsx')).toBeUndefined();
  });
});
