// The dependency check (offline lockfile, optional registry through a fake fetcher; never the network), the verify
// "Cannot find module" rule in both directions, the possible-hallucination flag on verify findings, the `(grounding)`
// marker, the AI judge's prompt and answer, and one whole run of the checks over a fake I/O.
import { describe, expect, it } from 'vitest'
import {
  addedDependencies,
  cargoDeps,
  httpRegistryFetcher,
  missingFromRegistry,
  notInstalled,
  packageJsonDeps,
  pyprojectDeps,
  registryUrl,
  requirementsDeps,
} from '@core/grounding/packages.ts'
import type { RegistryFetcher } from '@core/grounding/packages.ts'
import { cheapestModel, judgePrompt, parseJudgeAnswer } from '@core/grounding/judge.ts'
import { runGrounding, tsconfigAliases } from '@core/grounding/run.ts'
import type { GroundingIo } from '@core/grounding/run.ts'
import { newGroundingTrack } from '@core/grounding/evidence.ts'
import { classifyEnvFailure } from '@core/verify/classify.ts'
import { verifyFindings } from '@core/verify/render.ts'
import { parseFindings } from '@core/findings/parse.ts'
import type { VerifyCommandResult } from '@shared/verify.ts'
import type { PriceEntry } from '@shared/catalog.ts'

describe('manifests', () => {
  it('reads each kind of manifest', () => {
    expect([
      ...packageJsonDeps(
        JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '2', ws: 'workspace:*' } }),
      ),
    ]).toEqual(['a', 'b'])
    expect([...requirementsDeps('requests>=2\n# c\n-r other.txt\nPyYAML==6\n')]).toEqual([
      'requests',
      'pyyaml',
    ])
    expect([
      ...pyprojectDeps(
        '[project]\ndependencies = [\n  "Flask>=2",\n  "httpx",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nrich = "*"\n',
      ),
    ]).toEqual(['flask', 'httpx', 'rich'])
    expect([
      ...cargoDeps(
        '[package]\nname = "x"\n[dependencies]\nserde = "1"\ntokio-util = { version = "0.7" }\n[dev-dependencies.insta]\nversion = "1"\n',
      ),
    ]).toEqual(['serde', 'tokio_util', 'insta'])
  })

  it('names a manifest gained between the base and the end', () => {
    const before = JSON.stringify({ dependencies: { react: '18' } })
    const after = JSON.stringify({ dependencies: { react: '18', 'left-padx': '1' } })
    expect(addedDependencies('web/package.json', before, after)).toEqual([
      { manifest: 'web/package.json', ecosystem: 'npm', name: 'left-padx' },
    ])
    expect(addedDependencies('README.md', null, 'x')).toEqual([])
  })
})

describe('check 6 offline: no lockfile entry', () => {
  const dep = (manifest: string, ecosystem: 'npm' | 'pip' | 'cargo' | 'go', name: string) => ({
    manifest,
    ecosystem,
    name,
  })
  it.each([
    // npm: locked → installed; not locked and not in node_modules → not installed.
    [dep('package.json', 'npm', 'a'), new Map([['package-lock.json', new Set(['a'])]]), false, false],
    [dep('package.json', 'npm', 'b'), new Map([['package-lock.json', new Set(['a'])]]), false, true],
    [dep('package.json', 'npm', 'b'), new Map([['package-lock.json', new Set(['a'])]]), true, false],
    [dep('package.json', 'npm', 'c'), new Map(), false, true],
    // Another folder's lockfile does not count.
    [dep('web/package.json', 'npm', 'a'), new Map([['package-lock.json', new Set(['a'])]]), false, true],
    [dep('Cargo.toml', 'cargo', 'serde'), new Map([['Cargo.lock', new Set(['tokio'])]]), false, true],
    // pip with no lockfile: nothing pins it, not judged.
    [dep('requirements.txt', 'pip', 'x'), new Map(), false, false],
  ])('%j', (d, locks, inNodeModules, missing) => {
    expect(notInstalled([d], locks, () => inNodeModules)).toEqual(missing ? [d] : [])
  })
})

describe('the registry check (opt-in): a fake fetcher, never the network', () => {
  it('asks each name once and returns the ones the registry does not know', async () => {
    const asked: string[] = []
    const fake: RegistryFetcher = (eco, name) => {
      asked.push(`${eco}:${name}`)
      return Promise.resolve(name === 'made-up' ? 'missing' : name === 'flaky' ? 'unknown' : 'exists')
    }
    const deps = [
      { manifest: 'package.json', ecosystem: 'npm' as const, name: 'react' },
      { manifest: 'package.json', ecosystem: 'npm' as const, name: 'made-up' },
      { manifest: 'web/package.json', ecosystem: 'npm' as const, name: 'made-up' },
      { manifest: 'requirements.txt', ecosystem: 'pip' as const, name: 'flaky' },
    ]
    expect(await missingFromRegistry(deps, fake)).toEqual([deps[1]])
    expect(asked).toEqual(['npm:react', 'npm:made-up', 'pip:flaky'])
  })

  it('the default fetcher reads 404 as missing, 2xx as there, anything else as unknown (fake fetch)', async () => {
    const urls: string[] = []
    const fetchImpl = ((url: string) => {
      urls.push(url)
      if (url.includes('made-up')) return Promise.resolve(new Response('', { status: 404 }))
      if (url.includes('down')) return Promise.reject(new Error('offline'))
      if (url.includes('busy')) return Promise.resolve(new Response('', { status: 503 }))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const f = httpRegistryFetcher(fetchImpl)
    expect(await f('npm', 'made-up')).toBe('missing')
    expect(await f('pip', 'requests')).toBe('exists')
    expect(await f('cargo', 'down')).toBe('unknown')
    expect(await f('npm', 'busy')).toBe('unknown')
    expect(await f('go', 'github.com/x/y')).toBe('unknown')
    expect(urls).toEqual([
      'https://registry.npmjs.org/made-up',
      'https://pypi.org/pypi/requests/json',
      'https://crates.io/api/v1/crates/down',
      'https://registry.npmjs.org/busy',
    ])
    expect(registryUrl('npm', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope%2Fpkg')
  })
})

describe('verify: a missing module the run itself imports is the code’s failure (both directions)', () => {
  const base = { exitCode: 1, cwd: 'C:\\proj', argv0: 'node', exists: () => false }
  const node = ["Error: Cannot find module 'left-padx'", 'Require stack:', '- C:\\proj\\src\\a.js']
  const py = ['Traceback (most recent call last):', "ModuleNotFoundError: No module named 'fakelib'"]

  it('not introduced by the run: still an environment problem (install the dependencies)', () => {
    expect(classifyEnvFailure({ ...base, tail: node })).toMatch(/A package is missing: left-padx/)
    expect(classifyEnvFailure({ ...base, tail: node, introduced: () => false })).toMatch(
      /A package is missing/,
    )
    expect(classifyEnvFailure({ ...base, tail: py, introduced: (n) => n === 'other' })).toMatch(
      /A Python module is missing: fakelib/,
    )
  })

  it("introduced by the run's own added lines: a failure (a finding), never hidden as env", () => {
    expect(classifyEnvFailure({ ...base, tail: node, introduced: (n) => n === 'left-padx' })).toBeNull()
    expect(classifyEnvFailure({ ...base, tail: py, introduced: (n) => n === 'fakelib' })).toBeNull()
    // A scoped package's subpath is its package.
    const scoped = ["Error: Cannot find module '@acme/ghost/sub'"]
    expect(classifyEnvFailure({ ...base, tail: scoped, introduced: (n) => n === '@acme/ghost' })).toBeNull()
  })

  it('its finding is flagged possible-hallucination; an ordinary failure is not', () => {
    const r = (excerpt: string): VerifyCommandResult => ({
      name: 'test',
      argv: ['npm', 'test'],
      status: 'fail',
      exitCode: 1,
      durationMs: 10,
      excerpt,
      logPath: '',
    })
    expect(verifyFindings([r(node.join('\n'))])[0]?.flags).toEqual(['possible-hallucination'])
    expect(verifyFindings([r('FAIL a.test.ts\nexpected 1 to be 2')])[0]?.flags).toEqual([])
  })
})

describe('the (grounding) marker in Review and Critic', () => {
  it('flags the finding and cuts the marker from its title', () => {
    const out = parseFindings(
      '- [must] (grounding) `src/a.ts:3`: calls `fs.readJsonSync`, which does not exist.\n- [should] `b.ts:1`: style',
      'review',
    )
    expect(out.findings.map((f) => [f.severity, f.title, f.flags])).toEqual([
      ['must', '`src/a.ts:3`: calls `fs.readJsonSync`, which does not exist.', ['grounding']],
      ['should', '`b.ts:1`: style', []],
    ])
    expect(parseFindings('- **[must]** (Grounding): made-up API', 'critic').findings[0]?.flags).toEqual([
      'grounding',
    ])
  })
})

describe('the AI judge (off by default)', () => {
  it('picks the cheapest priced model of the vendor', () => {
    const e = (vendor: string, model: string, i: number, o: number, deprecated = false): PriceEntry => ({
      vendor,
      model,
      aliases: [],
      inputPerMTok: i,
      outputPerMTok: o,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
      sourceUrl: '',
      fetchedAt: 0,
      confidence: 'unverified',
      ...(deprecated ? { deprecated: true } : {}),
    })
    const entries = [
      e('claude', 'opus', 15, 75),
      e('claude', 'haiku', 1, 5),
      e('claude', 'old', 0.1, 0.1, true),
      e('codex', 'mini', 0.1, 0.4),
    ]
    expect(cheapestModel(entries, 'claude')).toBe('haiku')
    expect(cheapestModel(entries, 'gemini')).toBeNull()
  })

  it('sends claims, diff numbers and a tool summary only; reads its answer as AI-judged [should]s', () => {
    const prompt = judgePrompt({
      step: 'implement',
      finalText: 'All tests pass.\nUpdated `src/a.ts`.',
      diff: { files: 1, added: 3, deleted: 1, paths: ['src/a.ts'] },
      evidence: { ...newGroundingTrack(), shells: 2, tests: 0 },
      verify: [{ name: 'test', status: 'fail' }],
    })
    expect(prompt).toContain('- All tests pass.')
    expect(prompt).toContain('2 shell commands (0 ran tests')
    expect(prompt).toContain('Verify after it: test: fail.')
    const out = parseJudgeAnswer(
      'UNSUPPORTED: the tests were never run\nnoise\n- UNSUPPORTED: x',
      'implement',
    )
    expect(out.map((f) => [f.severity, f.title, f.flags])).toEqual([
      ['should', 'AI-judged: the tests were never run', ['ai-judged']],
      ['should', 'AI-judged: x', ['ai-judged']],
    ])
    expect(parseJudgeAnswer('ALL SUPPORTED', 'implement')).toEqual([])
  })
})

describe('one run of the checks over a fake I/O', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,2 @@',
    "+import pad from 'left-padx'",
    "+import { u } from './util'",
    'diff --git a/package.json b/package.json',
    '+++ b/package.json',
    '@@ -1 +1 @@',
    '+{"dependencies":{"react":"18","left-padx":"1"}}',
  ].join('\n')
  const at: Record<string, Record<string, string>> = {
    base: { 'package.json': '{"dependencies":{"react":"18"}}' },
    end: {
      'package.json': '{"dependencies":{"react":"18","left-padx":"1"}}',
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/react': { version: '18.0.0' } },
      }),
      'tsconfig.json': '{ // comment\n "compilerOptions": { "paths": { "@shared/*": ["src/shared/*"] }, }, }',
    },
  }
  const io: GroundingIo = {
    patch: () => Promise.resolve(patch),
    changedPaths: () => Promise.resolve(['src/a.ts', 'package.json']),
    files: () =>
      Promise.resolve(['src/a.ts', 'src/util.ts', 'package.json', 'package-lock.json', 'tsconfig.json']),
    fileAt: (commit, path) => Promise.resolve(at[commit]?.[path] ?? null),
    onDisk: () => false,
  }
  const req = {
    step: 'implement' as const,
    from: 'base',
    to: 'end',
    finalText: 'Updated `src/a.ts` and `src/b.ts`. All tests pass.',
    evidence: newGroundingTrack(),
    registryCheck: true,
  }

  it('finds the ghost path, the unrun tests and the package the registry does not know', async () => {
    const registry: RegistryFetcher = (_e, name) =>
      Promise.resolve(name === 'left-padx' ? 'missing' : 'exists')
    const out = await runGrounding(io, req, { registry })
    expect(out.findings.map((f) => `${f.severity} ${f.title}`)).toEqual([
      'must The AI said it changed `src/b.ts`, but there is no such file.',
      'must The AI said it ran the tests, but none ran.',
      'must `left-padx` is not on npm: the AI may have made up this package.',
    ])
    // The import resolves to the manifest the pass changed: the dependency checks speak for it.
  })

  it('without the registry check: the offline [should] only; a judge that fails is a note', async () => {
    const out = await runGrounding(
      io,
      { ...req, registryCheck: false, judge: { vendor: 'claude' } },
      { judge: () => Promise.reject(new Error('No AI vendor is ready to check the claims.')) },
    )
    expect(out.findings.map((f) => f.title)).toContain(
      '`left-padx` was added to package.json but is not installed (no lockfile entry).',
    )
    expect(out.notes).toEqual([
      'The AI judge could not check the claims: No AI vendor is ready to check the claims.',
    ])
  })

  it('the judge adds AI-judged findings', async () => {
    const out = await runGrounding(
      io,
      { ...req, judge: { vendor: 'claude' } },
      {
        judge: (vendor, prompt) => {
          expect(vendor).toBe('claude')
          expect(prompt).toContain('src/a.ts')
          return Promise.resolve('UNSUPPORTED: no test ran')
        },
      },
    )
    expect(out.findings.filter((f) => f.flags?.includes('ai-judged')).map((f) => f.title)).toEqual([
      'AI-judged: no test ran',
    ])
  })

  it('reads tsconfig paths with comments and trailing commas', () => {
    expect(tsconfigAliases(at['end']!['tsconfig.json']!)).toEqual(['@shared/'])
  })
})
