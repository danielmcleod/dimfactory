// Runs history through a real core (Pin / Remove (undo), storage, shadow GC; retention (pinned exempt, batched
// update-ref --stdin), index compaction/rebuild): finished
// runs seeded on disk with real shadow snapshots, then runs.pin / runs.remove / runs.undoRemove over IPC, the deferred
// delete (folder, refs in one batch, other runs' diffs intact), the next start after a quit inside the undo window, an
// index rebuilt after corruption, and `dimf gc` (dry run, then the real pass with the shadow collected).
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import { SHADOW_REF_PREFIX, forgetShadows, listRunRefs, shadowFor } from '../../../src/core/git/shadow.ts'
import { homePaths } from '../../../src/core/home.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanupTemps, initRepo, tempDir, testGitVersion, write } from '../git/helpers.ts'
import { hermeticEnv } from '../run/scenario.ts'
import { DAY, rawLog, seedState } from '../../unit/history/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] core history suite: ${version.raw}`)

const cores: Core[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  forgetShadows()
  cleanupTemps()
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

async function boot(home: string): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv(), retention: false })
  cores.push(core)
  return core
}

async function stop(core: Core): Promise<void> {
  cores.splice(cores.indexOf(core), 1)
  await core.shutdown()
}

const runIdOf = (n: number): string => `20261009T15000${n}Z-hist`

/** A finished run in `folder` with real S0/S1 snapshots (it changed f<n>.txt) and a raw log, `ageDays` old. */
async function seedRun(home: string, folder: string, n: number, ageDays: number): Promise<string> {
  const runId = runIdOf(n)
  const scope = await resolveScope(folder)
  const shadow = await shadowFor(scope, { home })
  write(folder, `f${n}.txt`, `before ${n}\n`)
  const s0 = await shadow.snapshot(runId, 'S0')
  write(folder, `f${n}.txt`, `after ${n}\n`)
  const s1 = await shadow.snapshot(runId, 'S1')
  const createdAt = Date.now() - ageDays * DAY
  const state = seedState({
    runId,
    displayNo: n,
    createdAt,
    folder: scope.folder,
    folderKey: scope.folderKey,
  })
  state.snapshots.S0 = { label: 'S0', commit: s0.commit, tree: s0.tree, at: createdAt + 1 }
  state.snapshots.S1 = { label: 'S1', commit: s1.commit, tree: s1.tree, at: createdAt + 2 }
  const doc: RunDoc = {
    runId,
    state,
    lastSeq: 0,
    scope: {
      folder: scope.folder,
      scopeRoot: scope.scopeRoot,
      lockKey: scope.lockKey,
      folderKey: scope.folderKey,
      isRepo: scope.isRepo,
    },
    createdBy: 'app',
  }
  await RunStore.create(homePaths(home), runId, doc)
  rawLog(homePaths(home), runId, 'implement-1.ndjson', 0)
  return runId
}

async function world(
  n = 3,
  ageDays = 0,
): Promise<{ home: string; folder: string; key: string; ids: string[] }> {
  const home = tempDir('core-home')
  const folder = tempDir('core-repo')
  initRepo(folder)
  const ids: string[] = []
  for (let i = 1; i <= n; i++) ids.push(await seedRun(home, folder, i, ageDays))
  return { home, folder, key: (await resolveScope(folder)).folderKey, ids }
}

const listed = async (core: Core): Promise<string[]> =>
  value(await core.invoke('runs.list', {})).items.map((s) => s.runId)

async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe(`Runs history through the core (${version.raw})`, () => {
  it('pin, remove and undo over IPC; a removed run leaves the lists and the tiles at once', async () => {
    const { home, ids } = await world()
    const [one, two, three] = ids as [string, string, string]
    const core = await boot(home)
    const pushed: string[] = []
    core.bus.attach({
      name: 't',
      global: (e) => {
        if (e.kind === 'run-summary') pushed.push(e.summary.runId)
      },
    })
    expect(await listed(core)).toEqual([three, two, one])
    value(await core.invoke('runs.pin', { runId: one, pinned: true }))
    expect(value(await core.invoke('runs.list', {})).items.find((s) => s.runId === one)?.pinned).toBe(true)
    await until(() => pushed.includes(one), 5000)
    const tiles = value(await core.invoke('stats.get', { range: 'all' }))
    const removed = value(await core.invoke('runs.remove', { runIds: [two] }))
    expect(removed.removed).toEqual([two])
    expect(await listed(core)).toEqual([three, one])
    expect(value(await core.invoke('stats.get', { range: 'all' })).runs).toBe(tiles.runs - 1)
    expect(value(await core.invoke('dashboard.get')).recent.map((s) => s.runId)).not.toContain(two)
    // A pinned run is refused with the reason.
    const pinned = await core.invoke('runs.remove', { runIds: [one] })
    expect(pinned.ok ? null : pinned.error).toEqual({
      code: 'CONFLICT',
      message: 'Run #1 is pinned. Unpin it first, then remove it.',
      details: { refused: [{ runId: one, reason: 'Run #1 is pinned. Unpin it first, then remove it.' }] },
    })
    value(await core.invoke('runs.undoRemove', { undoToken: removed.undoToken }))
    expect(await listed(core)).toEqual([three, two, one])
    expect(existsSync(homePaths(home).run(two).dir)).toBe(true)
  })

  it("the deferred delete removes the run and its refs in one batch; the other runs' diffs still read", async () => {
    const { home, key, ids } = await world()
    const [one, two, three] = ids as [string, string, string]
    const core = await boot(home)
    expect(await listRunRefs(home, key)).toEqual([one, two, three])
    const removed = value(await core.invoke('runs.remove', { runIds: [two] }))
    const dir = homePaths(home).run(two).dir
    await until(() => !existsSync(dir), 40_000)
    await core.history.settled()
    expect(await listRunRefs(home, key)).toEqual([one, three])
    expect(JSON.parse(readFileSync(join(homePaths(home).shadowDir, key, 'gc.json'), 'utf8'))).toHaveProperty(
      'refsDeletedAt',
    )
    const files = value(await core.invoke('diff.files', { runId: three, seg: 'implement' }))
    expect(files).toMatchObject({ persisted: false })
    expect(files.files.map((f) => f.path)).toEqual(['f3.txt'])
    const late = await core.invoke('runs.undoRemove', { undoToken: removed.undoToken })
    expect(late.ok ? null : late.error).toEqual({
      code: 'CONFLICT',
      message: 'It is too late to undo: Run #2 was already deleted.',
    })
    expect(await listed(core)).toEqual([three, one])
  })

  it('a quit inside the undo window: the next start deletes the run; pins and the removal survive an index rebuild', async () => {
    const { home, key, ids } = await world()
    const [one, two, three] = ids as [string, string, string]
    const first = await boot(home)
    value(await first.invoke('runs.pin', { runId: one, pinned: true }))
    value(await first.invoke('runs.remove', { runIds: [two] }))
    await stop(first)
    expect(existsSync(homePaths(home).run(two).dir)).toBe(true)
    // The index is corrupt at the next start: it is rebuilt from the run folders.
    const index = homePaths(home).runIndex
    const lines = readFileSync(index, 'utf8').split('\n')
    lines.splice(1, 0, '{"v":1,"op":"put","s":{"runId":')
    writeFileSync(index, lines.join('\n'))
    const next = await boot(home)
    const items = value(await next.invoke('runs.list', {})).items
    expect(items.map((s) => [s.runId, s.pinned])).toEqual([
      [three, false],
      [one, true],
    ])
    await next.history.settled()
    expect(existsSync(homePaths(home).run(two).dir)).toBe(false)
    expect(await listRunRefs(home, key)).toEqual([one, three])
    expect(existsSync(`${index}.bad`)).toBe(true)
  })

  it('dimf gc: the dry run changes nothing; the pass deletes old runs (pinned kept), raw logs, and collects the shadow', async () => {
    const { home, key, ids } = await world(3, 10)
    const [one, two, three] = ids as [string, string, string]
    writeFileSync(
      join(home, 'dimfactory.json'),
      JSON.stringify({ storage: { keepRuns: 1, keepDays: 1, rawLogDays: 0 } }),
    )
    const core = await boot(home)
    value(await core.invoke('runs.pin', { runId: one, pinned: true }))
    await stop(core)
    const run = async (...args: string[]): Promise<{ code: number; out: string[] }> => {
      const out: string[] = []
      const code = await main(['gc', ...args, '--home', home], {
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        env: hermeticEnv(),
      })
      return { code, out }
    }
    const dry = await run('--dry-run')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('Would delete 1 run:')
    expect(dry.out.some((l) => l.includes('#2'))).toBe(true)
    expect(dry.out.some((l) => l.includes('#1') && l.includes('(pinned)'))).toBe(true)
    // The kept runs' raw logs (the deleted run's go with its folder).
    expect(dry.out).toContain('Raw logs: would delete 2 files (20 B).')
    for (const l of dry.out) expect(l).not.toContain(String.fromCharCode(0x2014))
    expect(existsSync(homePaths(home).run(two).dir)).toBe(true)
    expect(await listRunRefs(home, key)).toEqual([one, two, three])

    // The shadow was written a moment ago: the pass leaves it alone (a run may still be about to use it).
    const fresh = await run()
    expect(fresh.code).toBe(0)
    expect(fresh.out).toContain('Deleted 1 run:')
    expect(fresh.out).toContain(`  ${key}  left alone: a run used this folder in the last 5 minutes`)
    expect(existsSync(homePaths(home).run(two).dir)).toBe(false)
    expect(await listRunRefs(home, key)).toEqual([one, three])
    expect(existsSync(homePaths(home).run(one).rawDir)).toBe(true)
    expect(existsSync(join(homePaths(home).run(one).rawDir, 'implement-1.ndjson'))).toBe(false)

    // Ten minutes later (its files aged), `dimf gc` collects it.
    const root = join(homePaths(home).shadowDir, key)
    const t = (Date.now() - 10 * 60_000) / 1000
    for (const p of [
      join(root, 'repo.git', 'index'),
      join(root, 'repo.git', 'info', 'exclude'),
      join(root, 'repo.git', ...SHADOW_REF_PREFIX.split('/').filter((x) => x !== '')),
      join(root, 'meta.json'),
    ]) {
      mkdirSync(join(p, '..'), { recursive: true })
      if (existsSync(p)) utimesSync(p, t, t)
    }
    const later = await run('--json')
    expect(later.code).toBe(0)
    const report = JSON.parse(later.out.join('\n')) as { gc: { folderKey: string; action: string }[] }
    expect(report.gc).toContainEqual(expect.objectContaining({ folderKey: key, action: 'gc' }))
    expect(await listRunRefs(home, key)).toEqual([one, three])
  })

  it('a damaged runs/history.json loses no pin, and retention deletes no run until it reads again', async () => {
    const { home, ids } = await world(3, 10)
    const [one, two, three] = ids as [string, string, string]
    writeFileSync(join(home, 'dimfactory.json'), JSON.stringify({ storage: { keepRuns: 1, keepDays: 1 } }))
    const first = await boot(home)
    value(await first.invoke('runs.pin', { runId: one, pinned: true }))
    await stop(first)
    // Truncated by a disk error: the pins it held are gone from it.
    const file = join(homePaths(home).runsDir, 'history.json')
    const damaged = '{"schemaVersion":1,"pinned":{"2026'
    writeFileSync(file, damaged)
    const next = await boot(home)
    await next.history.settled()
    const pins = value(await next.invoke('runs.list', {})).items.map((s) => [s.runId, s.pinned])
    expect(pins).toEqual([
      [three, false],
      [two, false],
      [one, true],
    ])
    const r = await next.history.retention()
    expect(r.removed).toEqual([])
    expect(r.kept.map((k) => k.displayNo)).toEqual([1, 2])
    expect(r.kept[1]?.reason).toMatch(/^runs\/history\.json was damaged, so retention deletes no run/)
    for (const id of ids) expect(existsSync(homePaths(home).run(id).dir)).toBe(true)
    // The damaged file is kept beside the one written again with the pins the index held.
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe(damaged)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      pinned: { [one]: expect.any(Number) as number },
    })
    await stop(next)
    // The next start reads it again: the pinned run stays, the others past the rules go.
    const third = await boot(home)
    await third.history.settled()
    const later = await third.history.retention()
    expect(later.removed.map((x) => x.displayNo)).toEqual([2])
    expect(existsSync(homePaths(home).run(one).dir)).toBe(true)
    expect(value(await third.invoke('runs.list', {})).items.find((s) => s.runId === one)?.pinned).toBe(true)
  })

  it('the app runs retention on its own after boot, while idle (the schedule wired to the core)', async () => {
    const { home, key, ids } = await world(2, 10)
    const [one, two] = ids as [string, string]
    writeFileSync(join(home, 'dimfactory.json'), JSON.stringify({ storage: { keepRuns: 1, keepDays: 1 } }))
    const core = await createCore({
      home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      retention: { bootDelayMs: 200 },
    })
    cores.push(core)
    await until(() => !existsSync(homePaths(home).run(one).dir), 30_000)
    await core.history.settled()
    expect(await listed(core)).toEqual([two])
    expect(await listRunRefs(home, key)).toEqual([two])
  })
})
