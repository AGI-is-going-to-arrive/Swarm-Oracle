import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Test-only import from Node-executed script helper.
import { validateSvgDownloadArtifact } from '../../scripts/lib/exportValidation.mjs';

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tempFiles.map(async (filePath) => {
    await fs.rm(filePath, { force: true });
  }));
  tempFiles.length = 0;
});

async function writeTempFile(filename: string, contents: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filePath, contents, 'utf8');
  tempFiles.push(filePath);
  return filePath;
}

describe('validateSvgDownloadArtifact', () => {
  it('accepts exported SVG files that contain serialized graph markup', async () => {
    const filePath = await writeTempFile(
      'graph-export-valid.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>graph</div></foreignObject></svg>',
    );

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'causal-graph_2026-04-14.svg',
        expectedPrefix: 'causal-graph_',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects empty or malformed SVG downloads', async () => {
    const filePath = await writeTempFile('graph-export-invalid.svg', '');

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'causal-graph_2026-04-14.svg',
        expectedPrefix: 'causal-graph_',
      }),
    ).rejects.toThrow(/empty|malformed|svg/i);
  });

  it('rejects SVG files with an empty foreignObject payload', async () => {
    const filePath = await writeTempFile(
      'graph-export-empty-foreign-object.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>   </foreignObject></svg>',
    );

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'causal-graph_2026-04-14.svg',
        expectedPrefix: 'causal-graph_',
      }),
    ).rejects.toThrow(/foreignObject|content|malformed/i);
  });

  it('rejects truncated SVG files even when they contain svg and foreignObject markers', async () => {
    const filePath = await writeTempFile(
      'graph-export-truncated.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>graph</div>',
    );

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'causal-graph_2026-04-14.svg',
        expectedPrefix: 'causal-graph_',
      }),
    ).rejects.toThrow(/foreignObject|svg|malformed/i);
  });

  it('rejects SVG files that leak transient node detail UI into the export', async () => {
    const filePath = await writeTempFile(
      'graph-export-leaked-detail-panel.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div data-testid="node-detail-panel">detail</div></foreignObject></svg>',
    );

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'causal-graph_2026-04-14.svg',
        expectedPrefix: 'causal-graph_',
      }),
    ).rejects.toThrow(/transient|detail|export/i);
  });

  it('accepts argument-map SVG filenames that match the expected prefix', async () => {
    const filePath = await writeTempFile(
      'argument-map-export-valid.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>graph</div></foreignObject></svg>',
    );

    await expect(
      validateSvgDownloadArtifact({
        filePath,
        filename: 'argument-map_2026-04-14.svg',
        expectedPrefix: 'argument-map_',
      }),
    ).resolves.toBeUndefined();
  });
});
