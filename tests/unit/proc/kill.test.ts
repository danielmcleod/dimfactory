// stopChild / killTree tree discovery with injected snapshots. The pids cannot exist (not multiples of 4 on
// Windows, above pid_max elsewhere), so every signal hits nothing and no real process is touched.
import { describe, expect, it } from 'vitest'
import { killTree, stopChild } from '../../../src/core/proc/kill.ts'
import type { StoppableChild } from '../../../src/core/proc/kill.ts'
import type { ProcInfo, ProcSnapshot } from '../../../src/core/proc/ps.ts'
import type { ExitInfo } from '../../../src/core/proc/spawn.ts'

const ROOT = 2_000_000_001
const SHELL = 2_000_000_005
const SERVER = 2_000_000_009

const p = (pid: number, ppid: number, startMs: number): ProcInfo => ({ pid, ppid, startMs, exe: 'node.exe' })
const snap = (procs: ProcInfo[]): ProcSnapshot => ({ source: 'cim', at: 0, procs, bootMs: 0 })

describe('killTree', () => {
  it('kills known descendants still running (same pid and start) even when their parent exited', async () => {
    const now = snap([p(ROOT, 1, 100), p(SERVER, SHELL, 300)]) // SHELL exited: SERVER hangs off a dead ppid
    const known = [p(SHELL, ROOT, 200), p(SERVER, SHELL, 300)]
    const { killed } = await killTree(ROOT, {
      platform: 'linux',
      spawnAt: 100,
      termWaitMs: 10,
      known,
      snapshot: () => Promise.resolve(now),
    })
    expect(killed).toEqual([SERVER])
    // Without the earlier view the walk cannot see it.
    const blind = await killTree(ROOT, {
      platform: 'linux',
      spawnAt: 100,
      termWaitMs: 10,
      snapshot: () => Promise.resolve(now),
    })
    expect(blind.killed).toEqual([])
  })

  it('a known pid that now belongs to another process (new start time) is left alone', async () => {
    const { killed } = await killTree(ROOT, {
      platform: 'linux',
      spawnAt: 100,
      termWaitMs: 10,
      known: [p(SERVER, SHELL, 300)],
      snapshot: () => Promise.resolve(snap([p(ROOT, 1, 100), p(SERVER, 77, 9_999)])),
    })
    expect(killed).toEqual([])
  })

  it('children the root pid gained after the kill began belong to a process that reused the pid', async () => {
    const later = Date.now() + 60_000
    const { killed } = await killTree(ROOT, {
      platform: 'linux',
      spawnAt: 100,
      termWaitMs: 10,
      snapshot: () =>
        Promise.resolve(snap([p(ROOT, 1, later - 1), p(SHELL, ROOT, 200), p(SERVER, ROOT, later)])),
    })
    expect(killed).toEqual([SHELL])
  })
})

describe('stopChild (win32)', () => {
  it('looks at the tree before the graceful step, so a shell that exits meanwhile does not hide its child', async () => {
    let resolveExit: (e: ExitInfo) => void = () => undefined
    let exitInfo: ExitInfo | null = null
    const exited = new Promise<ExitInfo>((r) => {
      resolveExit = r
    })
    const child: StoppableChild = {
      pid: ROOT,
      pgid: undefined,
      spawnAt: 100,
      exited,
      exitInfo: () => exitInfo,
      closeStdin: () => undefined,
    }
    const views = [
      snap([p(ROOT, 1, 100), p(SHELL, ROOT, 200), p(SERVER, SHELL, 300)]),
      snap([p(ROOT, 1, 100), p(SERVER, SHELL, 300)]),
    ]
    let calls = 0
    const snapshot = (): Promise<ProcSnapshot> => {
      const v = views[Math.min(calls, views.length - 1)]!
      calls++
      if (calls === 2) {
        // The hard kill's own snapshot: let the root "die" right after it.
        setTimeout(() => {
          exitInfo = { code: 1, signal: null, ms: 5 }
          resolveExit(exitInfo)
        }, 5)
      }
      return Promise.resolve(v)
    }
    const r = await stopChild(child, { platform: 'win32', stdinWaitMs: 10, snapshot })
    expect(r.how).toBe('killed')
    expect(calls).toBe(2)
    expect(r.killed).toContain(SERVER)
  })
})
