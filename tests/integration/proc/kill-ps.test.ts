// Process snapshot, stop/kill tree and the relaunch orphan sweep against real fake-CLI processes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stopChild } from '../../../src/core/proc/kill.ts'
import { ProcTable, procRecordFor, sweepOrphans } from '../../../src/core/proc/proc-table.ts'
import { exeKey, isAlive, snapshotProcesses } from '../../../src/core/proc/ps.ts'
import { execCapture, spawnChild } from '../../../src/core/proc/spawn.ts'
import {
  fixture,
  forceKill,
  isWin,
  lineReader,
  STREAM_ARGS,
  resolveFake,
  sharedFixture,
  vendorEnv,
  waitGone,
} from './helpers.ts'

let work = ''
const leftovers: number[] = []
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-proc-'))
})
afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    forceKill(pid)
    await waitGone(pid, 2000)
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function startFake(script: string): Promise<Awaited<ReturnType<typeof spawnChild>>> {
  const { build, cli } = await resolveFake()
  const child = await spawnChild({
    cli,
    args: STREAM_ARGS,
    cwd: work,
    env: vendorEnv(build, cli, { FAKE_CLI_SCRIPT: script }),
    label: { purpose: 'pass', step: 'implement' },
  })
  leftovers.push(child.pid)
  return child
}

describe('ps + kill', () => {
  it('a snapshot finds the spawned child with its parent, start time and exe', async () => {
    const child = await startFake(fixture('sleeper.script.jsonl'))
    const next = lineReader(child.lines())
    expect(await next()).toBe('ready')
    const snap = await snapshotProcesses()
    const me = snap.procs.find((p) => p.pid === child.pid)
    expect(me, `pid ${child.pid} in ${snap.source} snapshot`).toBeDefined()
    expect(me?.ppid).toBe(process.pid)
    expect(exeKey(me?.exe ?? '')).toBe(exeKey(process.execPath))
    expect(me?.startMs).toBeGreaterThanOrEqual(child.spawnAt - 2000)
    expect(me?.startMs).toBeLessThanOrEqual(child.spawnAt + 10_000)
    if (!isWin) expect(me?.pgid).toBe(child.pid)

    const stopped = await stopChild(child, { stdinWaitMs: 100 })
    expect(stopped.how).toBe('killed')
  })

  it('stop: graceful step first, and nothing else when it works', async () => {
    const child = await startFake(sharedFixture('echo-handshake.script.jsonl'))
    expect(await lineReader(child.lines())()).toContain('"system"')
    let gracefulCalled = false
    const stopped = await stopChild(child, {
      graceful: () => {
        gracefulCalled = true
        child.closeStdin() // the fake exits 98 on EOF while waiting for input
        return Promise.resolve()
      },
    })
    expect(gracefulCalled).toBe(true)
    expect(stopped.how).toBe('graceful')
    expect(stopped.exit.code).toBe(98)
    expect((await stopChild(child)).how).toBe('already-exited')
  })

  it('hard kill takes down the whole tree, including a grandchild', async () => {
    const child = await startFake(fixture('tree.script.jsonl'))
    const next = lineReader(child.lines())
    const marker = JSON.parse(await next()) as { type: string; pid: number }
    expect(marker.type).toBe('fake_grandchild')
    leftovers.push(marker.pid)
    expect(await next()).toBe('ready')
    expect(isAlive(marker.pid)).toBe(true)

    const stopped = await stopChild(child, { stdinWaitMs: 200, termWaitMs: 1000 })
    expect(stopped.how).toBe('killed')
    // win32: taskkill /T usually ends the grandchild before the follow-up snapshot sees it.
    if (!isWin) expect(stopped.killed).toContain(marker.pid)
    expect(stopped.exit.code === 0 && stopped.exit.signal === null).toBe(false)
    expect(await waitGone(marker.pid)).toBe(true)
    expect(isAlive(child.pid)).toBe(false)
  })
})

describe('execCapture timeout', () => {
  it('killTree takes down a grandchild that holds the pipes (as cmd/git.exe runs mingw64 git.exe)', async () => {
    // A launcher that does not take its children down when it dies (cmd.exe; sh on POSIX) runs a node grandchild
    // that prints its pid and sleeps. A plain kill of the launcher would orphan it on win32.
    const grand = join(work, 'grand.js')
    writeFileSync(grand, 'console.log(String(process.pid)); setTimeout(() => {}, 60000)\n')
    const cmdExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const [cmd, args] = isWin
      ? [cmdExe, ['/d', '/c', process.execPath, grand]]
      : ['/bin/sh', ['-c', `"${process.execPath}" "${grand}"; sleep 60`]]
    // Generous timeout: under load a cold node start alone can take several seconds before the pid is printed.
    const r = await execCapture(cmd, args, { timeoutMs: 10_000, killTree: true })
    expect(r.timedOut).toBe(true)
    const pid = Number(r.stdout.trim())
    expect(pid, r.stdout + r.stderr).toBeGreaterThan(0)
    leftovers.push(pid)
    expect(await waitGone(pid, 15_000)).toBe(true)
  }, 60_000)
})

describe('orphan sweep', () => {
  it('kills a grandchild left behind by a dead recorded process and marks the record', async () => {
    const child = await startFake(sharedFixture('grandchild.script.jsonl'))
    const table = await ProcTable.open(
      join(process.env['DIM_FACTORY_HOME'] ?? work, 'runs', 'r1', 'procs.json'),
    )
    const rec = await table.add(procRecordFor(child, 'implement', 'claude-stdio'))
    const marker = JSON.parse(await lineReader(child.lines())()) as { type: string; pid: number }
    expect(marker.type).toBe('grandchild')
    leftovers.push(marker.pid)
    expect((await child.exited).code).toBe(0)
    expect(isAlive(marker.pid)).toBe(true)

    // "Relaunch": the record has no exit (crash before it was written); the grandchild is an orphan. The
    // file's mtime is the crashed session's last sign of life, which bounds what counts as its child.
    const reopened = await ProcTable.open(table.file)
    expect(reopened.lastWriteAt).toBeDefined()
    const result = await reopened.sweep({ termWaitMs: 1000 })
    expect(result.plan.lost.map((r) => r.id)).toEqual([rec.id])
    expect(result.plan.descendants.map((p) => p.pid)).toEqual([marker.pid])
    expect(result.killed).toEqual([marker.pid])
    expect(await waitGone(marker.pid)).toBe(true)
    expect((await ProcTable.open(table.file)).records()[0]?.exit?.how).toBe('lost')
    // A second relaunch leaves the settled record alone.
    const again = await sweepOrphans((await ProcTable.open(table.file)).records(), {
      lastAliveAt: Date.now(),
    })
    expect(again.plan).toMatchObject({ lost: [], owned: [], pids: [] })
  })

  it('the snapshot reports this boot, which is before any process it lists', async () => {
    const snap = await snapshotProcesses()
    if (snap.source === 'tasklist') return
    expect(typeof snap.bootMs).toBe('number')
    expect(snap.bootMs!).toBeLessThan(Date.now())
    const me = snap.procs.find((p) => p.pid === process.pid)
    expect(me?.startMs).toBeGreaterThan(snap.bootMs!)
  })
})
