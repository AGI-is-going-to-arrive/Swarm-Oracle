import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

import { resolveManualChunk } from './manualChunks';
// @ts-expect-error Test-only import from Node-executed script helper.
import { FILE_BUDGETS } from '../../scripts/lib/performanceBudgetConfig.mjs';

describe('performance budget config', () => {
  it('covers every explicitly named manual chunk plus the shared vendor chunk', () => {
    const expectedChunkNames = new Set([
      'vendor',
      resolveManualChunk('/repo/frontend/node_modules/phaser/dist/phaser.js'),
      resolveManualChunk('/repo/frontend/node_modules/html2canvas/dist/html2canvas.js'),
      resolveManualChunk('/repo/frontend/node_modules/gif.js/dist/gif.js'),
      resolveManualChunk('/repo/frontend/node_modules/@antv/g6/lib/index.js'),
      resolveManualChunk('/repo/frontend/node_modules/@radix-ui/react-dialog/dist/index.js'),
      resolveManualChunk('/repo/frontend/node_modules/@dnd-kit/core/dist/core.esm.js'),
      resolveManualChunk('/repo/frontend/node_modules/lucide-react/dist/esm/icons/x.js'),
      resolveManualChunk('/repo/frontend/node_modules/@chenglou/pretext/dist/index.js'),
      resolveManualChunk('/repo/frontend/node_modules/@xyflow/react/dist/index.js'),
      resolveManualChunk('/repo/frontend/node_modules/react-i18next/dist/index.js'),
    ].filter((chunkName): chunkName is string => Boolean(chunkName)));

    const configuredChunkNames = new Set(FILE_BUDGETS.map((budget: { chunkName: string }) => budget.chunkName));

    expect(configuredChunkNames).toEqual(expectedChunkNames);
  });

  it('runs perf budget checks as part of the default build script', () => {
    expect(packageJson.scripts.build).toContain('perf:budgets:check');
  });
});
