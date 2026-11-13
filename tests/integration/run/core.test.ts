// createCore + handlers against the fake Claude (real adapter, real spawn, real git shadow):
//   - a blocked authoritative preflight creates no run folder
//   - two runs in one folder queue FIFO; a run in a sub-folder of a busy non-git folder waits too
//   - R1..R5 → completed: run.json, resolved.json, events.jsonl, snapshots and the S0..S1 patch
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { cleanup, git, hermeticEnv, makeHome, makeSandbox, makeScenario, passArgvs } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function boot(home: string): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return core
}

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

function runDirs(home: string): string[] {
  const runs = join(home, 'runs')
  return existsSync(runs)
    ? readdirSync(runs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []
}

describe('core: runs.start', () => {
  it('a blocked authoritative preflight answers PREFLIGHT_BLOCKED and creates no run folder', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const core = await boot(home)
    // Inside DIM_FACTORY_HOME: the folder guard refuses it.
    const guarded = join(home, 'inside-home')
    mkdirSync(guarded)
    const r = await core.invoke('runs.start', { folder: guarded, task: 'anything' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    const report = r.error.details as { blocking: { id: string }[] }
    expect(report.blocking.map((b) => b.id)).toContain('folder.guard')
    // A folder that does not exist is blocked the same way.
    const missing = await core.invoke('runs.start', { folder: join(home, '..', 'no-such-folder'), task: 'x' })
    expect(missing.ok === false && missing.error.code).toBe('PREFLIGHT_BLOCKED')
    expect(runDirs(home)).toEqual([])
    const list = await core.invoke('runs.list', {})
    expect(list.ok && list.value.items).toEqual([])
    // Nothing was spawned for a pass.
    expect(passArgvs(sc.entries())).toEqual([])
  }, 60_000)

  it('a project folder inside a repository at the home folder is blocked: the guard checks the scope root', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const userHome = mkdtempSync(join(tmpdir(), 'dim-run-userhome-'))
    dirs.push(home, sc.dir, userHome)
    // A dotfiles-style repository at ~ and a plain project folder inside it.
    git(userHome, 'init', '-q')
    const project = join(userHome, 'proj')
    mkdirSync(project)
    writeFileSync(join(project, 'a.txt'), 'a\n')
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
    process.env['HOME'] = userHome
    process.env['USERPROFILE'] = userHome
    try {
      expect(homedir()).toBe(userHome)
      const core = await boot(home)
      const r = await core.invoke('runs.start', { folder: project, task: 'anything' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
      const report = r.error.details as { blocking: { id: string; detail: string }[] }
      const guard = report.blocking.find((b) => b.id === 'folder.guard')
      expect(guard?.detail).toMatch(/is inside the git repository at .*, which is your home folder/)
      expect(runDirs(home)).toEqual([])
      expect(passArgvs(sc.entries())).toEqual([])
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 60_000)

  it('runs Plan → Implement to completion and persists the run folder', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        { recording: 'C03-accept-edits', write: { path: 'src/version.ts', content: 'export const v = 1\n' } },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const refsBefore = git(folder, 'for-each-ref')
    const core = await boot(home)
    const events: RunEnvelope[] = []
    const attention: { needsYou: number; kinds: string[] }[] = []
    core.bus.attach({
      name: 't',
      run: (e) => events.push(e),
      global: (g) => {
        if (g.kind === 'attention')
          attention.push({ needsYou: g.needsYou, kinds: g.items.map((i) => i.kind) })
      },
    })
    const r = await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: { gates: { afterPlan: false } },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = core.controller(r.value.runId)!
    // C03's PowerShell ask: the app answers it like a user would.
    const off = c.subscribe((s) => {
      for (const a of s.steps.implement.asks) {
        void core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    })
    const done = await c.waitFor(settled, 60_000)
    off()
    expect(done.status).toBe('completed')
    expect(done.outcome).toBe('clean')
    expect(done.steps.plan.planMode).toBe('native')
    expect(done.steps.implement.sessionId).toBeDefined()
    await c.settle(10_000)
    const dir = join(home, 'runs', r.value.runId)
    for (const f of [
      'run.json',
      'resolved.json',
      'events.jsonl',
      'snapshots.json',
      'procs.json',
      'plan.md',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true)
    }
    const snaps = JSON.parse(readFileSync(join(dir, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.map((s) => s.label)).toEqual(expect.arrayContaining(['run-start', 'S0', 'S1']))
    expect(readFileSync(join(dir, 'diffs', 'S0..S1.patch'), 'utf8')).toContain('src/version.ts')
    // The user's repo is untouched: same refs, same index; only the new file shows up as untracked.
    expect(git(folder, 'for-each-ref')).toBe(refsBefore)
    expect(git(folder, 'status', '--porcelain').trim()).toBe('?? src/version.ts')
    // Envelope seqs are gap-free and run-status ends completed.
    const mine = events.filter((e) => e.runId === r.value.runId)
    expect(mine.map((e) => e.seq)).toEqual(mine.map((_, i) => mine[0]!.seq + i))
    expect(mine.at(-1)?.body).toMatchObject({ t: 'run-status', status: 'completed' })
    const snap = await core.invoke('runs.get', { runId: r.value.runId })
    expect(snap.ok && snap.value.summary.progress.filesChanged).toBe(1)
    // The ask showed up in the attention feed and cleared again.
    expect(attention.some((a) => a.kinds.includes('ask'))).toBe(true)
    expect(attention.at(-1)?.needsYou).toBe(0)
  }, 90_000)
})

describe('core: scheduler', () => {
  it('queues a second run in the same folder until the first one finishes (FIFO)', async () => {
    const write = (n: string) => ({ path: `src/${n}.ts`, content: `export const ${n} = 1\n` })
    const sc = await makeScenario({
      plan: [{ recording: 'C06-plan-native-host', delayMs: 1500 }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: write('a') },
        { recording: 'C08a-session-id-implement', write: write('b') },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await boot(home)
    const overrides = { gates: { afterPlan: false } }
    const a = await core.invoke('runs.start', { folder, task: 'first', overrides })
    const b = await core.invoke('runs.start', { folder, task: 'second', overrides })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const ca = core.controller(a.value.runId)!
    const cb = core.controller(b.value.runId)!
    const bSnap = await core.invoke('runs.get', { runId: b.value.runId })
    expect(bSnap.ok && bSnap.value.summary.status).toBe('queued')
    expect(bSnap.ok && bSnap.value.summary.blockedBy).toBe(a.value.runId)
    const [sa, sb] = await Promise.all([ca.waitFor(settled, 90_000), cb.waitFor(settled, 90_000)])
    expect(sa.status).toBe('completed')
    expect(sb.status).toBe('completed')
    // B's preflight began only after A had finished (A released the lock after its last snapshot).
    expect(sb.steps.preflight.startedAt ?? 0).toBeGreaterThanOrEqual(sa.endedAt ?? Infinity)
    expect(b.value.displayNo).toBe(a.value.displayNo + 1)
  }, 120_000)

  it('a run in a sub-folder of a busy non-git folder waits for it (ancestor/descendant conflict)', async () => {
    const sc = await makeScenario({
      plan: [{ recording: 'C06-plan-native-host', delayMs: 1500 }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'x.txt', content: 'x\n' } },
        { recording: 'C08a-session-id-implement', write: { path: 'y.txt', content: 'y\n' } },
      ],
    })
    const { home } = await makeHome(sc)
    const parent = makeSandbox({ git: false })
    const child = join(parent, 'src')
    dirs.push(home, sc.dir, parent)
    const core = await boot(home)
    const overrides = { gates: { afterPlan: false } }
    const outer = await core.invoke('runs.start', { folder: parent, task: 'outer', overrides })
    const inner = await core.invoke('runs.start', { folder: child, task: 'inner', overrides })
    expect(outer.ok && inner.ok).toBe(true)
    if (!outer.ok || !inner.ok) return
    expect(core.scheduler.blockedBy(inner.value.runId)?.runId).toBe(outer.value.runId)
    const so = await core.controller(outer.value.runId)!.waitFor(settled, 90_000)
    const si = await core.controller(inner.value.runId)!.waitFor(settled, 90_000)
    expect(so.status).toBe('completed')
    expect(si.status).toBe('completed')
    expect(si.steps.preflight.startedAt ?? 0).toBeGreaterThanOrEqual(so.endedAt ?? Infinity)
  }, 120_000)
})
