import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { resolveManualChunk } from './src/lib/manualChunks'

const backendTarget = process.env.SWARM_BACKEND_URL || 'http://127.0.0.1:18927'
const websocketTarget = backendTarget.replace(/^http/i, 'ws')

const phaserCustomEntry = fileURLToPath(
  new URL('./experiments/phaser-custom/entry.mjs', import.meta.url),
)
const spectorStub = fileURLToPath(
  new URL('./experiments/phaser-custom/phaser3spectorjs-stub.cjs', import.meta.url),
)
const legacyTargets = [
  'chrome >= 79',
  'edge >= 79',
  'firefox >= 78',
  'safari >= 12',
  'iOS >= 12',
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    legacy({
      targets: legacyTargets,
    }),
  ],
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
    // Phaser remains a single large engine asset, but it is now isolated behind
    // route + Theater-only lazy loading. Keep warnings focused on chunks that
    // are unexpectedly large in the eager path.
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return resolveManualChunk(id)
        },
      },
    },
  },
  server: {
    port: 18928,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: websocketTarget,
        ws: true,
      },
    },
  },
})
