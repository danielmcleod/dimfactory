// Easy mode's E2E helpers: the fake Claude's scenario for a new project made from an idea (plain questions, a plan
// with acceptance criteria, the files, the acceptance review's verdicts, the plain-language summary), edits to the
// generated scripts (the plan's text, a pass's cost), and walking the Easy screens from the idea to the run.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import { synth } from '../synth.ts'

export const IDEA =
  'A help guide for the customers of my knitting shop: how to order, how shipping works and how to care for the yarn.'

export const QUESTIONS = {
  questions: [{ question: 'Who will read it?', options: ['New customers', 'Regular customers'] }],
}

export const CRITERIA = ['A customer can read how to order', 'A customer can read how shipping works']

export const VERDICTS = {
  verdicts: [
    { id: 'AC1', status: 'met', evidence: 'docs/ordering.md and index.html explain ordering' },
    { id: 'AC2', status: 'met', evidence: 'docs/shipping.md and index.html explain shipping' },
  ],
}

export const SUMMARY = [
  '## What was built',
  'A small help guide for your shop that opens in any browser.',
  '',
  '## How to run it',
  '1. Open the project folder.',
  '2. Double-click index.html.',
  '',
  '## What to try next',
  '- Read each page on your phone.',
  '',
  '## Known limits',
  '- None known.',
].join('\n')

export const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Knitting shop help</title></head>' +
  '<body><h1>Knitting shop help</h1><p>How to order, shipping and yarn care.</p></body></html>\n'

/**
 * The fake Claude for one Easy project: Clarify and Explain run read-only on the Plan pass's model (haiku here), so they
 * take the explain list in turn (questions, then the summary); the acceptance review takes the first review entry.
 */
export function easyScenario(
  o: { implementDelayMs?: number; implement?: ScenarioSpec['implement'] } = {},
): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    implement: o.implement ?? [
      {
        recording: 'C08a-session-id-implement',
        write: { path: 'index.html', content: INDEX_HTML },
        ...(o.implementDelayMs !== undefined ? { delayMs: o.implementDelayMs } : {}),
      },
    ],
    review: [{ recording: 'C02-review-shape', text: JSON.stringify(VERDICTS), structured: VERDICTS }],
    explain: [
      { recording: 'C02-review-shape', text: JSON.stringify(QUESTIONS) },
      { recording: 'C02-review-shape', text: SUMMARY },
    ],
  }
}

/** The user file keys every Easy test starts with: Clarify and Explain on haiku (see easyScenario). */
export const EASY_CONFIG = { passes: { plan: { model: 'haiku' } } }

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function mapScript(file: string, edit: (frame: { [k: string]: Json }) => boolean): void {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out = lines.map((l) => {
    if (l.trim() === '') return l
    const op = JSON.parse(l) as { op: string; line?: string }
    if (op.op !== 'stdout' || typeof op.line !== 'string') return l
    let frame: { [k: string]: Json }
    try {
      frame = JSON.parse(op.line) as { [k: string]: Json }
    } catch {
      return l
    }
    return edit(frame) ? JSON.stringify({ ...op, line: JSON.stringify(frame) }) : l
  })
  writeFileSync(file, out.join('\n'))
}

/** The recorded plan (synthesized from `# Plan: add --version flag`) becomes the knitting guide's, with its acceptance criteria. */
export function withCriteria(sc: Scenario): void {
  withPlan(sc, [
    '# Plan: a help guide for the knitting shop',
    '',
    '## Goal',
    'Pages that explain ordering, shipping and yarn care, opened from index.html.',
    '',
    '## Acceptance criteria',
    ...CRITERIA.map((c) => `- ${c}`),
    '',
  ])
}

/** The recorded plan (synthesized from `# Plan: add --version flag`) becomes the given lines. */
export function withPlan(sc: Scenario, lines: readonly string[]): void {
  const plan = lines.join('\n')
  const walk = (v: Json): boolean => {
    let changed = false
    if (Array.isArray(v)) {
      for (const x of v) changed = walk(x) || changed
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'plan' && typeof x === 'string' && x.startsWith(synth('# Plan: add'))) {
          v[k] = plan
          changed = true
        } else changed = walk(x) || changed
      }
    }
    return changed
  }
  mapScript(join(sc.dir, 'plan-1.script.jsonl'), walk)
}

/** A pass's reported cost (its result frames' total_cost_usd), so a limit is reached at a known point. */
export function setCost(sc: Scenario, script: string, usd: number): void {
  mapScript(join(sc.dir, script), (f) => {
    if (f['type'] !== 'result') return false
    f['total_cost_usd'] = usd
    return true
  })
}

/** The script names makeScenario wrote (for a test's own checks). */
export function scripts(sc: Scenario): string[] {
  return readdirSync(sc.dir).filter((f) => f.endsWith('.script.jsonl'))
}

/** Easy's home: type the idea, Next, and wait for the confirm screen's decision. */
export async function ideaToConfirm(page: Page, idea = IDEA): Promise<void> {
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(idea)
  await page.getByTestId('easy-next').click()
  await expect(page).toHaveURL(/#\/easy\/new$/)
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible()
}
