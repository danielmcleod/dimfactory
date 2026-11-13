// "Live preflight spawns no vendor (spy)" (live mode = cheap + io; git spawns allowed, ≤ 4 at
// once, 2 s, --no-optional-locks; never a vendor spawn; vendor results from the launch-probe store). Every process
// Dim Factory starts goes through src/core/proc/spawn.ts, so that module is wrapped here to record each spawn (and how
// many run at once) while the real core runs N live preflights against the fake Claude and a git sandbox:
//   - zero vendor spawns: the adapter's probe/start are never called and the fake `claude` never starts
//   - only git runs, at most 4 at a time; reads of the user's repository take no optional locks
//   - a repeat preflight is served from the caches (no process at all) and reports the same, in a stable order
import { afterEach, describe, expect, it, vi } from 'vitest'
import { basename, resolve, sep } from 'node:path'
import type { Core } from '../../../src/core/app-core.ts'
import { realPathSync } from '../../../src/core/real-path.ts'
import type * as SpawnModule from '../../../src/core/proc/spawn.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { controllableClock } from '../../../src/core/supervisor/effects.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { PreflightReport } from '../../../src/shared/preflight.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

interface SpawnRecord {
  command: string
  args: string[]
  env: Readonly<Record<string, string | undefined>>
  cwd?: string
}

const spy = vi.hoisted(() => ({
  recording: false,
  log: [] as {
    command: string
    args: string[]
    env: Readonly<Record<string, string | undefined>>
    cwd?: string
  }[],
  inflight: 0,
  maxInflight: 0,
}))

vi.mock('../../../src/core/proc/spawn.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof SpawnModule>()
  const enter = (
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    cwd: string | undefined,
  ) => {
    if (!spy.recording) return false
    spy.log.push({ command, args: [...args], env, ...(cwd !== undefined ? { cwd } : {}) })
    spy.inflight++
    spy.maxInflight = Math.max(spy.maxInflight, spy.inflight)
    return true
  }
  return {
    ...orig,
    execCapture: async (...a: Parameters<typeof orig.execCapture>) => {
      const counted = enter(a[0], a[1], a[2]?.env ?? {}, a[2]?.cwd)
      try {
        return await orig.execCapture(...a)
      } finally {
        if (counted) spy.inflight--
      }
    },
    spawnChild: async (o: Parameters<typeof orig.spawnChild>[0]) => {
      const command = o.cli?.command ?? o.command ?? '?'
      const counted = enter(command, [...(o.cli?.prefixArgs ?? []), ...(o.args ?? [])], o.env, o.cwd)
      const child = await orig.spawnChild(o)
      if (counted) void child.exited.finally(() => spy.inflight--)
      return child
    },
  }
})

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  spy.recording = false
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

const isGit = (s: SpawnRecord): boolean => /^git(\.exe)?$/i.test(basename(s.command))

// By real name: the core reads the user's repository at the folder's real path (an 8.3 short name or a linked temp
// folder in the test's spelling names the same folder).
const fold = (p: string): string => {
  const r = realPathSync(resolve(p))
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const sameOrInside = (p: string, dir: string): boolean =>
  fold(p) === fold(dir) || fold(p).startsWith(`${fold(dir)}${sep}`)

/** A report without its timestamps (`at`), for comparing repeats. */
const shape = (r: PreflightReport): unknown =>
  JSON.parse(JSON.stringify(r, (k, v: unknown) => (k === 'at' ? undefined : v))) as unknown

const N = 5

describe('live preflight spawns no vendor', () => {
  it(`${N} live preflights: no probe, no vendor process, only git (≤ 4 at once), then nothing on repeat`, async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    // The repeats must fall inside the checks' cache TTLs (30 s) however slow the machine is: the clock stands still
    // while they run (timers still fire on the wall clock).
    let frozen: number | undefined
    const clock = controllableClock({
      now: () => frozen ?? Date.now(),
      setTimer: (fn, due) => setTimeout(fn, Math.max(0, Math.min(2_147_483_647, due - Date.now()))),
      clearTimer: (h) => clearTimeout(h),
      scale: 1,
    })
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv(), clock })
    cores.push(core)

    // The launch probe (app start) is the only vendor spawn; live reads its store.
    value(await core.invoke('vendors.probe', { vendor: 'claude' }))
    const claude = core.adapters.get('claude')
    if (claude === undefined) throw new Error('no claude adapter')
    const probe = vi.spyOn(claude, 'probe')
    const start = vi.spyOn(claude, 'start')
    const listModels = vi.spyOn(claude, 'listModels')
    const fakeStarts = sc.entries().filter((e) => e.kind === 'start').length
    expect(fakeStarts).toBeGreaterThan(0)

    spy.log.length = 0
    spy.maxInflight = 0
    spy.recording = true
    const reports: PreflightReport[] = []
    const live = async (): Promise<PreflightReport> =>
      value(await core.invoke('preflight.run', { folder, overrides: { profile: 'claude-only' } }))
    frozen = Date.now()
    reports.push(await live())
    const firstSpawns = [...spy.log]
    for (let i = 1; i < N; i++) reports.push(await live())
    spy.recording = false
    frozen = undefined

    // No vendor: the adapter was never asked, and the fake CLI never started another process.
    expect(probe).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(listModels).not.toHaveBeenCalled()
    expect(sc.entries().filter((e) => e.kind === 'start')).toHaveLength(fakeStarts)
    // Only git, at most 4 at once. Reads of the user's repository (run in the folder, not through the shadow's
    // GIT_DIR) take no optional locks; the rest is Dim Factory's own shadow (created on first use) and `git --version`.
    expect(spy.log.filter((s) => !isGit(s))).toEqual([])
    expect(spy.maxInflight).toBeLessThanOrEqual(4)
    const inFolder = (s: SpawnRecord): boolean => s.cwd !== undefined && sameOrInside(s.cwd, folder)
    const userRepo = firstSpawns.filter((s) => inFolder(s) && s.env['GIT_DIR'] === undefined)
    expect(userRepo.length).toBeGreaterThan(0)
    for (const s of userRepo) expect(s.args[0], s.args.join(' ')).toBe('--no-optional-locks')
    for (const s of firstSpawns.filter((x) => !userRepo.includes(x))) {
      const shadow = s.env['GIT_DIR']?.startsWith(home) === true || (s.cwd ?? '').startsWith(home)
      expect(shadow || s.args.includes('--version'), s.args.join(' ')).toBe(true)
    }
    // Fast on repeat: every later preflight is answered from the caches (TTLs), with no process at all.
    expect(spy.log).toHaveLength(firstSpawns.length)
    // The same verdict each time, in the same order (blocking → warnings → info, by scope).
    expect(reports[0]?.ok).toBe(true)
    for (const r of reports.slice(1)) expect(shape(r)).toEqual(shape(reports[0] as PreflightReport))
    expect(reports[0]?.mode).toBe('live')
  }, 120_000)

  it('a vendor whose probe is stale or failing is still never spawned by live preflight', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox({ git: false })
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    // No launch probe yet: live says "Checking…" instead of probing.
    const claude = core.adapters.get('claude')
    if (claude === undefined) throw new Error('no claude adapter')
    const probe = vi.spyOn(claude, 'probe')
    spy.log.length = 0
    spy.recording = true
    const before = value(
      await core.invoke('preflight.run', { folder, overrides: { profile: 'claude-only' } }),
    )
    expect(before.info.find((c) => c.id === 'vendor.claude.bin')).toMatchObject({ status: 'skip' })
    // Invalidated (a copied fix, a runtime failure): live still shows the last state and spawns nothing.
    core.preflight.cache.invalidateVendor('claude')
    core.preflight.cache.awaitRecheck('vendor.claude.auth', Date.now())
    value(await core.invoke('preflight.run', { folder, overrides: { profile: 'claude-only' } }))
    spy.recording = false
    expect(probe).not.toHaveBeenCalled()
    expect(spy.log.filter((s) => !isGit(s))).toEqual([])
    expect(sc.entries().filter((e) => e.kind === 'start')).toEqual([])
  }, 120_000)
})
