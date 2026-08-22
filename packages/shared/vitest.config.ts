import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 認証・契約はセキュリティ境界 — サービス同様カバレッジをゲートにする
    // (AGENTS.md の「pnpm check = カバレッジゲート込み」を満たす)。
    coverage: {
      provider: 'istanbul',
      reporter: ['text'],
      include: ['src/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
