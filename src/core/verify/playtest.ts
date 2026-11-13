// Dim Factory's own play-test as a Verify command (`dimf:playtest playtest.json`, PLAYTEST_ARGV). It is never spawned:
// the round reads the project's playtest.json (data, checked against its format, never evaluated) and hands it to the
// play-tester the host gave it (the app: main plays the game in its sandboxed preview, a hidden window on its own
// session with no Node, no internet and no permissions). No trust grant is needed, since nothing of the project runs
// outside that page. Without a play-tester (the command-line tool has no Electron) it reports "not checked here" and is
// not a finding. Only `must` scenarios decide it: one that does not pass fails the command (a `[must]` verify finding,
// so Fix and fix-until-green repair the game); the other scenarios and the built-in game checks are reported in its log.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlaytestReport, PlaytestSpec, VerifyScenarioLine } from '../../shared/playtest.ts'
import {
  PLAYTEST_FILE,
  PLAYTEST_FILE_MAX_BYTES,
  PLAYTEST_TIMEOUT_MS,
  failedMustScenarios,
  parsePlaytestText,
} from '../../shared/playtest.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'

/** What the round asks a play-tester to do. */
export interface PlaytestRequest {
  /** The folder whose game is played (the command's cwd: the run's folder, or its isolated copy). */
  folder: string
  spec: PlaytestSpec
  runId: string
  /** Where screenshots may be kept (the command's log folder). */
  dir: string
  signal: AbortSignal
}

/** A play-tester's answer: what it saw, or why it could not play here. */
export type PlaytestOutcome = { kind: 'report'; report: PlaytestReport } | { kind: 'skipped'; reason: string }

export type Playtester = (r: PlaytestRequest) => Promise<PlaytestOutcome>

/** Said when there is no play-tester (the command-line tool). */
export const PLAYTEST_NOT_HERE =
  'Not checked here: the play-test needs the Dim Factory app, which plays the game in its sandboxed preview'
export const PLAYTEST_NO_FILE = 'There is no playtest.json in the project yet'

const MESSAGE_MAX = 300
const cut = (s: string): string => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s)

/** playtest.json read and checked: the spec, missing (null), or why it is refused. */
export async function readPlaytestFile(
  folder: string,
): Promise<{ spec: PlaytestSpec } | { missing: true } | { error: string }> {
  const file = join(folder, PLAYTEST_FILE)
  try {
    const s = await stat(file)
    if (!s.isFile()) return { missing: true }
    if (s.size > PLAYTEST_FILE_MAX_BYTES)
      return { error: `playtest.json is larger than ${PLAYTEST_FILE_MAX_BYTES / 1024} KB.` }
  } catch {
    return { missing: true }
  }
  const r = parsePlaytestText(await readFile(file, 'utf8'))
  return r.ok ? { spec: r.spec } : { error: r.error }
}

/** The scenario lines a result carries. */
export function scenarioLines(report: Pick<PlaytestReport, 'scenarios'>): VerifyScenarioLine[] {
  return report.scenarios.map((s) => ({
    name: s.name,
    must: s.must,
    status: s.status,
    ...(s.failure !== undefined
      ? { message: cut(`step ${s.failure.step} (${s.failure.what}): ${s.failure.message}`) }
      : {}),
  }))
}

/** The play-test's log: each scenario as passed or failed, then the game checks, console errors and blocked requests. */
export function playtestLogLines(report: PlaytestReport): string[] {
  const out: string[] = []
  if (report.error !== undefined) out.push(`The play-test could not finish: ${report.error}`)
  for (const s of report.scenarios) {
    const tag = s.status === 'pass' ? 'PASS ' : s.status === 'fail' ? 'FAIL ' : 'ERROR'
    const need = s.must ? '' : ' (not required)'
    const why =
      s.failure !== undefined ? `: step ${s.failure.step} (${s.failure.what}): ${cut(s.failure.message)}` : ''
    out.push(`${tag} ${s.name}${need}${why}`)
  }
  for (const c of report.checks) {
    if (c.status === 'pass') out.push(`check ${c.id}: ok, ${c.title}`)
    else
      out.push(`check ${c.id}: ${c.status}, ${c.title}${c.detail !== undefined ? ` (${cut(c.detail)})` : ''}`)
  }
  for (const e of report.consoleErrors.slice(0, 10)) out.push(`console error: ${cut(e.message)}`)
  for (const b of report.blocked.slice(0, 10))
    out.push(`blocked (no internet for game previews): ${cut(b.url)}`)
  return out
}

/** The result's status and its reason from a report (only `must` scenarios decide it). */
export function playtestVerdict(report: PlaytestReport): { status: 'pass' | 'fail'; reason?: string } {
  if (!report.loaded) return { status: 'fail', reason: report.error ?? 'The game page did not load' }
  const failed = failedMustScenarios(report)
  if (failed.length > 0) {
    const n = report.scenarios.filter((s) => s.must).length
    return {
      status: 'fail',
      reason: `${failed.length} of ${n} must scenario${n === 1 ? '' : 's'} did not pass: ${failed.map((s) => s.name).join('; ')}`,
    }
  }
  return { status: 'pass' }
}

export interface RunPlaytestOptions {
  name: string
  argv: string[]
  /** The command's folder. */
  cwd: string
  runId: string
  logDir: string
  /** The command's log, already holding its header line. */
  write: (text: string) => void
  playtester: Playtester | undefined
  signal: AbortSignal | undefined
  now?: () => number
}

/** Run the built-in play-test (see the header). Never throws. */
export async function runPlaytest(o: RunPlaytestOptions): Promise<VerifyCommandResult> {
  const now = o.now ?? Date.now
  const started = now()
  const base = { name: o.name, argv: [...o.argv] }
  const skipped = (reason: string): VerifyCommandResult => {
    return {
      ...base,
      status: 'skipped',
      exitCode: null,
      durationMs: now() - started,
      excerpt: '',
      logPath: '',
      reason,
    }
  }
  if (o.playtester === undefined) return skipped(PLAYTEST_NOT_HERE)
  const file = await readPlaytestFile(o.cwd)
  if ('missing' in file) return skipped(PLAYTEST_NO_FILE)
  if ('error' in file) {
    o.write(`${file.error}\n`)
    return {
      ...base,
      status: 'fail',
      exitCode: null,
      durationMs: now() - started,
      excerpt: file.error,
      logPath: '',
      reason: 'playtest.json does not fit its format',
    }
  }
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  if (o.signal?.aborted === true) ac.abort()
  const timer = setTimeout(() => ac.abort(), PLAYTEST_TIMEOUT_MS)
  let outcome: PlaytestOutcome
  try {
    outcome = await o.playtester({
      folder: o.cwd,
      spec: file.spec,
      runId: o.runId,
      dir: o.logDir,
      signal: ac.signal,
    })
  } catch (err) {
    outcome = {
      kind: 'report',
      report: {
        url: '',
        loaded: false,
        hook: false,
        scenarios: [],
        checks: [],
        measures: {},
        consoleErrors: [],
        failedLoads: [],
        blocked: [],
        durationMs: now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
  if (o.signal?.aborted === true) return skipped('Stopped before it finished')
  if (outcome.kind === 'skipped') return skipped(outcome.reason)
  const report = outcome.report
  const lines = playtestLogLines(report)
  o.write(lines.map((l) => `${l}\n`).join(''))
  const verdict = playtestVerdict(report)
  const durationMs = now() - started
  const scenarios = scenarioLines(report)
  if (verdict.status === 'pass')
    return { ...base, status: 'pass', exitCode: null, durationMs, excerpt: '', logPath: '', scenarios }
  const excerpt = lines.filter((l) => !l.startsWith('PASS ') && !/^check \w+: ok/.test(l)).join('\n')
  return {
    ...base,
    status: 'fail',
    exitCode: null,
    durationMs,
    excerpt: excerpt.length > 4000 ? `${excerpt.slice(0, 4000)}…` : excerpt,
    logPath: '',
    scenarios,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
  }
}
