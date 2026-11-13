import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  configLocation,
  listBackups,
  readConfigText,
  readLastGood,
  replaceConfigText,
  restoreBackup,
} from '../../../src/core/config/backups.ts'
import {
  applyConfigEdits,
  commitConfigWrite,
  detectFormat,
  patchConfig,
  planConfigPatch,
  planOverridesSave,
  saveOverrides,
  undo,
  validateConfigText,
} from '../../../src/core/config/save.ts'
import type { ConfigIssue } from '../../../src/shared/ipc.ts'

const BOM = String.fromCharCode(0xfeff)
const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const userFile = (): string => join(home(), 'dimfactory.json')

async function project(): Promise<{
  folder: string
  file: string
  folderScope: { scopeRoot: string; folderKey: string }
}> {
  const folder = join(home(), 'work', 'proj')
  await mkdir(folder, { recursive: true })
  return {
    folder,
    file: join(folder, '.dimfactory', 'dimfactory.json'),
    folderScope: { scopeRoot: folder, folderKey: '0123456789abcdef' },
  }
}

/** Resolver stub: what lower layers give without the target layer's key (balanced builtins). */
const BUILTIN_INHERITED: Record<string, unknown> = {
  '/profile': 'balanced',
  '/auto': false,
  '/gates/afterPlan': true,
  '/passes/review/model': 'sonnet',
  '/passes/review/mode': 'readonly',
  '/passes/review/vendor': 'claude',
  '/passes/critic/model': 'opus',
  '/passes/implement/vendor': 'codex',
}
const inherited = (ptr: string): unknown => BUILTIN_INHERITED[ptr]

async function caught(p: Promise<unknown>): Promise<DimFactoryError> {
  try {
    await p
  } catch (err) {
    if (err instanceof DimFactoryError) return err
    throw err
  }
  throw new Error('expected a DimFactoryError')
}

const CRLF_FILE = [
  '{',
  '    // My settings',
  '    "profile": "balanced", // the default profile',
  '    "passes": {',
  '        "review": {',
  '            "model": "opus", // reviewer',
  '            "mode": "readonly"',
  '        }',
  '    },',
  '    /* timeouts below */',
  '    "timeouts": { "stallMs": 600000 }',
  '}',
  '',
].join('\r\n')

describe('saveOverrides: minimal diff', () => {
  it('prunes overrides equal to the inherited value, removes emptied objects, keeps comments and CRLF', async () => {
    await writeFile(userFile(), CRLF_FILE)
    const out = await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'row',
      pass: 'review',
      overrides: { passes: { review: { model: 'sonnet', mode: 'readonly' } } },
      resolveInherited: inherited,
    })
    const text = await readFile(userFile(), 'utf8')
    expect(text).toBe(
      [
        '{',
        '    // My settings',
        '    "profile": "balanced", // the default profile',
        '    /* timeouts below */',
        '    "timeouts": { "stallMs": 600000 }',
        '}',
        '',
      ].join('\r\n'),
    )
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(out.changed).toBe(true)
    expect(out.diff).toContain('-        "review": {')
    expect(out.diff).toMatch(/^--- a\/.*dimfactory\.json$/m)
    expect(out.undoToken).not.toBeNull()
  })

  it('plans without writing ("view diff"); one commit writes the previewed text', async () => {
    await writeFile(userFile(), CRLF_FILE)
    const plan = await planOverridesSave({
      home: home(),
      scope: 'user',
      mode: 'row',
      pass: 'critic',
      overrides: { passes: { critic: { enabled: false } } },
      resolveInherited: inherited,
    })
    expect(plan.changed).toBe(true)
    expect(plan.diff).toContain('+        "critic": {\n+            "enabled": false\n')
    expect(await readFile(userFile(), 'utf8')).toBe(CRLF_FILE)
    const out = await commitConfigWrite(plan)
    expect(out.writes[0]?.reapplied).toBe(false)
    expect(await readFile(userFile(), 'utf8')).toBe(plan.targets[0]?.newText)
    expect(parseJsonc(await readFile(userFile(), 'utf8'))).toMatchObject({
      passes: { review: { model: 'opus' }, critic: { enabled: false } },
    })
  })

  it('writes only non-redundant keys, creating .dimfactory/ with 2-space LF formatting', async () => {
    const p = await project()
    const out = await saveOverrides({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      mode: 'projectDefault',
      overrides: { profile: 'fast', passes: { critic: { model: 'opus' } }, gates: { afterPlan: false } },
      resolveInherited: inherited,
    })
    expect(await readFile(p.file, 'utf8')).toBe(
      '{\n  "profile": "fast",\n  "gates": {\n    "afterPlan": false\n  }\n}\n',
    )
    expect(out.path).toBe(p.file)
    expect(out.writes[0]?.created).toBe(true)
    expect(out.backupId).toBeNull()
    expect(out.diff.startsWith('--- /dev/null\n')).toBe(true)
  })

  it('leaves an absent file absent when every override is redundant', async () => {
    const p = await project()
    const out = await saveOverrides({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      mode: 'row',
      pass: 'review',
      overrides: { passes: { review: { model: 'sonnet' } } },
      resolveInherited: inherited,
    })
    expect(out.changed).toBe(false)
    expect(out.undoToken).toBeNull()
    expect(await readdir(p.folder)).toEqual([])
  })

  it('a row save writes only that pass', async () => {
    await writeFile(userFile(), '{\n  "profile": "balanced"\n}\n')
    await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'row',
      pass: 'review',
      overrides: { profile: 'fast', passes: { review: { model: 'opus' }, critic: { model: 'sonnet' } } },
      resolveInherited: inherited,
    })
    expect(parseJsonc(await readFile(userFile(), 'utf8'))).toEqual({
      profile: 'balanced',
      passes: { review: { model: 'opus' } },
    })
  })

  it('keeps key order, edits values in place and appends new keys after a trailing comment', async () => {
    await writeFile(userFile(), '{\n  "profile": "fast", // mine\n  "auto": false // never\n}\n')
    await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'projectDefault',
      overrides: { profile: 'thorough', gates: { beforeFix: true } },
      resolveInherited: inherited,
    })
    expect(await readFile(userFile(), 'utf8')).toBe(
      '{\n  "profile": "thorough", // mine\n  "auto": false, // never\n  "gates": {\n    "beforeFix": true\n  }\n}\n',
    )
  })

  it('removing a middle key keeps the neighbours’ trailing comments where they were', async () => {
    await writeFile(
      userFile(),
      '{\n  "profile": "fast", // a\n  "auto": false, // b\n  "ask": { "denyPauses": true } // c\n}\n',
    )
    await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'projectDefault',
      overrides: { auto: false },
      resolveInherited: inherited,
    })
    expect(await readFile(userFile(), 'utf8')).toBe(
      '{\n  "profile": "fast", // a\n  "ask": { "denyPauses": true } // c\n}\n',
    )
  })

  it('keeps tabs and trailing commas', async () => {
    await writeFile(userFile(), '{\n\t"profile": "fast",\n\t"gates": {\n\t\t"afterPlan": false,\n\t},\n}\n')
    await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'projectDefault',
      overrides: { gates: { beforeFix: true } },
      resolveInherited: inherited,
    })
    expect(await readFile(userFile(), 'utf8')).toBe(
      '{\n\t"profile": "fast",\n\t"gates": {\n\t\t"afterPlan": false,\n\t\t"beforeFix": true,\n\t},\n}\n',
    )
  })

  it('refuses invalid run overrides', async () => {
    const err = await caught(
      saveOverrides({
        home: home(),
        scope: 'user',
        mode: 'projectDefault',
        overrides: { ui: { theme: 'dark' } } as never,
        resolveInherited: inherited,
      }),
    )
    expect(err.code).toBe('VALIDATION')
  })
})

describe('undo', () => {
  it('restores the previous bytes, and removes a file the save created', async () => {
    await writeFile(userFile(), CRLF_FILE)
    const out = await saveOverrides({
      home: home(),
      scope: 'user',
      mode: 'projectDefault',
      overrides: { profile: 'fast' },
      resolveInherited: inherited,
    })
    await undo(out.undoToken ?? '', { home: home() })
    expect(await readFile(userFile(), 'utf8')).toBe(CRLF_FILE)

    const p = await project()
    const created = await patchConfig({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: [{ op: 'replace', path: '/profile', value: 'fast' }],
    })
    const back = await undo(created.undoToken ?? '', { home: home(), folderScope: p.folderScope })
    expect(back.writes[0]?.removed).toBe(true)
    expect(await readdir(join(p.folder, '.dimfactory'))).toEqual([])
  })
})

describe('concurrent edits', () => {
  it('re-applies the path-based edits onto a file changed after the plan', async () => {
    await writeFile(userFile(), '{\n  "profile": "balanced"\n}\n')
    const plan = await planConfigPatch({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/passes/review/model', value: 'opus' }],
    })
    expect(plan.diff).toContain('+  "passes": {')
    await writeFile(userFile(), '{\n  // edited elsewhere\n  "profile": "fast",\n  "auto": false\n}\n')
    const out = await commitConfigWrite(plan)
    expect(out.writes[0]?.reapplied).toBe(true)
    expect(await readFile(userFile(), 'utf8')).toBe(
      '{\n  // edited elsewhere\n  "profile": "fast",\n  "auto": false,\n  "passes": {\n    "review": {\n      "model": "opus"\n    }\n  }\n}\n',
    )
  })

  it('refuses (CONFLICT, nothing written) when the re-applied result is invalid', async () => {
    await writeFile(userFile(), '{}\n')
    const plan = await planConfigPatch({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/timeouts/stallMs', value: 200_000 }],
    })
    const external = '{ "timeouts": { "hardKillMs": 150000 } }\n'
    await writeFile(userFile(), external)
    const err = await caught(commitConfigWrite(plan))
    expect(err.code).toBe('CONFLICT')
    expect((err.details as ConfigIssue[])[0]?.code).toBe('timeout-order')
    expect(await readFile(userFile(), 'utf8')).toBe(external)
    expect(await listBackups(await configLocation('user', undefined, { home: home() }))).toEqual([])
  })
})

describe('validation', () => {
  it('refuses a result that breaks a semantic rule, writing nothing', async () => {
    await writeFile(userFile(), '{}\n')
    const err = await caught(
      patchConfig({
        home: home(),
        scope: 'user',
        allowlist: false,
        ops: [{ op: 'add', path: '/passes/review/mode', value: 'autoedit' }],
      }),
    )
    expect(err.code).toBe('VALIDATION')
    const issues = err.details as ConfigIssue[]
    expect(issues[0]).toMatchObject({ code: 'readonly-pass', pointer: '/passes/review/mode', line: 4 })
    expect(await readFile(userFile(), 'utf8')).toBe('{}\n')
  })

  it('reports an unknown key with its pointer and line:col', async () => {
    await writeFile(userFile(), '{\n  "passes": {\n    "review": {}\n  }\n}\n')
    const err = await caught(
      patchConfig({
        home: home(),
        scope: 'user',
        allowlist: false,
        ops: [{ op: 'add', path: '/passes/review/promptTemplte', value: 'x' }],
      }),
    )
    expect((err.details as ConfigIssue[])[0]).toMatchObject({
      code: 'unknown-key',
      pointer: '/passes/review/promptTemplte',
      line: 4,
      col: 7,
    })
  })

  it('refuses to edit a file with syntax errors', async () => {
    await writeFile(userFile(), '{ "profile": "fast" ')
    const err = await caught(
      patchConfig({
        home: home(),
        scope: 'user',
        ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
      }),
    )
    expect(err.code).toBe('VALIDATION')
    expect((err.details as ConfigIssue[])[0]?.code).toBe('syntax')
  })

  it('refuses mode "full" and user-only keys in a project file', async () => {
    const p = await project()
    const full = await caught(
      patchConfig({
        home: home(),
        folderScope: p.folderScope,
        scope: 'project',
        folder: p.folder,
        allowlist: false,
        ops: [{ op: 'add', path: '/passes/implement/mode', value: 'full' }],
      }),
    )
    expect((full.details as ConfigIssue[])[0]?.code).toBe('full-in-file')
    expect(
      validateConfigText('{ "ui": { "theme": "dark" } }', { scope: 'project', file: 'p' })[0],
    ).toMatchObject({
      code: 'user-only-key',
      line: 1,
      col: 9,
    })
  })

  it('a failed test op refuses the patch (CONFLICT)', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    const err = await caught(
      patchConfig({
        home: home(),
        scope: 'user',
        ops: [
          { op: 'test', path: '/profile', value: 'balanced' },
          { op: 'replace', path: '/profile', value: 'thorough' },
        ],
      }),
    )
    expect(err.code).toBe('CONFLICT')
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "fast" }\n')
  })
})

describe('backups and last-good', () => {
  it('backs up every write, keeps the newest 10 and stores last-good', async () => {
    await writeFile(userFile(), '{}\n')
    const loc = await configLocation('user', undefined, { home: home() })
    let previous = ''
    for (let i = 0; i < 12; i++) {
      previous = await readFile(userFile(), 'utf8')
      await patchConfig({
        home: home(),
        scope: 'user',
        ops: [{ op: 'replace', path: '/timeouts/askMs', value: 60_000 + i * 1000 }],
      })
    }
    const backups = await listBackups(loc)
    const writes = backups.filter((b) => b.kind === 'write')
    expect(writes).toHaveLength(10)
    expect([...writes].sort((a, b) => b.id.localeCompare(a.id))).toEqual(writes)
    const newest = await readFile(join(loc.backupDir, `dimfactory.${writes[0]?.id ?? ''}.jsonc`), 'utf8')
    expect(newest).toBe(previous)
    expect(await readLastGood(loc)).toBe(await readFile(userFile(), 'utf8'))
    expect(backups.at(-1)?.kind).toBe('last-good')
  })

  it('project backups live under backups/project/<folderKey>/', async () => {
    const p = await project()
    await mkdir(join(p.folder, '.dimfactory'))
    await writeFile(p.file, '{ "profile": "fast" }\n')
    const out = await patchConfig({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    const dir = join(home(), 'backups', 'project', p.folderScope.folderKey)
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining([`dimfactory.${out.backupId ?? ''}.jsonc`, 'last-good.jsonc']),
    )
  })
})

describe('user-only paths', () => {
  it('are forced to the user file; the rest of a project patch stays in the project', async () => {
    const p = await project()
    const out = await patchConfig({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: [
        { op: 'add', path: '/vendors/claude/extraArgs', value: ['--verbose'] },
        { op: 'replace', path: '/passes/review/model', value: 'opus' },
      ],
    })
    expect(out.forcedToUser).toEqual([{ op: 'add', path: '/vendors/claude/extraArgs', value: ['--verbose'] }])
    expect(out.writes.map((w) => w.scope)).toEqual(['user', 'project'])
    expect(out.path).toBe(p.file)
    expect(parseJsonc(await readFile(userFile(), 'utf8'))).toEqual({
      vendors: { claude: { extraArgs: ['--verbose'] } },
    })
    expect(parseJsonc(await readFile(p.file, 'utf8'))).toEqual({ passes: { review: { model: 'opus' } } })

    // One undo token covers both files.
    await undo(out.undoToken ?? '', { home: home(), folderScope: p.folderScope })
    expect(await readdir(home())).not.toContain('dimfactory.json')
  })
})

describe('applyConfigEdits / detectFormat', () => {
  it('detects indent and EOL, defaulting to 2-space LF', () => {
    expect(detectFormat('{\r\n    "a": 1\r\n}\r\n')).toEqual({ unit: '    ', eol: '\r\n' })
    expect(detectFormat('{\n\t"a": 1\n}')).toEqual({ unit: '\t', eol: '\n' })
    expect(detectFormat('{}')).toEqual({ unit: '  ', eol: '\n' })
  })

  it('handles single-line objects, arrays and BOMs', () => {
    expect(applyConfigEdits('{ "a": { "x": 1 } }', [{ op: 'add', path: ['a', 'y'], value: [1, 2] }])).toBe(
      '{ "a": { "x": 1, "y": [1, 2] } }',
    )
    expect(applyConfigEdits('{ "a": 1, "b": 2 }', [{ op: 'remove', path: ['b'] }])).toBe('{ "a": 1 }')
    expect(applyConfigEdits('{ "a": 1, "b": 2 }', [{ op: 'remove', path: ['a'] }])).toBe('{ "b": 2 }')
    expect(applyConfigEdits('{ "l": ["x"] }', [{ op: 'add', path: ['l', '-'], value: 'y' }])).toBe(
      '{ "l": ["x", "y"] }',
    )
    expect(applyConfigEdits(BOM + '{}', [{ op: 'add', path: ['a'], value: 1 }])).toBe(BOM + '{\n  "a": 1\n}')
  })

  it('a file of only comments (the loader reads {}) keeps them and gets the object after them', () => {
    expect(applyConfigEdits('// my settings\n', [{ op: 'add', path: ['profile'], value: 'fast' }])).toBe(
      '// my settings\n{\n  "profile": "fast"\n}\n',
    )
    expect(applyConfigEdits('// a\r\n/* b */', [{ op: 'add', path: ['auto'], value: false }])).toBe(
      '// a\r\n/* b */\r\n{\r\n  "auto": false\r\n}\r\n',
    )
    expect(validateConfigText('// nothing yet\n', { scope: 'user', file: 'u' })).toEqual([])
    expect(validateConfigText('/* unterminated', { scope: 'user', file: 'u' })[0]?.code).toBe('syntax')
  })

  it('first launch can write its profile into a comment-only user file', async () => {
    await writeFile(userFile(), '// my settings\n')
    const out = await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'add', path: '/profile', value: 'fast' }],
    })
    expect(out.changed).toBe(true)
    expect(await readFile(userFile(), 'utf8')).toBe('// my settings\n{\n  "profile": "fast"\n}\n')
  })

  it('removing a key that is duplicated removes every copy (an earlier value never comes back)', () => {
    const dup = '{\n  "profile": "a",\n  "auto": false,\n  "profile": "b"\n}'
    expect(applyConfigEdits(dup, [{ op: 'remove', path: ['profile'] }])).toBe('{\n  "auto": false\n}')
    // Setting it keeps the last copy (the one that counts) and drops the earlier ones.
    expect(applyConfigEdits(dup, [{ op: 'replace', path: ['profile'], value: 'c' }])).toBe(
      '{\n  "auto": false,\n  "profile": "c"\n}',
    )
    const nested = '{ "gates": { "afterPlan": true, "afterPlan": false } }'
    expect(applyConfigEdits(nested, [{ op: 'remove', path: ['gates', 'afterPlan'] }])).toBe('{ }')
  })

  it('an emptied object that holds a comment is kept with its comment', () => {
    const text = '{\n  "passes": {\n    // keep me\n    "review": { "model": "x" }\n  }\n}'
    expect(applyConfigEdits(text, [{ op: 'remove', path: ['passes', 'review', 'model'] }])).toBe(
      '{\n  "passes": {\n    // keep me\n  }\n}',
    )
    const inline = '{ "gates": { /* team */ "afterPlan": false } }'
    expect(applyConfigEdits(inline, [{ op: 'remove', path: ['gates', 'afterPlan'] }])).toBe(
      '{ "gates": { /* team */ } }',
    )
    // Without a comment it is pruned.
    expect(
      applyConfigEdits('{\n  "gates": { "afterPlan": false }\n}', [
        { op: 'remove', path: ['gates', 'afterPlan'] },
      ]),
    ).toBe('{\n}')
  })
})

describe('files that are not UTF-8', () => {
  const latin1 = Buffer.concat([
    Buffer.from('{\n  // caf', 'utf8'),
    Buffer.from([0xe9]),
    Buffer.from('\n  "profile": "fast"\n}\n', 'utf8'),
  ])

  it('are never edited (VALIDATION); the bytes stay as they were', async () => {
    await writeFile(userFile(), latin1)
    const err = await caught(
      patchConfig({
        home: home(),
        scope: 'user',
        ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
      }),
    )
    expect(err.code).toBe('VALIDATION')
    expect((err.details as ConfigIssue[])[0]?.code).toBe('not-utf8')
    expect((await readFile(userFile())).equals(latin1)).toBe(true)
  })

  it('are backed up and restored byte for byte (restore, undo)', async () => {
    await writeFile(userFile(), latin1)
    const loc = await configLocation('user', undefined, { home: home() })
    const cur = await readConfigText(userFile())
    expect(cur?.utf8).toBe(false)
    const w = await replaceConfigText(loc, cur, '{ "profile": "thorough" }\n')
    const back = await readFile(join(loc.backupDir, `dimfactory.${w.backupId ?? ''}.jsonc`))
    expect(back.equals(latin1)).toBe(true)
    const restored = await restoreBackup('user', undefined, w.backupId ?? '', { home: home() })
    expect((await readFile(userFile())).equals(latin1)).toBe(true)
    const undone = await undo(restored.undoToken ?? '', { home: home() })
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "thorough" }\n')
    await undo(undone.undoToken ?? '', { home: home() })
    expect((await readFile(userFile())).equals(latin1)).toBe(true)
  })
})
