// Verify round execution against real processes (execution and results; the runner steps):
// pass/fail with excerpt and logs, the child's env (CI=1 NO_COLOR=1 TERM=dumb, stdin ignored), environment failures
// classified as `env` (a missing tool, a .cmd exiting 9009 / a script exiting 127, a node script requiring a missing
// module), failFast, the timeout's tree kill, Stop, trust re-checked before each spawn (untrusted and changed bodies
// never run), a package script through the real npm, and a failing round's [must] cleared by a "fix".
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import { homePaths } from '../../../src/core/home.ts'
import { ProcTable } from '../../../src/core/proc/proc-table.ts'
import { isAlive } from '../../../src/core/proc/ps.ts'
import { readBody } from '../../../src/core/verify/discover.ts'
import {
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from '../../../src/core/verify/render.ts'
import { readVerifyOutput } from '../../../src/core/supervisor/verify-output.ts'
import { runVerifyRound } from '../../../src/core/verify/run.ts'
import type { VerifyDeps, VerifyOutputEvent, VerifyRoundCommand } from '../../../src/core/verify/run.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import { pkg, removeDir, tempDir, writeFiles } from '../../unit/verify/helpers.ts'

const isWin = process.platform === 'win32'
const RUN = '20261009T120000Z-verify'
const PATH = [dirname(process.execPath), process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter)

let folder = ''
beforeEach(() => {
  folder = tempDir('dim-factory-verify-run-')
})
afterEach(() => removeDir(folder))

const cmd = (name: string, run: string[], extra: Partial<VerifyRoundCommand> = {}): VerifyRoundCommand => ({
  name,
  run,
  cwdRel: '.',
  ...extra,
})

/** Grants for these commands with the bodies on disk now (what the user trusted). */
async function trustAll(commands: readonly VerifyRoundCommand[]): Promise<TrustGrants> {
  const out: NonNullable<TrustGrants['commands']> = {}
  for (const c of commands) {
    const argv = Array.isArray(c.run) ? [...(c.run as string[])] : []
    const body = await readBody(folder, c)
    const g = { kind: 'verify' as const, argv, cwdRel: '.', ...(body !== null ? { body } : {}) }
    out[commandGrantHash(g)] = { ...g, at: 1 }
  }
  return { commands: out }
}

function deps(grants: TrustGrants, extra: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    paths: homePaths(process.env['DIM_FACTORY_HOME'] ?? ''),
    pathEnv: PATH,
    grants: () => Promise.resolve(grants),
    ...extra,
  }
}

async function round(
  commands: VerifyRoundCommand[],
  o: {
    failFast?: boolean
    grants?: TrustGrants
    timeoutMs?: number
    signal?: AbortSignal
    d?: Partial<VerifyDeps>
  } = {},
) {
  const events: VerifyOutputEvent[] = []
  const grants = o.grants ?? (await trustAll(commands))
  const result = await runVerifyRound(deps(grants, o.d), {
    runId: RUN,
    round: 'verify:1',
    folder,
    commands,
    failFast: o.failFast ?? false,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    onOutput: (e) => events.push(e),
  })
  return { ...result, events }
}

const SCRIPTS = {
  'pass.cjs': [
    'const e = process.env',
    'console.log(JSON.stringify({ CI: e.CI, NO_COLOR: e.NO_COLOR, TERM: e.TERM, FORCE: e.FORCE_COLOR ?? null }))',
    "process.stdin.on('data', () => {})",
    "process.stdin.on('end', () => process.exit(0))",
    'process.stdin.resume()',
  ].join('\n'),
  // One stream only: the order between two pipes is not the order the child wrote in (on Linux the parent can read
  // all of stdout before the stderr line), so a stdout/stderr mix has no fixed excerpt. pass.cjs covers stdout.
  'fail.cjs': [
    "for (let i = 0; i < 80; i++) console.error('progress ' + i)",
    "console.error('\\u001b[31mAssertionError: expected 1 to be 2\\u001b[0m')",
    "for (let i = 0; i < 70; i++) console.error('after ' + i)",
    "console.error('Tests: 1 failed')",
    'process.exit(2)',
  ].join('\n'),
}

describe('runVerifyRound', () => {
  it('pass and fail: statuses, excerpt, logs, output events and the child env', async () => {
    writeFiles(folder, SCRIPTS)
    const r = await round([cmd('ok', ['node', 'pass.cjs']), cmd('unit', ['node', 'fail.cjs'])], {
      timeoutMs: 30_000,
    })
    const [ok, unit] = r.results
    expect(ok).toMatchObject({ name: 'ok', status: 'pass', exitCode: 0, excerpt: '' })
    expect(unit).toMatchObject({ name: 'unit', status: 'fail', exitCode: 2 })
    expect(unit?.excerpt).toContain('AssertionError: expected 1 to be 2')
    expect(unit?.excerpt).not.toContain('\u001b')
    expect(unit?.excerpt.split('\n').at(-1)).toBe('Tests: 1 failed')
    expect(unit?.excerpt.split('\n')).toHaveLength(2 + 1 + 2 + 1 + 60) // context, error, context, …, tail

    const dir = join(homePaths(process.env['DIM_FACTORY_HOME'] ?? '').run(RUN).dir, 'verify', 'verify-1')
    expect(r.logDir).toBe(dir)
    expect(ok?.logPath).toBe(join(dir, '1-ok.log'))
    expect(unit?.logPath).toBe(join(dir, '2-unit.log'))
    const okLog = readFileSync(ok?.logPath ?? '', 'utf8')
    expect(okLog.split('\n')[0]).toBe('$ node pass.cjs')
    // The child saw CI=1 NO_COLOR=1 TERM=dumb, no FORCE_COLOR, and an ignored stdin (it reached EOF at once).
    expect(JSON.parse(okLog.split('\n')[1] ?? '{}')).toEqual({
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
      FORCE: null,
    })
    const unitLog = readFileSync(unit?.logPath ?? '', 'utf8')
    expect(unitLog).toContain('progress 0\n')
    expect(unitLog).toContain('Tests: 1 failed\n[failed with exit 2 after')
    const all = readFileSync(r.outputLog, 'utf8')
    expect(all.indexOf('$ node pass.cjs')).toBeLessThan(all.indexOf('$ node fail.cjs'))

    const kinds = r.events.map((e) => `${e.type}:${e.index}`)
    expect(kinds[0]).toBe('start:0')
    expect(kinds.indexOf('end:0')).toBeLessThan(kinds.indexOf('start:1'))
    expect(kinds.at(-1)).toBe('end:1')
    expect(
      r.events.filter((e) => e.type === 'line' && e.index === 0).map((e) => e.type === 'line' && e.stream),
    ).toEqual(['stdout'])
    expect(r.events.filter((e) => e.type === 'line' && e.index === 1)).toHaveLength(152)
    expect(r.events).toContainEqual({
      type: 'line',
      index: 1,
      name: 'unit',
      stream: 'stderr',
      line: 'AssertionError: expected 1 to be 2',
    })
    expect(r.aborted).toBeUndefined()
  })

  it('environment failures are `env`: a missing tool, a node script requiring a missing module, 9009 / 127', async () => {
    const commands = [
      cmd('missing', ['dim-factory-no-such-tool-xyz', '--version']),
      cmd('module', ['node', '-e', "require('dim-factory-missing-module-xyz')"]),
    ]
    if (isWin) {
      writeFiles(folder, {
        'nf.cmd': '@dim-factory-not-a-command-xyz --flag\r\n',
        'quiet.cmd': '@exit /b 9009\r\n',
      })
      commands.push(cmd('not recognized', ['./nf.cmd']), cmd('9009', ['./quiet.cmd']))
    } else {
      writeFiles(folder, {
        'nf.sh': '#!/bin/sh\ndim-factory-not-a-command-xyz --flag\n',
        'quiet.sh': '#!/bin/sh\nexit 127\n',
      })
      chmodSync(join(folder, 'nf.sh'), 0o755)
      chmodSync(join(folder, 'quiet.sh'), 0o755)
      commands.push(cmd('not recognized', ['./nf.sh']), cmd('9009', ['./quiet.sh']))
    }
    const r = await round(commands)
    expect(r.results.map((x) => [x.name, x.status])).toEqual([
      ['missing', 'env'],
      ['module', 'env'],
      ['not recognized', 'env'],
      ['9009', 'env'],
    ])
    const [missing, module, nf, quiet] = r.results
    expect(missing).toMatchObject({
      exitCode: null,
      reason: 'Dim Factory could not find dim-factory-no-such-tool-xyz',
    })
    expect(module?.reason).toBe(
      "A package is missing: dim-factory-missing-module-xyz (install the project's dependencies)",
    )
    expect(nf?.reason).toBe('A program it runs was not found: dim-factory-not-a-command-xyz')
    // cmd /c reports a batch file's "not recognized" as exit 1 (the message decides); sh exits 127.
    expect(nf?.exitCode).toBe(isWin ? 1 : 127)
    expect(quiet).toMatchObject({ exitCode: isWin ? 9009 : 127 })
    expect(quiet?.reason).toMatch(/not found \(exit (9009|127)\)/)
    // Environment failures are never findings.
    expect(verifyFindings(r.results)).toEqual([])
    expect(verifyHasMustFailures(r.results)).toBe(false)
  })

  it('failFast stops the round at the first failure; without it every command runs', async () => {
    writeFiles(folder, SCRIPTS)
    const commands = [cmd('unit', ['node', 'fail.cjs']), cmd('ok', ['node', 'pass.cjs'])]
    const fast = await round(commands, { failFast: true })
    expect(fast.aborted).toBe(true)
    expect(fast.results.map((x) => x.status)).toEqual(['fail', 'skipped'])
    expect(fast.results[1]?.reason).toBe('Not run: failFast stopped the round after unit failed')
    const all = await round(commands, { failFast: false })
    expect(all.aborted).toBeUndefined()
    expect(all.results.map((x) => x.status)).toEqual(['fail', 'pass'])
  })

  it('a timeout fails the command and kills its whole tree', async () => {
    writeFiles(folder, {
      'tree.cjs': [
        "const { spawn } = require('node:child_process')",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        "require('node:fs').writeFileSync('grandchild.pid', String(g.pid))",
        "console.log('started ' + g.pid)",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    })
    const procs = await ProcTable.open(join(folder, 'procs.json'))
    const r = await round([cmd('hang', ['node', 'tree.cjs'], { timeoutMs: 6000 })], {
      d: { procTable: procs },
    })
    const [hang] = r.results
    expect(hang).toMatchObject({
      status: 'fail',
      exitCode: null,
      timedOut: true,
      reason: 'Timed out after 6s',
    })
    expect(hang?.durationMs).toBeGreaterThanOrEqual(5900)
    const pid = Number(readFileSync(join(folder, 'grandchild.pid'), 'utf8'))
    const deadline = Date.now() + 10_000
    while (isAlive(pid) && Date.now() < deadline) await delay(200)
    expect(isAlive(pid)).toBe(false)
    expect(procs.records()).toHaveLength(1)
    expect(procs.records()[0]).toMatchObject({
      step: 'verify:1',
      transport: 'verify',
      exit: { how: 'killed' },
    })
    expect(verifyFindings(r.results)[0]?.title).toMatch(/^`node tree\.cjs` timed out \(/)
  })

  it('Stop kills the running command; the rest are not run', async () => {
    writeFiles(folder, SCRIPTS)
    const ac = new AbortController()
    const commands = [
      cmd('long', ['node', '-e', "console.log('up'); setInterval(() => {}, 1000)"]),
      cmd('ok', ['node', 'pass.cjs']),
    ]
    const grants = await trustAll(commands)
    const events: VerifyOutputEvent[] = []
    const started = runVerifyRound(deps(grants), {
      runId: RUN,
      round: 'verify:2',
      folder,
      commands,
      failFast: false,
      signal: ac.signal,
      onOutput: (e) => {
        events.push(e)
        if (e.type === 'line' && e.line === 'up') ac.abort()
      },
    })
    const r = await started
    expect(r.stopped).toBe(true)
    expect(r.results.map((x) => [x.status, x.reason])).toEqual([
      ['skipped', 'Stopped before it finished'],
      ['skipped', 'Stopped before it ran'],
    ])
    expect(r.logDir.endsWith(join('verify', 'verify-2'))).toBe(true)
  })

  it('nothing runs untrusted: no grant, or a grant for another body (re-read before the round)', async () => {
    writeFiles(folder, {
      'package.json': pkg({ test: 'node mark.cjs' }),
      'mark.cjs': "require('node:fs').writeFileSync('ran.txt', 'x')",
    })
    const test = cmd('test', ['npm', 'run', 'test'])
    const direct = cmd('direct', ['node', 'mark.cjs'])
    const none = await round([test, direct], { grants: {} })
    expect(none.results.map((x) => [x.status, x.trust, x.reason])).toEqual([
      ['skipped-untrusted', 'untrusted', 'Not trusted'],
      ['skipped-untrusted', 'untrusted', 'Not trusted'],
    ])

    const grants = await trustAll([test])
    writeFiles(folder, { 'package.json': pkg({ test: 'node mark.cjs && node -e "1"' }) })
    const changed = await round([test], { grants })
    expect(changed.results[0]).toMatchObject({
      status: 'skipped-untrusted',
      trust: 'changed',
      reason: 'Changed since it was trusted',
      exitCode: null,
      logPath: '',
    })
    expect(existsSync(join(folder, 'ran.txt'))).toBe(false)
    // In Auto these become [should] findings; they never block the skip rule.
    expect(verifyFindings(changed.results).map((f) => [f.severity, f.title])).toEqual([
      ['should', '`npm run test` changed since it was trusted, so it was not run (it needs your approval)'],
    ])
    expect(renderVerifySection(changed.results)).toBe(
      '- NOT RUN `npm run test` (changed since it was trusted)',
    )
  })

  it('commands the engine decided not to run, invalid ones and a cwd outside the project are reported, not run', async () => {
    const r = await round(
      [
        { name: 'auto-skipped', argv: ['node', '-v'], cwdRel: '.', run: false, status: 'skipped-untrusted' },
        { name: 'user-skipped', argv: ['node', '-v'], cwdRel: '.', run: false, reason: 'Skipped by you' },
        { name: 'bad', run: [], cwdRel: '.', error: 'It uses `|`' },
        { name: 'away', run: ['node', '-v'], cwdRel: '../elsewhere' },
      ],
      { grants: {} },
    )
    expect(r.results.map((x) => [x.name, x.status, x.reason ?? null, x.trust ?? null])).toEqual([
      ['auto-skipped', 'skipped-untrusted', null, 'untrusted'],
      ['user-skipped', 'skipped', 'Skipped by you', null],
      ['bad', 'skipped', 'It uses `|`', null],
      ['away', 'skipped', 'Its folder is outside the project', null],
    ])
  })

  it('a package script through the real npm (a .cmd shim on win32) and a failing round cleared by a fix', async () => {
    writeFiles(folder, {
      'package.json': pkg({ test: 'node check.cjs' }),
      'check.cjs': "console.error('Error: sum(1, 1) returned 3'); process.exit(1)",
    })
    const test = cmd('test', ['npm', 'run', 'test'])
    const grants = await trustAll([test])
    const first = await round([test], { grants })
    expect(first.results[0]?.status).toBe('fail')
    expect(first.results[0]?.exitCode).not.toBe(0)
    expect(first.results[0]?.excerpt).toContain('Error: sum(1, 1) returned 3')
    const must = verifyFindings(first.results)
    expect(must.map((f) => [f.severity, f.source])).toEqual([['must', 'verify']])
    expect(must[0]?.title).toMatch(/^`npm run test` failed \(exit \d+, \d+s\)$/)
    expect(verifyHasMustFailures(first.results)).toBe(true)

    // "Fix" changes the code, not the script: the grant still covers the body and the next round passes.
    writeFiles(folder, { 'check.cjs': "console.log('ok')" })
    const second = await round([test], { grants })
    expect(second.results[0]?.status).toBe('pass')
    expect(verifyFindings(second.results)).toEqual([])
    expect(renderVerifySection(second.results)).toMatch(/^- PASS `npm run test` \(\d+s\)$/)
  })

  // output.log reaches the disk past a command's first 1 MB only when the command ends, so the Run view
  // (runs.output verify:<n>) froze for a chatty suite. It reads live.log, current while the command still runs.
  it('the live output stays current past 1 MB while the command runs (runs.output reads live.log)', async () => {
    writeFiles(folder, {
      'chatty.cjs': [
        "const line = 'x'.repeat(1023) + '\\n'",
        'for (let i = 0; i < 1300; i++) process.stdout.write(line)',
        "console.log('MARKER-END')",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    })
    const ac = new AbortController()
    const commands = [cmd('chatty', ['node', 'chatty.cjs'])]
    let written = 0
    const run = homePaths(process.env['DIM_FACTORY_HOME'] ?? '').run(RUN)
    const started = runVerifyRound(deps(await trustAll(commands)), {
      runId: RUN,
      round: 'verify:1',
      folder,
      commands,
      failFast: false,
      signal: ac.signal,
      onOutputWritten: () => written++,
    })
    let seen = ''
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      seen = (await readVerifyOutput(run, 'verify:1').catch(() => ({ text: '' }))).text
      if (seen.includes('MARKER-END')) break
      await delay(100)
    }
    // Seen while the command is still running (it never exits on its own).
    expect(seen.endsWith('MARKER-END\n')).toBe(true)
    expect(seen.startsWith('[Earlier output: ')).toBe(true)
    expect(Buffer.byteLength(seen)).toBeLessThanOrEqual(256 * 1024 + 1024)
    expect(written).toBeGreaterThan(0)
    expect(readFileSync(join(run.verify('verify:1'), 'output.log'), 'utf8')).not.toContain('MARKER-END')
    ac.abort()
    const r = await started
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'Stopped before it finished' })
    expect(r.liveLog).toBe(join(r.logDir, 'live.log'))
    expect((await readVerifyOutput(run, 'verify:1')).text).toContain('[not run: Stopped before it finished]')
  }, 60_000)

  it('a rerun of the round starts over in a cleared folder', async () => {
    writeFiles(folder, SCRIPTS)
    const a = await round([cmd('a', ['node', 'pass.cjs']), cmd('b', ['node', 'pass.cjs'])])
    expect(existsSync(join(a.logDir, '2-b.log'))).toBe(true)
    const b = await round([cmd('a', ['node', 'pass.cjs'])])
    expect(existsSync(join(b.logDir, '1-a.log'))).toBe(true)
    expect(existsSync(join(b.logDir, '2-b.log'))).toBe(false)
  })
})

describe.skipIf(isWin)('POSIX executables', () => {
  it('runs an executable script relative to the cwd', async () => {
    writeFileSync(join(folder, 'ok.sh'), '#!/bin/sh\necho fine\n')
    chmodSync(join(folder, 'ok.sh'), 0o755)
    const r = await round([cmd('sh', ['./ok.sh'])])
    expect(r.results[0]).toMatchObject({ status: 'pass', exitCode: 0 })
  })
})
