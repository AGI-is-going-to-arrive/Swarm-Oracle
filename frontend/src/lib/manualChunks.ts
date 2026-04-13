export function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;

  if (id.includes('/phaser/')) return 'phaser';
  if (id.includes('html2canvas')) return 'capture-html';
  if (id.includes('gif.js')) return 'capture-gif';
  if (id.includes('@xyflow') || id.includes('/dagre/') || id.includes('/d3-')) return 'flow-vendor';
  if (id.includes('react-i18next') || id.includes('/i18next/')) return 'i18n-vendor';

  // Keep React inside the shared vendor chunk. Splitting it into a dedicated
  // chunk caused a vendor <-> react-vendor cycle in production output.
  return 'vendor';
}
