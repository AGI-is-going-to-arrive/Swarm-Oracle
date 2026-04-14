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
  if (!trimmed.includes("<foreignObject")) {
    throw new Error(`Malformed SVG download for ${filename}: missing <foreignObject`);
  }
  if (!trimmed.includes("</svg>")) {
    throw new Error(`Malformed SVG download for ${filename}: missing </svg>`);
  }
  if (!trimmed.includes("</foreignObject>")) {
    throw new Error(`Malformed SVG download for ${filename}: missing </foreignObject>`);
  }

  const foreignObjectMatch = trimmed.match(/<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/i);
  if (!foreignObjectMatch) {
    throw new Error(`Malformed SVG download for ${filename}: unreadable foreignObject`);
  }
  const foreignObjectContent = foreignObjectMatch[1]?.trim() ?? "";
  if (!foreignObjectContent) {
    throw new Error(`Malformed SVG download for ${filename}: empty foreignObject content`);
  }
  if (trimmed.includes('data-testid="node-detail-panel"')) {
    throw new Error(`Malformed SVG download for ${filename}: transient graph UI leaked into export`);
  }
}
