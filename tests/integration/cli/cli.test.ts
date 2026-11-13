// The dev CLI against fake Claude scenarios built from the real recordings (C06 native plan with ExitPlanMode
// capture → plan gate → C03/C04-style Implement). Subprocess runs check the exit codes 0/3/5, non-TTY asks,
// the plan gate edit, the ask timeout → resume flow and --json; in-process runs inject Ctrl+C for 4 and 130.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import { encodeProjectDir } from '../../../src/core/adapters/claude/session.ts'
import {
  CLI_ENTRY,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
  stdinByScript,
} from '../run/scenario.ts'
import type { FakeLogEntry } from '../../fake-cli/harness.ts'

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(
  args: string[],
  o: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: hermeticEnv(o.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dimf ${args[0]} timed out\n${stdout}\n${stderr}`))
    }, o.timeoutMs ?? 90_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(o.input ?? '')
  })
}

interface RunJson {
  runId: string
  state: {
    status: string
    outcome?: string
    cards: { view: { kind: string } }[]
    steps: Record<string, { status: string; pause?: string; sessionId?: string }>
    allowRules: unknown[]
  }
}

function onlyRun(home: string): { id: string; dir: string; json: RunJson } {
  const runs = join(home, 'runs')
  const ids = readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  expect(ids).toHaveLength(1)
  const id = ids[0]!
  const dir = join(runs, id)
  return { id, dir, json: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunJson }
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }

describe('dimf run (subprocess, non-TTY)', () => {
  it('exit 0: native plan → gate approved with an edited plan (--plan-file) → Implement gets the edited plan', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const planFile = join(sc.dir, 'edited-plan.md')
    writeFileSync(
      planFile,
      '## Goal\nEDITED PLAN MARKER: print the version.\n\n## Steps\n1. Edit `src/cli.ts`\n',
    )
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--gates',
      'approve',
      '--plan-file',
      planFile,
      '--asks',
      'allow',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Run #1 completed \(Clean\)/)
    const run = onlyRun(home)
    expect(run.json.state.status).toBe('completed')
    expect(readFileSync(join(run.dir, 'plan.md'), 'utf8')).toContain('EDITED PLAN MARKER')
    expect(readFileSync(join(run.dir, 'plan.original.md'), 'utf8')).not.toContain('EDITED PLAN MARKER')
    const stdin = stdinByScript(sc.entries())
    const implUser = (stdin.get('implement-1.script.jsonl') ?? []).map(userText).find((t) => t !== '')
    expect(implUser).toContain('EDITED PLAN MARKER')
    expect(implUser).toContain('add a --version flag')
    // Both C04a asks were answered "allow" on the vendor's stdin.
    const answers = (stdin.get('implement-1.script.jsonl') ?? []).filter((l) =>
      l.includes('"behavior":"allow"'),
    )
    expect(answers).toHaveLength(2)
    for (const f of ['events.jsonl', 'snapshots.json', 'resolved.json', 'procs.json'])
      expect(existsSync(join(run.dir, f)), f).toBe(true)
    expect(readFileSync(join(run.dir, 'diffs', 'S0..S1.patch'), 'utf8')).toContain('src/version.ts')
  }, 120_000)

  it('exit 3: a blocked preflight starts nothing and leaves no run folder', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const inside = join(home, 'work')
    mkdirSync(inside)
    const r = await cli(['run', inside, 'do something', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toMatch(/Preflight blocked/)
    const runs = join(home, 'runs')
    expect(existsSync(runs) ? readdirSync(runs).filter((n) => n !== 'index.jsonl') : []).toEqual([])
    expect(passArgvs(sc.entries())).toEqual([])
  }, 60_000)

  it('exit 2 on bad usage', async () => {
    const r = await cli(['run', 'only-folder'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/usage: dimf run/)
    expect((await cli(['run', '.', 'x', '--set', 'timeouts.askMs=1'])).code).toBe(2)
  }, 30_000)

  it('exit 5 at the plan gate without a TTY, then `resume --gates approve` finishes with 0', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const first = await cli(['run', folder, 'add a --version flag', '--home', home])
    expect(first.code, first.stdout + first.stderr).toBe(5)
    expect(first.stdout).toMatch(/Waiting on "Review the plan"/)
    const run = onlyRun(home)
    expect(run.json.state.status).toBe('waiting')
    expect(run.json.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
    // The waiting run keeps its folder lock across processes: a new run there queues behind it (exit 5).
    const queued = await cli(['run', folder, 'another task', '--home', home])
    expect(queued.code, queued.stdout + queued.stderr).toBe(5)
    expect(queued.stdout).toMatch(new RegExp(`Queued behind run #1 ${run.id}`))
    const second = await cli(['resume', run.id, '--gates', 'approve', '--home', home])
    expect(second.code, second.stdout + second.stderr).toBe(0)
    const after = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')) as RunJson
    expect(after.state.status).toBe('completed')
  }, 150_000)

  it('denies asks without a TTY (C04e) and the vendor continues (a Deny lets the vendor go on)', async () => {
    // C04e-ask-deny-twice is C04b's first recording (the vendor asks again after a deny); the live C04b asks once.
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04e-ask-deny-twice', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const r = await cli(['run', folder, 'add a --version flag', '--gates', 'approve', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/denied \(--asks deny\)/)
    const lines = stdinByScript(sc.entries()).get('implement-1.script.jsonl') ?? []
    expect(lines.filter((l) => l.includes('"behavior":"deny"'))).toHaveLength(2)
    const events = readFileSync(join(onlyRun(home).dir, 'events.jsonl'), 'utf8')
    expect(
      events.match(
        /"t":"ask-resolved"[^\n]*"via":"cli"[^\n]*"decision":"deny"|"t":"ask-resolved"[^\n]*"decision":"deny"/g,
      ),
    ).toHaveLength(2)
  }, 120_000)

  it('ask timeout (compressed clock) → paused(ask-timeout), exit 5; resume --allow-timed-out spawns --resume=<session> with the allow-rule', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04d-ask-cancel' }],
      resume: [{ recording: 'C08b-resume-fix', write: versionWrite }],
    })
    const { home, claudeConfigDir } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const fast = { DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_TIME_SCALE: '200' }
    const first = await cli(
      ['run', folder, 'add a --version flag', '--gates', 'approve', '--asks', 'ask', '--home', home],
      { env: fast },
    )
    expect(first.code, first.stdout + first.stderr).toBe(5)
    expect(first.stdout).toMatch(/question timed out/)
    expect(first.stdout).toMatch(/--allow-timed-out/)
    const run = onlyRun(home)
    const impl = run.json.state.steps['implement']!
    expect(impl.status).toBe('paused')
    expect(impl.pause).toBe('ask-timeout')
    const sid = impl.sessionId
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    // The real CLI keeps the transcript; canResume looks for it under CLAUDE_CONFIG_DIR.
    const projects = join(claudeConfigDir, 'projects', encodeProjectDir(folder))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${sid}.jsonl`), '{}\n')
    // The cancel the timer sent: deny + interrupt.
    const implStdin = stdinByScript(sc.entries()).get('implement-1.script.jsonl') ?? []
    expect(implStdin.some((l) => l.includes('"behavior":"deny"') && l.includes('"interrupt":true'))).toBe(
      true,
    )

    // P19 "Allow & resume": the timed-out `npm --version` becomes an exact allow-rule of the run.
    const second = await cli(['resume', run.id, '--allow-timed-out', '--home', home])
    expect(second.code, second.stdout + second.stderr).toBe(0)
    expect(onlyRun(home).json.state.allowRules).toEqual([
      expect.objectContaining({
        vendor: 'claude',
        tool: 'Bash',
        match: { argv: ['npm', '--version'] },
        nativeRules: ['Bash(npm --version)'],
        source: 'exact',
      }),
    ])
    // Review ∥ Critic run after the resumed Implement, so the resume is no longer the last process.
    const resumed = passArgvs(sc.entries()).find((a) => a.some((x) => x.startsWith('--resume=')))
    expect(resumed).toContain(`--resume=${sid}`)
    const allowed = resumed?.[resumed.indexOf('--allowedTools') + 1]
    expect(allowed).toContain('Bash(npm --version)')
    expect(resumed?.some((a) => a.startsWith('--session-id'))).toBe(false)
    const resumeUser = (stdinByScript(sc.entries()).get('resume-1.script.jsonl') ?? [])
      .map(userText)
      .find((t) => t !== '')
    expect(resumeUser).toBe('continue')
    expect(onlyRun(home).json.state.status).toBe('completed')
  }, 150_000)

  it('exit 1: an auth failure with ANTHROPIC_API_KEY set (C09c) ends in a snag offering to unset the key', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C09c-invalid-api-key' }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const r = await cli(['run', folder, 'add a --version flag', '--gates', 'approve', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toMatch(/Implement: .*log in/)
    expect(r.stdout).toMatch(/Copy command to unset ANTHROPIC_API_KEY: .*ANTHROPIC_API_KEY/)
    const run = onlyRun(home)
    expect(run.json.state.status).toBe('failed')
    const events = readFileSync(join(run.dir, 'events.jsonl'), 'utf8')
    expect(events).toMatch(/"t":"snag","step":"implement","failure":{"category":"auth_required"/)
    expect(events).toMatch(/"id":"implement:unset-api-key"/)
  }, 120_000)

  it('exit 6 when another Dim Factory process holds the home', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const { createCore } = await import('../../../src/core/app-core.ts')
    const holder = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    try {
      const r = await cli(['run', folder, 'x', '--home', home])
      expect(r.code, r.stderr).toBe(6)
      expect(r.stderr).toMatch(/Another Dim Factory process is using this home/)
    } finally {
      await holder.shutdown()
    }
  }, 60_000)

  it('--json prints envelopes byte-identical to events.jsonl', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--gates',
      'approve',
      '--json',
      '--home',
      home,
    ])
    expect(r.code, r.stderr).toBe(0)
    const printed = r.stdout.split('\n').filter((l) => l.trim() !== '')
    const file = readFileSync(join(onlyRun(home).dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(1)
    expect(printed).toEqual(file)
    expect(r.stderr).toMatch(/Run #1 completed/)
  }, 120_000)
})

// ---- in-process: Ctrl+C and a TTY prompt --------------------------------------------------------------------------

function fakeIo(o: {
  env: Record<string, string | undefined>
  tty?: boolean
  stdin?: NodeJS.ReadableStream
}): {
  io: Partial<CliIo>
  out: string[]
  interrupt: () => void
} {
  const out: string[] = []
  const handlers: (() => void)[] = []
  return {
    out,
    interrupt: () => {
      for (const h of [...handlers]) h()
    },
    io: {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin: o.stdin ?? Readable.from([]),
      isTTY: o.tty === true,
      env: o.env,
      cwd: process.cwd(),
      onInterrupt: (fn) => {
        handlers.push(fn)
        return () => {
          const i = handlers.indexOf(fn)
          if (i >= 0) handlers.splice(i, 1)
        }
      },
    },
  }
}

/**
 * The plan pass is mid-turn: the fake vendor started for the pass has read the plan prompt on stdin. Before that it is
 * still in its start-up handshake, where a stop closes its stdin and it may exit on its own before a hard kill lands.
 */
function planMidTurn(entries: readonly FakeLogEntry[]): boolean {
  const start = entries.find(
    (e) =>
      e.kind === 'start' &&
      Array.isArray(e['argv']) &&
      (e['argv'] as string[]).includes('-p') &&
      !(e['argv'] as string[]).includes('default'),
  )
  const pid = start?.['pid']
  return (
    pid !== undefined &&
    entries.some((e) => e.kind === 'stdin' && e['pid'] === pid && String(e['line']).includes('"type":"user"'))
  )
}

async function until(pred: () => boolean, ms = 30_000, everyMs = 50): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

describe('dimf run (in-process)', () => {
  it('exit 4: Ctrl+C stops the run gracefully (cancelled)', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host', delayMs: 60_000 } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const f = fakeIo({ env: hermeticEnv() })
    const running = main(['run', folder, 'add a --version flag', '--home', home], f.io)
    // The signal, not a sleep: the plan pass is mid-turn (the fake vendor has its prompt, so its start-up handshake is
    // over). A Ctrl+C before the CLI follows the run (first-launch setup still in flight) is kept and replayed.
    await until(() => planMidTurn(sc.entries()))
    f.interrupt()
    const code = await running
    expect(code, f.out.join('\n')).toBe(4)
    const run = onlyRun(home)
    expect(run.json.state.status).toBe('cancelled')
    expect(run.json.state.steps['plan']!.status).toBe('cancelled')
  }, 90_000)

  it('exit 4: a Ctrl+C the moment the pass starts (before the CLI follows the run) is not lost', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host', delayMs: 60_000 } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const f = fakeIo({ env: hermeticEnv() })
    const running = main(['run', folder, 'add a --version flag', '--home', home], f.io)
    // As early as the test can see the pass: the CLI may still be in first-launch setup, not following the run yet.
    await until(() => passArgvs(sc.entries()).length === 1, 30_000, 5)
    f.interrupt()
    const code = await running
    expect(code, f.out.join('\n')).toBe(4)
    expect(f.out).toContain('Stopping the run (press Ctrl+C again within 2 s to kill it)…')
    const run = onlyRun(home)
    expect(run.json.state.status).toBe('cancelled')
    expect(run.json.state.steps['plan']!.status).toBe('cancelled')
  }, 90_000)

  it('exit 130: a second Ctrl+C within 2 s hard-kills the vendor', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host', delayMs: 60_000 } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const f = fakeIo({ env: hermeticEnv() })
    const running = main(['run', folder, 'add a --version flag', '--home', home], f.io)
    // The signal, not a sleep: the plan pass is mid-turn (the fake vendor has its prompt, so its start-up handshake is
    // over). A Ctrl+C before the CLI follows the run (first-launch setup still in flight) is kept and replayed.
    await until(() => planMidTurn(sc.entries()))
    f.interrupt()
    f.interrupt()
    const code = await running
    expect(code, f.out.join('\n')).toBe(130)
    const exits = sc.entries().filter((e) => e.kind === 'exit')
    // version, auth, probe handshake exit normally; the plan process never reached its own exit.
    expect(exits.length).toBe(3)
  }, 90_000)

  it('TTY: the plan gate is a numbered prompt built from the card choices', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const stdin = new PassThrough()
    const f = fakeIo({ env: hermeticEnv(), tty: true, stdin })
    const running = main(['run', folder, 'add a --version flag', '--home', home], f.io)
    await until(() => f.out.some((l) => l.startsWith('Choose 1-')))
    expect(f.out.join('\n')).toMatch(
      /1\) Approve \(default\)[\s\S]*2\) Edit the plan, then approve[\s\S]*3\) Cancel run/,
    )
    stdin.write('1\n')
    const code = await running
    expect(code, f.out.join('\n')).toBe(0)
    expect(onlyRun(home).json.state.status).toBe('completed')
  }, 90_000)
})
