// Folder guard: home, drive/volume roots, system folders, DIM_FACTORY_HOME; exempt owners.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkGuard, guardCheckResult, isGuarded } from '../../../src/core/preflight/guard.ts'
import type { GuardContext } from '../../../src/core/preflight/guard.ts'

const win: GuardContext = {
  platform: 'win32',
  home: 'C:\\Users\\Dan',
  dimFactoryHome: 'C:\\Users\\Dan\\.dimfactory',
  env: {
    WINDIR: 'C:\\WINDOWS',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  },
}
const mac: GuardContext = { platform: 'darwin', home: '/Users/dan', dimFactoryHome: '/Users/dan/.dimfactory' }
const linux: GuardContext = { platform: 'linux', home: '/home/dan', dimFactoryHome: '/tmp/ch' }

const reason = (p: string, ctx: GuardContext): string | undefined => checkGuard(p, ctx).reason

describe('checkGuard', () => {
  it('win32: home, drive roots, UNC roots, Windows, Program Files*, DIM_FACTORY_HOME', () => {
    expect(reason('C:\\Users\\Dan', win)).toBe('home')
    expect(reason('c:\\users\\dan\\', win)).toBe('home')
    expect(reason('C:\\Users', win)).toBe('home')
    expect(reason('C:\\', win)).toBe('root')
    expect(reason('D:\\', win)).toBe('root')
    expect(reason('\\\\server\\share', win)).toBe('root')
    expect(reason('\\\\server\\share\\', win)).toBe('root')
    expect(reason('C:\\Windows\\System32', win)).toBe('system')
    expect(reason('C:\\Program Files\\App', win)).toBe('system')
    expect(reason('C:\\Program Files (x86)', win)).toBe('system')
    expect(reason('D:\\Program Files\\Tool', win)).toBe('system')
    expect(reason('C:\\Users\\Dan\\.dimfactory', win)).toBe('dimFactoryHome')
    expect(reason('C:\\Users\\Dan\\.dimfactory\\worktrees\\r1', win)).toBe('dimFactoryHome')
    expect(checkGuard('C:\\Users\\Dan\\code\\app', win).guarded).toBe(false)
    expect(checkGuard('C:\\_Dev\\AI\\DimFactory', win).guarded).toBe(false)
    expect(checkGuard('\\\\server\\share\\proj', win).guarded).toBe(false)
    expect(checkGuard('C:\\Users\\Dan\\.dim-factory-other', win).guarded).toBe(false)
    expect(reason('C:\\code\\app\\.git', win)).toBe('gitDir')
    expect(reason('C:\\code\\app\\.git\\modules\\x', win)).toBe('gitDir')
    expect(checkGuard('C:\\code\\app\\.github', win).guarded).toBe(false)
  })

  it('macOS: /, /Volumes/X, /usr, /System, /Applications, ~/Library', () => {
    expect(reason('/', mac)).toBe('root')
    expect(reason('/Volumes/External', mac)).toBe('root')
    expect(reason('/usr/local/src/x', mac)).toBe('system')
    expect(reason('/System/Library', mac)).toBe('system')
    expect(reason('/Applications/Foo.app', mac)).toBe('system')
    expect(reason('/users/dan/library/Caches', mac)).toBe('system')
    expect(reason('/Users/dan', mac)).toBe('home')
    expect(reason('/Users', mac)).toBe('home')
    expect(checkGuard('/Volumes/External/proj', mac).guarded).toBe(false)
    expect(checkGuard('/Users/dan/code/app', mac).guarded).toBe(false)
  })

  it('linux: case-sensitive, mount roots, DIM_FACTORY_HOME', () => {
    expect(reason('/home/dan', linux)).toBe('home')
    expect(reason('/home', linux)).toBe('home')
    expect(checkGuard('/home/Dan', linux).guarded).toBe(false)
    expect(reason('/mnt/c', linux)).toBe('root')
    expect(reason('/media/dan/usb', linux)).toBe('root')
    expect(reason('/tmp/ch/runs/x', linux)).toBe('dimFactoryHome')
    expect(reason('/usr', linux)).toBe('system')
    expect(checkGuard('/mnt/c/code/app', linux).guarded).toBe(false)
    expect(checkGuard('/home/dan/src/app', linux).guarded).toBe(false)
    expect(reason('/home/dan/src/app/.git', linux)).toBe('gitDir')
  })

  it('builds the folder.guard CheckResult', () => {
    const bad = guardCheckResult(checkGuard('/home/dan', linux), 5)
    expect(bad).toMatchObject({
      id: 'folder.guard',
      scope: 'folder',
      status: 'fail',
      blocking: true,
      category: 'folder_guard',
      at: 5,
      ttlMs: 0,
    })
    const good = guardCheckResult(checkGuard('/home/dan/app', linux), 5)
    expect(good).toMatchObject({ status: 'pass', blocking: false })
    expect(good.category).toBeUndefined()
  })
})

describe('isGuarded (real paths)', () => {
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('refuses the real home, a drive root and anything inside DIM_FACTORY_HOME; exempt owners pass', async () => {
    const ch = mkdtempSync(join(tmpdir(), 'dim-factory-guard-home-'))
    const project = mkdtempSync(join(tmpdir(), 'dim-factory-guard-proj-'))
    made.push(ch, project)
    mkdirSync(join(ch, 'tmp', 'heal'), { recursive: true })
    expect((await isGuarded(homedir(), { dimFactoryHome: ch })).reason).toBe('home')
    expect((await isGuarded(parse(project).root, { dimFactoryHome: ch })).reason).toBe('root')
    expect((await isGuarded(join(ch, 'tmp', 'heal'), { dimFactoryHome: ch })).reason).toBe('dimFactoryHome')
    expect((await isGuarded(project, { dimFactoryHome: ch })).guarded).toBe(false)
    for (const owner of ['worktree', 'heal', 'catalog', 'probe'] as const) {
      expect((await isGuarded(join(ch, 'tmp', 'heal'), { dimFactoryHome: ch, owner })).guarded).toBe(false)
    }
    // default DIM_FACTORY_HOME comes from the env (tests/setup/home.ts sets it per test)
    const envHome = process.env['DIM_FACTORY_HOME'] ?? ''
    expect((await isGuarded(envHome)).reason).toBe('dimFactoryHome')
  })
})
