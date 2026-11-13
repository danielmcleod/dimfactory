// Helpers shared by the composer and Dashboard E2E specs (first-launch.spec.ts, queued-run.spec.ts): a run by its display
// number, a fake `auth status` that answers "not logged in" until the user "logs in" (the scenario file is swapped
// back), the developer's clipboard kept around a test, and clean scenarios for repeated runs.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSummary } from '../../src/shared/run.ts'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'

/** The run with this display number (runs.list), waiting for it to exist. */
export async function runByNo(e2e: E2EHarness, no: number, timeoutMs = 30_000): Promise<RunSummary> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const r = await e2e.invoke('runs.list', {})
    const found = r.ok ? r.value.items.find((s) => s.displayNo === no) : undefined
    if (found !== undefined) return found
    if (Date.now() > end) throw new Error(`run #${no} was not created`)
    await e2e.p.waitForTimeout(250)
  }
}

/**
 * `n` clean runs: Plan → Implement (writes its own file, so every run changes something) → NO FINDINGS reviewers
 * (the default) → Fix skipped.
 */
export function cleanRuns(n: number): ScenarioSpec {
  return {
    plan: Array.from({ length: n }, () => ({ recording: 'C06-plan-native-host' })),
    implement: Array.from({ length: n }, (_, i) => ({
      recording: 'C08a-session-id-implement',
      write: {
        path: `src/flag${i + 1}.ts`,
        content: `export const flag${i + 1} = true
`,
      },
    })),
  }
}

/** `claude auth status` as a logged-out CLI answers it: exit 1 (failure category auth_required). */
const LOGGED_OUT = [
  { op: 'stdout', line: '{' },
  { op: 'stdout', line: '  "loggedIn": false,' },
  { op: 'stdout', line: '  "authMethod": "none",' },
  { op: 'stdout', line: '  "apiProvider": "firstParty"' },
  { op: 'stdout', line: '}' },
  { op: 'exit', code: 1 },
]

interface ScenarioEntry {
  match: { argvIncludes?: string[] }
  script: string
}

/**
 * Make the scenario's `auth status` answer "not logged in" (exit 1). Returns `login()`, which restores the recorded
 * logged-in answer, as if the user ran `claude auth login`. Use as StartOptions.editScenario.
 */
export function logOut(sc: Scenario): { login: () => void } {
  const file = join(sc.dir, 'scenario.json')
  const original = readFileSync(file, 'utf8')
  const entries = JSON.parse(original) as ScenarioEntry[]
  const auth = entries.find((e) => e.match.argvIncludes?.join(' ') === 'auth status')
  if (auth === undefined) throw new Error('the scenario has no auth status entry')
  const failing = join(sc.dir, 'auth-logged-out.script.jsonl')
  writeFileSync(failing, `${LOGGED_OUT.map((o) => JSON.stringify(o)).join('\n')}\n`)
  auth.script = failing
  writeFileSync(file, JSON.stringify(entries, null, 2))
  return { login: () => writeFileSync(file, original) }
}

/** Run `fn` and put the developer's clipboard text back afterwards, whatever happens (full-run.spec.ts does the same). */
export async function keepingClipboard<T>(e2e: E2EHarness, fn: () => Promise<T>): Promise<T> {
  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    return await fn()
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }
}

/** The system clipboard's text, read in main. */
export async function clipboardText(e2e: E2EHarness): Promise<string> {
  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  return app.evaluate(({ clipboard }) => clipboard.readText())
}
