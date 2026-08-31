import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { validateTauriDevHost } from '../../scripts/tauri-dev-host.mjs'
import { webCspPlugin } from '../../scripts/web-csp.mjs'

const e2eStatePath = process.env.E2E_STATE_PATH
const persistState = e2eStatePath ? { path: e2eStatePath } : true
const e2eAuth = process.env.E2E_AUTH === 'true'
const tauriDevHost = validateTauriDevHost(process.env.TAURI_DEV_HOST)

// One dev server (:5175) runs both halves: Vite serves/HMRs the SPA while the
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
    port: 5175,
    // Tauri's devUrl is fixed to this port. Vite must fail instead of silently
    // moving to another port, otherwise the native window opens a stale server.
    strictPort: true,
    // Tauri uses this for iOS physical-device development. Keep the default
    // loopback-only; an explicit LAN host is a developer opt-in.
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
