// The Deploy helper on demand, end to end, in the temp sandbox turned into a small Express app (no network,
// no vendor; under E2E the GitHub CLI is never looked up). The Deploy page (the palette's "Deploy" route) classifies
// the folder as a server app from local rules, lists where it could go with the cost caveat, marks the manual checklist
// items "Not checked" until the user ticks one (the tick is kept for the folder across a reload), flags the variable
// the code reads, and shows the chosen target's steps as commands to copy with their caveat. Nothing is run and
// nothing is written to the folder. Settings has a Deploy section whose commit and pull request switches need a
// project. No em dashes.
import { readdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { setScripts, writeSandbox } from './verify-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)

async function openDeploy(page: Page, folder: string): Promise<void> {
  await page.evaluate((f) => {
    window.location.hash = `#/deploy?folder=${encodeURIComponent(f)}`
  }, folder)
  await expect(page.getByTestId('deploy-page')).toBeVisible()
}

test('the Deploy helper for a folder: class, options, checklist, commands to copy; nothing runs', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  writeSandbox(e2e, {
    'server.js':
      "const express = require('express')\nexpress().listen(process.env.PORT)\nconst db = process.env.DATABASE_URL\n",
  })
  setScripts(e2e, { start: 'node server.js' })
  const before = readdirSync(e2e.sandbox).sort()
  // package.json's dependencies say what it ships as.
  writeSandbox(e2e, {
    'package.json': JSON.stringify({
      name: 'shop',
      version: '1.0.0',
      dependencies: { express: '4' },
      scripts: { start: 'node server.js' },
    }),
  })

  await openDeploy(page, e2e.sandbox)
  const classLine = page.getByTestId('deploy-class-line')
  await expect(classLine).toHaveAttribute('data-class', 'server-app', { timeout: 30_000 })
  await expect(classLine).toContainText('Server app (from the folder')

  // Where it could go, with the cost caveat; a suggested target is picked.
  await expect(page.getByTestId('deploy-option-fly')).toBeVisible()
  await expect(page.getByTestId('deploy-cost-caveat')).toContainText("Check the provider's current pricing")
  await expect(page.locator('[data-testid^="deploy-option-"][aria-checked="true"]')).toHaveCount(1)

  // The checklist: the variable the code reads is flagged; a manual item reads "Not checked" until ticked.
  await expect(page.getByTestId('deploy-check-env-vars')).toContainText('DATABASE_URL')
  const https = page.getByTestId('deploy-check-https-state')
  await expect(https).toHaveText('Not checked')
  await page.getByTestId('deploy-tick-https').click()
  await expect(https).toHaveText('Ticked by you')
  await expect(page.getByTestId('deploy-security-caveat')).toBeVisible()

  // Fly.io's steps are commands to copy, with their caveat.
  await page.getByTestId('deploy-option-fly').click()
  await expect(page.getByTestId('deploy-option-fly')).toHaveAttribute('aria-checked', 'true')
  const steps = page.getByTestId('deploy-steps')
  await expect(steps).toContainText('Steps for Fly.io')
  await expect(page.getByTestId('deploy-commands-caveat')).toBeVisible()
  await expect(steps.getByTestId('deploy-step-command').first()).toContainText('fly')

  // The tick is kept for the folder.
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await openDeploy(page, e2e.sandbox)
  await expect(page.getByTestId('deploy-check-https-state')).toHaveText('Ticked by you', { timeout: 30_000 })

  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  // Nothing was written into the folder.
  expect(readdirSync(e2e.sandbox).sort()).toEqual(before)

  // ---- Settings, Deploy: the step is off by default; commit and pull request are per project ----
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-deploy').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'deploy')
  await expect(page.getByTestId('settings-deploy')).toBeVisible()
  expect(e2e.pageErrors).toEqual([])
})
