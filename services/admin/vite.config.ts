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

// One dev server (:5174) for SPA + Worker. The non-deployable scaffold binding
// is added only for `vite serve`; production builds retain the catalog-exact
// service bindings from wrangler.jsonc.
export default defineConfig(({ command }) => ({
  // Only explicitly public Vite variables may cross into the renderer bundle.
  envPrefix: 'VITE_PUBLIC_',
  plugins: [
    react(),
    tailwindcss(),
    webCspPlugin(),
    cloudflare({
      persistState,
      config: (config) => {
        if (command === 'serve') {
          // The dev registry resolves this across processes. Run the
          // example_service dev server too when exercising local org sync.
          config.services = [
            ...(config.services ?? []),
            { binding: 'EXAMPLE_SERVICE', service: 'example-service' },
          ]
        }
        if (e2eAuth) {
          // E2E builds use test-only credentials without changing the
          // production wrangler.jsonc secret boundary.
          config.vars = { ...config.vars, APP_ENV: 'development', AUTH_DEV_GRANT: 'true' }
          config.secrets = {
            required: [...(config.secrets?.required ?? []), 'AUTH_DEV_PRIVATE_KEY'],
          }
        }
      },
    }),
  ],
  server: {
    port: 5174,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}))
