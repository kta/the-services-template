import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const e2eStatePath = process.env.E2E_STATE_PATH
const persistState = e2eStatePath ? { path: e2eStatePath } : true

// One dev server (:5174) for SPA + Worker. The EXAMPLE_SERVICE service binding
// resolves across processes via the wrangler dev registry — run the
// example_service dev server too when exercising the org sync locally.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ persistState })],
  server: { port: 5174 },
})
