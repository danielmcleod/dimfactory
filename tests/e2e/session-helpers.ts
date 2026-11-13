// Helpers shared by the session E2E specs (sessions and usage, state-machine row R10, failure category
// resume_failed): the composer flow with a step before Run (the Fix row), the C08 recordings' cumulative usage, a
// raw recording placed first in the scenario (C08c, a resume the CLI rejects), and what core keeps in run.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { sumClaudeModelUsage } from '../../src/core/adapters/usage.ts'
import type { Usage } from '../../src/shared/events.ts'
import type { RunSummary } from '../../src/shared/run.ts'
import { STDIO } from '../integration/run/scenario.ts'
import type { Scenario } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'

/**
 * The Dashboard composer as E2EHarness.runFromDashboard drives it (typed folder, task, Run), with `before(page)` run
 * once core resolved the folder's passes and before Run is pressed. Resolves once the new run's Run view is open.
 */
export async function composeRun(
  e2e: E2EHarness,
  task: string,
  before: (page: Page) => Promise<void>,
): Promise<RunSummary> {
  const page = e2e.p
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill(task)
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await before(page)
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  await expect(page.getByTestId('run-view')).toBeVisible()
  return run
}

/** Open the composer's pass rows and the Fix row (its session select is `fix-session`). */
export async function openFixRow(page: Page): Promise<void> {
  await page.getByTestId('composer-passes-toggle').click()
  await page.getByTestId('pass-row-toggle-fix').click()
  await expect(page.getByTestId('fix-session')).toBeVisible()
}

interface RecordedFrame {
  type?: string
  subtype?: string
  session_id?: string
  modelUsage?: Parameters<typeof sumClaudeModelUsage>[0]
}

/** The stdout frames of a recording (tests/fixtures/claude/stdio/<id>/recording.jsonl), in order. */
function recordedFrames(recording: string): RecordedFrame[] {
  const out: RecordedFrame[] = []
  for (const l of readFileSync(join(STDIO, recording, 'recording.jsonl'), 'utf8').split('\n')) {
    if (l.trim() === '') continue
    const f = JSON.parse(l) as { dir?: string; line?: string }
    if (f.dir !== 'out' || f.line === undefined) continue
    try {
      out.push(JSON.parse(f.line) as RecordedFrame)
    } catch {
      // a non-JSON stdout line
    }
  }
  return out
}

/** The cumulative session totals a recording's `result` reports (`modelUsage`, what the adapter subtracts from). */
export function cumulativeUsage(recording: string): Usage {
  const result = recordedFrames(recording).find((f) => f.type === 'result')
  if (result === undefined) throw new Error(`${recording}: no result frame`)
  return sumClaudeModelUsage(result.modelUsage)
}

/** The session id a recording's `system/init` reports. */
export function recordedSessionId(recording: string): string {
  const init = recordedFrames(recording).find((f) => f.type === 'system' && f.subtype === 'init')
  if (init?.session_id === undefined) throw new Error(`${recording}: no system/init frame`)
  return init.session_id
}

/**
 * Put a raw recording first in the scenario for argv matching `argvIncludes` (the fake replays it as recorded), e.g.
 * C08c for `--resume=*`: the CLI answers "No conversation found" and exits 1. Use inside StartOptions.editScenario.
 */
export function playFirst(sc: Scenario, argvIncludes: string[], recording: string): void {
  const file = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
  const first = { match: { argvIncludes }, script: join(STDIO, recording, 'recording.jsonl') }
  writeFileSync(file, JSON.stringify([first, ...entries], null, 2))
}

/** A step as core keeps it in run.json (fields StepView does not carry, e.g. the retry budget). */
export interface StoredStep {
  status?: string
  attempt?: number
  autoRetryUsed?: boolean
  sessionId?: string
  sessionNote?: string
}

export function storedStep(e2e: E2EHarness, runId: string, step: string): StoredStep {
  const run = JSON.parse(readFileSync(join(e2e.home, 'runs', runId, 'run.json'), 'utf8')) as {
    state?: { steps?: Record<string, StoredStep | undefined> }
  }
  const st = run.state?.steps?.[step]
  if (st === undefined) throw new Error(`run.json has no ${step} step`)
  return st
}

/** `--session-id=<id>` / `--session-id <id>` of an argv, if any. */
export function argvSessionId(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--session-id=')) return a.slice('--session-id='.length)
    if (a === '--session-id') return argv[i + 1]
  }
  return undefined
}
