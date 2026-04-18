export function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;

  if (id.includes('/phaser/')) return 'phaser';
  if (id.includes('html2canvas')) return 'capture-html';
  if (id.includes('gif.js')) return 'capture-gif';
  if (id.includes('@antv/g6')) return 'g6-vendor';
  // Keep the whole React Flow stack inside the shared vendor chunk. Splitting
  // @xyflow/d3/dagre/graphlib created a production-only TDZ crash during app
  // bootstrap because Rollup emitted a vendor <-> flow-vendor cycle.
  if (
    id.includes('@xyflow')
    || id.includes('/d3-')
    || id.includes('/dagre/')
    || id.includes('/graphlib/')
  ) {
    return 'vendor';
  }
  if (id.includes('react-i18next') || id.includes('/i18next/')) return 'i18n-vendor';

  // Keep React inside the shared vendor chunk. Splitting it into a dedicated
  // chunk caused a vendor <-> react-vendor cycle in production output.
  return 'vendor';
}
