import { describe, expect, it } from 'vitest'
import {
  AllowCache,
  RunAllowCaches,
  exactRuleFor,
  globMatches,
  globToRegExp,
  hostOf,
  normalizePath,
  ruleMatches,
} from '@core/adapters/allow-cache.ts'
import type { AllowQuery } from '@core/adapters/allow-cache.ts'
import type { AllowRule } from '@shared/events.ts'

const shellRule = (
  match: AllowRule['match'],
  source: AllowRule['source'] = 'vendor-suggestion',
): AllowRule => ({
  vendor: 'codex',
  kind: 'shell',
  tool: 'commandExecution',
  match,
  source,
})
const shellQ = (argv: string[]): AllowQuery => ({
  vendor: 'codex',
  kind: 'shell',
  tool: 'commandExecution',
  argv,
})

const editRule = (pathGlob: string, source: AllowRule['source'] = 'vendor-suggestion'): AllowRule => ({
  vendor: 'gemini',
  kind: 'edit',
  tool: 'edit',
  match: { pathGlob },
  source,
})
const editQ = (path: string | string[]): AllowQuery =>
  Array.isArray(path)
    ? { vendor: 'gemini', kind: 'edit', tool: 'edit', paths: path }
    : { vendor: 'gemini', kind: 'edit', tool: 'edit', path }

const netRule = (host: string, source: AllowRule['source'] = 'vendor-suggestion'): AllowRule => ({
  vendor: 'codex',
  kind: 'network',
  tool: 'webFetch',
  match: { host },
  source,
})
const netQ = (url: string): AllowQuery => ({ vendor: 'codex', kind: 'network', tool: 'webFetch', url })

const posix = { caseInsensitivePaths: false }
const win = { caseInsensitivePaths: true }

describe('normalizePath', () => {
  it.each([
    ['C:\\Repo\\src\\a.ts', 'C:/Repo/src/a.ts'],
    ['/repo//src/./a.ts', '/repo/src/a.ts'],
    ['/repo/src/../lib/a.ts', '/repo/lib/a.ts'],
    ['/repo/../../etc/passwd', '/etc/passwd'],
    ['C:\\..\\Windows', 'C:/Windows'],
    ['\\\\server\\share\\x', '//server/share/x'],
    ['/repo/src/', '/repo/src'],
    ['src/../../x', '../x'],
    ['', '.'],
  ])('%s → %s', (input, out) => {
    expect(normalizePath(input)).toBe(out)
  })

  it('anchors relative paths at cwd and expands ~ with home', () => {
    expect(normalizePath('src/a.ts', { cwd: 'C:\\Repo' })).toBe('C:/Repo/src/a.ts')
    expect(normalizePath('/abs/a.ts', { cwd: '/repo' })).toBe('/abs/a.ts')
    expect(normalizePath('~/notes/x.md', { home: '/home/u' })).toBe('/home/u/notes/x.md')
    expect(normalizePath('~/x', { cwd: '/repo' })).toBe('~/x')
  })
})

describe('globToRegExp / globMatches', () => {
  const cases: [glob: string, path: string, match: boolean][] = [
    ['/repo/src/*.ts', '/repo/src/a.ts', true],
    ['/repo/src/*.ts', '/repo/src/sub/a.ts', false],
    ['/repo/src/**', '/repo/src/sub/deep/a.ts', true],
    ['/repo/src/**', '/repo/src', false],
    ['/repo/src/**', '/repo/srcx/a.ts', false],
    ['/repo/**/test/*.ts', '/repo/test/a.ts', true],
    ['/repo/**/test/*.ts', '/repo/a/b/test/a.ts', true],
    ['/repo/**/test/*.ts', '/repo/a/b/test/x/a.ts', false],
    ['/repo/src/?.ts', '/repo/src/a.ts', true],
    ['/repo/src/?.ts', '/repo/src/ab.ts', false],
    ['/repo/src/[ab].ts', '/repo/src/b.ts', true],
    ['/repo/src/[!ab].ts', '/repo/src/b.ts', false],
    ['/repo/src/[!ab].ts', '/repo/src/c.ts', true],
    ['/repo/src/*.{ts,tsx}', '/repo/src/a.tsx', true],
    ['/repo/src/*.{ts,tsx}', '/repo/src/a.js', false],
    ['/repo/a.b', '/repo/aXb', false],
    ['/repo/(x)+', '/repo/(x)+', true],
    ['/repo/[id]/page.tsx', '/repo/i/page.tsx', true],
    ['/repo/src/**', '/repo/src/../../etc/passwd', false],
    ['/repo/src/../secret/**', '/repo/secret/k', true],
    ['/repo/src/*', '/repo/src/.env', true],
    ['/repo/[/]x', '/repo//x', false],
  ]
  it.each(cases)('%s vs %s → %s', (glob, path, match) => {
    expect(globMatches(glob, path, { caseInsensitive: false })).toBe(match)
  })

  it('folds case only when asked (Windows paths)', () => {
    expect(globMatches('C:/Repo/Src/**', 'c:\\repo\\src\\A.TS', { caseInsensitive: true })).toBe(true)
    expect(globMatches('C:/Repo/Src/**', 'c:\\repo\\src\\A.TS', { caseInsensitive: false })).toBe(false)
    expect(globToRegExp('C:\\Repo\\*.ts', { caseInsensitive: true }).test('c:/repo/x.TS')).toBe(true)
  })

  it('anchors relative globs at cwd', () => {
    expect(globMatches('src/**', '/repo/src/a.ts', { cwd: '/repo' })).toBe(true)
    expect(globMatches('src/**', '/other/src/a.ts', { cwd: '/repo' })).toBe(false)
    expect(globMatches('src/**', '/repo/src/a.ts')).toBe(false)
  })

  it('keeps UNC roots distinct', () => {
    expect(globMatches('//server/share/**', '\\\\server\\share\\a\\b')).toBe(true)
    expect(globMatches('//server/share/**', '/server/share/a')).toBe(false)
  })
})

describe('ruleMatches: identity', () => {
  it('requires the same vendor, tool and kind', () => {
    const r = shellRule({ argv: ['npm', 'test'] }, 'exact')
    expect(ruleMatches(r, shellQ(['npm', 'test']))).toBe(true)
    expect(ruleMatches(r, { ...shellQ(['npm', 'test']), vendor: 'claude' })).toBe(false)
    expect(ruleMatches(r, { ...shellQ(['npm', 'test']), tool: 'Bash' })).toBe(false)
    expect(ruleMatches(r, { ...shellQ(['npm', 'test']), kind: 'other' })).toBe(false)
  })
})

describe('ruleMatches: argv', () => {
  it('exact argv matches only the identical command', () => {
    const r = shellRule({ argv: ['npm', 'test'] }, 'exact')
    expect(ruleMatches(r, shellQ(['npm', 'test']))).toBe(true)
    expect(ruleMatches(r, shellQ(['npm', 'test', '--watch']))).toBe(false)
    expect(ruleMatches(r, shellQ(['npm']))).toBe(false)
    expect(ruleMatches(r, shellQ(['NPM', 'test']))).toBe(false)
  })

  it('argvPrefix applies only to vendor suggestions', () => {
    const suggested = shellRule({ argvPrefix: ['npm', 'run'] })
    expect(ruleMatches(suggested, shellQ(['npm', 'run', 'build']))).toBe(true)
    expect(ruleMatches(suggested, shellQ(['npm', 'run']))).toBe(true)
    expect(ruleMatches(suggested, shellQ(['npm', 'install']))).toBe(false)
    const exact = shellRule({ argvPrefix: ['npm', 'run'] }, 'exact')
    expect(ruleMatches(exact, shellQ(['npm', 'run', 'build']))).toBe(false)
  })

  it('a prefix never covers a compound command', () => {
    const r = shellRule({ argvPrefix: ['git', 'status'] })
    expect(ruleMatches(r, shellQ(['git', 'status', '&&', 'rm', '-rf', '/']))).toBe(false)
    expect(ruleMatches(r, shellQ(['git', 'status', ';rm']))).toBe(false)
    expect(ruleMatches(r, shellQ(['git', 'status', '$(curl x)']))).toBe(false)
    expect(ruleMatches(r, shellQ(['git', 'status', '|', 'sh']))).toBe(false)
    expect(ruleMatches(r, shellQ(['git', 'status', '--short']))).toBe(true)
  })

  it('a shell wrapper is not matched by the wrapped command prefix', () => {
    const r = shellRule({ argvPrefix: ['git'] })
    expect(ruleMatches(r, shellQ(['bash', '-lc', 'git status']))).toBe(false)
  })
})

describe('ruleMatches: paths', () => {
  it('exact rules compare literal paths, even with glob characters', () => {
    const r = editRule('/repo/app/[id]/page.tsx', 'exact')
    expect(ruleMatches(r, editQ('/repo/app/[id]/page.tsx'), posix)).toBe(true)
    expect(ruleMatches(r, editQ('/repo/app/i/page.tsx'), posix)).toBe(false)
    const star = editRule('/repo/src/*', 'exact')
    expect(ruleMatches(star, editQ('/repo/src/a.ts'), posix)).toBe(false)
  })

  it('suggested globs match by pattern; every path of a multi-file edit must match', () => {
    const r = editRule('/repo/src/**')
    expect(ruleMatches(r, editQ('/repo/src/a/b.ts'), posix)).toBe(true)
    expect(ruleMatches(r, editQ(['/repo/src/a.ts', '/repo/src/b.ts']), posix)).toBe(true)
    expect(ruleMatches(r, editQ(['/repo/src/a.ts', '/repo/package.json']), posix)).toBe(false)
    expect(ruleMatches(r, { vendor: 'gemini', kind: 'edit', tool: 'edit' }, posix)).toBe(false)
  })

  it('Windows paths match case-insensitively with either separator', () => {
    const r = editRule('C:\\Repo\\src\\**')
    expect(ruleMatches(r, editQ('c:/repo/SRC/index.ts'), win)).toBe(true)
    expect(ruleMatches(r, editQ('c:/repo/SRC/index.ts'), posix)).toBe(false)
    const exact = editRule('C:\\Repo\\README.md', 'exact')
    expect(ruleMatches(exact, editQ('c:/repo/readme.MD'), win)).toBe(true)
    expect(ruleMatches(exact, editQ('c:/repo/readme.MD'), posix)).toBe(false)
  })

  it('traversal cannot escape a suggested glob', () => {
    const r = editRule('/repo/src/**')
    expect(ruleMatches(r, editQ('/repo/src/../.git/config'), posix)).toBe(false)
    expect(ruleMatches(r, editQ('/repo/src/../../home/u/.ssh/id_rsa'), posix)).toBe(false)
  })

  it('relative globs and paths resolve against the pass cwd', () => {
    const r = editRule('src/**')
    expect(ruleMatches(r, editQ('/repo/src/a.ts'), { ...posix, cwd: '/repo' })).toBe(true)
    expect(ruleMatches(r, editQ('src/a.ts'), { ...posix, cwd: '/repo' })).toBe(true)
    expect(ruleMatches(r, editQ('/elsewhere/src/a.ts'), { ...posix, cwd: '/repo' })).toBe(false)
  })
})

describe('ruleMatches: hosts', () => {
  it('exact and suggested hosts match the same host (case-insensitive), not subdomains', () => {
    for (const source of ['exact', 'vendor-suggestion'] as const) {
      const r = netRule('Example.com', source)
      expect(ruleMatches(r, netQ('https://example.com/a'))).toBe(true)
      expect(ruleMatches(r, netQ('https://api.example.com/a'))).toBe(false)
      expect(ruleMatches(r, netQ('https://example.com.evil.io/'))).toBe(false)
    }
  })

  it('wildcard hosts only from vendor suggestions, and never the apex', () => {
    const r = netRule('*.example.com')
    expect(ruleMatches(r, netQ('https://api.example.com/x'))).toBe(true)
    expect(ruleMatches(r, netQ('https://a.b.example.com/x'))).toBe(true)
    expect(ruleMatches(r, netQ('https://example.com/x'))).toBe(false)
    expect(ruleMatches(r, netQ('https://notexample.com/x'))).toBe(false)
    expect(ruleMatches(netRule('*.example.com', 'exact'), netQ('https://api.example.com/x'))).toBe(false)
  })

  it('a port in the rule must match', () => {
    expect(ruleMatches(netRule('localhost:8080'), netQ('http://localhost:8080/v1'))).toBe(true)
    expect(ruleMatches(netRule('localhost:8080'), netQ('http://localhost:9090/v1'))).toBe(false)
    expect(ruleMatches(netRule('localhost'), netQ('http://localhost:9090/v1'))).toBe(true)
  })

  it('hostOf parses URLs', () => {
    expect(hostOf('https://API.Example.com:443/x')).toBe('api.example.com')
    expect(hostOf('http://[::1]:11434/v1')).toBe('[::1]:11434')
    expect(hostOf('not a url')).toBeUndefined()
  })
})

describe('ruleMatches: scope', () => {
  it('an empty vendor suggestion is tool-wide; an empty exact rule matches nothing', () => {
    const whole: AllowRule = {
      vendor: 'claude',
      kind: 'network',
      tool: 'WebSearch',
      match: {},
      source: 'vendor-suggestion',
    }
    expect(ruleMatches(whole, { vendor: 'claude', kind: 'network', tool: 'WebSearch' })).toBe(true)
    expect(
      ruleMatches({ ...whole, source: 'exact' }, { vendor: 'claude', kind: 'network', tool: 'WebSearch' }),
    ).toBe(false)
  })

  it('all criteria in a rule must hold', () => {
    const r = shellRule({ argvPrefix: ['git'], pathGlob: '/repo/**' })
    expect(ruleMatches(r, { ...shellQ(['git', 'add']), path: '/repo/a' }, posix)).toBe(true)
    expect(ruleMatches(r, { ...shellQ(['git', 'add']), path: '/etc/a' }, posix)).toBe(false)
    expect(ruleMatches(r, shellQ(['git', 'add']), posix)).toBe(false)
  })
})

describe('exactRuleFor', () => {
  it('builds rules that match exactly the query and nothing broader', () => {
    const q = shellQ(['npm', 'test'])
    const r = exactRuleFor(q)!
    expect(r).toEqual({
      vendor: 'codex',
      kind: 'shell',
      tool: 'commandExecution',
      match: { argv: ['npm', 'test'] },
      source: 'exact',
    })
    expect(ruleMatches(r, q)).toBe(true)
    expect(ruleMatches(r, shellQ(['npm', 'test', 'x']))).toBe(false)

    const e = exactRuleFor(editQ('C:\\Repo\\a.ts'))!
    expect(e.match).toEqual({ pathGlob: 'C:/Repo/a.ts' })
    expect(ruleMatches(e, editQ('C:/Repo/a.ts'), posix)).toBe(true)
    expect(ruleMatches(e, editQ('C:/Repo/b.ts'), posix)).toBe(false)

    const n = exactRuleFor(netQ('https://example.com/a?b=1'))!
    expect(n.match).toEqual({ argv: ['https://example.com/a?b=1'] })
    expect(ruleMatches(n, netQ('https://example.com/a?b=1'))).toBe(true)
    expect(ruleMatches(n, netQ('https://example.com/other'))).toBe(false)

    expect(exactRuleFor({ vendor: 'x', kind: 'other', tool: 't' })).toBeUndefined()
    expect(exactRuleFor(editQ(['/a', '/b']))).toBeUndefined()
  })
})

describe('AllowCache', () => {
  it('adds, matches and lists rules per run; duplicates merge nativeRules', () => {
    const c = new AllowCache([], posix)
    const r: AllowRule = { ...shellRule({ argvPrefix: ['npm', 'test'] }), nativeRules: ['Bash(npm test:*)'] }
    expect(c.add(r)).toBe(true)
    expect(c.add(r)).toBe(false)
    expect(c.add({ ...r, nativeRules: ['Bash(npm test:*)', 'PowerShell(npm test:*)'] })).toBe(true)
    expect(c.size).toBe(1)
    expect(c.list()[0]!.nativeRules).toEqual(['Bash(npm test:*)', 'PowerShell(npm test:*)'])
    expect(c.match(shellQ(['npm', 'test', '--', 'a']))).toEqual(c.list()[0])
    expect(c.match(shellQ(['npm', 'ci']))).toBeUndefined()
  })

  it('refuses invalid and generalizing rules', () => {
    const c = new AllowCache()
    expect(c.add(shellRule({ argvPrefix: ['npm'] }, 'exact'))).toBe(false)
    expect(c.add(netRule('*.example.com', 'exact'))).toBe(false)
    expect(c.add(shellRule({}, 'exact'))).toBe(false)
    expect(c.add(shellRule({ argv: [] }))).toBe(false)
    expect(c.add({ ...shellRule({ argv: ['x'] }), tool: '' })).toBe(false)
    expect(c.size).toBe(0)
  })

  it('collects native rules for Claude --allowedTools, deduped and per vendor', () => {
    const c = new AllowCache()
    c.add({
      vendor: 'claude',
      kind: 'shell',
      tool: 'Bash',
      match: { argvPrefix: ['npm', 'test'] },
      source: 'vendor-suggestion',
      nativeRules: ['Bash(npm test:*)'],
    })
    c.add({
      vendor: 'claude',
      kind: 'edit',
      tool: 'Edit',
      match: { pathGlob: '/repo/docs/**' },
      source: 'vendor-suggestion',
      nativeRules: ['Edit(/docs/**)', 'Bash(npm test:*)'],
    })
    c.add({ ...shellRule({ argv: ['ls'] }, 'exact'), nativeRules: ['codex-only'] })
    expect(c.nativeRules('claude')).toEqual(['Bash(npm test:*)', 'Edit(/docs/**)'])
    expect(c.nativeRules()).toHaveLength(3)
    expect(c.list('codex')).toHaveLength(1)
  })

  it('returns copies: callers cannot mutate the cache', () => {
    const c = new AllowCache([shellRule({ argv: ['ls'] }, 'exact')])
    c.list()[0]!.match.argv!.push('-la')
    expect(c.match(shellQ(['ls']))).toBeDefined()
    expect(c.match(shellQ(['ls', '-la']))).toBeUndefined()
  })

  it('match options override the cache defaults (pass cwd)', () => {
    const c = new AllowCache([editRule('src/**')], posix)
    expect(c.match(editQ('/repo/src/a.ts'))).toBeUndefined()
    expect(c.match(editQ('/repo/src/a.ts'), { cwd: '/repo' })).toBeDefined()
  })

  it('RunAllowCaches keeps one cache per run', () => {
    const runs = new RunAllowCaches()
    const a = runs.forRun('run-a', [shellRule({ argv: ['ls'] }, 'exact')])
    expect(runs.forRun('run-a')).toBe(a)
    expect(runs.forRun('run-b').size).toBe(0)
    runs.drop('run-a')
    expect(runs.forRun('run-a').size).toBe(0)
  })
})
