// kill -9 of the Dim Factory process during Implement ("Crash relaunch", state-machine row P24):
// the next start sweeps the orphaned vendor grandchild, takes an `interrupted` snapshot, marks the step
// paused(interrupted) and never resumes it on its own.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnedProcs } from '../owned-procs.ts'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import {
  CLI_ENTRY,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
} from '../run/scenario.ts'

const dirs: string[] = []
const owned = new OwnedProcs()
let core: Core | undefined

afterEach(async () => {
  await core?.shutdown()
  core = undefined
  await owned.killAll()
  cleanup(...dirs.splice(0))
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('crash relaunch', () => {
  it('kill -9 during Implement → next start sweeps the grandchild and pauses the step (no auto-resume)', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', grandchildThenSleepMs: 120_000 }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)

    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'run', folder, 'add a --version flag', '--gates', 'approve', '--home', home],
      {
        env: hermeticEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (output += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (output += d))
    const exited = new Promise<void>((r) => child.on('exit', () => r()))
    await owned.add(child.pid)

    await until(() => sc.entries().some((e) => e.kind === 'grandchild'))
    const grandchild = Number(sc.entries().find((e) => e.kind === 'grandchild')?.['pid'])
    await owned.add(grandchild)
    await new Promise((r) => setTimeout(r, 500))
    child.kill('SIGKILL')
    await exited
    expect(alive(grandchild), output).toBe(true)

    const runId = readdirSync(join(home, 'runs'), { withFileTypes: true }).find((d) => d.isDirectory())!.name
    const before = JSON.parse(readFileSync(join(home, 'runs', runId, 'run.json'), 'utf8')) as {
      state: { steps: { implement: { status: string; proc?: { live: boolean } } } }
    }
    expect(before.state.steps.implement.status).toBe('running')
    expect(before.state.steps.implement.proc?.live).toBe(true)
    const spawnsBefore = passArgvs(sc.entries()).length

    // The next start: recovery runs before anything else.
    core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    expect(core.recovery.paused).toEqual([{ runId, displayNo: 1, steps: ['implement'] }])
    await until(() => !alive(grandchild), 15_000)

    const c = core.controller(runId)!
    expect(c.state.steps.implement.status).toBe('paused')
    expect(c.state.steps.implement.pause).toBe('interrupted')
    expect(c.state.status).toBe('paused')
    await c.settle(15_000)
    const snaps = JSON.parse(readFileSync(join(home, 'runs', runId, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.map((s) => s.label)).toContain('interrupted')
    const procs = JSON.parse(readFileSync(join(home, 'runs', runId, 'procs.json'), 'utf8')) as {
      procs: { step: string; exit?: { how: string } }[]
    }
    expect(procs.procs.find((p) => p.step === 'implement')?.exit?.how).toMatch(/lost|orphan-killed/)
    // Never auto-resume: nothing new was spawned.
    await new Promise((r) => setTimeout(r, 1000))
    expect(passArgvs(sc.entries()).length).toBe(spawnsBefore)
    const events = readFileSync(join(home, 'runs', runId, 'events.jsonl'), 'utf8')
    expect(events).toMatch(/"step":"implement","attempt":1,"status":"paused","pause":"interrupted"/)
  }, 120_000)
})
