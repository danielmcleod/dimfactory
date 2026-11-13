import { describe, expect, it } from 'vitest'
import {
  computePathEnv,
  describePathEnv,
  expandWindowsEnv,
  extractMarkedPath,
  mergePathLists,
  parseRegQuery,
  splitPathList,
} from '../../../src/core/proc/path-env.ts'
import type { CaptureFn } from '../../../src/core/proc/path-env.ts'
import type { CaptureResult } from '../../../src/core/proc/spawn.ts'

const ok = (stdout: string, extra: Partial<CaptureResult> = {}): CaptureResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  ms: 1,
  ...extra,
})

describe('extractMarkedPath', () => {
  it('ignores rc-file noise around the markers', () => {
    const out = [
      'Welcome to fish / oh-my-zsh banner',
      'nvm: using node v24 __CP__ not this one',
      '',
      '__CP__/opt/homebrew/bin:/usr/bin:/bin__CP__',
      'rc noise after',
    ].join('\n')
    expect(extractMarkedPath(out)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('returns null without a complete marker pair or an empty value', () => {
    expect(extractMarkedPath('no markers')).toBeNull()
    expect(extractMarkedPath('__CP__/usr/bin')).toBeNull()
    expect(extractMarkedPath('__CP____CP__')).toBeNull()
  })
})

describe('PATH lists', () => {
  it('splits, unquotes and drops empty entries', () => {
    expect(splitPathList('C:\\a;;"C:\\Program Files\\b";', 'win32')).toEqual([
      'C:\\a',
      'C:\\Program Files\\b',
    ])
    expect(splitPathList('/a::/b', 'linux')).toEqual(['/a', '/b'])
    expect(splitPathList(undefined, 'linux')).toEqual([])
  })

  it('merges in order, deduping case- and slash-insensitively on win32', () => {
    expect(
      mergePathLists(
        [
          ['C:\\Tools', 'C:\\Windows\\System32'],
          ['c:\\tools\\', 'C:\\New', 'C:\\WINDOWS\\system32'],
        ],
        'win32',
      ),
    ).toEqual(['C:\\Tools', 'C:\\Windows\\System32', 'C:\\New'])
    expect(
      mergePathLists(
        [
          ['/usr/bin', '/a'],
          ['/usr/bin/', '/A'],
        ],
        'linux',
      ),
    ).toEqual(['/usr/bin', '/a', '/A'])
  })
})

describe('registry PATH', () => {
  const HKLM = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs\\;%UNKNOWN_VAR%\\bin',
    '',
  ].join('\r\n')
  const HKCU = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_SZ    C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm',
    '',
  ].join('\r\n')

  it('parses reg.exe output', () => {
    expect(parseRegQuery(HKLM)).toEqual({
      type: 'REG_EXPAND_SZ',
      value: '%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs\\;%UNKNOWN_VAR%\\bin',
    })
    expect(parseRegQuery(HKCU)?.type).toBe('REG_SZ')
    expect(
      parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'),
    ).toBeNull()
  })

  it('expands %VAR% case-insensitively and leaves unknown ones', () => {
    expect(expandWindowsEnv('%systemroot%\\x;%NOPE%', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\x;%NOPE%',
    )
  })

  it('forced re-probe merges process Path with fresh HKLM/HKCU values', async () => {
    const calls: string[][] = []
    const capture: CaptureFn = (command, args) => {
      calls.push([command, ...args])
      return Promise.resolve(ok(args[1]?.startsWith('HKLM') === true ? HKLM : HKCU))
    }
    const env = { Path: 'C:\\Windows\\system32;C:\\Launch', SystemRoot: 'C:\\Windows' }
    const cachedRun = await computePathEnv({ platform: 'win32', env, capture })
    expect(calls).toEqual([])
    expect(cachedRun).toMatchObject({ source: 'process', entries: ['C:\\Windows\\system32', 'C:\\Launch'] })

    const forced = await computePathEnv({ platform: 'win32', env, capture, force: true })
    expect(calls.map((c) => c[0])).toEqual([
      'C:\\Windows\\System32\\reg.exe',
      'C:\\Windows\\System32\\reg.exe',
    ])
    expect(calls[0]?.slice(1)).toEqual([
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      '/v',
      'Path',
    ])
    expect(forced.source).toBe('registry')
    expect(forced.entries).toEqual([
      'C:\\Windows\\system32',
      'C:\\Launch',
      'C:\\Windows',
      'C:\\Program Files\\nodejs\\',
      '%UNKNOWN_VAR%\\bin',
      'C:\\Users\\u\\.local\\bin',
      'C:\\Users\\u\\AppData\\Roaming\\npm',
    ])
    expect(forced.path.split(';')).toEqual(forced.entries)
  })
})

describe('POSIX login shell probe', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/home/u', SECRET: 'x' }
  const none = (): boolean => false

  it('uses the -ilc result, merged before the process PATH, with existing extras', async () => {
    const seen: { args: readonly string[]; env: unknown; timeoutMs: number | undefined }[] = []
    const capture: CaptureFn = (_cmd, args, opts) => {
      seen.push({ args, env: opts.env, timeoutMs: opts.timeoutMs })
      return Promise.resolve(ok('motd\n__CP__/opt/homebrew/bin:/usr/bin__CP__\n'))
    }
    const r = await computePathEnv({
      platform: 'darwin',
      env,
      capture,
      loginShell: true,
      exists: (p) => p === '/home/u/.local/bin',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args[0]).toBe('-ilc')
    expect(seen[0]?.args[1]).toContain('__CP__%s__CP__')
    expect(seen[0]?.timeoutMs).toBe(4000)
    expect(seen[0]?.env).toEqual({ TERM: 'dumb', HOME: '/home/u', SHELL: '/bin/zsh' })
    expect(r).toMatchObject({ source: 'login-shell', shell: '/bin/zsh' })
    expect(r.entries).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin', '/home/u/.local/bin'])
    expect(describePathEnv(r)).toBe('PATH source: login shell (zsh) · 4 entries')
  })

  it('falls back to -lc after a timeout, then to the process PATH', async () => {
    const flags: string[] = []
    const capture: CaptureFn = (_cmd, args) => {
      flags.push(args[0] ?? '')
      return Promise.resolve(
        args[0] === '-ilc' ? ok('', { timedOut: true, code: null }) : ok('__CP__/x/bin__CP__'),
      )
    }
    const r = await computePathEnv({ platform: 'linux', env, capture, loginShell: true, exists: none })
    expect(flags).toEqual(['-ilc', '-lc'])
    expect(r.source).toBe('login-shell-fallback')
    expect(r.entries).toEqual(['/x/bin', '/usr/bin', '/bin'])

    const broken: CaptureFn = () => Promise.resolve(ok('no markers at all'))
    const r2 = await computePathEnv({
      platform: 'linux',
      env,
      capture: broken,
      loginShell: true,
      exists: none,
    })
    expect(r2.source).toBe('process')
    expect(r2.entries).toEqual(['/usr/bin', '/bin'])
    expect(r2.warnings[0]).toContain('did not report PATH')
  })

  it('skips the shell when launched from a terminal', async () => {
    const capture: CaptureFn = () => Promise.reject(new Error('must not run'))
    const r = await computePathEnv({ platform: 'linux', env, capture, loginShell: false, exists: none })
    expect(r).toMatchObject({ source: 'process', entries: ['/usr/bin', '/bin'] })
  })
})
