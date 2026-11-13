// The processes a test started, killed at its end only while they are still those processes. A pid freed by an exited
// process is soon given to another one (fast on Windows), maybe a git or fake CLI of a test running beside this one:
// killing the number alone ends that stranger (on Windows with exit 1). Each pid keeps the start time it had when it
// was noted, and the kill goes only to a process with the same pid and start time.
import { snapshotProcesses } from '../../src/core/proc/ps.ts'

export class OwnedProcs {
  private readonly started = new Map<number, number>()

  /** Notes `pid` while it is surely this test's (it is running). A process already gone is not noted. */
  async add(pid: number | undefined): Promise<void> {
    if (pid === undefined) return
    const procs = await snapshotProcesses().then(
      (s) => s.procs,
      () => [],
    )
    const start = procs.find((p) => p.pid === pid)?.startMs
    if (typeof start === 'number') this.started.set(pid, start)
  }

  /** Kills each noted process that still runs with the start time it was noted with, and forgets them all. */
  async killAll(): Promise<void> {
    if (this.started.size === 0) return
    const owned = new Map(this.started)
    this.started.clear()
    const now = (await snapshotProcesses()).procs
    for (const p of now) {
      if (owned.get(p.pid) !== p.startMs) continue
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}
