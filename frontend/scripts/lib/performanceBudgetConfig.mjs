function buildChunkBudget({
  label,
  chunkName,
  maxBytes,
  maxGzipBytes,
  variant = "modern",
}) {
  const legacy = variant === "legacy";
  return {
    label: legacy ? `${label} legacy` : label,
    chunkName,
    pattern: legacy
      ? new RegExp(`^${chunkName}-legacy-.*\\.js$`)
      : new RegExp(`^${chunkName}-(?!legacy).*\\.js$`),
    maxBytes,
    maxGzipBytes,
  };
}

export const FILE_BUDGETS = [
  buildChunkBudget({
    label: "vendor chunk",
    chunkName: "vendor",
    maxBytes: 700 * 1024,
    maxGzipBytes: 230 * 1024,
  }),
  buildChunkBudget({
    label: "vendor chunk",
    chunkName: "vendor",
    variant: "legacy",
    maxBytes: 700 * 1024,
    maxGzipBytes: 230 * 1024,
  }),
  buildChunkBudget({
    label: "phaser chunk",
    chunkName: "phaser",
    maxBytes: 760 * 1024,
    maxGzipBytes: 215 * 1024,
  }),
  // Legacy Babel/SystemJS output is materially larger in raw bytes even when
  // transfer size stays inside the same gzip envelope.
  buildChunkBudget({
    label: "phaser chunk",
    chunkName: "phaser",
    variant: "legacy",
    maxBytes: 830 * 1024,
    maxGzipBytes: 215 * 1024,
  }),
  buildChunkBudget({
    label: "capture-html chunk",
    chunkName: "capture-html",
    maxBytes: 220 * 1024,
    maxGzipBytes: 55 * 1024,
  }),
  buildChunkBudget({
    label: "capture-html chunk",
    chunkName: "capture-html",
    variant: "legacy",
    maxBytes: 220 * 1024,
    maxGzipBytes: 55 * 1024,
  }),
  buildChunkBudget({
    label: "capture-gif chunk",
    chunkName: "capture-gif",
    maxBytes: 40 * 1024,
    maxGzipBytes: 15 * 1024,
  }),
  buildChunkBudget({
    label: "capture-gif chunk",
    chunkName: "capture-gif",
    variant: "legacy",
    maxBytes: 40 * 1024,
    maxGzipBytes: 15 * 1024,
  }),
  buildChunkBudget({
    label: "g6-vendor chunk",
    chunkName: "g6-vendor",
    maxBytes: 1280 * 1024,
    maxGzipBytes: 380 * 1024,
  }),
  buildChunkBudget({
    label: "g6-vendor chunk",
    chunkName: "g6-vendor",
    variant: "legacy",
    maxBytes: 1280 * 1024,
    maxGzipBytes: 380 * 1024,
  }),
  buildChunkBudget({
    label: "i18n-vendor chunk",
    chunkName: "i18n-vendor",
    maxBytes: 80 * 1024,
    maxGzipBytes: 25 * 1024,
  }),
  buildChunkBudget({
    label: "i18n-vendor chunk",
    chunkName: "i18n-vendor",
    variant: "legacy",
    maxBytes: 80 * 1024,
    maxGzipBytes: 25 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow runtime chunk",
    chunkName: "style",
    maxBytes: 260 * 1024,
    maxGzipBytes: 80 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow runtime chunk",
    chunkName: "style",
    variant: "legacy",
    maxBytes: 280 * 1024,
    maxGzipBytes: 80 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow graph traversal/card chunk",
    chunkName: "graphTraversal",
    maxBytes: 24 * 1024,
    maxGzipBytes: 8 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow graph traversal/card chunk",
    chunkName: "graphTraversal",
    variant: "legacy",
    maxBytes: 24 * 1024,
    maxGzipBytes: 8 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow graph tokens chunk",
    chunkName: "graphTokens",
    maxBytes: 4 * 1024,
    maxGzipBytes: 2 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow graph tokens chunk",
    chunkName: "graphTokens",
    variant: "legacy",
    maxBytes: 4 * 1024,
    maxGzipBytes: 2 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow utils chunk",
    chunkName: "utils",
    maxBytes: 2 * 1024,
    maxGzipBytes: 1 * 1024,
  }),
  buildChunkBudget({
    label: "React Flow utils chunk",
    chunkName: "utils",
    variant: "legacy",
    maxBytes: 2 * 1024,
    maxGzipBytes: 1 * 1024,
  }),
  buildChunkBudget({
    label: "radix-vendor chunk",
    chunkName: "radix-vendor",
    maxBytes: 240 * 1024,
    maxGzipBytes: 65 * 1024,
  }),
  buildChunkBudget({
    label: "radix-vendor chunk",
    chunkName: "radix-vendor",
    variant: "legacy",
    maxBytes: 260 * 1024,
    maxGzipBytes: 65 * 1024,
  }),
  buildChunkBudget({
    label: "dnd-vendor chunk",
    chunkName: "dnd-vendor",
    maxBytes: 90 * 1024,
    maxGzipBytes: 28 * 1024,
  }),
  buildChunkBudget({
    label: "dnd-vendor chunk",
    chunkName: "dnd-vendor",
    variant: "legacy",
    maxBytes: 95 * 1024,
    maxGzipBytes: 28 * 1024,
  }),
  buildChunkBudget({
    label: "icon-vendor chunk",
    chunkName: "icon-vendor",
    maxBytes: 140 * 1024,
    maxGzipBytes: 40 * 1024,
  }),
  buildChunkBudget({
    label: "icon-vendor chunk",
    chunkName: "icon-vendor",
    variant: "legacy",
    maxBytes: 145 * 1024,
    maxGzipBytes: 40 * 1024,
  }),
  buildChunkBudget({
    label: "pretext chunk",
    chunkName: "pretext",
    maxBytes: 120 * 1024,
    maxGzipBytes: 35 * 1024,
  }),
  buildChunkBudget({
    label: "pretext chunk",
    chunkName: "pretext",
    variant: "legacy",
    maxBytes: 125 * 1024,
    maxGzipBytes: 35 * 1024,
  }),
];
