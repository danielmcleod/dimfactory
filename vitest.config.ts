import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

const alias = {
  '@shared': r('./src/shared'),
  '@core': r('./src/core'),
  '@renderer': r('./src/renderer/src'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    globalSetup: ['tests/setup/global.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Some unit tests spawn real processes (git, taskkill, a fake CLI); Windows process start-up under full
          // parallelism needs more than the 5 s default.
          testTimeout: 15_000,
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/setup/home.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/setup/home.ts'],
          pool: 'forks',
          // Generous: on a Windows machine where each process start costs ~1 s (antivirus), suites that spawn git and
          // the fake CLI hundreds of times need it. Assertions stay strict; only the wall-clock budget grows.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          // Rendering hundreds of rows in happy-dom takes about a second alone and several under the full suite's
          // parallel load; the same budget as the unit project, assertions unchanged.
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Source files only (the prompt templates, seeds and styles beside them are not code).
      include: ['src/core/**/*.ts', 'src/shared/**/*.ts', 'src/renderer/src/**/*.{ts,tsx}'],
      // The vendored, generated protocol types (type-only, no runtime lines; eslint skips them too).
      exclude: ['src/core/adapters/*/protocol/**'],
      // The coverage bar: ≥ 80% lines and ≥ 75% branches on core + shared, measured over the
      // unit and integration projects (`pnpm test:coverage`). Keyed by glob, so a run that measures only the
      // renderer (`pnpm test:coverage:renderer`, no bar) checks nothing it did not measure.
      thresholds: {
        'src/{core,shared}/**': { lines: 80, branches: 75 },
      },
    },
  },
})
