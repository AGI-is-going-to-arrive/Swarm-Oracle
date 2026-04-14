export const FILE_BUDGETS = [
  {
    label: "vendor chunk",
    chunkName: "vendor",
    pattern: /^vendor-.*\.js$/,
    maxBytes: 700 * 1024,
    maxGzipBytes: 230 * 1024,
  },
  {
    label: "phaser chunk",
    chunkName: "phaser",
    pattern: /^phaser-.*\.js$/,
    maxBytes: 760 * 1024,
    maxGzipBytes: 215 * 1024,
  },
  {
    label: "capture-html chunk",
    chunkName: "capture-html",
    pattern: /^capture-html-.*\.js$/,
    maxBytes: 220 * 1024,
    maxGzipBytes: 55 * 1024,
  },
  {
    label: "capture-gif chunk",
    chunkName: "capture-gif",
    pattern: /^capture-gif-.*\.js$/,
    maxBytes: 40 * 1024,
    maxGzipBytes: 15 * 1024,
  },
  {
    label: "flow-vendor chunk",
    chunkName: "flow-vendor",
    pattern: /^flow-vendor-.*\.js$/,
    maxBytes: 220 * 1024,
    maxGzipBytes: 75 * 1024,
  },
  {
    label: "i18n-vendor chunk",
    chunkName: "i18n-vendor",
    pattern: /^i18n-vendor-.*\.js$/,
    maxBytes: 80 * 1024,
    maxGzipBytes: 25 * 1024,
  },
];
