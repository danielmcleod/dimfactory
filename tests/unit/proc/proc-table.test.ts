import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomicLite } from '../../../src/core/proc/atomic-lite.ts'
import {
  ProcTable,
  exeMatches,
  planOrphanSweep,
  procRecordFor,
  readProcsFile,
  sweepOrphans,
} from '../../../src/core/proc/proc-table.ts'
import type { ProcRecord } from '../../../src/core/proc/proc-table.ts'
import type { ProcInfo } from '../../../src/core/proc/ps.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

const SPAWN = 1_000_000
const rec = (over: Partial<ProcRecord> = {}): ProcRecord => ({
  id: 'p1',
  step: 'implement',
  pid: 500,
  spawnAt: SPAWN,
  exe: 'C:\\Program Files\\nodejs\\node.exe',
  argv: ['entry.mjs', '-p'],
  transport: 'claude-stdio',
  ...over,
})
const proc = (
  pid: number,
  ppid: number | null,
  startMs: number | null,
  exe = 'node.exe',
  pgid?: number,
): ProcInfo => (pgid === undefined ? { pid, ppid, startMs, exe } : { pid, ppid, startMs, exe, pgid })

describe('planOrphanSweep', () => {
  it('kills a live recorded process that is ours, plus its descendants', () => {
    const procs = [proc(500, 1, SPAWN + 300), proc(501, 500, SPAWN + 900), proc(502, 501, SPAWN + 5000)]
    const plan = planOrphanSweep([rec()], procs, { platform: 'win32' })
    expect(plan.owned.map((o) => o.proc.pid)).toEqual([500])
    expect(plan.pids.sort()).toEqual([500, 501, 502])
    expect(plan.lost).toEqual([])
  })

  it('applies the start-time window [spawnAt-2s, spawnAt+10s] and the exe match', () => {
    const early = planOrphanSweep([rec()], [proc(500, 1, SPAWN - 2500)], { platform: 'win32' })
    const late = planOrphanSweep([rec()], [proc(500, 1, SPAWN + 10_500)], { platform: 'win32' })
    const otherExe = planOrphanSweep([rec()], [proc(500, 1, SPAWN, 'notepad.exe')], { platform: 'win32' })
    for (const plan of [early, late, otherExe]) {
      expect(plan.owned).toEqual([])
      expect(plan.lost.map((r) => r.id)).toEqual(['p1'])
      expect(plan.pids).toEqual([])
    }
    expect(planOrphanSweep([rec()], [proc(500, 1, SPAWN - 1900)], { platform: 'win32' }).pids).toEqual([500])
  })

  it('finds orphans of a dead recorded process by ppid, skipping ones older than the spawn', () => {
    const procs = [proc(700, 500, SPAWN + 2000), proc(701, 700, SPAWN + 2500), proc(800, 500, SPAWN - 60_000)]
    const plan = planOrphanSweep(
      [rec({ exit: { code: 0, signal: null, at: SPAWN + 9000, how: 'exited' } })],
      procs,
      {
        platform: 'win32',
      },
    )
    expect(plan.owned).toEqual([])
    expect(plan.lost).toEqual([])
    expect(plan.pids.sort()).toEqual([700, 701])
  })

  it('never walks the children of a reused pid', () => {
    const procs = [proc(500, 1, SPAWN + 999_999, 'explorer.exe'), proc(501, 500, SPAWN + 1_000_000)]
    const plan = planOrphanSweep([rec()], procs, { platform: 'win32' })
    expect(plan.pids).toEqual([])
    expect(plan.lost.map((r) => r.id)).toEqual(['p1'])
  })

  it('POSIX: also sweeps surviving members of the recorded process group', () => {
    const r = rec({ exe: '/usr/bin/node', pgid: 500 })
    const procs = [
      proc(900, 1, SPAWN + 100, '/bin/sleep', 500), // reparented to init, still in the group
      proc(901, 1, SPAWN - 50_000, '/bin/sleep', 500), // older than the spawn: not ours
      proc(902, 1, SPAWN + 100, '/bin/sleep', 777),
      proc(903, 1, SPAWN + 500_000, '/bin/sleep', 500), // after the crashed session's last sign of life
    ]
    const opts = { platform: 'linux' as const, lastAliveAt: SPAWN + 60_000 }
    expect(planOrphanSweep([r], procs, opts).pids).toEqual([900])
  })

  it('POSIX: a script record matches its interpreter', () => {
    expect(exeMatches('/usr/bin/node', '/home/u/.local/bin/gemini', 'linux')).toBe(true)
    expect(exeMatches('/usr/bin/python3', '/home/u/.local/bin/gemini', 'linux')).toBe(false)
    expect(exeMatches('/usr/bin/sh', '/usr/bin/node', 'linux')).toBe(false)
    expect(exeMatches('C:\\x\\NODE.EXE', 'C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(true)
  })

  it('macOS: a process whose title rewrote argv[0] (npm run dev) matches by its first word', () => {
    const npm = '/Users/u/.nvm/versions/node/v22.0.0/bin/npm'
    expect(exeMatches('npm run dev', npm, 'darwin')).toBe(true)
    expect(exeMatches('/usr/local/bin/node', npm, 'darwin')).toBe(true)
    expect(exeMatches('pnpm run dev', npm, 'darwin')).toBe(false)
    // Linux reads /proc/<pid>/exe, which a title never changes: no first-word reading there.
    expect(exeMatches('npm run dev', npm, 'linux')).toBe(false)
    // The sweep owns the titled root, and its tree with it.
    const r = rec({ exe: npm, pgid: 500 })
    const procs = [proc(500, 1, SPAWN + 300, 'npm run dev', 500), proc(501, 500, SPAWN + 900, '/bin/sh', 500)]
    expect(planOrphanSweep([r], procs, { platform: 'darwin' }).pids.sort()).toEqual([500, 501])
  })

  it('POSIX: a native CLI spawned through a symlink matches its resolved target (Claude installer)', () => {
    const link = '/home/u/.local/bin/claude'
    const target = '/home/u/.local/share/claude/versions/2.1.289'
    expect(exeMatches(target, link, 'linux')).toBe(false)
    const r = rec({ exe: link, exeReal: target, pgid: 500 })
    const procs = [proc(500, 1, SPAWN + 300, target, 500), proc(501, 500, SPAWN + 900, '/bin/bash', 500)]
    const plan = planOrphanSweep([r], procs, { platform: 'linux' })
    expect(plan.owned.map((o) => o.proc.pid)).toEqual([500])
    expect(plan.pids.sort()).toEqual([500, 501])
  })

  it('tasklist fallback (no ppid/start time): an unverifiable pid is never killed, the record is lost', () => {
    const procs = [proc(500, null, null, 'node.exe'), proc(501, null, null, 'node.exe')]
    const plan = planOrphanSweep([rec()], procs, { platform: 'win32' })
    expect(plan.pids).toEqual([])
    expect(plan.owned).toEqual([])
    expect(plan.lost.map((r) => r.id)).toEqual(['p1'])
  })

  it('a stale ppid is not a child: nothing that started after the recorded exit (review repro)', () => {
    const T0 = SPAWN
    const r = rec({ pid: 1234, spawnAt: T0, exit: { code: 0, signal: null, at: T0 + 60_000, how: 'exited' } })
    const procs = [
      proc(5000, 1234, T0 + 3 * 86_400_000, 'C:\\Windows\\explorer.exe'),
      proc(5004, 5000, T0 + 3 * 86_400_000 + 10, 'Code.exe'),
    ]
    expect(planOrphanSweep([r], procs, { platform: 'win32' }).pids).toEqual([])
    // The same pid tree, but a real orphan that started while the recorded process ran, is swept.
    const orphan = [...procs, proc(6000, 1234, T0 + 30_000, 'node.exe')]
    expect(planOrphanSweep([r], orphan, { platform: 'win32' }).pids).toEqual([6000])
  })

  it('a record from before this boot is never walked (crash, then reboot)', () => {
    const r = rec({ pid: 1234 })
    const procs = [
      proc(5000, 1234, SPAWN + 3 * 86_400_000, 'explorer.exe'),
      proc(1234, 4, SPAWN + 86_400_000),
    ]
    const plan = planOrphanSweep([r], procs, {
      platform: 'win32',
      bootMs: SPAWN + 86_000_000,
      lastAliveAt: SPAWN + 3 * 86_400_000 + 1,
    })
    expect(plan.pids).toEqual([])
    expect(plan.lost.map((x) => x.id)).toEqual(['p1'])
  })

  it('a crash record is bounded by the last sign of life of its session', () => {
    const r = rec()
    const procs = [
      proc(700, 500, SPAWN + 5_000), // started while the session was alive: an orphan of ours
      proc(701, 500, SPAWN + 200_000), // long after the session died: a stale ppid
    ]
    expect(planOrphanSweep([r], procs, { platform: 'win32', lastAliveAt: SPAWN + 20_000 }).pids).toEqual([
      700,
    ])
    // Unknown last sign of life: children of a dead crash record cannot be attributed at all.
    expect(planOrphanSweep([r], procs, { platform: 'win32' }).pids).toEqual([])
  })

  it('the current holder of a reused pid caps the window: its own children are never ours', () => {
    const r = rec()
    const procs = [
      proc(500, 4, SPAWN + 50_000, 'svchost.exe'), // pid reused after ours died
      proc(600, 500, SPAWN + 20_000), // ours, from before the reuse
      proc(601, 500, SPAWN + 60_000), // the new holder's child
    ]
    const plan = planOrphanSweep([r], procs, { platform: 'win32', lastAliveAt: SPAWN + 100_000 })
    expect(plan.pids).toEqual([600])
    expect(plan.lost.map((x) => x.id)).toEqual(['p1'])
  })

  it('a deeper process that predates its parent hangs off a stale ppid and is skipped', () => {
    const procs = [proc(500, 1, SPAWN + 300), proc(501, 500, SPAWN + 900), proc(777, 501, SPAWN + 500)]
    expect(planOrphanSweep([rec()], procs, { platform: 'win32' }).pids.sort()).toEqual([500, 501])
  })

  it('records a sweep already settled are not swept again', () => {
    const procs = [proc(700, 500, SPAWN + 2000)]
    for (const how of ['lost', 'orphan-killed'] as const) {
      const r = rec({ exit: { code: null, signal: null, at: SPAWN + 9000, how } })
      const plan = planOrphanSweep([r], procs, { platform: 'win32' })
      expect(plan).toMatchObject({ pids: [], lost: [], owned: [] })
    }
  })

  it('never targets this process or its parent', () => {
    const self = rec({ pid: process.pid, exe: process.execPath })
    const procs = [
      proc(process.pid, process.ppid, SPAWN, process.execPath),
      proc(process.ppid, 1, SPAWN + 1, process.execPath),
    ]
    expect(planOrphanSweep([self], procs).pids).toEqual([])
  })
})

describe('sweepOrphans', () => {
  it('marks owned and lost records without signalling when nothing is alive', async () => {
    const records = [
      rec({ id: 'gone', pid: 2_000_000_001 }),
      rec({ id: 'done', exit: { code: 0, signal: null, at: 1, how: 'exited' } }),
    ]
    const result = await sweepOrphans(records, {
      platform: 'win32',
      snapshot: () => Promise.resolve({ source: 'cim', at: 0, procs: [] }),
      now: () => 42,
    })
    expect(result.killed).toEqual([])
    expect(result.records.map((r) => [r.id, r.exit?.how, r.exit?.at])).toEqual([
      ['gone', 'lost', 42],
      ['done', 'exited', 1],
    ])
  })
})

describe('ProcTable persistence', () => {
  it('writes procs.json atomically with schemaVersion and serializes updates', async () => {
    const file = join(home(), 'runs', 'r1', 'procs.json')
    const table = await ProcTable.open(file)
    expect(table.records()).toEqual([])
    const added = await table.add({
      step: 'plan',
      pid: 10,
      spawnAt: 1,
      exe: 'claude.exe',
      argv: ['-p'],
      transport: 'claude-stdio',
    })
    expect(added.id).toMatch(/^proc_[0-9a-f]{16}$/)
    await Promise.all([
      table.add({
        id: 'two',
        step: 'review',
        pid: 11,
        spawnAt: 2,
        exe: 'claude.exe',
        argv: [],
        transport: 'claude-stdio',
      }),
      table.markExit(added.id, { code: 0, signal: null, at: 3, how: 'exited' }),
    ])
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number; procs: ProcRecord[] }
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.procs.map((r) => [r.id, r.exit?.how])).toEqual([
      [added.id, 'exited'],
      ['two', undefined],
    ])
    expect((await ProcTable.open(file)).records()).toEqual(onDisk.procs)
  })

  it('treats missing or corrupt files as empty and filters bad rows', async () => {
    const file = join(home(), 'procs.json')
    expect(await readProcsFile(file)).toEqual([])
    await writeFile(file, '{not json')
    expect(await readProcsFile(file)).toEqual([])
    await writeFileAtomicLite(file, JSON.stringify({ schemaVersion: 1, procs: [{ id: 'x' }, rec()] }))
    expect((await readProcsFile(file)).map((r) => r.id)).toEqual(['p1'])
  })
})

describe('procRecordFor', () => {
  it('builds the entry from a spawned child, with pgid only when present', () => {
    const child = { pid: 9, pgid: undefined, spawnAt: 5, command: 'C:\n\node.exe', argv: ['e.mjs', '-p'] }
    expect(procRecordFor(child, 'plan', 'claude-stdio')).toEqual({
      step: 'plan',
      pid: 9,
      spawnAt: 5,
      exe: 'C:\n\node.exe',
      argv: ['e.mjs', '-p'],
      transport: 'claude-stdio',
    })
    expect(procRecordFor({ ...child, pgid: 9 }, 'fix', 'acp').pgid).toBe(9)
  })

  it('keeps the resolved target of a symlinked command (POSIX)', () => {
    const child = {
      pid: 9,
      pgid: 9,
      spawnAt: 5,
      command: '/home/u/.local/bin/claude',
      realCommand: '/home/u/.local/share/claude/versions/2.1.289',
      argv: ['-p'],
    }
    expect(procRecordFor(child, 'implement', 'claude-stdio').exeReal).toBe(child.realCommand)
    expect(
      procRecordFor({ ...child, realCommand: child.command }, 'implement', 'claude-stdio'),
    ).not.toHaveProperty('exeReal')
  })
})

describe('ProcTable.sweep', () => {
  it('bounds crash records by the file mtime and saves the marked records', async () => {
    const file = join(home(), 'runs', 'sweep', 'procs.json')
    const t = await ProcTable.open(file)
    expect(t.lastWriteAt).toBeUndefined()
    await t.add({
      id: 'c',
      step: 'implement',
      pid: 2_000_000_001,
      spawnAt: Date.now() - 1000,
      exe: 'node.exe',
      argv: [],
      transport: 'claude-stdio',
    })
    await t.touch()
    const reopened = await ProcTable.open(file)
    expect(reopened.lastWriteAt).toBeGreaterThan(Date.now() - 60_000)
    const r = await reopened.sweep({
      platform: 'win32',
      snapshot: () => Promise.resolve({ source: 'cim', at: 0, procs: [], bootMs: 0 }),
      now: () => 7,
    })
    expect(r.killed).toEqual([])
    expect((await ProcTable.open(file)).records().map((x) => [x.id, x.exit?.how, x.exit?.at])).toEqual([
      ['c', 'lost', 7],
    ])
  })
})
