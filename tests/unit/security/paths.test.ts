// Security pass, paths that come in over IPC (the folder guard; storage "fileSafe(key) maps `:` →
// `-` … (NTFS alternate data streams)"): traversal, NTFS streams, Windows device names and trailing dots, junctions,
// device-namespace prefixes and local administrative shares.
// - A run-relative path (diff.file, diff.blob, diff.revert, diff.markReviewed, worktree.apply) is relative, has no `..`
//   and no NUL; it is only ever a filter on git's own path list, never joined onto a folder as given.
// - A data-supplied path segment (run id, folder key, job id) cannot leave its folder or alias another one (a
//   trailing dot or space, `NUL`, `CON.json`).
// - The folder guard judges the real folder: a junction to the home folder, a `\\?\` or `\\.\` spelling, a
//   `::$INDEX_ALLOCATION` stream name and an administrative share (`\\localhost\C$\Users\me`, and, after a
//   review, whatever the host: the machine's own LAN address passed) are all the folder they stand for.
// - shell.open opens only an existing absolute folder, or a run folder Dim Factory builds itself.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertSafeSegment, homePaths } from '../../../src/core/home.ts'
import { isRunRelativePath } from '../../../src/core/handlers-diff-settings.ts'
import { adminShareDrivePath, checkGuard, isGuarded } from '../../../src/core/preflight/guard.ts'
import type { GuardContext } from '../../../src/core/preflight/guard.ts'
import { resolveShellOpen } from '../../../src/main/main-handlers.ts'
import { parseRequest } from '../../../src/shared/ipc-schemas.ts'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe('run-relative paths (the diff and worktree commands)', () => {
  it.each([
    ['..', 'a parent'],
    ['../outside.txt', 'a parent'],
    ['src/../../outside.txt', 'a parent deeper down'],
    ['src\\..\\..\\outside.txt', 'a parent, Windows separators'],
    ['/etc/passwd', 'an absolute POSIX path'],
    ['\\Windows\\win.ini', 'a rooted Windows path'],
    ['C:\\Windows\\win.ini', 'a drive path'],
    ['C:relative.txt', 'a drive-relative path'],
    ['\\\\server\\share\\x', 'a UNC path'],
    ['a\0b', 'a NUL'],
    ['   ', 'a blank'],
  ])('refuses %s (%s)', (p) => {
    expect(isRunRelativePath(p)).toBe(false)
  })

  it('accepts the paths a diff lists', () => {
    for (const p of ['src/index.ts', 'a b/c.txt', '.github/workflows/ci.yml', 'docs/a:b.md', 'x..y/z']) {
      expect(isRunRelativePath(p), p).toBe(true)
    }
  })

  it('a NUL never gets past the request schema, for any path-taking command', () => {
    const nul = 'src/a\0b.ts'
    const cases = [
      parseRequest('diff.file', { runId: 'r', seg: 'combined', path: nul }),
      parseRequest('diff.blob', { runId: 'r', seg: 'combined', side: 'new', path: nul }),
      parseRequest('diff.revert', { runId: 'r', paths: [nul] }),
      parseRequest('diff.markReviewed', { runId: 'r', paths: [nul], reviewed: true }),
      parseRequest('worktree.apply', { runId: 'r', paths: [nul] }),
      parseRequest('shell.open', { target: 'folder', path: `C:\\p${'\0'}` }),
      parseRequest('vendors.setPath', { vendor: 'claude', path: `C:\\x${'\0'}.exe` }),
      parseRequest('runs.start', { folder: `C:\\p${'\0'}`, task: 't' }),
    ]
    for (const r of cases) expect(r.ok ? 'ok' : r.error.code).toBe('VALIDATION')
  })
})

describe('path segments from data (run ids, folder keys, job ids)', () => {
  it('cannot leave their folder', () => {
    for (const bad of [
      '',
      '.',
      '..',
      'a/b',
      'a\\b',
      'c:x',
      'r1:stream',
      'r1::$DATA',
      'a\u0000b',
      'a\u001fb',
    ]) {
      expect(() => assertSafeSegment(bad), JSON.stringify(bad)).toThrow(/invalid/)
    }
  })

  it('cannot alias another folder on Windows (trailing dot or space) or name a device', () => {
    for (const bad of [
      '20261005T120000Z-abcd.',
      '20261005T120000Z-abcd ',
      'r1..',
      'NUL',
      'con',
      'CON.json',
      'aux.txt',
      'COM1',
      'lpt9.log',
      'CONIN$',
      'com²',
    ]) {
      expect(() => assertSafeSegment(bad), JSON.stringify(bad)).toThrow(/invalid/)
      expect(() => homePaths(join(tmpdir(), 'h')).run(bad), JSON.stringify(bad)).toThrow(/invalid/)
    }
    for (const ok of ['20261005T120000Z-abcd', 'console', 'nullable', 'com10', 'r1.2', '.hidden']) {
      expect(assertSafeSegment(ok), ok).toBe(ok)
    }
  })
})

describe('the folder guard judges the real folder', () => {
  const win: GuardContext = {
    platform: 'win32',
    home: 'C:\\Users\\Dan',
    dimFactoryHome: 'C:\\Users\\Dan\\.dimfactory',
    env: { WINDIR: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files' },
  }
  const reason = (p: string): string | undefined => checkGuard(p, win).reason

  it('an administrative share is the drive path it names', () => {
    expect(reason('\\\\localhost\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\127.0.0.1\\c$\\Users\\Dan\\')).toBe('home')
    expect(reason('\\\\[::1]\\C$\\Users')).toBe('home')
    expect(reason('\\\\dan-pc\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\?\\UNC\\localhost\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\localhost\\C$')).toBe('root')
    expect(reason('\\\\localhost\\D$\\')).toBe('root')
    expect(reason('\\\\localhost\\C$\\WINDOWS\\System32')).toBe('system')
    expect(reason('\\\\localhost\\C$\\Program Files\\App')).toBe('system')
    expect(reason('\\\\localhost\\C$\\Users\\Dan\\.dimfactory\\runs')).toBe('dimFactoryHome')
    // A project through the share is still a project; an ordinary share is not an admin share.
    expect(checkGuard('\\\\localhost\\C$\\Users\\Dan\\code\\app', win).guarded).toBe(false)
    expect(checkGuard('\\\\localhost\\projects\\app', win).guarded).toBe(false)
    expect(checkGuard('\\\\server\\tools$\\app', win).guarded).toBe(false)
  })

  it('whatever name the host goes by (a LAN address, 127.0.0.0/8, an FQDN, a trailing dot)', () => {
    // The machine's own LAN address passed the guard when only localhost, 127.0.0.1, ::1 and its name were mapped.
    expect(reason('\\\\192.0.2.10\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\192.0.2.10\\C$\\Windows')).toBe('system')
    expect(reason('\\\\192.0.2.10\\C$\\')).toBe('root')
    expect(reason('\\\\127.0.0.2\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\dan-pc.corp.example.com\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\localhost.\\C$\\Users\\Dan')).toBe('home')
    expect(reason('\\\\fe80--1.ipv6-literal.net\\C$\\Program Files\\App')).toBe('system')
    expect(reason('\\\\.\\UNC\\192.0.2.10\\C$\\Users\\Dan')).toBe('home')
    expect(reason('//192.0.2.10/c$/Users/Dan/')).toBe('home')
    // Another machine's drive root and system folders are no project folder either.
    expect(reason('\\\\fileserver\\D$')).toBe('root')
    expect(reason('\\\\fileserver\\C$\\Windows\\System32')).toBe('system')
    expect(checkGuard('\\\\fileserver\\C$\\src\\app', win).guarded).toBe(false)
  })

  it('adminShareDrivePath maps a drive-letter share of any host', () => {
    expect(adminShareDrivePath('\\\\localhost\\c$\\a\\b')).toBe('C:\\a\\b')
    expect(adminShareDrivePath('\\\\LOCALHOST\\C$')).toBe('C:\\')
    expect(adminShareDrivePath('\\\\Box\\C$\\x')).toBe('C:\\x')
    expect(adminShareDrivePath('\\\\10.0.0.7\\d$\\x\\y')).toBe('D:\\x\\y')
    expect(adminShareDrivePath('//host/d$/a/b')).toBe('D:\\a\\b')
    expect(adminShareDrivePath('\\\\?\\UNC\\host\\C$\\x')).toBe('C:\\x')
    expect(adminShareDrivePath('\\\\localhost\\share\\x')).toBe('\\\\localhost\\share\\x')
    expect(adminShareDrivePath('\\\\server\\tools$\\x')).toBe('\\\\server\\tools$\\x')
    expect(adminShareDrivePath('\\\\?\\C:\\x')).toBe('\\\\?\\C:\\x')
    expect(adminShareDrivePath('C:\\x')).toBe('C:\\x')
  })

  it.runIf(process.platform === 'win32')(
    'a junction to the home folder, \\\\?\\ and \\\\.\\ spellings and a stream name resolve to the home folder',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dim-factory-guard-paths-'))
      roots.push(root)
      const ch = join(root, 'dim-factory-home')
      mkdirSync(ch)
      const junction = join(root, 'looks-like-a-project')
      symlinkSync(homedir(), junction, 'junction')
      const o = { dimFactoryHome: ch }
      expect((await isGuarded(junction, o)).reason).toBe('home')
      expect((await isGuarded(`\\\\?\\${homedir()}`, o)).reason).toBe('home')
      expect((await isGuarded(`\\\\.\\${homedir()}`, o)).reason).toBe('home')
      expect((await isGuarded(`${homedir()}::$INDEX_ALLOCATION`, o)).reason).toBe('home')
      // This machine's own admin share for the home folder (the live hostname as well as localhost).
      const drive = homedir().slice(0, 1)
      const share = `\\\\localhost\\${drive}$${homedir().slice(2)}`
      expect((await isGuarded(share, o)).reason).toBe('home')
      expect((await isGuarded(`\\\\${hostname()}\\${drive}$${homedir().slice(2)}`, o)).reason).toBe('home')
      // And through this machine's own LAN address, which realpath keeps as it is.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address
      if (lan !== undefined) {
        expect((await isGuarded(`\\\\${lan}\\${drive}$${homedir().slice(2)}`, o)).reason).toBe('home')
        expect((await isGuarded(`\\\\${lan}\\C$\\Windows`, o)).reason).toBe('system')
      }
      // A junction into Dim Factory's own data folder.
      const intoHome = join(root, 'into-dim-factory-home')
      symlinkSync(ch, intoHome, 'junction')
      expect((await isGuarded(intoHome, o)).reason).toBe('dimFactoryHome')
    },
  )
})

describe('shell.open', () => {
  const paths = homePaths(join(tmpdir(), 'dim-factory-shell-open-home'))
  // An absolute folder on the OS running the test.
  const app = process.platform === 'win32' ? 'C:\\projects\\app' : '/projects/app'
  const isDir = (p: string): Promise<boolean> => Promise.resolve(p === app)

  it('opens an existing absolute folder only', async () => {
    await expect(resolveShellOpen({ target: 'folder', path: app }, paths, isDir)).resolves.toEqual({
      kind: 'path',
      path: app,
    })
    for (const path of [
      'projects\\app',
      '..\\..',
      'C:\\projects\\app\\run.exe',
      'C:\\Windows\\System32\\calc.exe',
    ]) {
      await expect(resolveShellOpen({ target: 'folder', path }, paths, isDir), path).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    }
  })

  it('a run folder is built from a safe run id, never from a path', async () => {
    for (const runId of ['..', '..\\..\\Windows', 'r1:evil', 'NUL', 'r1.']) {
      await expect(
        resolveShellOpen({ target: 'runFolder', runId }, paths, isDir),
        runId,
      ).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    }
  })

  it('a URL opens only when it is an allowlisted https link', async () => {
    await expect(
      resolveShellOpen({ target: 'url', url: 'https://evil.example/' }, paths, isDir),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      resolveShellOpen({ target: 'url', url: 'https://github.com/openai/codex' }, paths, isDir),
    ).resolves.toEqual({ kind: 'url', url: 'https://github.com/openai/codex' })
  })
})
