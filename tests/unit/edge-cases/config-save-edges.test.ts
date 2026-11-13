// Coverage: dimfactory.json writes on their failure paths (config save: minimal-diff edits, refused
// when the document is not shaped as the edit needs; "A failure on the second file rolls the first back", so a patch
// that spans the user and the project file never leaves half of itself written).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  ConfigEditError,
  applyConfigEdits,
  commitConfigWrite,
  planConfigPatch,
  planOverridesSave,
} from '../../../src/core/config/save.ts'
import type { ConfigEdit } from '../../../src/core/config/save.ts'
import type { JsonPatchOp } from '../../../src/shared/failure.ts'

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
    folderScope: { scopeRoot: folder, folderKey: 'fedcba9876543210' },
  }
}

/** A project patch that also carries a user-only key: two files, the user file written first. */
const SPLIT_OPS: JsonPatchOp[] = [
  { op: 'add', path: '/vendors/claude/extraArgs', value: ['--verbose'] },
  { op: 'replace', path: '/passes/review/model', value: 'opus' },
]

async function caught(p: Promise<unknown>): Promise<DimFactoryError> {
  try {
    await p
  } catch (err) {
    if (err instanceof DimFactoryError) return err
    throw err
  }
  throw new Error('expected a DimFactoryError')
}

function editError(text: string, edits: ConfigEdit[]): ConfigEditError {
  try {
    applyConfigEdits(text, edits)
  } catch (err) {
    if (err instanceof ConfigEditError) return err
    throw err
  }
  throw new Error('expected a ConfigEditError')
}

describe('a two-file patch whose second write fails', () => {
  it('puts the user file back byte for byte and reports STORAGE; the project file is never written', async () => {
    const p = await project()
    await mkdir(home(), { recursive: true })
    const before = '{\r\n  // mine\r\n  "ui": { "theme": "dark" }\r\n}\r\n'
    await writeFile(userFile(), before)
    const plan = await planConfigPatch({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: SPLIT_OPS,
    })
    expect(plan.targets.map((t) => t.location.scope)).toEqual(['user', 'project'])
    // Between the preview and the write, a file appears where the project's .dimfactory folder goes.
    await writeFile(join(p.folder, '.dimfactory'), 'not a folder')
    const err = await caught(commitConfigWrite(plan))
    expect(err.code).toBe('STORAGE')
    expect(await readFile(userFile(), 'utf8')).toBe(before)
    expect(await readFile(join(p.folder, '.dimfactory'), 'utf8')).toBe('not a folder')
  })

  it('removes a user file this commit created', async () => {
    const p = await project()
    const plan = await planConfigPatch({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: SPLIT_OPS,
    })
    await writeFile(join(p.folder, '.dimfactory'), 'not a folder')
    expect((await caught(commitConfigWrite(plan))).code).toBe('STORAGE')
    expect(await readdir(home())).not.toContain('dimfactory.json')
  })

  it('without the failure both files are written (the same plan shape)', async () => {
    const p = await project()
    const plan = await planConfigPatch({
      home: home(),
      folderScope: p.folderScope,
      scope: 'project',
      folder: p.folder,
      ops: SPLIT_OPS,
    })
    const out = await commitConfigWrite(plan)
    expect(out.writes.map((w) => [w.scope, w.changed])).toEqual([
      ['user', true],
      ['project', true],
    ])
    expect(parseJsonc(await readFile(userFile(), 'utf8'))).toEqual({
      vendors: { claude: { extraArgs: ['--verbose'] } },
    })
    expect(parseJsonc(await readFile(p.file, 'utf8'))).toEqual({ passes: { review: { model: 'opus' } } })
  })
})

describe('requests refused before any file is read', () => {
  it('config.patch: ops must be a list', async () => {
    const err = await caught(
      planConfigPatch({ home: home(), scope: 'user', ops: 'add' as unknown as JsonPatchOp[] }),
    )
    expect(err).toMatchObject({ code: 'VALIDATION', message: 'ops must be a list' })
  })

  it('config.save of a composer row needs a known pass', async () => {
    const p = await project()
    for (const pass of [undefined, 'verify']) {
      const err = await caught(
        planOverridesSave({
          home: home(),
          folderScope: p.folderScope,
          scope: 'project',
          folder: p.folder,
          mode: 'row',
          ...(pass !== undefined ? { pass: pass as 'plan' } : {}),
          overrides: { passes: { review: { model: 'opus' } } },
          resolveInherited: () => undefined,
        }),
      )
      expect(err).toMatchObject({ code: 'VALIDATION', message: 'Saving a composer row needs its pass' })
    }
    expect(await readdir(p.folder)).toEqual([])
  })
})

describe('applyConfigEdits: lists keep their layout', () => {
  const MULTI = [
    '{',
    '  "vendors": {',
    '    "claude": {',
    '      "extraArgs": [',
    '        "--verbose",',
    '        "--debug"',
    '      ]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')
  const SINGLE = '{ "vendors": { "claude": { "extraArgs": ["--verbose"] } } }\n'
  const at = (...i: string[]): string[] => ['vendors', 'claude', 'extraArgs', ...i]
  const lines = (...l: string[]): string => [...l, ''].join('\n')

  it('appends with "-" and inserts at an index on their own lines in a multi-line list', () => {
    expect(applyConfigEdits(MULTI, [{ op: 'add', path: at('-'), value: '--x' }])).toBe(
      MULTI.replace('"--debug"\n', '"--debug",\n        "--x"\n'),
    )
    expect(applyConfigEdits(MULTI, [{ op: 'add', path: at('0'), value: '--x' }])).toBe(
      MULTI.replace('        "--verbose",', '        "--x",\n        "--verbose",'),
    )
  })

  it('inserts inline in a single-line list; the length as an index appends', () => {
    expect(applyConfigEdits(SINGLE, [{ op: 'add', path: at('0'), value: '--x' }])).toBe(
      '{ "vendors": { "claude": { "extraArgs": ["--x", "--verbose"] } } }\n',
    )
    expect(applyConfigEdits(SINGLE, [{ op: 'add', path: at('1'), value: '--x' }])).toBe(
      '{ "vendors": { "claude": { "extraArgs": ["--verbose", "--x"] } } }\n',
    )
  })

  it('removes an item by index and leaves an emptied list in place', () => {
    expect(applyConfigEdits(MULTI, [{ op: 'remove', path: at('0') }])).toBe(
      MULTI.replace('        "--verbose",\n', ''),
    )
    expect(applyConfigEdits(SINGLE, [{ op: 'remove', path: at('0') }])).toBe(
      '{ "vendors": { "claude": { "extraArgs": [] } } }\n',
    )
  })

  it('an empty list gets its first item inline; CRLF lists keep CRLF', () => {
    expect(
      applyConfigEdits(lines('{', '  "extraArgs": []', '}'), [
        { op: 'add', path: ['extraArgs', '-'], value: '--x' },
      ]),
    ).toBe(lines('{', '  "extraArgs": ["--x"]', '}'))
    const crlf = '{\r\n  "l": [\r\n    1\r\n  ]\r\n}\r\n'
    expect(applyConfigEdits(crlf, [{ op: 'add', path: ['l', '-'], value: 2 }])).toBe(
      '{\r\n  "l": [\r\n    1,\r\n    2\r\n  ]\r\n}\r\n',
    )
  })

  it('a new key after a value with a trailing block comment: the comma goes after the value, the comment stays', () => {
    expect(
      applyConfigEdits(lines('{', '  "a": 1 /* one */', '}'), [{ op: 'add', path: ['b'], value: 2 }]),
    ).toBe(lines('{', '  "a": 1, /* one */', '  "b": 2', '}'))
  })
})

describe('applyConfigEdits: refusals name the pointer', () => {
  it('an index past the end of a list', () => {
    const e = editError('{ "l": [1] }\n', [{ op: 'add', path: ['l', '5'], value: 2 }])
    expect(e).toMatchObject({ kind: 'shape', pointer: '/l/5', message: '/l/5: index 5 is outside the list' })
  })

  it('a path through a list that does not exist (never created as an object)', () => {
    const e = editError('{}\n', [{ op: 'add', path: ['verify', 'commands', '0', 'argv'], value: ['npm'] }])
    expect(e).toMatchObject({
      kind: 'shape',
      message: '/verify/commands/0/argv: the list /verify/commands does not exist',
    })
  })

  it('a path through a value that is not an object', () => {
    expect(editError('{ "auto": true }\n', [{ op: 'add', path: ['auto', 'x'], value: 1 }]).message).toBe(
      '/auto is not an object',
    )
  })

  it('the whole file, a file with syntax errors, a root that is not an object', () => {
    expect(editError('{}\n', [{ op: 'replace', path: [], value: {} }]).message).toBe(
      'An edit cannot replace the whole file',
    )
    expect(editError('{ "a": }\n', [{ op: 'add', path: ['b'], value: 1 }]).message).toBe(
      'The file has syntax errors; fix them before saving',
    )
    expect(editError('[1]\n', [{ op: 'add', path: ['b'], value: 1 }]).message).toBe(
      'The file is not a JSON object',
    )
  })

  it('a test op: a different or a missing value is kind "test" (CONFLICT); a matching one lets the rest apply', () => {
    expect(editError('{ "auto": true }\n', [{ op: 'test', path: ['auto'], value: false }])).toMatchObject({
      kind: 'test',
      pointer: '/auto',
    })
    expect(editError('{ "auto": true }\n', [{ op: 'test', path: ['x'], value: false }]).kind).toBe('test')
    expect(
      applyConfigEdits('{ "auto": true }\n', [
        { op: 'test', path: ['auto'], value: true },
        { op: 'replace', path: ['auto'], value: false },
      ]),
    ).toBe('{ "auto": false }\n')
  })
})
