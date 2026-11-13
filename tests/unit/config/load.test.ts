import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import {
  DimFactoryConfigZ,
  FixConfigZ,
  PassConfigZ,
  ProfileZ,
  RunOverridesZ,
  validateSemantics,
} from '@shared/config-schema.ts'
import type { ConfigIssue } from '@shared/ipc.ts'
import { BUILTIN_DEFAULTS, BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES } from '@core/config/builtins.ts'
import {
  keyNodeAt,
  lineStarts,
  loadConfigFile,
  nodeAt,
  parseConfigText,
  positionAt,
  storeLastGood,
  toConfigLayer,
  validKeysAt,
} from '@core/config/load.ts'
import type { LoadResult } from '@core/config/load.ts'
import { projectFileKey } from '@core/config/paths.ts'
import { homePaths } from '@core/home.ts'

const FIXTURES = fileURLToPath(new URL('../../fixtures/config/', import.meta.url))
const fixture = async (name: string): Promise<string> => readFile(join(FIXTURES, `${name}.jsonc`), 'utf8')

/** `line:col-endLine:endCol code pointer` (suggestion appended) — compact and exact. */
const at = (i: ConfigIssue): string =>
  `${i.line}:${i.col}-${i.endLine}:${i.endCol} ${i.code} ${i.pointer}${i.suggestion !== undefined ? ` → ${i.suggestion}` : ''}`

const parse = (text: string, scope: 'user' | 'project' = 'user', file = 'dimfactory.json'): LoadResult =>
  parseConfigText(text, { file, scope })

describe('schema', () => {
  it.each(BUILTIN_PROFILE_NAMES)('built-in profile %s validates in a file', (name) => {
    expect(ProfileZ.safeParse(BUILTIN_PROFILES[name]).success).toBe(true)
    const r = parse(JSON.stringify({ profiles: { [name]: BUILTIN_PROFILES[name] }, profile: name }))
    expect(r.issues).toEqual([])
    expect(r.value?.profile).toBe(name)
  })

  it('layer 0 is a valid user file', () => {
    const { profiles: _p, ...rest } = BUILTIN_DEFAULTS
    expect(parse(JSON.stringify({ ...rest, profiles: BUILTIN_PROFILES })).issues).toEqual([])
  })

  it('.partial() stays strict at every level', () => {
    for (const z of [DimFactoryConfigZ, ProfileZ, PassConfigZ, FixConfigZ, RunOverridesZ]) {
      const r = z.safeParse({ bogus: 1 })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.code).toBe('unrecognized_keys')
    }
    const nested = DimFactoryConfigZ.safeParse({ isolation: { worktree: { bogus: 1 } } })
    expect(nested.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['isolation', 'worktree'],
    })
  })
})

describe('fixtures: exact file:line:col', () => {
  it('an unknown pass key → "did you mean promptTemplate"', async () => {
    const r = parse(await fixture('unknown-pass-key'), 'user', 'u.jsonc')
    expect(r.value).toBeUndefined()
    expect(r.issues.map(at)).toEqual([
      '6:7-6:22 unrecognized_keys /passes/review/promptTemplte → promptTemplate',
    ])
    expect(r.issues[0]).toMatchObject({
      file: 'u.jsonc',
      severity: 'error',
      message: 'Unknown key "promptTemplte" (did you mean "promptTemplate"?)',
    })
  })

  it('nested unknown keys (inside a profile and a record-free object)', async () => {
    const r = parse(await fixture('nested-unknown-key'))
    expect(r.issues.map(at)).toEqual([
      '4:22-4:29 unrecognized_keys /profiles/mine/implement/vendr → vendor',
      '9:7-9:15 unrecognized_keys /isolation/worktree/instal → install',
    ])
  })

  it('trailing commas are accepted; a later value error still maps exactly', async () => {
    const r = parse(await fixture('trailing-comma'))
    expect(r.issues.map(at)).toEqual(['7:16-7:22 invalid_type /timeouts/stallMs'])
    expect(r.raw).toEqual({
      gates: { afterPlan: false },
      verify: { runAfter: ['fix'] },
      timeouts: { stallMs: 'soon' },
    })
    const ok = parse('{\n  "gates": { "afterPlan": false, },\n  "verify": { "runAfter": ["fix",], },\n}\n')
    expect(ok.issues).toEqual([])
    expect(ok.value).toEqual({ gates: { afterPlan: false }, verify: { runAfter: ['fix'] } })
  })

  it('a syntax error (missing comma) points at the next token', async () => {
    const r = parse(await fixture('syntax-error'))
    expect(r.issues.map(at)).toEqual(['4:3-4:9 syntax '])
    expect(r.issues[0]?.message).toBe('Expected ","')
    expect(r.value).toBeUndefined()
    expect(r.raw).toBeUndefined()
  })

  it('a user-only key in a project file marks the key', async () => {
    const text = await fixture('user-only-in-project')
    const r = parse(text, 'project')
    expect(r.issues.map(at)).toEqual(['4:3-4:12 user-only-key /vendors'])
    expect(r.issues[0]?.message).toContain('can only be set in your user dimfactory.json')
    expect(r.value).toBeUndefined()
    // The same text is fine as a user file.
    expect(parse(text, 'user').issues).toEqual([])
  })

  it('mode "full" in a file marks the value, in a profile and in passes', async () => {
    const r = parse(await fixture('full-mode'))
    expect(r.issues.map(at)).toEqual([
      '4:50-4:56 full-in-file /profiles/yolo/implement/mode',
      '9:15-9:21 full-in-file /passes/fix/mode',
    ])
    expect(r.issues[0]?.message).toBe('"full" is only set by Auto mode; use "auto": true instead')
  })

  it('CRLF + BOM: columns as an editor shows them; eol and bom detected', async () => {
    const text = await fixture('crlf-bom')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const r = parse(text)
    expect(r.issues.map(at)).toEqual(['5:5-5:12 unrecognized_keys /ui/acent → accent'])
    expect(r.eol).toBe('\r\n')
    expect(r.bom).toBe(true)
    expect(r.text).toBe(text)
  })
})

describe('parseConfigText', () => {
  it('an empty or comment-only file is an empty config', () => {
    for (const text of ['', '  \n', '// nothing yet\n', '/* x */']) {
      const r = parse(text)
      expect(r.issues).toEqual([])
      expect(r.value).toEqual({})
    }
  })

  it('a non-object root is one error at the root', () => {
    const r = parse('[1, 2]')
    expect(r.issues.map(at)).toEqual(['1:1-1:7 invalid_type '])
    expect(r.issues[0]?.message).toBe('dimfactory.json must contain a JSON object')
  })

  it('a missing required key points at the enclosing object', () => {
    const text = '{\n  "verify": {\n    "commands": [\n      { "run": "pnpm test" }\n    ]\n  }\n}\n'
    const r = parse(text)
    expect(r.issues.map(at)).toEqual(['4:7-4:29 invalid_type /verify/commands/0/name'])
    expect(r.issues[0]?.message).toBe('Missing required key "name"')
  })

  it('an invalid record key marks the key with the inner reason', () => {
    const text = '{\n  "vendors": {\n    "claude": { "env": { "PATH": "x" } }\n  }\n}'
    const r = parse(text)
    expect(r.issues.map(at)).toEqual(['3:26-3:32 invalid_key /vendors/claude/env/PATH'])
    expect(r.issues[0]?.message).toBe('Invalid key "PATH": This variable is managed by Dim Factory')
  })

  it('an enum value error marks the value', () => {
    const r = parse('{ "isolation": { "mode": "sandbox" } }')
    expect(r.issues.map(at)).toEqual(['1:26-1:35 invalid_value /isolation/mode'])
  })

  it('an unknown key with no close match lists the allowed keys', () => {
    const r = parse('{ "passes": { "plan": { "temperature": 1 } } }')
    expect(r.issues[0]?.message).toBe(
      'Unknown key "temperature". Allowed keys: vendor, model, effort, mode, enabled, promptTemplate, extensions, ' +
        'clarify, clarifyQuestions, clarifyInAuto, clarifyPlain, research, researchLenses, explain, explainPlain',
    )
    expect(r.issues[0]?.suggestion).toBeUndefined()
    // `trust` lives only in trust.json.
    expect(parse('{ "trust": {} }').issues.map(at)).toEqual(['1:3-1:10 unrecognized_keys /trust'])
  })

  it('a user-only key in a project file is reported together with other errors', () => {
    const r = parse('{\n  "ui": { "theme": "dark" },\n  "auto": "yes"\n}', 'project')
    expect(r.issues.map(at)).toEqual(['2:3-2:7 user-only-key /ui', '3:11-3:16 invalid_type /auto'])
  })

  it('semantic rules map to the offending key or value', () => {
    const text = [
      '{',
      '  "timeouts": { "stallMs": 1300000 },',
      '  "passes": { "review": { "mode": "autoedit" } },',
      '  "vendors": { "claude": { "flagMap": { "--model": "model" } } }',
      '}',
    ].join('\n')
    const r = parseConfigText(text, {
      file: 'f',
      scope: 'user',
      managedFlags: { claude: ['--permission-mode'] },
    })
    expect(r.issues.map(at)).toEqual([
      '2:28-2:35 timeout-order /timeouts/stallMs',
      '3:35-3:45 readonly-pass /passes/review/mode',
      '4:41-4:50 flag-map-key /vendors/claude/flagMap/--model',
      '4:52-4:59 flag-map-value /vendors/claude/flagMap/--model',
    ])
  })

  it('inherited timeouts decide the order rule for a project file', () => {
    const text = '{ "timeouts": { "hardKillMs": 1000000 } }'
    expect(parseConfigText(text, { file: 'f', scope: 'project' }).issues).toEqual([])
    const r = parseConfigText(text, {
      file: 'f',
      scope: 'project',
      inheritedTimeouts: { stallMs: 1_100_000 },
    })
    expect(r.issues.map(at)).toEqual(['1:31-1:38 timeout-order /timeouts/hardKillMs'])
  })

  it('a duplicate key is a warning; the value stays usable', () => {
    const r = parse('{\n  "auto": false,\n  "auto": true\n}')
    expect(r.issues.map(at)).toEqual(['3:3-3:9 duplicate-key /auto'])
    expect(r.issues[0]?.severity).toBe('warning')
    expect(r.value).toEqual({ auto: true })
  })

  it('agrees with validateSemantics on a valid file', () => {
    const text = '{ "profile": "fast", "gates": { "beforeFix": true } }'
    const r = parse(text)
    expect(r.value).toEqual({ profile: 'fast', gates: { beforeFix: true } })
    expect(validateSemantics(r.value ?? {}, { scope: 'project' })).toEqual([])
  })

  it('records pointer → line, the sha256 of the exact text, eol and indent', () => {
    const text = '{\r\n\t"profile": "fast",\r\n\t"verify": {\r\n\t\t"runAfter": ["fix"]\r\n\t}\r\n}\r\n'
    const r = parse(text)
    expect(r.lines).toEqual({ '/profile': 2, '/verify': 3, '/verify/runAfter': 4, '/verify/runAfter/0': 4 })
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.eol).toBe('\r\n')
    expect(r.indent).toEqual({ insertSpaces: false, tabSize: 4 })
    expect(parse('{\n    "auto": true\n}').indent).toEqual({ insertSpaces: true, tabSize: 4 })
    expect(parse('{"auto": true}').indent).toEqual({ insertSpaces: true, tabSize: 2 })
  })

  it('toConfigLayer gives only valid, existing files', () => {
    expect(toConfigLayer(parse('{ "auto": true }'))).toMatchObject({
      value: { auto: true },
      file: 'dimfactory.json',
    })
    expect(toConfigLayer(parse('{ "auto": 1 }'))).toBeUndefined()
  })
})

describe('positions', () => {
  it('lineStarts handles LF, CRLF and a lone CR', () => {
    expect(lineStarts('a\nb\r\nc\rd')).toEqual([0, 2, 5, 7])
    const starts = lineStarts('ab\r\ncd')
    expect(positionAt(starts, 0)).toEqual({ line: 1, col: 1 })
    expect(positionAt(starts, 2)).toEqual({ line: 1, col: 3 })
    expect(positionAt(starts, 4)).toEqual({ line: 2, col: 1 })
    expect(positionAt(starts, 6)).toEqual({ line: 2, col: 3 })
  })

  it('validKeysAt walks objects, records, optionals and arrays', () => {
    expect(validKeysAt(['passes', 'review'])).toEqual([
      'vendor',
      'model',
      'effort',
      'mode',
      'enabled',
      'promptTemplate',
      'extensions',
      'acceptance',
    ])
    expect(validKeysAt(['passes', 'fix'])).toContain('reuseSession')
    expect(validKeysAt(['profiles', 'anything', 'plan'])).toContain('promptTemplate')
    expect(validKeysAt(['vendors', 'claude'])).toEqual([
      'path',
      'defaultModel',
      'defaultEffort',
      'extraArgs',
      'env',
      'flagMap',
    ])
    expect(validKeysAt(['verify', 'commands', 0])).toEqual(['name', 'run', 'cwd', 'timeoutMs', 'enabled'])
    expect(validKeysAt(['nope'])).toEqual([])
  })

  it('nodeAt / keyNodeAt return the value or key node, else the nearest existing node', () => {
    const root = parseTree('{ "a": { "b": 1 }, "c": [10, 20] }')
    if (root === undefined) throw new Error('no tree')
    expect(nodeAt(root, ['a', 'b'])).toMatchObject({ exact: true, node: { type: 'number', offset: 14 } })
    expect(keyNodeAt(root, ['a', 'b'])).toMatchObject({
      exact: true,
      node: { type: 'string', value: 'b', offset: 9 },
    })
    expect(keyNodeAt(root, ['a', 'zz'])).toMatchObject({ exact: false, node: { type: 'object', offset: 7 } })
    expect(nodeAt(root, ['c', '1'])).toMatchObject({ exact: true, node: { value: 20 } })
    expect(nodeAt(root, ['c', 5])).toMatchObject({ exact: false, node: { type: 'array' } })
  })
})

describe('vendors.<id>: a known vendor or a configured local preset', () => {
  it('a typo is an error with a suggestion (also for a case typo the key pattern rejects)', () => {
    const typo = parse('{ "vendors": { "claud": { "path": "C:/x/claude.exe" } } }')
    expect(typo.value).toBeUndefined()
    expect(typo.issues.map(at)).toEqual(['1:16-1:23 unknown-vendor /vendors/claud → claude'])
    expect(typo.issues[0]?.message).toBe('Unknown vendor "claud" (did you mean "claude"?)')
    const upper = parse('{ "vendors": { "Claude": { "path": "x" } } }')
    expect(upper.issues.map(at)).toEqual(['1:16-1:24 invalid_key /vendors/Claude → claude'])
    expect(upper.issues[0]?.message).toBe('Invalid key "Claude" (did you mean "claude"?)')
    const far = parse('{ "vendors": { "mystery": {} } }')
    expect(far.issues[0]?.message).toMatch(/^Unknown vendor "mystery"\. Vendors: claude, codex, /)
  })

  it('known vendors and local-<preset> ids of presets in the file are accepted', () => {
    const ok = parse(
      JSON.stringify({
        vendors: { claude: {}, codex: {}, 'local-qwen': { extraArgs: ['-v'] } },
        local: { presets: [{ id: 'qwen', label: 'Qwen', baseUrl: 'http://127.0.0.1:1234/v1', model: 'q' }] },
      }),
    )
    expect(ok.issues).toEqual([])
    expect(parse('{ "vendors": { "local-qwen": {} } }').issues.map((i) => i.code)).toEqual(['unknown-vendor'])
  })
})

describe('loadConfigFile', () => {
  const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'cfg-load-'))

  it('sha256 is of the file bytes (as backups and trust grants hash them), also for a file that is not UTF-8', async () => {
    const file = join(await tmp(), 'dimfactory.json')
    const bytes = Buffer.concat([
      Buffer.from('{\n // caf'),
      Buffer.from([0xe9]),
      Buffer.from('\n "auto": true\n}\n'),
    ])
    await writeFile(file, bytes)
    const r = await loadConfigFile(file, { scope: 'project' })
    expect(r.value).toEqual({ auto: true })
    expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it("a subfolder's own project file keeps its own last-good (backups/project/<folderKey>/<fileKey>/)", async () => {
    const paths = homePaths(await tmp())
    const root = await tmp()
    const a = join(root, 'packages', 'a', '.dimfactory', 'dimfactory.json')
    const b = join(root, 'packages', 'b', '.dimfactory', 'dimfactory.json')
    const top = join(root, '.dimfactory', 'dimfactory.json')
    for (const [f, text] of [
      [a, '{ "auto": false }'],
      [b, '{ "gates": { "beforeFix": true } }'],
      [top, '{}'],
    ] as const) {
      await mkdir(join(f, '..'), { recursive: true })
      await writeFile(f, text)
      await loadConfigFile(f, { scope: 'project', paths, folderKey: 'abcdef0123456789', scopeRoot: root })
    }
    const lg = (f: string): string =>
      join(paths.projectBackups('abcdef0123456789'), projectFileKey(root, f) ?? '', 'last-good.jsonc')
    expect(await readFile(lg(a), 'utf8')).toBe('{ "auto": false }')
    expect(await readFile(lg(b), 'utf8')).toBe('{ "gates": { "beforeFix": true } }')
    expect(lg(a)).not.toBe(lg(b))
    expect(await readFile(paths.lastGoodProjectConfig('abcdef0123456789'), 'utf8')).toBe('{}')
  })

  it('a missing file exists:false with no issues', async () => {
    const r = await loadConfigFile(join(await tmp(), 'dimfactory.json'), { scope: 'user' })
    expect(r).toMatchObject({ exists: false, issues: [], text: '', sha256: null })
    expect(toConfigLayer(r)).toBeUndefined()
  })

  it('a directory in place of the file is an unreadable issue', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'dimfactory.json'))
    const r = await loadConfigFile(join(dir, 'dimfactory.json'), { scope: 'user' })
    expect(r.exists).toBe(true)
    expect(r.issues.map((i) => i.code)).toEqual(['unreadable'])
  })

  it('stores last-good text on success only (user and project), and only when it changed', async () => {
    const paths = homePaths(await tmp())
    const user = join(await tmp(), 'dimfactory.json')
    const good = '{\n  // mine\n  "profile": "fast"\n}\n'
    await writeFile(user, good)
    const r = await loadConfigFile(user, { scope: 'user', paths })
    expect(r.value).toEqual({ profile: 'fast' })
    expect(r.issues).toEqual([])
    expect(await readFile(paths.lastGoodUserConfig, 'utf8')).toBe(good)

    await writeFile(user, '{ "profile": 42 }')
    const bad = await loadConfigFile(user, { scope: 'user', paths })
    expect(bad.issues[0]).toMatchObject({ file: user, code: 'invalid_type', pointer: '/profile' })
    expect(await readFile(paths.lastGoodUserConfig, 'utf8')).toBe(good)

    const project = join(await tmp(), 'dimfactory.json')
    await writeFile(project, '{ "auto": false }')
    await loadConfigFile(project, { scope: 'project', paths, folderKey: 'abcdef0123456789' })
    expect(await readFile(paths.lastGoodProjectConfig('abcdef0123456789'), 'utf8')).toBe('{ "auto": false }')
    // Without a folderKey there is nowhere to store it (and that is not an error).
    expect((await loadConfigFile(project, { scope: 'project', paths })).value).toEqual({ auto: false })
  })

  it('storeLastGood writes only when the text differs and never throws', async () => {
    const dir = await tmp()
    const target = join(dir, 'backups', 'last-good-user.jsonc')
    expect(await storeLastGood(target, 'a')).toBe(true)
    expect(await storeLastGood(target, 'a')).toBe(false)
    expect(await storeLastGood(target, 'b')).toBe(true)
    await mkdir(join(dir, 'blocked'))
    expect(await storeLastGood(join(dir, 'blocked'), 'x')).toBe(false)
  })
})
