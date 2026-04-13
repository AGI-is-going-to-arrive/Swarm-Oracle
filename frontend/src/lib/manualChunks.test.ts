import { describe, expect, it } from 'vitest';

import { resolveManualChunk } from './manualChunks';

describe('resolveManualChunk', () => {
  it('keeps react packages in the shared vendor chunk to avoid circular imports', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/react/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react-dom/index.js')).toBe('vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/scheduler/index.js')).toBe('vendor');
  });

  it('preserves explicit graph and i18n vendor chunks', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@xyflow/react/dist/index.js')).toBe('flow-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/dagre/index.js')).toBe('flow-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/react-i18next/dist/index.js')).toBe('i18n-vendor');
  });

  it('keeps special heavy assets isolated', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/phaser/dist/phaser.js')).toBe('phaser');
    expect(resolveManualChunk('/repo/frontend/node_modules/html2canvas/dist/html2canvas.js')).toBe('capture-html');
    expect(resolveManualChunk('/repo/frontend/node_modules/gif.js/dist/gif.js')).toBe('capture-gif');
  });
});
