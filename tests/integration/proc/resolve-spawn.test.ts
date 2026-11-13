// resolve-cli + spawnChild against the fake CLI's real launchers (npm .cmd shim on win32, shebang on POSIX).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCli } from '../../../src/core/proc/resolve-cli.ts'
import { SpawnError, spawnChild } from '../../../src/core/proc/spawn.ts'
import type { TapDir } from '../../../src/core/proc/spawn.ts'
import { readFakeLog } from '../../fake-cli/harness.ts'
import {
  FIXTURES,
  STREAM_ARGS,
  fakeClaudeSpec,
  installedLauncher,
  isWin,
  lineReader,
  plainEnv,
  real,
  resolveFake,
  sharedFixture,
  testPath,
  vendorEnv,
} from './helpers.ts'

let work = ''
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-proc-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('resolveCli with the fake CLI', () => {
  it('resolves the installed launcher to system node + JS entry (never a shell) and validates the version', async () => {
    const { build, cli } = await resolveFake()
    expect(cli).toMatchObject({
      vendor: 'claude',
      kind: 'node-entry',
      source: 'config',
      version: '2.1.287',
      pathPrepend: [],
      warnings: [],
    })
    expect(real(cli.command)).toBe(real(process.execPath))
    expect(cli.prefixArgs).toHaveLength(1)
    expect(real(cli.prefixArgs[0] ?? '')).toBe(real(isWin ? build.entry : installedLauncher(build)))
    expect(cli.path).toBe(installedLauncher(build))
    expect(cli.size).toBeGreaterThan(1000)
  })

  it('finds the launcher on PATH (PATHEXT on win32) when nothing is configured', async () => {
    const { build } = await resolveFake()
    const r = await resolveCli(fakeClaudeSpec, {
      pathEnv: testPath(build),
      npmPrefixes: [],
      vendorEnv: { FAKE_CLI_SCRIPT: join(FIXTURES, 'scenario') },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cli.source).toBe('path')
    expect(r.cli.path.toLowerCase()).toBe(installedLauncher(build).toLowerCase())
  })

  it('rejects a candidate whose --version does not identify the product', async () => {
    const { build } = await resolveFake()
    const r = await resolveCli(fakeClaudeSpec, {
      configuredPath: installedLauncher(build),
      pathEnv: '',
      npmPrefixes: [],
      vendorEnv: { FAKE_CLI_SCRIPT: sharedFixture('scenario-pair') }, // answers "2.1.287 (fake)"
    })
    expect(r.ok).toBe(false)
    expect(r.rejected).toEqual([
      expect.objectContaining({ source: 'config', reason: 'version-unrecognized' }),
    ])
  })
})

describe('spawnChild', () => {
  it('round-trips NDJSON with the fake (expectStdin + capture), tees raw I/O and keeps argv intact', async () => {
    const log = join(work, 'fake.log')
    const { build, cli } = await resolveFake()
    const env = vendorEnv(build, cli, {
      FAKE_CLI_SCRIPT: sharedFixture('echo-handshake.script.jsonl'),
      FAKE_CLI_LOG: log,
    })
    const taps: [TapDir, string][] = []
    const child = await spawnChild({
      cli,
      args: STREAM_ARGS,
      cwd: work,
      env,
      label: { purpose: 'pass', step: 'implement', attempt: 1 },
      tap: (dir, line) => taps.push([dir, line]),
    })
    expect(child.pid).toBeGreaterThan(0)
    expect(child.pgid).toBe(isWin ? undefined : child.pid)
    const next = lineReader(child.lines())

    const init = JSON.parse(await next()) as { type: string; cwd: string }
    expect(init.type).toBe('system')
    expect(real(init.cwd)).toBe(real(work))

    const initialize = {
      type: 'control_request',
      request_id: 'req_proc_1',
      request: { subtype: 'initialize' },
    }
    expect(await child.writeLine(initialize)).toBe(true)
    expect(JSON.parse(await next())).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_proc_1', response: { models: [] } },
    })
    const prompt = 'say "hi" — ünïcødé & <tags> %PATH% $HOME'
    await child.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    })
    const assistant = JSON.parse(await next()) as { message: { content: { text: string }[] } }
    expect(assistant.message.content[0]?.text).toBe(`echo: ${prompt}`)
    expect(JSON.parse(await next())).toMatchObject({ type: 'result', request_id: 'req_proc_1' })
    child.closeStdin()
    const exit = await child.exited
    expect(exit.code).toBe(0)
    expect(exit.ms).toBeGreaterThan(0)
    expect(child.stdinOpen).toBe(false)
    expect(await child.writeLine({ late: true })).toBe(false)
    expect(child.stderrTail()).toContain('fake: finished turn for req_proc_1')

    expect(taps.filter(([d]) => d === 'in').map(([, l]) => JSON.parse(l) as unknown)).toHaveLength(2)
    expect(taps.some(([d, l]) => d === 'err' && l.includes('finished turn'))).toBe(true)
    expect(taps.filter(([d]) => d === 'out')).toHaveLength(4)

    const entries = readFakeLog(log)
    expect(entries[0]).toMatchObject({ kind: 'start', argv: STREAM_ARGS })
    expect(entries.filter((e) => e.kind === 'stdin').map((e) => e['line'])).toEqual([
      JSON.stringify(initialize),
      expect.stringContaining('ünïcødé') as unknown,
    ])
  })

  it('sanitized env reaches the child: Dim Factory host-session variables are gone', async () => {
    const { build, cli } = await resolveFake()
    const env = vendorEnv(build, cli, { FAKE_CLI_SCRIPT: sharedFixture('echo-handshake.script.jsonl') })
    expect(
      Object.keys(env).some((k) => k === 'CLAUDECODE' || k.startsWith('npm_') || k === 'NODE_OPTIONS'),
    ).toBe(false)
    expect(env['NO_COLOR']).toBe('1')
    if (isWin) expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
  })

  it('surfaces spawn failures as SpawnError codes', async () => {
    const env = plainEnv()
    await expect(spawnChild({ command: join(work, 'missing-cli'), cwd: work, env })).rejects.toMatchObject({
      name: 'SpawnError',
      code: 'ENOENT',
    })
    await expect(
      spawnChild({ command: process.execPath, args: ['-e', 'x\ny'], cwd: work, env }),
    ).rejects.toBeInstanceOf(SpawnError)
  })

  it.runIf(isWin)('refuses to spawn a .cmd shim directly (no shell, ever)', async () => {
    const { build } = await resolveFake()
    await expect(
      spawnChild({ command: installedLauncher(build), cwd: work, env: plainEnv() }),
    ).rejects.toMatchObject({ code: 'ESHIM' })
  })

  it('records oversize lines without breaking the stream', async () => {
    const script = [
      "process.stdout.write('a'.repeat(3000) + '\\n')",
      'process.stdout.write(\'{"ok":true}\\r\\n\')',
      "process.stdout.write('tail-without-newline')",
    ].join(';')
    const child = await spawnChild({
      command: process.execPath,
      args: ['-e', script],
      cwd: work,
      env: plainEnv(),
      maxLineBytes: 1024,
    })
    const recs = []
    for await (const r of child.records()) recs.push(r)
    expect(recs).toEqual([
      { kind: 'oversize', bytes: 3000, head: 'a'.repeat(256) },
      { kind: 'line', line: '{"ok":true}' },
      { kind: 'line', line: 'tail-without-newline' },
    ])
    expect((await child.exited).code).toBe(0)
  })
})
