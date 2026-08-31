import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { webCspPlugin } from '../../scripts/web-csp.mjs'

const e2eStatePath = process.env.E2E_STATE_PATH
const persistState = e2eStatePath ? { path: e2eStatePath } : true
const e2eAuth = process.env.E2E_AUTH === 'true'

// One dev server (:5173) runs both halves: Vite serves/HMRs the SPA while the
// Worker (src/worker) executes inside real workerd with the bindings from
// wrangler.jsonc — no proxy, no separate `wrangler dev`, same-origin /api.
export default defineConfig({
  clearScreen: false,
  // Only explicitly public Vite variables may cross into the renderer bundle.
  envPrefix: 'VITE_PUBLIC_',
  plugins: [
    react(),
    tailwindcss(),
    webCspPlugin(),
    cloudflare({
      persistState,
      config: e2eAuth
        ? (config) => {
            // E2E builds use test-only credentials without changing the
            // production wrangler.jsonc secret boundary.
            config.vars = { ...config.vars, AUTH_DEV_GRANT: 'true' }
            config.secrets = {
              required: [...(config.secrets?.required ?? []), 'AUTH_DEV_PRIVATE_KEY'],
            }
          }
        : undefined,
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
})
