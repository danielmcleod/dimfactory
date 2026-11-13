// Verify argv[0] resolution per OS: <cwd>/node_modules/.bin, <cwd>/.venv/{Scripts|bin},
// PATH (+ PATHEXT on win32, natives before .cmd/.bat), repo-root wrappers (gradlew.bat / mvnw.cmd on win32, ./gradlew
// on POSIX), paths relative to the cwd. The file system is a set of names, so both OSes run everywhere.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localBinDirs, resolveCommand } from '../../../src/core/verify/resolve-cmd.ts'
import { removeDir, tempDir } from './helpers.ts'

const fsOf = (files: readonly string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return (p: string): boolean => set.has(p.toLowerCase())
}

describe('resolveCommand on win32', () => {
  const cwd = 'C:\\repo\\app'
  const root = 'C:\\repo'
  const path = ['C:\\tools', 'C:\\Program Files\\nodejs']
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' }
  const r = (argv0: string, files: string[]) =>
    resolveCommand(argv0, { cwd, root, pathEntries: path, env, platform: 'win32', isRunnable: fsOf(files) })

  it('PATH with PATHEXT: .exe before .cmd in a folder; earlier folders first; .cmd runs as a batch file', () => {
    expect(r('pnpm', ['C:\\tools\\pnpm.cmd', 'C:\\tools\\pnpm.exe'])).toEqual({
      path: 'C:\\tools\\pnpm.exe',
      via: 'path',
      batch: false,
    })
    expect(r('npm', ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\npm'])).toEqual({
      path: 'C:\\Program Files\\nodejs\\npm.cmd',
      via: 'path',
      batch: true,
    })
    expect(r('npm.cmd', ['C:\\Program Files\\nodejs\\npm.cmd'])?.path).toBe(
      'C:\\Program Files\\nodejs\\npm.cmd',
    )
    // A shell script without an extension (Git Bash's `pnpm`) and .js/.vbs are never picked.
    expect(r('pnpm', ['C:\\tools\\pnpm', 'C:\\tools\\pnpm.js', 'C:\\tools\\pnpm.vbs'])).toBeNull()
  })

  it('project bins first: node_modules\\.bin, then .venv\\Scripts, then PATH', () => {
    const local = 'C:\\repo\\app\\node_modules\\.bin\\vitest.cmd'
    expect(r('vitest', [local, 'C:\\tools\\vitest.exe'])).toEqual({
      path: local,
      via: 'node_modules',
      batch: true,
    })
    const venv = 'C:\\repo\\app\\.venv\\Scripts\\pytest.exe'
    expect(r('pytest', [venv, 'C:\\tools\\pytest.exe'])).toEqual({ path: venv, via: 'venv', batch: false })
    expect(r('pytest', ['C:\\tools\\pytest.exe'])?.via).toBe('path')
  })

  it('package managers and fixed tools come from PATH first; a planted local launcher waits', () => {
    const planted = [
      'C:\\repo\\app\\.venv\\Scripts\\npm.cmd',
      'C:\\repo\\app\\node_modules\\.bin\\pnpm.cmd',
      'C:\\repo\\app\\node_modules\\.bin\\git.cmd',
      'C:\\repo\\app\\node_modules\\.bin\\node.cmd',
    ]
    const global = [
      'C:\\Program Files\\nodejs\\npm.cmd',
      'C:\\tools\\pnpm.cmd',
      'C:\\tools\\git.exe',
      'C:\\Program Files\\nodejs\\node.exe',
    ]
    expect(r('npm', [...planted, ...global])).toMatchObject({
      path: 'C:\\Program Files\\nodejs\\npm.cmd',
      via: 'path',
    })
    expect(r('pnpm', [...planted, ...global])).toMatchObject({ path: 'C:\\tools\\pnpm.cmd', via: 'path' })
    expect(r('git', [...planted, ...global])).toMatchObject({ path: 'C:\\tools\\git.exe', via: 'path' })
    expect(r('npm.cmd', [...planted, ...global])?.via).toBe('path')
    expect(r('node', [...planted, ...global])?.via).toBe('path')
    // Not on PATH at all: the project's own copy still runs (pnpm as a devDependency).
    expect(r('pnpm', planted)).toMatchObject({ path: 'C:\\repo\\app\\node_modules\\.bin\\pnpm.cmd' })
    // A project tool keeps its local bin first.
    expect(r('vitest', ['C:\\repo\\app\\node_modules\\.bin\\vitest.cmd', 'C:\\tools\\vitest.exe'])?.via).toBe(
      'node_modules',
    )
  })

  it('a local bin whose real path leaves the scope root (a junction) is never used', () => {
    const files = ['C:\\repo\\app\\node_modules\\.bin\\vitest.cmd', 'C:\\tools\\vitest.exe']
    const outside = (p: string): string =>
      p.toLowerCase().startsWith('c:\\repo\\app\\node_modules\\.bin\\')
        ? `C:\\Users\\x\\Temp\\elsewhere\\${p.slice('C:\\repo\\app\\node_modules\\.bin\\'.length)}`
        : p
    const hit = resolveCommand('vitest', {
      cwd,
      root,
      pathEntries: path,
      env,
      platform: 'win32',
      isRunnable: fsOf(files),
      realpath: outside,
    })
    expect(hit).toMatchObject({ path: 'C:\\tools\\vitest.exe', via: 'path' })
    expect(
      resolveCommand('vitest', {
        cwd,
        root,
        pathEntries: [],
        env,
        platform: 'win32',
        isRunnable: fsOf(files),
        realpath: outside,
      }),
    ).toBeNull()
  })

  it('repo-root wrappers: gradlew → gradlew.bat, mvnw → mvnw.cmd, in the cwd, then the root', () => {
    expect(r('./gradlew', ['C:\\repo\\app\\gradlew', 'C:\\repo\\app\\gradlew.bat'])).toEqual({
      path: 'C:\\repo\\app\\gradlew.bat',
      via: 'wrapper',
      batch: true,
    })
    expect(r('gradlew', ['C:\\repo\\gradlew.bat'])?.path).toBe('C:\\repo\\gradlew.bat')
    expect(r('.\\mvnw', ['C:\\repo\\mvnw.cmd'])?.path).toBe('C:\\repo\\mvnw.cmd')
    // The POSIX script alone cannot run on Windows.
    expect(r('./gradlew', ['C:\\repo\\app\\gradlew'])).toBeNull()
    // A bare wrapper name may still be on PATH.
    expect(r('mvnw', ['C:\\tools\\mvnw.cmd'])?.path).toBe('C:\\tools\\mvnw.cmd')
  })

  it('a path is relative to the cwd, with PATHEXT when it has no extension', () => {
    expect(r('scripts\\check', ['C:\\repo\\app\\scripts\\check.bat'])).toEqual({
      path: 'C:\\repo\\app\\scripts\\check.bat',
      via: 'relative',
      batch: true,
    })
    expect(r('./bin/tool.exe', ['C:\\repo\\app\\bin\\tool.exe'])?.path).toBe('C:\\repo\\app\\bin\\tool.exe')
    expect(r('C:\\abs\\x', ['C:\\abs\\x.exe'])?.path).toBe('C:\\abs\\x.exe')
    expect(r('..\\up\\x', [])).toBeNull()
  })

  it('not found → null; an empty argv[0] → null', () => {
    expect(r('no-such-tool', [])).toBeNull()
    expect(r('', ['C:\\tools\\.exe'])).toBeNull()
  })
})

describe('resolveCommand on POSIX', () => {
  const cwd = '/repo/app'
  const root = '/repo'
  const path = ['/usr/local/bin', '/usr/bin']
  const r = (argv0: string, files: string[]) =>
    resolveCommand(argv0, { cwd, root, pathEntries: path, platform: 'linux', isRunnable: fsOf(files) })

  it('node_modules/.bin, .venv/bin, then PATH in order', () => {
    expect(r('vitest', ['/repo/app/node_modules/.bin/vitest', '/usr/bin/vitest'])).toEqual({
      path: '/repo/app/node_modules/.bin/vitest',
      via: 'node_modules',
      batch: false,
    })
    expect(r('ruff', ['/repo/app/.venv/bin/ruff'])?.via).toBe('venv')
    expect(r('make', ['/usr/local/bin/make', '/usr/bin/make'])?.path).toBe('/usr/local/bin/make')
    expect(r('make', [])).toBeNull()
  })

  it('wrappers are ./-prefixed scripts in the cwd, then the root; .bat never counts', () => {
    expect(r('./gradlew', ['/repo/app/gradlew'])).toEqual({
      path: '/repo/app/gradlew',
      via: 'wrapper',
      batch: false,
    })
    expect(r('./mvnw', ['/repo/mvnw'])?.path).toBe('/repo/mvnw')
    expect(r('./gradlew', ['/repo/app/gradlew.bat'])).toBeNull()
  })

  it('relative and absolute paths; no PATHEXT', () => {
    expect(r('./scripts/check.sh', ['/repo/app/scripts/check.sh'])?.via).toBe('relative')
    expect(r('/opt/x', ['/opt/x'])?.path).toBe('/opt/x')
    expect(r('./scripts/check', ['/repo/app/scripts/check.sh'])).toBeNull()
  })

  it('localBinDirs', () => {
    expect(localBinDirs('/repo/app', 'linux')).toEqual(['/repo/app/node_modules/.bin', '/repo/app/.venv/bin'])
    expect(localBinDirs('C:\\r', 'win32')).toEqual(['C:\\r\\node_modules\\.bin', 'C:\\r\\.venv\\Scripts'])
  })
})

describe('resolveCommand against the real file system', () => {
  let dir = ''
  beforeEach(() => {
    dir = tempDir()
  })
  afterEach(() => removeDir(dir))

  it('finds a project-local bin (and on POSIX only an executable one)', () => {
    const bin = join(dir, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const name = process.platform === 'win32' ? 'tool.cmd' : 'tool'
    writeFileSync(join(bin, name), '', { mode: 0o644 })
    const hit = resolveCommand('tool', { cwd: dir, pathEntries: [] })
    if (process.platform === 'win32')
      expect(hit).toEqual({ path: join(bin, name), via: 'node_modules', batch: true })
    else expect(hit).toBeNull()
  })

  it('node_modules/.bin linked (a junction) to a folder outside the project is not used', () => {
    const project = join(dir, 'project')
    const outside = join(dir, 'outside')
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    const name = process.platform === 'win32' ? 'tool.cmd' : 'tool'
    writeFileSync(join(outside, name), process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\n', {
      mode: 0o755,
    })
    symlinkSync(outside, join(project, 'node_modules', '.bin'), 'junction')
    expect(resolveCommand('tool', { cwd: project, root: project, pathEntries: [] })).toBeNull()
    // The same file inside the project is found.
    const inside = join(dir, 'inside')
    mkdirSync(join(inside, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(inside, 'node_modules', '.bin', name), '', { mode: 0o755 })
    expect(resolveCommand('tool', { cwd: inside, root: inside, pathEntries: [] })?.via).toBe('node_modules')
  })
})
