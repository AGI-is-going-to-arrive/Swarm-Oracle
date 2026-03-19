import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
          if (id.includes('html2canvas') || id.includes('gif.js')) return 'capture-vendor'
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
        target: 'http://localhost:18927',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:18927',
        ws: true,
      },
    },
  },
})
