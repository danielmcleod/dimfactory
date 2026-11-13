// Day-1 spike: Playwright drives the built app through `_electron` with an isolated DIM_FACTORY_HOME.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('@smoke the built app launches, loads the renderer and exposes the preload bridge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dim-factory-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DIM_FACTORY_HOME: home, DIM_FACTORY_E2E: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('#root')).not.toBeEmpty()
    const platform = await page.evaluate(
      () => (window as unknown as { dimFactory?: { platform?: string } }).dimFactory?.platform,
    )
    expect(platform).toBe(process.platform)
  } finally {
    await app.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
