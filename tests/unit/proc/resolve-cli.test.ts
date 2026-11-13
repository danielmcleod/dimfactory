import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  findOnPath,
  findSystemNode,
  isPlaceholder,
  isWindowsAppsPath,
  resolveCli,
  sniffFormat,
  toResolvedBinary,
} from '../../../src/core/proc/resolve-cli.ts'
import type { CliSpec, RunFn } from '../../../src/core/proc/resolve-cli.ts'
import type { CaptureResult } from '../../../src/core/proc/spawn.ts'
import { SpawnError } from '../../../src/core/proc/spawn.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const isWin = process.platform === 'win32'

describe('helpers', () => {
  it('compares versions numerically and ignores prerelease suffixes', () => {
    expect(compareVersions('2.1.287', '2.1.281')).toBe(1)
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1)
    expect(compareVersions('0.147.0-alpha.3', '0.147.0')).toBe(0)
    expect(compareVersions('v24.19.0', '20')).toBe(1)
  })

  it('sniffs executable formats', () => {
    expect(sniffFormat(Buffer.from('MZ\x90\x00')).format).toBe('pe')
    expect(sniffFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2])).format).toBe('elf')
    expect(sniffFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])).format).toBe('macho')
    expect(sniffFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe])).format).toBe('macho')
    expect(sniffFormat(Buffer.from('#!/usr/bin/env node\nconsole.log(1)'))).toEqual({
      format: 'shebang',
      shebang: '/usr/bin/env node',
    })
    expect(sniffFormat(Buffer.from('echo "postinstall did not run"')).format).toBe('unknown')
    expect(sniffFormat(Buffer.alloc(0)).format).toBe('unknown')
  })

  it('flags npm placeholder stubs', () => {
    expect(isPlaceholder('unknown', 1_000_000)).toBe(true)
    expect(isPlaceholder('pe', 1200)).toBe(true)
    expect(isPlaceholder('pe', 200_000)).toBe(false)
    expect(isPlaceholder('shebang', 120)).toBe(false)
  })

  it('detects WindowsApps paths', () => {
    expect(isWindowsAppsPath('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\Claude.exe')).toBe(true)
    expect(isWindowsAppsPath('C:\\Users\\u\\.local\\bin\\claude.exe')).toBe(false)
  })

  it('searches PATH with .exe before .cmd per directory and ignores .ps1/extensionless', () => {
    const files = new Set([
      'C:\\a\\claude.cmd',
      'C:\\a\\claude.exe',
      'C:\\a\\claude.ps1',
      'C:\\a\\claude',
      'C:\\b\\claude.cmd',
    ])
    const hits = findOnPath(
      'claude',
      ['C:\\a', 'relative\\dir', 'C:\\b'],
      'win32',
      { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1' },
      (p) => files.has(p),
    )
    expect(hits).toEqual(['C:\\a\\claude.exe', 'C:\\a\\claude.cmd', 'C:\\b\\claude.cmd'])
    expect(
      findOnPath('claude', ['/usr/bin', '/opt/bin'], 'linux', {}, (p) => p === '/opt/bin/claude'),
    ).toEqual(['/opt/bin/claude'])
  })

  it('system node on win32 is a spawnable .exe, never a .cmd shim (mise)', () => {
    const files = new Set(['C:\\mise\\shims\\node.cmd', 'C:\\nodejs\\node.exe'])
    const ctx = (dirs: string[]) => ({
      pathEntries: dirs,
      platform: 'win32' as const,
      env: { PATHEXT: '.EXE;.CMD' },
    })
    const isFile = (p: string): boolean => files.has(p)
    expect(findSystemNode(ctx(['C:\\mise\\shims', 'C:\\nodejs']), { electron: true, isFile })).toEqual({
      node: 'C:\\nodejs\\node.exe',
    })
    const shimOnly = findSystemNode(ctx(['C:\\mise\\shims']), { electron: true, isFile })
    expect(shimOnly).toMatchObject({
      reject: expect.stringMatching(/node\.cmd.*cannot run without a shell/) as unknown,
    })
    expect(findSystemNode(ctx(['C:\\mise\\shims']), { electron: false, isFile })).toEqual({
      node: process.execPath,
    })
    expect(findSystemNode(ctx([]), { electron: true, isFile })).toBeNull()
  })

  it('maps to the shared ResolvedBinary shape', () => {
    const bin = toResolvedBinary({
      vendor: 'gemini',
      command: '/usr/bin/node',
      prefixArgs: ['/x/index.js'],
      kind: 'posix-script',
      version: '0.9.0',
      source: 'well-known',
      pathPrepend: [],
      warnings: ['w'],
      path: '/x/gemini',
      target: '/x/index.js',
      mtimeMs: 5,
      size: 6,
    })
    expect(bin).toMatchObject({
      kind: 'shebang',
      source: 'known',
      argvPrefix: ['/x/index.js'],
      path: '/x/gemini',
    })
  })
})

describe('resolveCli with an injected runner', () => {
  const exeName = isWin ? 'tool.exe' : 'tool'
  const nativeBytes = (): Buffer => {
    const buf = Buffer.alloc(8192)
    if (isWin) buf.write('MZ', 0, 'latin1')
    else Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buf)
    return buf
  }
  const spec = (over: Partial<CliSpec> = {}): CliSpec => ({
    vendor: 'claude',
    bin: 'tool',
    wellKnown: () => [],
    versionArgs: ['--version'],
    parseVersion: (out) => {
      const m = /^(\d+\.\d+\.\d+) \(Claude Code\)/.exec(out.trim())
      return m === null ? null : { version: m[1] ?? '' }
    },
    ...over,
  })
  const answer = (stdout: string, extra: Partial<CaptureResult> = {}): CaptureResult => ({
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    ms: 1,
    ...extra,
  })

  it('retries ENOENT once after the delay (updater rename) and validates by version output', async () => {
    const dir = join(home(), 'bin')
    await mkdir(dir, { recursive: true })
    const exe = join(dir, exeName)
    await writeFile(exe, nativeBytes(), { mode: 0o755 })
    const calls: string[][] = []
    const run: RunFn = (command, args, opts) => {
      calls.push([command, ...args])
      expect(opts.env['NO_COLOR']).toBe('1')
      if (calls.length === 1)
        return Promise.resolve(answer('', { code: null, error: new SpawnError('ENOENT', 'gone') }))
      return Promise.resolve(answer('2.1.287 (Claude Code)\n'))
    }
    const r = await resolveCli(spec(), {
      configuredPath: exe,
      run,
      retryDelayMs: 1,
      pathEnv: '',
      npmPrefixes: [],
    })
    expect(calls).toEqual([
      [exe, '--version'],
      [exe, '--version'],
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.cli).toMatchObject({ source: 'config', kind: 'native', version: '2.1.287', command: exe })
  })

  it('rejects a binary that answers --version as some other product, then falls through', async () => {
    const a = join(home(), 'a')
    const b = join(home(), 'b')
    for (const d of [a, b]) {
      await mkdir(d, { recursive: true })
      await writeFile(join(d, exeName), nativeBytes(), { mode: 0o755 })
    }
    const run: RunFn = (command) =>
      Promise.resolve(answer(command.startsWith(a) ? 'Claude 1.0.0 (desktop)\n' : '2.1.290 (Claude Code)\n'))
    const r = await resolveCli(spec(), { pathEnv: [a, b].join(isWin ? ';' : ':'), run, npmPrefixes: [] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cli.source).toBe('path')
    expect(r.cli.path).toBe(join(b, exeName))
    expect(r.rejected).toEqual([
      expect.objectContaining({ path: join(a, exeName), reason: 'version-unrecognized' }),
    ])
    expect(r.candidates).toEqual([join(a, exeName), join(b, exeName)])
  })

  it('reports placeholders, timeouts, a missing configured path and the desktop-bundle warning', async () => {
    const dir = join(home(), 'c')
    await mkdir(dir, { recursive: true })
    const stub = join(dir, exeName)
    await writeFile(stub, 'echo "claude: native binary not installed"\n', { mode: 0o755 })
    const bundleDir = join(home(), 'bundle')
    await mkdir(bundleDir, { recursive: true })
    const bundled = join(bundleDir, exeName)
    await writeFile(bundled, nativeBytes(), { mode: 0o755 })
    const slowDir = join(home(), 'slow')
    await mkdir(slowDir, { recursive: true })
    const slow = join(slowDir, exeName)
    await writeFile(slow, nativeBytes(), { mode: 0o755 })
    const run: RunFn = (command) =>
      Promise.resolve(
        command === slow ? answer('', { timedOut: true, code: null }) : answer('2.1.281 (Claude Code)'),
      )
    const r = await resolveCli(
      spec({
        wellKnown: () => [stub, slow],
        desktopBundle: () => [bundled],
        desktopBundleWarning: 'updates with Claude Desktop',
      }),
      { configuredPath: join(home(), 'nope', exeName), run, pathEnv: '', npmPrefixes: [] },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejected.map((x) => [x.source, x.reason])).toEqual([
      ['config', 'not-found'],
      ['well-known', 'placeholder'],
      ['well-known', 'timeout'],
    ])
    expect(r.cli).toMatchObject({ source: 'desktop-bundle', warnings: ['updates with Claude Desktop'] })
  })

  it.runIf(isWin)('rejects WindowsApps candidates when the spec asks', async () => {
    const dir = join(home(), 'Microsoft', 'WindowsApps')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tool.exe'), nativeBytes())
    const run: RunFn = () => Promise.resolve(answer('2.1.287 (Claude Code)'))
    const r = await resolveCli(spec({ rejectWindowsApps: true }), { pathEnv: dir, run, npmPrefixes: [] })
    expect(r).toMatchObject({ ok: false, rejected: [{ reason: 'windows-apps' }] })
    const allowed = await resolveCli(spec(), { pathEnv: dir, run, npmPrefixes: [] })
    expect(allowed.ok).toBe(true)
  })

  it('fails with every rejection listed when nothing validates', async () => {
    const r = await resolveCli(spec(), {
      pathEnv: '',
      npmPrefixes: [],
      run: () => Promise.reject(new Error('unused')),
    })
    expect(r).toEqual({ ok: false, rejected: [], candidates: [] })
  })
})
