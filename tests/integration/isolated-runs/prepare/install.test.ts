// Deps install against real processes (Prepare step 3, deps detection; verify command execution; failure category
// deps_missing). Node scripts stand in for pnpm / npm / corepack (no network): a win32 .cmd shim runs through the
// verify step's batchInvocation, a POSIX shim is an executable script. Covered: a granted install passes with its output in
// deps.log / live.log and procs.json; nothing runs without the SOURCE folder's `deps` grant, and a lockfile changed in
// the run's copy asks again; failure, a missing program (env), corepack standing in for a pnpm packageManager, the
// setup steps' order, the 15 min budget's tree kill (shortened here) and Stop.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trustGrantsFor } from '../../../../src/core/config/trust.ts'
import { homePaths } from '../../../../src/core/home.ts'
import { ProcTable } from '../../../../src/core/proc/proc-table.ts'
import { isAlive } from '../../../../src/core/proc/ps.ts'
import { detectDeps, planFromCommand } from '../../../../src/core/prepare/detectDeps.ts'
import type { DepsPlan } from '../../../../src/core/prepare/detectDeps.ts'
import { DEPS_INSTALL_TIMEOUT_MS, depsLogPaths, runInstall } from '../../../../src/core/prepare/install.ts'
import type { InstallDeps, InstallOutputEvent } from '../../../../src/core/prepare/install.ts'
import { grantDeps, readDepsBody } from '../../../../src/core/prepare/trust.ts'
import { samePath } from '../../../../src/core/real-path.ts'
import { removeDir, tempDir, writeFiles } from '../../../unit/verify/helpers.ts'

const isWin = process.platform === 'win32'
const RUN = '20261009T120000Z-install'
const NODE_DIR = dirname(process.execPath)

let source = ''
let wt = ''
let bin = ''
beforeEach(() => {
  source = tempDir('dim-factory-install-src-')
  wt = tempDir('dim-factory-install-wt-')
  bin = tempDir('dim-factory-install-bin-')
})
afterEach(() => {
  for (const d of [source, wt, bin]) removeDir(d)
})

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const paths = () => homePaths(home())

/**
 * The stand-in package manager: records how it was run in `install-log.json`, then does what `fake-mode.txt` in its
 * cwd says (pass: makes node_modules/.bin/vitest; fail: an error and exit 1; hang: a grandchild and no exit).
 */
const FAKE_PM = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const { spawn } = require('node:child_process')",
  'const [tool, ...args] = process.argv.slice(2)',
  "const mode = fs.existsSync('fake-mode.txt') ? fs.readFileSync('fake-mode.txt', 'utf8').trim() : 'pass'",
  "const prev = fs.existsSync('install-log.json') ? JSON.parse(fs.readFileSync('install-log.json', 'utf8')) : []",
  'prev.push({ tool, args, cwd: process.cwd(), CI: process.env.CI, NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM })',
  "fs.writeFileSync('install-log.json', JSON.stringify(prev))",
  "console.log('Lockfile is up to date, resolution step is skipped')",
  "if (mode === 'fail') {",
  '  console.error(\'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date\')',
  '  process.exit(1)',
  '}',
  "if (mode === 'hang') {",
  "  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  "  fs.writeFileSync('grandchild.pid', String(g.pid))",
  "  console.log('downloading forever')",
  '  setInterval(() => {}, 1000)',
  '} else {',
  "  const b = path.join('node_modules', '.bin')",
  '  fs.mkdirSync(b, { recursive: true })',
  "  fs.writeFileSync(path.join(b, process.platform === 'win32' ? 'vitest.cmd' : 'vitest'), '')",
  "  console.log('Packages: +3')",
  "  console.log('Done in 1s')",
  '}',
].join('\n')

/** A program named `name` in `bin` that runs the stand-in as `<tool> <args…>`. */
function shim(dir: string, name: string): void {
  const script = join(dir, 'fake-pm.cjs')
  writeFileSync(script, FAKE_PM)
  if (isWin) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" ${name} %*\r\n`)
  } else {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`)
    chmodSync(file, 0o755)
  }
}

const PKG = '{"name":"p","scripts":{"postinstall":"node setup.js"}}\n'

/** The same project in the user's folder and in the run's copy. */
function project(extra: Record<string, string> = {}): void {
  const files = { 'package.json': PKG, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", ...extra }
  writeFiles(source, files)
  writeFiles(wt, files)
}

async function grant(plan: DepsPlan): Promise<string> {
  const body = (await readDepsBody(source, plan)).body ?? ''
  await grantDeps(source, plan, body, { home: home(), folderScope: { scopeRoot: source } })
  return body
}

function deps(extra: Partial<InstallDeps> = {}): InstallDeps {
  return {
    paths: paths(),
    pathEnv: [bin, NODE_DIR].join(delimiter),
    // The SOURCE folder's grants: the run's copy has another folder key.
    grants: () => trustGrantsFor(source, { home: home(), folderScope: { scopeRoot: source } }),
    ...extra,
  }
}

const log = (): {
  tool: string
  args: string[]
  cwd: string
  CI?: string
  NO_COLOR?: string
  TERM?: string
}[] =>
  (JSON.parse(readFileSync(join(wt, 'install-log.json'), 'utf8')) as { cwd: string }[]).map((e) =>
    // The stand-in's getcwd() is the real path (macOS /private/var for /var): the run's copy reads as `wt`.
    samePath(e.cwd, wt) ? { ...e, cwd: wt } : e,
  ) as never

describe('runInstall', () => {
  it('a granted install runs in the run’s copy: output in deps.log and live.log, procs.json, the child env', async () => {
    project()
    shim(bin, 'pnpm')
    const plan = (await detectDeps(wt)) as DepsPlan
    await grant(plan)
    const procs = await ProcTable.open(join(wt, 'procs.json'))
    const events: InstallOutputEvent[] = []
    let written = 0
    const r = await runInstall(deps({ procTable: procs }), {
      runId: RUN,
      root: wt,
      plan,
      onOutput: (e) => events.push(e),
      onOutputWritten: () => written++,
    })
    expect(r).toMatchObject({
      status: 'pass',
      exitCode: 0,
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      excerpt: '',
    })
    expect(r.steps).toEqual([expect.objectContaining({ status: 'pass', exitCode: 0 })])
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(log()).toEqual([
      { tool: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: wt, CI: '1', NO_COLOR: '1', TERM: 'dumb' },
    ])
    expect(existsSync(join(wt, 'node_modules', '.bin'))).toBe(true)
    expect(existsSync(join(source, 'node_modules'))).toBe(false)

    const files = depsLogPaths(paths(), RUN)
    expect(r.logPath).toBe(files.log)
    expect(r.liveLog).toBe(files.live)
    expect(files.log).toBe(join(paths().run(RUN).dir, 'prepare', 'deps.log'))
    const text = readFileSync(files.log, 'utf8')
    expect(text).toContain('$ pnpm install --frozen-lockfile')
    expect(text).toContain('Packages: +3')
    expect(text).toMatch(/\[done in \d+s\]/)
    expect(readFileSync(files.live, 'utf8')).toContain('Packages: +3')
    expect(written).toBeGreaterThan(0)
    expect(events[0]).toEqual({ type: 'start', index: 0, argv: ['pnpm', 'install', '--frozen-lockfile'] })
    expect(events.filter((e) => e.type === 'line').map((e) => (e.type === 'line' ? e.line : ''))).toContain(
      'Done in 1s',
    )
    expect(events.at(-1)).toMatchObject({ type: 'end', step: { status: 'pass' } })
    expect(procs.records()).toEqual([
      expect.objectContaining({
        step: 'prepare',
        transport: 'verify',
        exit: expect.objectContaining({ how: 'exited' }) as unknown,
      }),
    ])
  })

  it('npm ci for a package-lock (the stand-in first on PATH, never the real npm)', async () => {
    const files = { 'package.json': PKG, 'package-lock.json': '{"lockfileVersion":3}\n' }
    writeFiles(source, files)
    writeFiles(wt, files)
    shim(bin, 'npm')
    const plan = (await detectDeps(wt)) as DepsPlan
    expect(plan.argv).toEqual(['npm', 'ci'])
    await grant(plan)
    const r = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(r.status).toBe('pass')
    expect(log()).toEqual([expect.objectContaining({ tool: 'npm', args: ['ci'] })])
  })

  it('nothing runs without the grant; a lockfile changed in the run’s copy asks again', async () => {
    project()
    shim(bin, 'pnpm')
    const plan = (await detectDeps(wt)) as DepsPlan
    const none = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(none).toMatchObject({
      status: 'skipped-untrusted',
      trust: 'untrusted',
      reason: 'Not allowed yet',
      exitCode: null,
    })
    expect(none.body).toBe((await readDepsBody(wt, plan)).body)
    expect(existsSync(join(wt, 'install-log.json'))).toBe(false)
    expect(readFileSync(none.logPath, 'utf8')).toContain('[not run: Not allowed yet]')

    const body = await grant(plan)
    writeFileSync(join(wt, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  evil: {}\n")
    const changed = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(changed).toMatchObject({
      status: 'skipped-untrusted',
      trust: 'changed',
      grantedBody: body,
      reason: 'Its files changed since you allowed it',
    })
    expect(existsSync(join(wt, 'install-log.json'))).toBe(false)
  })

  it('a failing install: fail with its exit code, excerpt and reason', async () => {
    project({ 'fake-mode.txt': 'fail' })
    shim(bin, 'pnpm')
    const plan = (await detectDeps(wt)) as DepsPlan
    await grant(plan)
    const r = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(r).toMatchObject({
      status: 'fail',
      exitCode: 1,
      reason: 'pnpm install --frozen-lockfile failed with exit 1',
    })
    expect(r.excerpt).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
    expect(readFileSync(r.logPath, 'utf8')).toContain('[failed with exit 1 after ')
  })

  it('the program is missing: env (deps_missing), nothing spawned', async () => {
    project()
    const plan = (await detectDeps(wt)) as DepsPlan
    await grant(plan)
    const empty = tempDir('dim-factory-install-empty-')
    try {
      const r = await runInstall(deps({ pathEnv: empty }), { runId: RUN, root: wt, plan })
      expect(r).toMatchObject({ status: 'env', reason: 'Dim Factory could not find pnpm', exitCode: null })
    } finally {
      removeDir(empty)
    }
  })

  it('corepack runs pnpm when package.json names it and pnpm is not on PATH', async () => {
    project({ 'package.json': '{"name":"p","packageManager":"pnpm@10.28.0"}\n' })
    shim(bin, 'corepack')
    const plan = (await detectDeps(wt)) as DepsPlan
    expect(plan.corepack).toBe(true)
    await grant(plan)
    // PATH = the shims only: no pnpm anywhere (Node's own folder may hold corepack's pnpm shim).
    const r = await runInstall(deps({ pathEnv: bin }), { runId: RUN, root: wt, plan })
    expect(r).toMatchObject({ status: 'pass', viaCorepack: true })
    expect(log()).toEqual([
      expect.objectContaining({ tool: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] }),
    ])
    expect(readFileSync(r.logPath, 'utf8')).toContain('running it through corepack')
  })

  it('setup steps run first, in order; a failing step stops the install', async () => {
    writeFiles(wt, {
      'requirements.txt': 'x\n',
      'mkvenv.cjs': "require('node:fs').appendFileSync('order.txt', 'venv\\n')",
      'pip.cjs': "require('node:fs').appendFileSync('order.txt', 'pip\\n')",
      'bad.cjs': "console.error('venv: error: no python'); process.exit(3)",
    })
    writeFiles(source, { 'requirements.txt': 'x\n' })
    const plan: DepsPlan = {
      manager: 'pip',
      setup: [['node', 'mkvenv.cjs']],
      argv: ['node', 'pip.cjs'],
      cwdRel: '.',
      lockfile: 'requirements.txt',
      sources: ['requirements.txt'],
      via: 'lockfile',
      tools: ['node'],
    }
    await grant(plan)
    const ok = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(ok.status).toBe('pass')
    expect(ok.steps.map((s) => s.argv)).toEqual([
      ['node', 'mkvenv.cjs'],
      ['node', 'pip.cjs'],
    ])
    expect(readFileSync(join(wt, 'order.txt'), 'utf8')).toBe('venv\npip\n')

    const failing: DepsPlan = { ...plan, setup: [['node', 'bad.cjs']] }
    await grant(failing)
    const r = await runInstall(deps(), { runId: RUN, root: wt, plan: failing })
    expect(r).toMatchObject({ status: 'fail', argv: ['node', 'bad.cjs'], exitCode: 3 })
    expect(r.steps).toHaveLength(1)
    expect(readFileSync(join(wt, 'order.txt'), 'utf8')).toBe('venv\npip\n')
  })

  it('the budget (15 min by default) ends in a tree kill', async () => {
    expect(DEPS_INSTALL_TIMEOUT_MS).toBe(15 * 60_000)
    project({ 'fake-mode.txt': 'hang' })
    shim(bin, 'pnpm')
    const plan = (await detectDeps(wt)) as DepsPlan
    await grant(plan)
    const procs = await ProcTable.open(join(wt, 'procs.json'))
    const r = await runInstall(deps({ procTable: procs }), { runId: RUN, root: wt, plan, timeoutMs: 6000 })
    expect(r).toMatchObject({ status: 'fail', timedOut: true, exitCode: null, reason: 'Timed out after 6s' })
    expect(r.durationMs).toBeGreaterThanOrEqual(5900)
    const pid = Number(readFileSync(join(wt, 'grandchild.pid'), 'utf8'))
    const deadline = Date.now() + 10_000
    while (isAlive(pid) && Date.now() < deadline) await delay(200)
    expect(isAlive(pid)).toBe(false)
    expect(procs.records()[0]).toMatchObject({ step: 'prepare', exit: { how: 'killed' } })
  })

  it('Stop kills the running install; nothing after it runs', async () => {
    project({ 'fake-mode.txt': 'hang' })
    shim(bin, 'pnpm')
    const plan = (await detectDeps(wt)) as DepsPlan
    await grant(plan)
    const ac = new AbortController()
    const r = await runInstall(deps(), {
      runId: RUN,
      root: wt,
      plan,
      signal: ac.signal,
      onOutput: (e) => {
        if (e.type === 'line' && e.line === 'downloading forever') ac.abort()
      },
    })
    expect(r).toMatchObject({ status: 'skipped', reason: 'Stopped before it finished' })
    const pid = Number(readFileSync(join(wt, 'grandchild.pid'), 'utf8'))
    const deadline = Date.now() + 10_000
    while (isAlive(pid) && Date.now() < deadline) await delay(200)
    expect(isAlive(pid)).toBe(false)

    const before = new AbortController()
    before.abort()
    const early = await runInstall(deps(), { runId: RUN, root: wt, plan, signal: before.signal })
    expect(early).toMatchObject({ status: 'skipped', reason: 'Stopped before it ran' })
  })

  it('a configured install command runs as argv, under its own grant', async () => {
    writeFiles(wt, {
      'setup.cjs': "console.log('set up'); require('node:fs').writeFileSync('done.txt', '1')",
    })
    mkdirSync(join(source), { recursive: true })
    const plan = (await planFromCommand(['node', 'setup.cjs'], wt)).plan as DepsPlan
    expect((await runInstall(deps(), { runId: RUN, root: wt, plan })).status).toBe('skipped-untrusted')
    await grant(plan)
    const r = await runInstall(deps(), { runId: RUN, root: wt, plan })
    expect(r.status).toBe('pass')
    expect(readFileSync(join(wt, 'done.txt'), 'utf8')).toBe('1')
  })
})
