import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
  namespace Cloudflare {
    interface Env {
      // Explicit test-only domain stub. Production wrangler.jsonc intentionally
      // contains bindings for catalog-deployable domains only.
      EXAMPLE_SERVICE: Fetcher
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
