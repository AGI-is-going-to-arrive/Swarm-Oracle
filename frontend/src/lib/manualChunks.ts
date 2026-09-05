export function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;

  if (id.includes('/phaser/')) return 'phaser';
  if (id.includes('html2canvas')) return 'capture-html';
  if (id.includes('gif.js')) return 'capture-gif';
  // GFM is imported only after detecting regex lookbehind support. Keeping
  // its parser extensions in vendor would eagerly parse them on old Safari.
  // Shared React, core Markdown, and sanitization dependencies stay in vendor.
  if (
    id.includes('/remark-gfm/')
    || id.includes('/mdast-util-gfm')
    || id.includes('/micromark-extension-gfm')
  ) {
    return 'markdown-gfm';
  }
  // Keep the whole G6 runtime isolated from the eager app shell. Routing only
  // @antv/g6 was insufficient because Rollup still left a large set of direct
  // @antv/* support packages in the shared vendor chunk, which regressed the
  // homepage preload path.
  if (
    id.includes('/@antv/')
    || id.includes('bubblesets-js')
    || id.includes('gl-matrix')
  ) {
    return 'g6-vendor';
  }
  if (id.includes('@radix-ui')) return 'radix-vendor';
  if (id.includes('@dnd-kit')) return 'dnd-vendor';
  if (id.includes('lucide-react')) return 'icon-vendor';
  if (id.includes('@chenglou/pretext')) return 'pretext';
  // Let Rollup auto-split the React Flow stack. Forcing it into the shared
  // vendor chunk regressed homepage cold-load size, while forcing a dedicated
  // named chunk previously created fragile vendor <-> flow cycles.
  if (
    id.includes('@xyflow')
    || id.includes('/d3-')
    || id.includes('/dagre/')
    || id.includes('/graphlib/')
  ) {
    return undefined;
  }
  if (id.includes('react-i18next') || id.includes('/i18next/')) return 'i18n-vendor';

  // Keep React inside the shared vendor chunk. Splitting it into a dedicated
  // chunk caused a vendor <-> react-vendor cycle in production output.
  return 'vendor';
}
