import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const e2eStatePath = process.env.E2E_STATE_PATH
const persistState = e2eStatePath ? { path: e2eStatePath } : true

// One dev server (:5173) runs both halves: Vite serves/HMRs the SPA while the
// Worker (src/worker) executes inside real workerd with the bindings from
// wrangler.jsonc — no proxy, no separate `wrangler dev`, same-origin /api.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ persistState })],
  server: { port: 5173 },
})
