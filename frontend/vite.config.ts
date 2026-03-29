import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const backendTarget = process.env.SWARM_BACKEND_URL || 'http://127.0.0.1:18927'
const websocketTarget = backendTarget.replace(/^http/i, 'ws')

const phaserCustomEntry = fileURLToPath(
  new URL('./experiments/phaser-custom/entry.mjs', import.meta.url),
)
const spectorStub = fileURLToPath(
  new URL('./experiments/phaser-custom/phaser3spectorjs-stub.cjs', import.meta.url),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
          if (!id.includes('node_modules')) return undefined

          if (id.includes('/phaser/')) return 'phaser'
          if (id.includes('html2canvas')) return 'capture-html'
          if (id.includes('gif.js')) return 'capture-gif'
          if (id.includes('@xyflow') || id.includes('/dagre/') || id.includes('/d3-')) return 'flow-vendor'
          if (id.includes('react-i18next') || id.includes('/i18next/')) return 'i18n-vendor'
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }

          return 'vendor'
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
