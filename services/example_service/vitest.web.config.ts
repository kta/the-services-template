import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/web/test/setup.ts'],
    include: ['src/web/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text'],
      include: ['src/web/**/*.{ts,tsx}'],
      exclude: ['src/web/main.tsx', 'src/web/**/*.d.ts', 'src/web/test/**', 'src/web/**/*.css'],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
})
