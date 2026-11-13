// The words and readers of a verify round in the Run view.
// Statuses, results and reasons are core's (StepView.verify, VerifyCommandView); this only words them and counts
// core's per-command statuses for a summary line. Read defensively: an older core sends no `verify`.
import { isPageloadArgv } from '@shared/pageload.ts'
import { isPlaytestArgv } from '@shared/playtest.ts'
import type {
  RunOutputFile,
  StepKey,
  StepView,
  VerifyCommandStatus,
  VerifyCommandView,
  VerifyStep,
} from '@shared/run.ts'
import { RUN_OUTPUT_FILES, VERIFY_COMMAND_STATUSES } from '@shared/run.ts'
import { formatDuration } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { formatCommandLine } from './text.ts'

/** The verify rounds (verify:0 is the isolated-run baseline; verify:red is Test-first's check that the tests fail). */
export function isVerifyStep(key: StepKey): key is VerifyStep {
  return key === 'verify:0' || key === 'verify:red' || key === 'verify:1' || key === 'verify:2'
}

/**
 * Test-first's red check: its failing commands are expected (they show the new tests fail before Implement), and a
 * round with no failing command is the one that needs a look.
 */
export function isRedCheck(key: StepKey): boolean {
  return key === 'verify:red'
}

/**
 * A finished round's outcome for its marks: `problem` when it needs a look (a failing command; for the red check, none
 * failing), else `fine`. Null while the round has not finished or core sent no commands.
 */
export function verifyOutcome(view: StepView): 'fine' | 'problem' | null {
  if (view.status !== 'done') return null
  const commands = verifyCommandsOf(view)
  if (commands.length === 0) return null
  const failing = commands.some((c) => c.status === 'fail')
  return failing !== isRedCheck(view.key) ? 'problem' : 'fine'
}

/** The runs.output file a round's combined output streams through (`verify:<n>`), when core serves one. */
export function verifyOutputFile(key: StepKey): RunOutputFile | null {
  return (RUN_OUTPUT_FILES as readonly string[]).includes(key) ? (key as RunOutputFile) : null
}

/** A command's state in words, beside its icon (colour is never the only signal). */
export const VERIFY_STATUS_LABEL: Readonly<Record<VerifyCommandStatus, string>> = {
  queued: 'Waiting',
  running: 'Running',
  pass: 'Passed',
  fail: 'Failed',
  env: 'Could not run',
  'skipped-untrusted': 'Not trusted',
  skipped: 'Skipped',
}

/** What a status adds to the round's summary line ("2 passed · 1 failed"). */
const SUMMARY_WORD: Readonly<Record<VerifyCommandStatus, string>> = {
  queued: 'waiting',
  running: 'running',
  pass: 'passed',
  fail: 'failed',
  env: 'could not run',
  'skipped-untrusted': 'not trusted',
  skipped: 'skipped',
}

/** Summary order: what needs a look first. */
const SUMMARY_ORDER: readonly VerifyCommandStatus[] = [
  'fail',
  'env',
  'skipped-untrusted',
  'running',
  'queued',
  'pass',
  'skipped',
]

function isStatus(v: unknown): v is VerifyCommandStatus {
  return typeof v === 'string' && (VERIFY_COMMAND_STATUSES as readonly string[]).includes(v)
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** core's commands of a round, each checked (a malformed entry is left out); [] when core sent none. */
export function verifyCommandsOf(view: StepView): VerifyCommandView[] {
  const list = rec(view.verify)['commands']
  if (!Array.isArray(list)) return []
  const out: VerifyCommandView[] = []
  for (const x of list) {
    const c = rec(x)
    const name = c['name']
    const status = c['status']
    if (typeof name !== 'string' || !isStatus(status)) continue
    const argv = Array.isArray(c['argv']) ? c['argv'].filter((a): a is string => typeof a === 'string') : []
    const exitCode = c['exitCode']
    const durationMs = c['durationMs']
    const excerpt = c['excerpt']
    const reason = c['reason']
    const scenarios = scenariosOf(c['scenarios'])
    out.push({
      name,
      argv,
      status,
      ...(typeof exitCode === 'number' || exitCode === null ? { exitCode } : {}),
      ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs } : {}),
      ...(typeof excerpt === 'string' && excerpt !== '' ? { excerpt } : {}),
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      ...(scenarios.length > 0 ? { scenarios } : {}),
    })
  }
  return out
}

/** A play-test's scenario lines, each checked (a malformed one is left out). */
function scenariosOf(v: unknown): NonNullable<VerifyCommandView['scenarios']> {
  if (!Array.isArray(v)) return []
  const out: NonNullable<VerifyCommandView['scenarios']> = []
  for (const x of v) {
    const s = rec(x)
    const name = s['name']
    const status = s['status']
    const message = s['message']
    if (typeof name !== 'string' || (status !== 'pass' && status !== 'fail' && status !== 'error')) continue
    out.push({
      name,
      must: s['must'] !== false,
      status,
      ...(typeof message === 'string' && message !== '' ? { message } : {}),
    })
  }
  return out
}

/** failFast stopped the round (core's flag). */
export function verifyAborted(view: StepView): boolean {
  return rec(view.verify)['aborted'] === true
}

/** "2 passed · 1 failed", from core's per-command statuses; null before the round has its commands. */
export function verifySummaryText(commands: readonly VerifyCommandView[]): string | null {
  if (commands.length === 0) return null
  const counts = new Map<VerifyCommandStatus, number>()
  for (const c of commands) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  const parts: string[] = []
  for (const s of SUMMARY_ORDER) {
    const n = counts.get(s)
    if (n !== undefined && n > 0) parts.push(`${n} ${SUMMARY_WORD[s]}`)
  }
  return parts.join(' · ')
}

/** The command as the user would type it (argv joined, quoted where needed); the name when core sent no argv. */
export function verifyCommandLine(c: Pick<VerifyCommandView, 'argv' | 'name'>): string {
  // Dim Factory's own checks are no program: say what they do instead.
  if (isPlaytestArgv(c.argv)) return PLAYTEST_LINE
  if (isPageloadArgv(c.argv)) return pageloadLine(c.argv[1] ?? 'index.html')
  return c.argv.length > 0 ? formatCommandLine(c.argv) : c.name
}

/** What the built-in play-test does, in place of a command line. */
export const PLAYTEST_LINE = 'Plays playtest.json in a hidden preview with no internet'

/** What the built-in page-load check does, in place of a command line. */
export function pageloadLine(page: string): string {
  return `Opens ${page} in a hidden preview with no internet and checks it loads without console errors`
}

/** "exit 1 · 41s", "12s", "exit 127": the facts core gave about a finished command. */
export function verifyFactsText(c: VerifyCommandView): string {
  const parts: string[] = []
  if (c.status === 'fail' || c.status === 'env') {
    if (typeof c.exitCode === 'number') parts.push(`exit ${c.exitCode}`)
  }
  if (c.durationMs !== undefined && (c.status !== 'queued' || c.durationMs > 0)) {
    parts.push(formatDuration(c.durationMs))
  }
  return parts.join(' · ')
}

/** Statuses whose excerpt is shown under the row (what went wrong). */
export function showsExcerpt(c: VerifyCommandView): boolean {
  return (c.status === 'fail' || c.status === 'env') && c.excerpt !== undefined && c.excerpt !== ''
}

/** Settings → Isolation & Verify for a folder, at the commands (where a command is trusted). */
export function verifySettingsHref(folder: string | null): string {
  const query: Record<string, string> = { field: '/verify/commands' }
  if (folder !== null && folder !== '') query['folder'] = folder
  return href({ name: 'settings', section: 'isolation', query })
}
