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
    label: "flow-vendor chunk",
    chunkName: "flow-vendor",
    maxBytes: 220 * 1024,
    maxGzipBytes: 75 * 1024,
  }),
  buildChunkBudget({
    label: "flow-vendor chunk",
    chunkName: "flow-vendor",
    variant: "legacy",
    maxBytes: 230 * 1024,
    maxGzipBytes: 75 * 1024,
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
];
