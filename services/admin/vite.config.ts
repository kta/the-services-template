import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One dev server (:5174) for SPA + Worker. The EXAMPLE_SERVICE service binding
// resolves across processes via the wrangler dev registry — run the
// example_service dev server too when exercising the org sync locally.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { port: 5174 },
})
