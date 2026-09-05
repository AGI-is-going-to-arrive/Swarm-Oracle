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

  it('lets the React Flow stack use Rollup auto-splitting', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@xyflow/react/dist/index.js')).toBeUndefined();
    expect(resolveManualChunk('/repo/frontend/node_modules/d3-selection/src/index.js')).toBeUndefined();
    expect(resolveManualChunk('/repo/frontend/node_modules/dagre/index.js')).toBeUndefined();
    expect(resolveManualChunk('/repo/frontend/node_modules/graphlib/index.js')).toBeUndefined();
    expect(resolveManualChunk('/repo/frontend/node_modules/react-i18next/dist/index.js')).toBe('i18n-vendor');
  });

  it('keeps special heavy assets isolated', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/phaser/dist/phaser.js')).toBe('phaser');
    expect(resolveManualChunk('/repo/frontend/node_modules/html2canvas/dist/html2canvas.js')).toBe('capture-html');
    expect(resolveManualChunk('/repo/frontend/node_modules/gif.js/dist/gif.js')).toBe('capture-gif');
  });

  it('isolates the GFM parser from the eager core Markdown and sanitizer chunk', () => {
    for (const packageName of [
      'remark-gfm',
      'mdast-util-gfm',
      'mdast-util-gfm-autolink-literal',
      'mdast-util-gfm-table',
      'micromark-extension-gfm',
      'micromark-extension-gfm-autolink-literal',
    ]) {
      expect(resolveManualChunk(`/repo/frontend/node_modules/${packageName}/index.js`)).toBe('markdown-gfm');
    }
    for (const packageName of [
      'react-markdown',
      'remark-parse',
      'rehype-sanitize',
      'hast-util-sanitize',
      'mdast-util-from-markdown',
      'micromark',
    ]) {
      expect(resolveManualChunk(`/repo/frontend/node_modules/${packageName}/index.js`)).toBe('vendor');
    }
  });

  it('splits large UI/support libraries out of the shared vendor chunk', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@radix-ui/react-dialog/dist/index.js')).toBe('radix-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/@dnd-kit/core/dist/core.esm.js')).toBe('dnd-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/lucide-react/dist/esm/icons/x.js')).toBe('icon-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/@chenglou/pretext/dist/index.js')).toBe('pretext');
  });

  it('routes the full G6 ecosystem into g6-vendor before any graph auto-splitting', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/@antv/g6/lib/index.js')).toBe('g6-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/@antv/layout/lib/antv-dagre.js')).toBe('g6-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/gl-matrix/esm/index.js')).toBe('g6-vendor');
    expect(resolveManualChunk('/repo/frontend/node_modules/bubblesets-js/dist/index.js')).toBe('g6-vendor');
    // Sanity check: a path that contains both markers (unlikely in practice)
    // still lands in g6-vendor because the graph-runtime rule is evaluated first.
    expect(resolveManualChunk('/repo/frontend/node_modules/@antv/g6/node_modules/@xyflow-shim/index.js')).toBe('g6-vendor');
  });

  it('defaults unmatched node_modules packages to the shared vendor chunk', () => {
    expect(resolveManualChunk('/repo/frontend/node_modules/lodash-es/chunk.js')).toBe('vendor');
  });

  it('returns undefined for app source files outside node_modules', () => {
    expect(resolveManualChunk('/repo/frontend/src/main.tsx')).toBeUndefined();
  });
});
