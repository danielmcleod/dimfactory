// Playwright E2E via `_electron` (the scenario specs in tests/e2e). `pnpm e2e` builds first. One
// worker: each test launches its own Electron with an isolated DIM_FACTORY_HOME. Timeouts are generous because a
// process start costs about a second on some Windows machines (antivirus).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: process.env['CI'] !== undefined ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env['CI'] !== undefined ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
})
