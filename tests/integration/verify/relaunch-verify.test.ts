// A runner step across a crash (runner steps use the pass statuses except stalled, and
// Resume reruns them idempotently; "Crash relaunch", P24): kill -9 of the Dim Factory CLI while verify:1 runs a command
// → the next start sweeps the orphaned verify command (procs.json), marks verify:1 paused(interrupted) and never
// resumes it on its own → Resume reruns the round from its trust check, and the run completes.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnedProcs } from '../owned-procs.ts'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { grantTrust } from '../../../src/core/config/trust.ts'
import { CLI_ENTRY, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import { settled, value, version } from './helpers.ts'

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

/** The first run records its pid and never ends; a later run (the marker exists) passes at once. */
const SLOW = [
  "import { existsSync, writeFileSync } from 'node:fs'",
  'const marker = process.argv[2]',
  "if (existsSync(marker)) { console.log('second run: ok'); process.exit(0) }",
  'writeFileSync(marker, String(process.pid))',
  'setInterval(() => {}, 1000)',
].join('\n')

describe('verify:1 across a crash relaunch', () => {
  it('kill -9 during the round → swept, paused(interrupted), no auto-resume → Resume reruns it → completes', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    writeFileSync(join(folder, 'slow.mjs'), SLOW)
    const marker = join(home, 'slow.pid')
    const argv = ['node', 'slow.mjs', marker]
    await grantTrust(folder, { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.' } }, { home })

    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'run',
        folder,
        'add a --version flag',
        '--gates',
        'approve',
        '--home',
        home,
        '--set',
        'verify.enabled=true',
        '--set',
        `verify.commands=${JSON.stringify([{ name: 'slow', run: argv }])}`,
      ],
      { env: hermeticEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (output += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (output += d))
    const exited = new Promise<void>((r) => child.on('exit', () => r()))
    await owned.add(child.pid)

    await until(() => existsSync(marker), 90_000).catch((err: unknown) => {
      throw new Error(`${String(err)}\n${output}`)
    })
    const verifyPid = Number(readFileSync(marker, 'utf8'))
    await owned.add(verifyPid)
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(verifyPid), output).toBe(true)
    child.kill('SIGKILL')
    await exited
    // On POSIX the command (its own process group) outlives Dim Factory until the sweep; on Windows libuv's job object
    // takes it down with the CLI. Either way it is gone after the next start.

    const runId = readdirSync(join(home, 'runs'), { withFileTypes: true }).find((d) => d.isDirectory())!.name
    const before = JSON.parse(readFileSync(join(home, 'runs', runId, 'run.json'), 'utf8')) as {
      state: { steps: Record<string, { status: string }> }
    }
    expect(before.state.steps['verify:1']?.status).toBe('running')

    // The next start: recovery sweeps the round's orphaned command and pauses the step.
    core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    expect(core.recovery.paused).toEqual([{ runId, displayNo: 1, steps: ['verify:1'] }])
    await until(() => !alive(verifyPid), 20_000)
    const c = core.controller(runId)!
    expect(c.state.steps['verify:1']).toMatchObject({ status: 'paused', pause: 'interrupted', attempt: 1 })
    expect(c.state.status).toBe('paused')
    await c.settle(15_000)
    const procs = JSON.parse(readFileSync(join(home, 'runs', runId, 'procs.json'), 'utf8')) as {
      procs: { step: string; exit?: { how: string } }[]
    }
    expect(procs.procs.find((p) => p.step === 'verify:1')?.exit?.how).toMatch(/lost|orphan-killed/)
    // Never auto-resume.
    await new Promise((r) => setTimeout(r, 1000))
    expect(c.state.steps['verify:1'].status).toBe('paused')

    // Resume reruns the round (attempt 2) from its trust check; this time the command passes.
    value(await core.invoke('runs.resume', { runId }))
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    expect(done.outcome).toBe('clean')
    expect(done.steps['verify:1']).toMatchObject({ status: 'done', attempt: 2 })
    expect(done.steps['verify:1'].verify?.commands[0]).toMatchObject({ name: 'slow', status: 'pass' })
  }, 240_000)
})
