// Beginners part B's E2E helpers (shared by beginner-flows.spec.ts and beginner-flows-screens.spec.ts): the fake Claude's answers for an
// Easy project (no questions, a summary with Things to fill in), a report from data's files, walking Easy from an
// idea to a run, and reading a run's files under the test's own home (run.json, resolved.json).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PassScript } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect } from './harness.ts'
import { EASY_CONFIG, INDEX_HTML, SUMMARY } from './easy-helpers.ts'

export const EM_DASH = String.fromCodePoint(0x2014)

/** Easy chosen, no plan check, Clarify and Explain on haiku (easy-helpers.ts EASY_CONFIG). */
export const CONFIG = { ...EASY_CONFIG, ui: { experience: 'easy' }, easy: { skipPlanCheck: true } }

export const PLAN: PassScript = { recording: 'C06-plan-native-host' }
export const NO_QUESTIONS: PassScript = {
  recording: 'C02-review-shape',
  text: JSON.stringify({ questions: [] }),
}
export const PLAIN_SUMMARY: PassScript = { recording: 'C02-review-shape', text: SUMMARY }

export const FILL_INS = ["Your shop's phone number on the contact page", 'The days you post parcels']

/** The Explain summary with a Things to fill in list (the first item in bold, as a model may write it). */
export const FILL_IN_SUMMARY = [
  '## What was built',
  'A small help guide for your shop that opens in any browser.',
  '',
  '## Things to fill in',
  "- **Your shop's phone number** on the contact page",
  '- The days you post parcels',
  '',
  '## How to run it',
  '1. Open the project folder.',
  '2. Double-click index.html.',
].join('\n')

export const GUIDE_INDEX: PassScript = {
  recording: 'C08a-session-id-implement',
  write: { path: 'index.html', content: INDEX_HTML },
}

export const RETURNS = {
  path: 'docs/returns.md',
  content: '# Returns\n\nSend unused yarn back within 30 days.\n',
}

export const DATA_IDEA = 'A report of my monthly sales from my spreadsheet'
export const SAMPLE_CSV = 'month,sales\nJan,120\nFeb,150\nMar,170\n'
export const REPORT_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Monthly sales</title></head>' +
  '<body><h1>Monthly sales</h1><p>Example data: these numbers are made up.</p>' +
  '<table><tr><th>Month</th><th>Sales</th></tr><tr><td>Jan</td><td>120</td></tr></table></body></html>\n'

/**
 * Implement for a report from data: the example data in data/, the report page, and the index.html the template asks
 * for beside it (the upload file needs an index.html at the top of the folder: deploy upload.ts uploadView).
 */
export const REPORT_IMPLEMENT: PassScript = {
  recording: 'C08a-session-id-implement',
  prepend: [
    { op: 'writeFile', path: 'data/sample.csv', content: SAMPLE_CSV },
    { op: 'writeFile', path: 'index.html', content: REPORT_HTML },
  ],
  write: { path: 'report.html', content: REPORT_HTML },
}

/** Easy's home: the idea, Next, and the confirm screen's decision. */
export async function toConfirm(page: Page, idea: string): Promise<void> {
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(idea)
  await page.getByTestId('easy-next').click()
  await expect(page).toHaveURL(/#\/easy\/new$/)
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible({ timeout: 30_000 })
}

/** From the idea to a finished first run (completed), on its Done screen. Answers the run's id and folder. */
export async function firstRun(
  e2e: E2EHarness,
  page: Page,
  idea: string,
): Promise<{ runId: string; folder: string }> {
  await toConfirm(page, idea)
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  const ended = await e2e.waitForEnd(run.runId, 240_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-title')).toBeVisible({ timeout: 60_000 })
  return { runId: run.runId, folder: run.folder }
}

/** The run the URL shows now (#/easy/runs/<id>), once it is not `not`. */
export async function runInUrl(page: Page, not: string): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`#/easy/runs/(?!${not}$)[^/]+$`), { timeout: 30_000 })
  const m = /#\/easy\/runs\/([^/?]+)$/.exec(page.url())
  if (m?.[1] === undefined) throw new Error(`no run in ${page.url()}`)
  return m[1]
}

/** Make a change from the Done screen: the words, the click, and the new run's id. */
export async function makeChange(page: Page, from: string, change: string): Promise<string> {
  await page.getByTestId('easy-change-text').fill(change)
  await page.getByTestId('easy-make-change').click()
  return runInUrl(page, from)
}

export type Json = Record<string, unknown>

/** One of a run's files under the test's home (run.json, resolved.json). */
export function runFile(e2e: E2EHarness, runId: string, file: string): Json {
  return JSON.parse(readFileSync(join(e2e.home, 'runs', runId, file), 'utf8')) as Json
}

/** A value deep in a JSON object (undefined when a key on the way is missing). */
export function at(v: unknown, ...keys: string[]): unknown {
  let cur = v
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Json)[k]
  }
  return cur
}
