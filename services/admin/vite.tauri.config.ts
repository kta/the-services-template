import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri ships a static SPA. Keep this build independent from the Cloudflare
// Worker plugin used by vite.config.ts for the browser deployment.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/tauri',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
