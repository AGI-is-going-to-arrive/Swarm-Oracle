import { fileURLToPath, URL } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';

import baseConfig from '../../vite.config';

const phaserCustomEntry = fileURLToPath(new URL('./entry.mjs', import.meta.url));
const spectorStub = fileURLToPath(new URL('./phaser3spectorjs-stub.cjs', import.meta.url));

export default mergeConfig(baseConfig, defineConfig({
  resolve: {
    alias: [
      {
        find: /^phaser$/,
        replacement: phaserCustomEntry,
      },
      {
        find: /^phaser3spectorjs$/,
        replacement: spectorStub,
      },
    ],
  },
  build: {
    outDir: 'dist-spikes/phaser-custom',
  },
}));
