// Helpers shared by the attention E2E specs (asks.spec.ts, no-allow-session.spec.ts, notifications.spec.ts, auto.spec.ts, keyboard.spec.ts; timers,
// "Allow for this run"; notifications): what the fake Claude received (control responses, argv per script),
// scenario rewrites (Auto's full mode, an ask the vendor will not let be allowed for the run), core's E2E clock and
// power events, and main's E2E notification / focus hooks (src/main/e2e.ts; nothing reaches the desktop).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { encodeProjectDir } from '../../src/core/adapters/claude/session.ts'
import { RUN_EVENTS_MAX_LIMIT } from '../../src/shared/ipc.ts'
import type { E2EState } from '../../src/shared/ipc.ts'
import type { RunEnvelope, RunEventBody } from '../../src/shared/run.ts'
import type { Scenario } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'

/** The default `askMs` (10 min). */
export const ASK_MS = 600_000

// ---- the fake's log ---------------------------------------------------------------------------------------------

interface LogLine {
  pid: number
  kind: string
  [key: string]: unknown
}

/** The fake's JSONL log, tolerating a line still being written. */
function fakeLines(e2e: E2EHarness): LogLine[] {
  const file = e2e.scenario?.log
  if (file === undefined || !existsSync(file)) return []
  const out: LogLine[] = []
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (l.trim() === '') continue
    try {
      out.push(JSON.parse(l) as LogLine)
    } catch {
      // the last line, half written
    }
  }
  return out
}

export interface FakeProc {
  pid: number
  /** The scenario script it ran (`implement-1.script.jsonl`, `resume-1.script.jsonl`, …). */
  script: string
  argv: string[]
  stdin: string[]
  exited: boolean
}

/** Every `-p` process the fake started, in start order, with its script, argv and stdin. */
export function fakeProcs(e2e: E2EHarness): FakeProc[] {
  const byPid = new Map<number, FakeProc>()
  const order: FakeProc[] = []
  for (const e of fakeLines(e2e)) {
    let p = byPid.get(e.pid)
    if (e.kind === 'start') {
      p = {
        pid: e.pid,
        script: '',
        argv: Array.isArray(e['argv']) ? (e['argv'] as string[]) : [],
        stdin: [],
        exited: false,
      }
      byPid.set(e.pid, p)
      order.push(p)
      continue
    }
    if (p === undefined) continue
    if (e.kind === 'script' && typeof e['file'] === 'string')
      p.script = e['file'].replace(/\\/g, '/').split('/').pop() ?? ''
    else if (e.kind === 'stdin' && typeof e['line'] === 'string') p.stdin.push(e['line'])
    else if (e.kind === 'exit') p.exited = true
  }
  return order.filter((p) => p.argv.includes('-p') && !p.argv.includes('default'))
}

/** The process that ran `script` (throws while there is none yet). */
export function fakeProc(e2e: E2EHarness, script: string): FakeProc {
  const p = fakeProcs(e2e).find((x) => x.script === script)
  if (p === undefined) throw new Error(`the fake never ran ${script}`)
  return p
}

export interface PermissionAnswer {
  behavior: string
  message?: string
  interrupt?: boolean
  updatedPermissions?: { type: string; behavior?: string; destination?: string; rules?: unknown[] }[]
}

/** The `can_use_tool` answers (control responses) a process got on stdin, in order. */
export function permissionAnswers(p: FakeProc): PermissionAnswer[] {
  const out: PermissionAnswer[] = []
  for (const line of p.stdin) {
    let f: { type?: string; response?: { response?: unknown } }
    try {
      f = JSON.parse(line) as typeof f
    } catch {
      continue
    }
    const r = f.response?.response
    if (f.type === 'control_response' && r !== null && typeof r === 'object' && 'behavior' in r)
      out.push(r as PermissionAnswer)
  }
  return out
}

/** The session id core holds for a step (run.json; the vendor's own id once it reported one). */
export function stepSessionId(e2e: E2EHarness, runId: string, step: string): string | undefined {
  const file = join(e2e.home, 'runs', runId, 'run.json')
  const run = JSON.parse(readFileSync(file, 'utf8')) as {
    state?: { steps?: Record<string, { sessionId?: string } | undefined> }
  }
  return run.state?.steps?.[step]?.sessionId
}

/**
 * The transcript the real CLI keeps for a session (the fake keeps none), where the Claude adapter's canResume looks
 * for it: `<CLAUDE_CONFIG_DIR>/projects/<encoded folder>/<id>.jsonl`. Without it Resume starts a fresh session.
 */
export function writeTranscript(e2e: E2EHarness, sessionId: string): void {
  const dir = join(e2e.root, 'claude-config', 'projects', encodeProjectDir(e2e.sandbox))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n')
}

/** `--allowedTools <list>` of an argv, split on commas (undefined when absent). */
export function allowedTools(argv: readonly string[]): string[] | undefined {
  const i = argv.indexOf('--allowedTools')
  return i >= 0 ? (argv[i + 1]?.split(',') ?? []) : undefined
}

// ---- scenario rewrites ------------------------------------------------------------------------------------------

/**
 * Auto runs launch Implement / Fix with `bypassPermissions` (Auto = full mode): point the scenario's fresh
 * `acceptEdits` entries at that permission mode. Use as (or inside) StartOptions.editScenario.
 */
export function fullMode(sc: Scenario): void {
  const file = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as { match: { argvIncludes?: string[] } }[]
  for (const e of entries) {
    const inc = e.match.argvIncludes
    if (inc !== undefined)
      e.match.argvIncludes = inc.map((a) => (a === 'acceptEdits' ? 'bypassPermissions' : a))
  }
  writeFileSync(file, JSON.stringify(entries, null, 2))
}

/**
 * Mark every `can_use_tool` request of `<name>.script.jsonl` with `suppress_always_allow_rule: true`: the vendor
 * will not take an "always allow" rule for it (no-allow-session.spec.ts, allowSession:false).
 */
export function suppressAllowRule(sc: Scenario, name: string): void {
  const file = join(sc.dir, `${name}.script.jsonl`)
  let n = 0
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line
      const op = JSON.parse(line) as { op: string; line?: unknown }
      if (op.op !== 'stdout' || typeof op.line !== 'string') return line
      const frame = JSON.parse(op.line) as { type?: string; request?: Record<string, unknown> }
      if (frame.type !== 'control_request' || frame.request?.['subtype'] !== 'can_use_tool') return line
      frame.request['suppress_always_allow_rule'] = true
      n++
      return JSON.stringify({ ...op, line: JSON.stringify(frame) })
    })
  if (n === 0) throw new Error(`${name}: no can_use_tool request to mark`)
  writeFileSync(file, lines.join('\n'))
}

// ---- core: clock, power, the run's log ----------------------------------------------------------------------------

/** e2e.clock: move core's clock forward; resolves with core's new now. */
export async function advanceClock(e2e: E2EHarness, ms: number): Promise<number> {
  return (await e2e.call('e2e.clock', { advanceMs: ms })).now
}

export async function power(e2e: E2EHarness, event: 'suspend' | 'resume'): Promise<void> {
  await e2e.call('e2e.power', { event })
}

/** Every event body of the run so far (runs.events, paged). */
export async function runBodies(e2e: E2EHarness, runId: string): Promise<RunEventBody[]> {
  const out: RunEnvelope[] = []
  let sinceSeq = 0
  for (;;) {
    const page = await e2e.call('runs.events', { runId, sinceSeq, limit: RUN_EVENTS_MAX_LIMIT })
    out.push(...page.events)
    const last = page.events.at(-1)?.seq
    if (!page.more || last === undefined) break
    sinceSeq = last
  }
  return out.map((e) => e.body)
}

export function bodiesOf<T extends RunEventBody['t']>(
  bodies: readonly RunEventBody[],
  t: T,
): Extract<RunEventBody, { t: T }>[] {
  return bodies.filter((b): b is Extract<RunEventBody, { t: T }> => b.t === t)
}

// ---- e2e.state extras (src/main/e2e.ts) ----------------------------------------------------------------------------

/** Taskbar overlay / Dock badge / flash state main reports in e2e.state.extra.attention (attention-surfaces.ts). */
export interface AttentionSurfaces {
  needsYou: number
  overlay: string | null
  overlayDescription: string
  badge: number | null
  flashing: boolean
}

export function surfacesOf(st: E2EState): AttentionSurfaces {
  const a = st.extra?.['attention']
  if (a === undefined || a === null || typeof a !== 'object')
    throw new Error('e2e.state has no attention extra')
  return a as AttentionSurfaces
}

/** The last power state main applied ('suspend' | 'resume'). */
export function powerOf(st: E2EState): unknown {
  return st.extra?.['power']
}

// ---- main's E2E hooks (src/main/e2e.ts) -------------------------------------------------------------------------

/** A notification the main-process recorder took instead of showing it (src/main/notification-recorder.ts). */
export interface RecordedNotification {
  index: number
  id: string
  runId: string | null
  kind: string
  requestId?: string
  title: string
  body: string
  actions: string[]
  launch: string
  actionArgs: string[]
  sticky: boolean
  silent: boolean
  closed: boolean
}

/** What pressing a recorded notification did (src/main/notifications.ts ActivationOutcome). */
export type ActivationOutcome =
  | { kind: 'opened'; runId: string | null }
  | { kind: 'answered'; runId: string; requestId: string; decision: string }
  | { kind: 'stale'; runId: string; requestId: string }
  | { kind: 'error'; runId: string; message: string }
  | { kind: 'duplicate' }
  | { kind: 'unknown' }

interface MainHooks {
  notifications: {
    list(): RecordedNotification[]
    act(target: number | string, action: number | string): Promise<ActivationOutcome | null>
    activate(args: string): Promise<ActivationOutcome>
    clear(): void
  }
  focus: { simulate(focused: boolean | null): void }
}

function app(e2e: E2EHarness): NonNullable<E2EHarness['app']> {
  if (e2e.app === null) throw new Error('the app is not running')
  return e2e.app
}

/** Main treats the window as focused (true), unfocused (false), or goes back to the real focus (null). */
export async function simulateFocus(e2e: E2EHarness, focused: boolean | null): Promise<void> {
  await app(e2e).evaluate((_electron, f) => {
    const g = (globalThis as { __dimFactoryE2E?: Partial<MainHooks> }).__dimFactoryE2E
    if (g?.focus === undefined) throw new Error('the main-process focus hook is missing')
    g.focus.simulate(f)
  }, focused)
}

export async function recordedNotifications(e2e: E2EHarness): Promise<RecordedNotification[]> {
  return app(e2e).evaluate(() => {
    const g = (globalThis as { __dimFactoryE2E?: Partial<MainHooks> }).__dimFactoryE2E
    if (g?.notifications === undefined) throw new Error('the main-process notification hooks are missing')
    return g.notifications.list()
  })
}

/** Press an action (label or index) or 'click' on a recorded notification (record index or id). */
export async function actOnNotification(
  e2e: E2EHarness,
  target: number | string,
  action: number | string,
): Promise<ActivationOutcome | null> {
  return app(e2e).evaluate(
    (_electron, [t, a]) => {
      const g = (globalThis as { __dimFactoryE2E?: Partial<MainHooks> }).__dimFactoryE2E
      if (g?.notifications === undefined) throw new Error('the main-process notification hooks are missing')
      return g.notifications.act(t, a)
    },
    [target, action] as const,
  )
}

/** Replay an activation as Action Center hands it back (the arguments string). */
export async function activateNotification(e2e: E2EHarness, args: string): Promise<ActivationOutcome> {
  return app(e2e).evaluate((_electron, a) => {
    const g = (globalThis as { __dimFactoryE2E?: Partial<MainHooks> }).__dimFactoryE2E
    if (g?.notifications === undefined) throw new Error('the main-process notification hooks are missing')
    return g.notifications.activate(a)
  }, args)
}

/** Wait for a recorded notification matching `pred`. */
export async function waitForNotification(
  e2e: E2EHarness,
  pred: (n: RecordedNotification) => boolean,
  timeoutMs = 60_000,
): Promise<RecordedNotification> {
  let found: RecordedNotification | undefined
  await expect
    .poll(
      async () => {
        found = (await recordedNotifications(e2e)).find(pred)
        return found !== undefined
      },
      { timeout: timeoutMs },
    )
    .toBe(true)
  if (found === undefined) throw new Error('unreachable')
  return found
}

// ---- the page ---------------------------------------------------------------------------------------------------

/** The ask panel, once it shows an ask other than `notRequestId`; resolves with its request id. */
export async function nextAsk(page: Page, notRequestId?: string, timeoutMs = 90_000): Promise<string> {
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toBeVisible({ timeout: timeoutMs })
  if (notRequestId !== undefined)
    await expect(ask).not.toHaveAttribute('data-request-id', notRequestId, { timeout: timeoutMs })
  const id = await ask.getAttribute('data-request-id')
  if (id === null) throw new Error('the ask panel has no request id')
  return id
}

/** The toast region's items. */
export function toasts(page: Page): ReturnType<Page['locator']> {
  return page.getByRole('region', { name: 'Notifications' }).locator('li[data-toast-id]')
}
