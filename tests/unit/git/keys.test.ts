// Lock keys, folder keys, overlap rules and the small pure helpers of the git layer.
import { describe, expect, it } from 'vitest'
import {
  chunkPaths,
  classifyGitFailure,
  compareGitVersion,
  isDubiousOwnership,
  isLockContention,
  parseGitVersion,
  splitNul,
} from '../../../src/core/git/exec.ts'
import {
  folderKeyOf,
  lockKeysOverlap,
  normalizeLockPath,
  stripLongPathPrefix,
} from '../../../src/core/git/repo.ts'
import {
  assertRunRefId,
  excludeLine,
  parseAddStderr,
  shadowConfig,
  withShadowConfigBlock,
} from '../../../src/core/git/shadow.ts'

describe('lock keys and folder keys', () => {
  it('normalizes: strips \\\\?\\, trailing separators and folds case when the volume does', () => {
    expect(normalizeLockPath('\\\\?\\C:\\Users\\Dan\\Proj\\', true, 'win32')).toBe('c:\\users\\dan\\proj')
    expect(normalizeLockPath('\\\\?\\UNC\\srv\\share\\Proj', false, 'win32')).toBe('\\\\srv\\share\\Proj')
    expect(normalizeLockPath('C:\\', true, 'win32')).toBe('c:\\')
    expect(normalizeLockPath('/home/u/Proj/', false, 'linux')).toBe('/home/u/Proj')
    expect(normalizeLockPath('/Users/u/Proj', true, 'darwin')).toBe('/users/u/proj')
    expect(normalizeLockPath('/', false, 'linux')).toBe('/')
    expect(stripLongPathPrefix('C:\\x')).toBe('C:\\x')
  })

  it('folderKey = sha256(lockKey).slice(0,16)', () => {
    const k = folderKeyOf('c:\\_dev\\proj')
    expect(k).toMatch(/^[0-9a-f]{16}$/)
    expect(folderKeyOf('c:\\_dev\\proj')).toBe(k)
    expect(folderKeyOf('c:\\_dev\\proj2')).not.toBe(k)
    // sha256("abc") = ba7816bf8f01cfea…
    expect(folderKeyOf('abc')).toBe('ba7816bf8f01cfea')
  })

  it('overlap = equal, ancestor or descendant (not a sibling prefix)', () => {
    expect(lockKeysOverlap('/a/b', '/a/b', 'linux')).toBe(true)
    expect(lockKeysOverlap('/a', '/a/b', 'linux')).toBe(true)
    expect(lockKeysOverlap('/a/b/c', '/a/b', 'linux')).toBe(true)
    expect(lockKeysOverlap('/a/b', '/a/bc', 'linux')).toBe(false)
    expect(lockKeysOverlap('c:\\', 'c:\\x', 'win32')).toBe(true)
    expect(lockKeysOverlap('c:\\x', 'c:\\xy', 'win32')).toBe(false)
  })
})

describe('exec helpers', () => {
  it('parses and compares git versions (incl. Git for Windows suffixes)', () => {
    const v = parseGitVersion('git version 2.17.1.windows.2\n')
    expect(v).toEqual({ major: 2, minor: 17, patch: 1, raw: 'git version 2.17.1.windows.2' })
    expect(parseGitVersion('git version 2.55.0')).toMatchObject({ major: 2, minor: 55, patch: 0 })
    expect(parseGitVersion('nope')).toBeNull()
    expect(
      compareGitVersion({ major: 2, minor: 17, patch: 1 }, { major: 2, minor: 35, patch: 2 }),
    ).toBeLessThan(0)
  })

  it('classifies failures: disk full, ownership, lock files, fallback', () => {
    expect(classifyGitFailure('fatal: write error: No space left on device', 'snapshot_failed')).toBe(
      'disk_full',
    )
    expect(classifyGitFailure("fatal: detected dubious ownership in repository at '/x'")).toBe('git_state')
    const lock = "fatal: Unable to create '/x/.git/index.lock': File exists."
    expect(classifyGitFailure(lock, 'git_state')).toBe('git_state')
    expect(classifyGitFailure(lock)).toBe('git_state')
    // a held lock in Dim Factory's own shadow is a (retryable) snapshot failure
    expect(classifyGitFailure(lock, 'snapshot_failed')).toBe('snapshot_failed')
    expect(classifyGitFailure('fatal: bad object', 'snapshot_failed')).toBe('snapshot_failed')
    expect(isDubiousOwnership('detected dubious ownership')).toBe(true)
    expect(isLockContention("error: cannot lock ref 'refs/heads/x'")).toBe(true)
  })

  it('splits -z output and batches argv paths', () => {
    expect(splitNul('')).toEqual([])
    expect(splitNul('a\0b c\0')).toEqual(['a', 'b c'])
    const batches = chunkPaths(['aaaa', 'bbbb', 'cccc'], 14)
    expect(batches).toEqual([['aaaa', 'bbbb'], ['cccc']])
    expect(chunkPaths([])).toEqual([])
  })
})

describe('shadow helpers', () => {
  it('per-platform config', () => {
    const win = new Map(shadowConfig('win32', true))
    expect(win.get('core.autocrlf')).toBe('false')
    expect(win.get('core.safecrlf')).toBe('false')
    expect(win.get('core.quotepath')).toBe('false')
    expect(win.get('gc.auto')).toBe('0')
    expect(win.get('commit.gpgsign')).toBe('false')
    expect(win.get('core.ignorecase')).toBe('true')
    expect(win.get('core.longpaths')).toBe('true')
    expect(win.get('core.filemode')).toBe('false')
    expect(win.has('core.precomposeunicode')).toBe(false)
    const mac = new Map(shadowConfig('darwin', true))
    expect(mac.get('core.precomposeunicode')).toBe('true')
    expect(mac.has('core.longpaths')).toBe(false)
    expect(new Map(shadowConfig('linux', false)).get('core.ignorecase')).toBe('false')
  })

  it('appends one settings block to the config file and replaces it on upgrade', () => {
    const init = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'
    const once = withShadowConfigBlock(init, [
      ['core.autocrlf', 'false'],
      ['core.fsmonitor', ''],
      ['gc.auto', '0'],
    ])
    expect(once).toBe(
      `${init}# >>> Dim Factory shadow settings (generated; rewritten on upgrade) >>>\n` +
        '[core]\n\tautocrlf = false\n\tfsmonitor =\n[gc]\n\tauto = 0\n# <<< Dim Factory shadow settings <<<\n',
    )
    const twice = withShadowConfigBlock(once, [['core.autocrlf', 'false']])
    expect(twice.match(/Dim Factory shadow settings \(generated/g)).toHaveLength(1)
    expect(twice).not.toContain('[gc]')
    expect(twice.startsWith(init)).toBe(true)
  })

  it('escapes info/exclude lines and anchors them', () => {
    expect(excludeLine('big.bin')).toBe('/big.bin')
    expect(excludeLine('dir/a*b?[c].txt')).toBe('/dir/a\\*b\\?\\[c\\].txt')
    expect(excludeLine('#hash !bang')).toBe('/\\#hash \\!bang')
    expect(excludeLine('trailing  ')).toBe('/trailing\\ \\ ')
    expect(excludeLine('.dimfactory', true)).toBe('/.dimfactory/')
  })

  it('parses add --ignore-errors stderr into unreadable paths and warnings', () => {
    const stderr = [
      'error: open("locked.txt"): Permission denied',
      "error: unable to index file 'locked.txt'",
      'error: unable to index file other.txt',
      "error: 'sub/' does not have a commit checked out",
      'warning: adding embedded git repository: nested',
      "hint: You've added another git repository inside your current repository.",
    ].join('\n')
    expect(parseAddStderr(stderr)).toEqual({
      unreadable: ['locked.txt', 'other.txt', 'sub/'],
      warnings: ['warning: adding embedded git repository: nested'],
    })
  })

  it('accepts only ref-safe run ids', () => {
    expect(assertRunRefId('20261005T120000Z-abcd')).toBe('20261005T120000Z-abcd')
    for (const bad of ['', '-x', 'a..b', 'x.lock', 'a/b', 'a b', 'x.', '../x']) {
      expect(() => assertRunRefId(bad), bad).toThrow()
    }
  })
})
