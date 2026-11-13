// Chaos drivers ("Crash relaunch", state-machine row P24; the home's storage files): a temp home, a fake
// Claude scenario and a git sandbox; a child Dim Factory (fixtures/core-child.ts) that drives a run and is killed at a
// named point (src/core/chaos.ts, DIM_FACTORY_E2E_CHAOS_KILL); then the checks every kill must pass: every JSON file
// parses and no temp file is left, run.json, events.jsonl and runs/index.jsonl agree, no process the dead instance
// started outlives the relaunch, and nothing starts again on its own. Everything lives in temp folders; only processes
// this suite started (the child, the fakes it ran) are killed, by pid.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { Core, CreateCoreOptions } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { grantTrust } from '../../../src/core/config/trust.ts'
import { ATOMIC_TEMP_NAME } from '../../../src/core/store/atomic.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type {
  CardKind,
  RunEnvelope,
  RunOutcome,
  RunSnapshot,
  RunStatus,
  StepKey,
} from '../../../src/shared/run.ts'
import { STEP_KEYS } from '../../../src/shared/run.ts'
import { cleanup, git, hermeticEnv, makeHome, makeSandbox, makeScenario, passArgvs } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import type { ChildAction, ChildPlan } from './fixtures/core-child.ts'

const CHILD = fileURLToPath(new URL('./fixtures/core-child.ts', import.meta.url))

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

/** Passes when src/version.ts names 1.0.0 (exit 0), else exit 1; each run appends its pid to `.verify-runs` there. */
export const CHECK_SCRIPT = [
  "import { appendFileSync, readFileSync } from 'node:fs'",
  "appendFileSync(new URL('./.verify-runs', import.meta.url), String(process.pid) + '\\n')",
  "let v = ''",
  "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
  "if (v.includes('1.0.0')) { console.log('version ok'); process.exit(0) }",
  "console.error('expected version 1.0.0, got ' + (v.trim() || 'nothing'))",
  'process.exit(1)',
].join('\n')

export const version = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

export interface ChaosWorld {
  sc: Scenario
  home: string
  folder: string
}

export interface ChildOutcome {
  /** The child Dim Factory's pid. */
  pid: number
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  runId: string | undefined
  /** Where the child killed itself (src/core/chaos.ts's note), or undefined when it was not killed. */
  killed: { point: string; n: number; pid: number } | undefined
  done: boolean
}

export class Chaos {
  readonly dirs: string[] = []
  /** The children started; only one that has not exited is killed (its pid may be another process's by then). */
  readonly children: ChildProcess[] = []
  readonly cores: Core[] = []

  /** A scenario, a home, a git sandbox with `check.mjs` committed (and its verify grant when `trustCheck`). */
  async world(spec: ScenarioSpec, o: { trustCheck?: boolean; committed?: Record<string, string> } = {}) {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    this.dirs.push(home, sc.dir, folder)
    for (const [rel, text] of Object.entries({ 'check.mjs': CHECK_SCRIPT, ...o.committed }))
      writeFileSync(join(folder, rel), text)
    writeFileSync(join(folder, '.gitignore'), '.verify-runs\n')
    git(folder, 'add', '-A')
    git(folder, 'commit', '-q', '-m', 'chaos scripts')
    if (o.trustCheck === true) {
      await grantTrust(
        folder,
        { kind: 'command', command: { kind: 'verify', argv: ['node', 'check.mjs'], cwdRel: '.' } },
        { home },
      )
    }
    return { sc, home, folder } satisfies ChaosWorld
  }

  /**
   * Run the child Dim Factory on `w` with `plan`, killed at `kill` (`<point>[#n]`) when given, every point it reaches
   * appended to `trace` when given. Resolves once it exited: killed (its note says where), done, or failed.
   */
  async child(
    w: ChaosWorld,
    plan: { overrides: Record<string, unknown>; actions: ChildAction[]; task?: string },
    o: { kill?: string; trace?: string; timeoutMs?: number; killWhen?: (out: string) => boolean } = {},
  ): Promise<ChildOutcome> {
    const { kill, trace } = o
    const timeoutMs = o.timeoutMs ?? 240_000
    const file = join(w.sc.dir, `plan-${Date.now()}.json`)
    const body: ChildPlan = {
      home: w.home,
      folder: w.folder,
      task: plan.task ?? 'add a --version flag',
      overrides: plan.overrides,
      actions: plan.actions,
    }
    writeFileSync(file, JSON.stringify(body, null, 2))
    const env = hermeticEnv({
      DIM_FACTORY_E2E: '1',
      ...(kill !== undefined ? { DIM_FACTORY_E2E_CHAOS_KILL: kill } : {}),
      ...(trace !== undefined ? { DIM_FACTORY_E2E_CHAOS_TRACE: trace } : {}),
    })
    const child = spawn(process.execPath, [CHILD, file], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.children.push(child)
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
    // `killWhen` (given the child's output so far): the test kills the child itself, by its pid, as Task Manager would.
    const poll =
      o.killWhen !== undefined
        ? setInterval(() => {
            if (o.killWhen?.(out) === true) child.kill('SIGKILL')
          }, 100)
        : undefined
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`the chaos child did not end within ${timeoutMs} ms: ${out}`))
        }, timeoutMs)
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      },
    ).finally(() => clearInterval(poll))
    const marker = join(w.home, 'e2e', 'chaos.json')
    const killed = existsSync(marker)
      ? (JSON.parse(readFileSync(marker, 'utf8')) as { point: string; n: number; pid: number })
      : undefined
    // A kill inside runs.start comes before the child names the run: the home's one run folder does.
    const runsDir = join(w.home, 'runs')
    const folders = existsSync(runsDir)
      ? readdirSync(runsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : []
    return {
      pid: child.pid ?? 0,
      ...exit,
      out,
      runId: /^RUN (\S+)$/m.exec(out)?.[1] ?? (folders.length === 1 ? folders[0] : undefined),
      killed,
      done: /^DONE$/m.test(out),
    }
  }

  /** The next Dim Factory on the same home (in this process; no kill armed). */
  async relaunch(
    w: ChaosWorld,
    o: Partial<CreateCoreOptions> = {},
  ): Promise<{ core: Core; events: RunEnvelope[] }> {
    const core = await createCore({
      home: w.home,
      host: { kind: 'app' },
      env: hermeticEnv({ DIM_FACTORY_E2E: '1' }),
      ...o,
    })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 'chaos', run: (e) => events.push(e) })
    return { core, events }
  }

  async stop(core: Core): Promise<void> {
    const i = this.cores.indexOf(core)
    if (i >= 0) this.cores.splice(i, 1)
    await core.shutdown()
  }

  async dispose(): Promise<void> {
    for (const c of this.cores.splice(0)) await c.shutdown().catch(() => undefined)
    for (const child of this.children.splice(0))
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    cleanup(...this.dirs.splice(0))
  }
}

// ---- checks ---------------------------------------------------------------------------------------------------------

const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export interface FileReport {
  /** JSON files that do not parse. */
  badJson: string[]
  /** JSONL files with a complete line that does not parse (`file:line`). */
  badLines: string[]
  /** JSONL files whose last line has no newline (a torn append). */
  tornTail: string[]
  /** Temp files of an atomic write (`*.tmp`). */
  temps: string[]
}

/** Every JSON and JSONL file under the home's runs/, catalog/ and top level (logs and shadows aside). */
export function homeFiles(home: string): FileReport {
  const files = [
    ...walk(join(home, 'runs')),
    ...walk(join(home, 'catalog')),
    ...readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(home, e.name)),
  ]
  const r: FileReport = { badJson: [], badLines: [], tornTail: [], temps: [] }
  for (const f of files) {
    const rel = f.slice(home.length + 1)
    if (/\.tmp$/i.test(f)) r.temps.push(rel)
    else if (/\.json$/i.test(f) && !/dimfactory\.json$/i.test(f)) {
      try {
        JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        r.badJson.push(rel)
      }
    } else if (/\.jsonl$/i.test(f)) {
      const text = readFileSync(f, 'utf8')
      if (text !== '' && !text.endsWith('\n')) r.tornTail.push(rel)
      const lines = text.split('\n')
      lines.pop()
      lines.forEach((l, i) => {
        if (l.trim() === '') return
        try {
          JSON.parse(l)
        } catch {
          r.badLines.push(`${rel}:${i + 1}`)
        }
      })
    }
  }
  return r
}

export function runDoc(home: string, runId: string): RunDoc {
  return JSON.parse(readFileSync(join(home, 'runs', runId, 'run.json'), 'utf8')) as RunDoc
}

/** events.jsonl's envelopes (complete lines; the header skipped). */
export function logEnvelopes(home: string, runId: string): RunEnvelope[] {
  const file = join(home, 'runs', runId, 'events.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.pop()
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEnvelope & { t?: string })
    .filter((v) => v.t !== 'header')
}

/** The runs index as a reader sees it: the last line for each run (`del` removes it). */
export function indexEntries(home: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  const file = join(home, 'runs', 'index.jsonl')
  if (!existsSync(file)) return map
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.pop()
  for (const l of lines) {
    if (l.trim() === '') continue
    const v = JSON.parse(l) as { op: string; s?: Record<string, unknown>; id?: string }
    if (v.op === 'put' && v.s !== undefined) map.set(String(v.s['runId']), v.s)
    else if (v.op === 'del' && v.id !== undefined) map.delete(v.id)
  }
  return map
}

/**
 * run.json, events.jsonl and runs/index.jsonl as one story (read once the core that wrote them closed): run.json has
 * the log's last seq, each step's status and the run's status and phase are the last ones the log announced, and the
 * index lists the run with run.json's status, phase and outcome. The problems found, as text.
 */
export function consistency(home: string, runId: string): string[] {
  const problems: string[] = []
  const doc = runDoc(home, runId)
  const envs = logEnvelopes(home, runId)
  const lastSeq = envs.reduce((m, e) => Math.max(m, e.seq), 0)
  if (doc.lastSeq !== lastSeq) problems.push(`run.json lastSeq ${doc.lastSeq}, events.jsonl ${lastSeq}`)
  const seqs = envs.map((e) => e.seq)
  for (let i = 1; i < seqs.length; i++) {
    if ((seqs[i] as number) !== (seqs[i - 1] as number) + 1) {
      problems.push(`events.jsonl seq ${seqs[i - 1]} then ${seqs[i]}`)
      break
    }
  }
  const s = doc.state
  for (const k of STEP_KEYS) {
    const last = envs
      .map((e) => e.body)
      .filter(
        (b): b is Extract<RunEnvelope['body'], { t: 'step-status' }> => b.t === 'step-status' && b.step === k,
      )
      .at(-1)
    if (last !== undefined && last.status !== s.steps[k].status)
      problems.push(`${k}: run.json ${s.steps[k].status}, events.jsonl ${last.status}`)
  }
  const run = envs
    .map((e) => e.body)
    .filter((b): b is Extract<RunEnvelope['body'], { t: 'run-status' }> => b.t === 'run-status')
    .at(-1)
  if (run !== undefined && (run.status !== s.status || run.phase !== s.phase))
    problems.push(`run: run.json ${s.status}/${s.phase}, events.jsonl ${run.status}/${run.phase}`)
  const idx = indexEntries(home).get(runId)
  if (idx === undefined) problems.push('runs/index.jsonl does not list the run')
  else {
    for (const key of ['status', 'phase', 'outcome'] as const) {
      if (idx[key] !== s[key]) problems.push(`index ${key} ${String(idx[key])}, run.json ${String(s[key])}`)
    }
  }
  return problems
}

/** Every pid the dead instance's processes had: procs.json records and every fake (and grandchild) the log names. */
export function deadInstancePids(w: ChaosWorld, runId: string | undefined): number[] {
  const pids = new Set<number>()
  if (runId !== undefined) {
    const file = join(w.home, 'runs', runId, 'procs.json')
    if (existsSync(file)) {
      try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as { procs?: { pid: number }[] }
        for (const p of v.procs ?? []) pids.add(p.pid)
      } catch {
        // checked by homeFiles
      }
    }
  }
  for (const e of w.sc.entries())
    if (e.kind === 'start' || e.kind === 'grandchild') pids.add(Number(e['pid'] ?? e.pid))
  for (const pid of readVerifyPids(w.folder)) pids.add(pid)
  return [...pids].filter((p) => Number.isInteger(p) && p > 0)
}

/** The pids check.mjs recorded (one line per run). */
export function readVerifyPids(folder: string): number[] {
  const f = join(folder, '.verify-runs')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(Number)
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pids still alive after `ms` (polled). */
export async function survivors(pids: readonly number[], ms = 20_000): Promise<number[]> {
  const end = Date.now() + ms
  let left = pids.filter(alive)
  while (left.length > 0 && Date.now() < end) {
    await sleep(200)
    left = left.filter(alive)
  }
  return left
}

/** Pass spawns (fake log) and verify runs (check.mjs) so far: what "nothing auto-resumes" compares. */
export function workCount(w: ChaosWorld): { passes: number; verify: number } {
  return { passes: passArgvs(w.sc.entries()).length, verify: readVerifyPids(w.folder).length }
}

/** Each step's status (and pause) in a state: what two relaunches compare. */
export function stepStatuses(s: RunState): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of STEP_KEYS) {
    const st = s.steps[k]
    out[k] = st.pause !== undefined ? `${st.status}(${st.pause})` : st.status
  }
  return out
}

/** File size (for the "no partial file" checks), or -1 when missing. */
export function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

// ---- one kill, checked end to end -------------------------------------------------------------------------------

/** What the relaunch after a kill must show ("Crash relaunch"; state-machine row P24). */
export interface KillExpect {
  /** The steps the relaunch paused(interrupted) (recovery.paused); none when absent. */
  paused?: StepKey[]
  /** The run's status after the relaunch (default `paused` when steps were paused). */
  status?: RunStatus
  /** The open cards after the relaunch, by kind (default none). */
  cards?: CardKind[]
  outcome?: RunOutcome
}

export interface Relaunched {
  core: Core
  runId: string
  snap: RunSnapshot
  events: RunEnvelope[]
}

/** Step keys whose status is paused(interrupted) in a snapshot. */
export function interruptedSteps(snap: RunSnapshot): StepKey[] {
  return STEP_KEYS.filter((k) => snap.steps[k].status === 'paused' && snap.steps[k].pause === 'interrupted')
}

/**
 * After the child was killed at `point` (`external`: by the test, by pid): the files a reader parses are whole, the
 * next Dim Factory recovers the run as `want` says without starting anything on its own, every process the dead one
 * started is gone, run.json, events.jsonl and runs/index.jsonl agree with no temp file left, and a second relaunch
 * finds nothing more to do. Returns that second core (still running) for the case's own checks.
 */
export async function verifyRelaunch(
  chaos: Chaos,
  w: ChaosWorld,
  k: ChildOutcome,
  point: string,
  want: KillExpect,
): Promise<Relaunched> {
  expect(k.done, k.out).toBe(false)
  if (point === 'external') expect(k.killed, k.out).toBeUndefined()
  else {
    const [name, nth] = point.split('#')
    expect(k.killed, k.out).toEqual(expect.objectContaining({ point: name, n: Number(nth ?? '1') }))
  }
  const runId = k.runId
  if (runId === undefined) throw new Error(`no run: ${k.out}`)
  // Atomic writes: nothing a reader parses is ever half written (an append may be torn; the next writer drops it).
  const before = homeFiles(w.home)
  expect(before.badJson, 'JSON after the kill').toEqual([])
  expect(before.badLines, 'JSONL after the kill').toEqual([])
  // Children still starting (a verify command recording its pid) get a moment before the pids are read.
  await sleep(1000)
  const pids = deadInstancePids(w, runId)
  // A kill in the middle of an atomic write leaves its temp file behind: one such file of the dead process in the run
  // folder and one in the home, as a kill between a temp write and its rename leaves them (whichever this kill hit).
  for (const temp of [join(w.home, 'runs', runId, 'run.json'), join(w.home, 'trust.json')])
    writeFileSync(`${temp}.${k.pid}.0badc0de.tmp`, '{"half": ')

  const { core } = await chaos.relaunch(w)
  expect(core.recovery.errors).toEqual([])
  await core.controller(runId)?.settle(30_000)
  const snap = value(await core.invoke('runs.get', { runId }))
  const paused = [...(want.paused ?? [])].sort()
  expect(interruptedSteps(snap).sort(), 'paused(interrupted) steps').toEqual(paused)
  expect(core.recovery.paused.flatMap((p) => p.steps).sort()).toEqual(paused)
  expect(snap.summary.status).toBe(want.status ?? (paused.length > 0 ? 'paused' : snap.summary.status))
  if (want.outcome !== undefined) expect(snap.summary.outcome).toBe(want.outcome)
  expect(snap.cards.map((c) => c.kind).sort()).toEqual([...(want.cards ?? [])].sort())
  // No process of the dead instance outlives the relaunch (the sweep, or the OS with the parent).
  expect(await survivors(pids), 'processes left running').toEqual([])
  // Never auto-resume: no pass spawns, no verify command runs, the run stays as it is.
  const work = workCount(w)
  await sleep(2000)
  expect(workCount(w), 'work started after the relaunch').toEqual(work)
  const again = value(await core.invoke('runs.get', { runId }))
  expect(stepStatusesOf(again)).toEqual(stepStatusesOf(snap))
  // The relaunch wrote what it decided: run.json, the log and the index agree, nothing torn, no temp file.
  await chaos.stop(core)
  expect(consistency(w.home, runId), 'run.json / events.jsonl / index').toEqual([])
  expect(homeFiles(w.home), 'files after the relaunch').toEqual({
    badJson: [],
    badLines: [],
    tornTail: [],
    temps: [],
  })
  // A second relaunch has nothing left to recover and finds the same run.
  const second = await chaos.relaunch(w)
  expect(second.core.recovery.errors).toEqual([])
  expect(second.core.recovery.paused).toEqual([])
  await second.core.controller(runId)?.settle(30_000)
  const snap2 = value(await second.core.invoke('runs.get', { runId }))
  expect(stepStatusesOf(snap2)).toEqual(stepStatusesOf(snap))
  expect(snap2.summary.status).toBe(snap.summary.status)
  return { core: second.core, runId, snap: snap2, events: second.events }
}

/** Each step's status (and pause) in a snapshot. */
export function stepStatusesOf(snap: RunSnapshot): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of STEP_KEYS) {
    const st = snap.steps[k]
    out[k] = st.pause !== undefined ? `${st.status}(${st.pause})` : st.status
  }
  return out
}

// ---- the runs the suite kills -----------------------------------------------------------------------------------

/**
 * The in-place run: Plan (native) → the plan gate → the run branch → Implement writes version 0.1.0 → verify:1 fails
 * (check.mjs wants 1.0.0) → Review ∥ Critic (NO FINDINGS) → Fix resumes Implement's session and writes 1.0.0 →
 * verify:2 passes → completed `fixed` → diff.revert of the whole run. Every controller effect kind of an in-place run
 * happens on the way (`DIM_FACTORY_E2E_CHAOS_TRACE` lists them).
 */
export const FULL_SPEC: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
  resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F1 fixed' }],
}

export const FULL_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: {
    profile: 'claude-only',
    gates: { afterPlan: true, beforeFix: false },
    isolation: { branch: 'runBranch' },
    verify: {
      enabled: true,
      commands: [{ name: 'check', run: ['node', 'check.mjs'] }],
      runAfter: ['implement', 'fix'],
    },
  },
  actions: [
    { card: 'gate:afterPlan', choice: 'approve' },
    { until: 'settled' },
    { invoke: 'diff.revert', req: { paths: 'all' } },
  ],
}

/** An isolated run (no install, no verify): the finalize card → Apply to folder → completed → Undo the apply. */
export const ISO_SPEC: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
}

const ISO_OVERRIDES = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  isolation: { mode: 'worktree', worktree: { install: 'never', installCommand: null, autoApply: false } },
  verify: { enabled: false },
}

export const ISO_APPLY_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: ISO_OVERRIDES,
  actions: [{ card: 'finalize', choice: 'apply' }, { until: 'settled' }, { undoApply: true }],
}

/** The isolated run discarded: the finalize card → Discard → its 10 s pass on the E2E clock → the copy deleted. */
export const ISO_DISCARD_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: ISO_OVERRIDES,
  actions: [
    { card: 'finalize', choice: 'discard' },
    { sleep: 500 },
    { advance: 15_000 },
    { until: 'settled' },
  ],
}

const QUICK = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  verify: { enabled: false },
}

/** Plan fails `model_unavailable` (C11b); "Use Claude's default model" patches the run; Plan runs again without it. */
export const PATCH_SPEC: ScenarioSpec = {
  ...FULL_SPEC,
  plan: [
    { recording: 'C11b-invalid-model' },
    { recording: 'C06-plan-native-host' },
    { recording: 'C06-plan-native-host' },
  ],
}

export const PATCH_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: QUICK,
  actions: [{ until: 'failed:plan' }, { recovery: 'plan:default-model' }, { until: 'settled' }],
}

/** C04a asks twice (Bash, then Write); a Resume of Implement (C08b) writes the version file and ends. */
export const ASK_SPEC: ScenarioSpec = {
  ...FULL_SPEC,
  implement: [{ recording: 'C04a-ask-allow', write: version('0.1.0') }],
  resume: [{ recording: 'C08b-resume-fix', write: version('0.1.0'), text: 'Done.' }],
}

/** Both of Implement's asks allowed from the window; the run ends clean. */
export const ANSWER_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: QUICK,
  actions: [{ answer: 'allow' }, { answer: 'allow' }, { until: 'settled' }],
}

/** Stop while Implement's first ask waits (P18): the ask cancelled, Implement interrupted, the run cancelled. */
export const STOP_RUN: { overrides: Record<string, unknown>; actions: ChildAction[] } = {
  overrides: QUICK,
  actions: [{ until: 'ask' }, { invoke: 'runs.stop' }, { until: 'settled' }],
}

/** The run folder's src/version.ts, or null when it does not exist. */
export function folderVersion(folder: string): string | null {
  const f = join(folder, 'src', 'version.ts')
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

/** Temp files of an atomic write (`<name>.<pid>.<8 hex>.tmp`) in the user's folder (its .git aside), relative. */
export function folderTemps(folder: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else if (ATOMIC_TEMP_NAME.test(e.name)) out.push(p.slice(folder.length + 1).replace(/\\/g, '/'))
    }
  }
  visit(folder)
  return out.sort()
}
