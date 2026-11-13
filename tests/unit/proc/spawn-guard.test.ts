import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { errnoCategory } from '../../../src/core/heal/signals/generic.ts'
import {
  MAX_WIN_COMMAND_LINE,
  SpawnError,
  spawnChild,
  validateArgv,
  windowsCommandLineLength,
} from '../../../src/core/proc/spawn.ts'

const code = (fn: () => void): string | undefined => {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof SpawnError ? err.code : 'other'
  }
}

describe('validateArgv', () => {
  it('accepts ordinary argv, including JSON flag values', () => {
    expect(
      code(() =>
        validateArgv('C:\\x\\claude.exe', ['-p', '--settings', '{"disableAllHooks":true}', 'a b'], 'win32'),
      ),
    ).toBeUndefined()
  })

  it.each(['line\nbreak', 'carriage\rreturn', 'nul\0byte'])('rejects control characters: %j', (bad) => {
    expect(code(() => validateArgv('/usr/bin/x', ['-p', bad], 'linux'))).toBe('EARGV')
    expect(code(() => validateArgv('/usr/bin/x', [bad], 'win32'))).toBe('EARGV')
    expect(code(() => validateArgv(`/usr/bin/${bad}`, [], 'linux'))).toBe('EARGV')
  })

  it('caps the win32 command line under 32,000 chars but not POSIX argv', () => {
    const big = 'x'.repeat(MAX_WIN_COMMAND_LINE)
    expect(code(() => validateArgv('C:\\x.exe', [big], 'win32'))).toBe('EARGV')
    expect(code(() => validateArgv('/x', [big], 'linux'))).toBeUndefined()
    const fits = 'y'.repeat(31_000)
    expect(code(() => validateArgv('C:\\x.exe', [fits], 'win32'))).toBeUndefined()
  })

  it('counts quoting overhead', () => {
    expect(windowsCommandLineLength('a.exe', ['b', 'c"d'])).toBeGreaterThan('a.exe b c"d'.length)
  })

  it('refuses .cmd/.bat on win32 (they need the shim resolver, never a shell)', () => {
    expect(code(() => validateArgv('C:\\npm\\claude.cmd', [], 'win32'))).toBe('ESHIM')
    expect(code(() => validateArgv('C:\\npm\\claude.BAT', [], 'win32'))).toBe('ESHIM')
    expect(code(() => validateArgv('/x/claude.cmd', [], 'linux'))).toBeUndefined()
  })
})

describe('spawnChild working folder', () => {
  it('a missing cwd is ECWD naming the folder, not ENOENT on the binary (which reads as "not installed")', async () => {
    const cwd = join(tmpdir(), 'dim-factory-missing-cwd', 'definitely', 'gone')
    const err = await spawnChild({ command: process.execPath, args: ['-v'], cwd, env: {} }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SpawnError)
    expect(err).toMatchObject({ code: 'ECWD', path: cwd })
    expect(errnoCategory('ECWD', { vendor: 'claude' })).toBe('folder_guard')
  })
})
