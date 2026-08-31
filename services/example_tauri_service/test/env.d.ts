import type { D1Migration } from '@cloudflare/vitest-pool-workers'

// Augment the test env with the migrations binding injected in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
