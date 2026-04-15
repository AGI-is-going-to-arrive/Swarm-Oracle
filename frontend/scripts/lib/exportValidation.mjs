import fs from "node:fs/promises";

export async function validateSvgDownloadArtifact({ filePath, filename, expectedPrefix }) {
  if (!filename.startsWith(expectedPrefix) || !filename.endsWith(".svg")) {
    throw new Error(`Unexpected SVG filename: ${filename}`);
  }
  if (!filePath) {
    throw new Error(`Missing SVG download path for ${filename}`);
  }

  const contents = await fs.readFile(filePath, "utf8");
  const trimmed = contents.trim();
  if (!trimmed) {
    throw new Error(`Empty SVG download for ${filename}`);
  }
  if (!trimmed.includes("<svg")) {
    throw new Error(`Malformed SVG download for ${filename}: missing <svg`);
  }
  if (!trimmed.includes("</svg>")) {
    throw new Error(`Malformed SVG download for ${filename}: missing </svg>`);
  }
  if (trimmed.includes("<foreignObject")) {
    throw new Error(`Malformed SVG download for ${filename}: foreignObject reduces portability`);
  }
  const hasNativeLayer = trimmed.includes('data-export-layer="background"')
    || trimmed.includes('data-export-layer="edges"');
  const hasExportNode = trimmed.includes('data-export-node="true"');
  if (!hasNativeLayer && !hasExportNode) {
    throw new Error(`Malformed SVG download for ${filename}: missing native graph markup`);
  }
  if (trimmed.includes('data-testid="node-detail-panel"')) {
    throw new Error(`Malformed SVG download for ${filename}: transient graph UI leaked into export`);
  }
}
