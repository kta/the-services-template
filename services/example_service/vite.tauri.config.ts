import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { webCspPlugin } from '../../scripts/web-csp.mjs'

export default defineConfig({
  base: './',
  envPrefix: 'VITE_PUBLIC_',
  plugins: [react(), tailwindcss(), webCspPlugin()],
  build: {
    outDir: 'dist/tauri',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
