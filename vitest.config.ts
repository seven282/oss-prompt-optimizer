import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The published surface is `src/`; `lib/` is generated from it and the
      // client half has its own typecheck (tsconfig.client.json).
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json'],
      reportsDirectory: 'coverage',
      // The real gate: every dimension must hold at 95% or the run exits
      // non-zero. A statement-only threshold lets branch-heavy code ship
      // untested decision paths — the exact failure mode this replaces.
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
