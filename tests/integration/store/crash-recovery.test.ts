// Real-process durability: a writer killed mid-stream (kill -9 / TerminateProcess) and a lock holder that dies.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../../src/core/bus/bus.ts'
import { homePaths } from '../../../src/core/home.ts'
import { acquireHomeLock, checkLockHolder, readHomeLock } from '../../../src/core/store/home-lock.ts'
import type { LockInfo } from '../../../src/core/store/home-lock.ts'
import { readJsonlAll } from '../../../src/core/store/jsonl.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const children: ChildProcessWithoutNullStreams[] = []

function start(script: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [fixture(script), ...args], {
    stdio: 'pipe',
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  children.push(child)
  return child
}

/** Resolve with the first stdout line matching `re` (rejects on exit). */
function waitForLine(child: ChildProcessWithoutNullStreams, re: RegExp, count = 1): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const got: string[] = []
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!re.test(line)) return
      got.push(line)
      if (got.length === count) resolve(got)
    })
    child.once('exit', (code) => reject(new Error(`child exited ${code}: ${stderr}`)))
  })
}

function hardKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

afterEach(async () => {
  for (const c of children.splice(0)) await hardKill(c)
})

describe('events.jsonl survives a hard kill', () => {
  it('reopens with contiguous seqs, no bad lines, and every synced envelope kept', async () => {
    const child = start('bus-writer.ts', [home(), 'crash1'])
    const lines = await waitForLine(child, /^synced \d+$/, 8)
    await hardKill(child)
    const syncedSeq = Math.max(...lines.map((l) => Number(l.split(' ')[1])))
    expect(syncedSeq).toBeGreaterThan(0)

    const bus = new EventBus({ home: home() })
    const opened = await bus.openRun('crash1')
    expect(opened.created).toBe(false)
    expect(opened.lastSeq).toBeGreaterThanOrEqual(syncedSeq)
    const next = bus.emit('crash1', { t: 'run-status', status: 'paused', phase: 'needs-attention' })
    expect(next.seq).toBe(opened.lastSeq + 1)
    await bus.closeRun('crash1')

    const { values, stats } = await readJsonlAll(homePaths(home()).run('crash1').eventsJsonl)
    expect(stats.bad).toBe(0)
    expect(stats.partialTail).toBe(false)
    const seqs = values.map((v) => (v as { seq: number }).seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i))

    const bus2 = new EventBus({ home: home() })
    const replayed: number[] = []
    let since = 0
    for (;;) {
      const page = await bus2.replay('crash1', since, 2000)
      replayed.push(...page.events.map((e) => e.seq))
      since = page.events.at(-1)?.seq ?? since
      if (!page.more) break
    }
    expect(replayed).toEqual(Array.from({ length: next.seq }, (_, i) => i + 1))
  })
})

describe('home lock with real processes', () => {
  it('a live holder blocks; once it is killed the lock is stale and can be taken', async () => {
    const child = start('lock-holder.ts', [home()])
    const [line] = await waitForLine(child, /^locked /)
    const [, pid] = (line ?? '').split(' ')
    expect(Number(pid)).toBe(child.pid)

    // Real ps snapshot: the holder's OS start time matches the recorded startMs.
    await expect(acquireHomeLock(home(), { kind: 'cli' })).rejects.toMatchObject({
      code: 'HOME_LOCKED',
      details: { pid: child.pid, kind: 'app', reason: 'alive' },
    })

    await hardKill(child)
    const lock = await acquireHomeLock(home(), { kind: 'cli' })
    expect(lock.info.pid).toBe(process.pid)
    await lock.release()
    expect(await readHomeLock(home())).toBeNull()
  })

  it('detects pid reuse: a live pid whose start time does not match is stale', async () => {
    // A live process (holding a lock in another home) stands in for "the pid was reused".
    const child = start('lock-holder.ts', [join(home(), 'other-home')])
    await waitForLine(child, /^locked /)
    const pid = child.pid ?? 0
    const reused: LockInfo = {
      schemaVersion: 1,
      pid,
      startMs: Date.now() - 3_600_000,
      kind: 'app',
      acquiredAt: 0,
    }
    expect(await checkLockHolder(reused)).toEqual({
      stale: true,
      reason: 'pid-reused',
    })
    await writeFile(homePaths(home()).instanceLock, JSON.stringify(reused))
    const lock = await acquireHomeLock(home(), { kind: 'app' })
    expect(lock.info.pid).toBe(process.pid)
    await lock.release()
  })
})
