import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BACKUPS_KEEP,
  configLocation,
  createBackup,
  decodeUndoToken,
  listBackups,
  newBackupId,
  readBackup,
  readLastGood,
  restoreBackup,
  restoreLastGood,
  unifiedDiff,
  undoConfigWrite,
  writeLastGood,
} from '../../../src/core/config/backups.ts'
import { projectFileKey } from '../../../src/core/config/paths.ts'
import { patchConfig } from '../../../src/core/config/save.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const userFile = (): string => join(home(), 'dimfactory.json')
const userLoc = (): ReturnType<typeof configLocation> => configLocation('user', undefined, { home: home() })

async function caught(p: Promise<unknown>): Promise<DimFactoryError> {
  try {
    await p
  } catch (err) {
    if (err instanceof DimFactoryError) return err
    throw err
  }
  throw new Error('expected a DimFactoryError')
}

describe('configLocation', () => {
  it('user: DIM_FACTORY_HOME/dimfactory.json with backups/ and last-good-user.jsonc', async () => {
    const loc = await userLoc()
    expect(loc.path).toBe(userFile())
    expect(loc.backupDir).toBe(join(home(), 'backups'))
    expect(loc.lastGoodPath).toBe(join(home(), 'backups', 'last-good-user.jsonc'))
  })

  it('project: the folder file, else the scope-root file, else a new file under the folder', async () => {
    const root = join(home(), 'repo')
    const sub = join(root, 'pkg')
    await mkdir(sub, { recursive: true })
    const folderScope = { scopeRoot: root, folderKey: 'fedcba9876543210' }
    const at = async (): Promise<string> =>
      (await configLocation('project', sub, { home: home(), folderScope })).path
    expect(await at()).toBe(join(sub, '.dimfactory', 'dimfactory.json'))
    await mkdir(join(root, '.dimfactory'))
    await writeFile(join(root, '.dimfactory', 'dimfactory.json'), '{}')
    expect(await at()).toBe(join(root, '.dimfactory', 'dimfactory.json'))
    // The scope root's file: backups/project/<folderKey>/.
    const scopeDir = join(home(), 'backups', 'project', 'fedcba9876543210')
    const atRoot = await configLocation('project', sub, { home: home(), folderScope })
    expect(atRoot.backupDir).toBe(scopeDir)
    expect(atRoot.lastGoodPath).toBe(join(scopeDir, 'last-good.jsonc'))
    await mkdir(join(sub, '.dimfactory'))
    await writeFile(join(sub, '.dimfactory', 'dimfactory.json'), '{}')
    expect(await at()).toBe(join(sub, '.dimfactory', 'dimfactory.json'))
    // A subfolder's own file has its own backups and last-good: backups/project/<folderKey>/<fileKey>/.
    const loc = await configLocation('project', sub, { home: home(), folderScope })
    expect(loc.backupDir).toBe(join(scopeDir, projectFileKey(root, loc.path) ?? ''))
    expect(loc.backupDir).toMatch(/[\\/]fedcba9876543210[\\/][0-9a-f]{16}$/)
    expect(loc.lastGoodPath).toBe(join(loc.backupDir, 'last-good.jsonc'))
    // The scope root itself still uses the scope's directory.
    const rootLoc = await configLocation('project', root, { home: home(), folderScope })
    expect(rootLoc.backupDir).toBe(scopeDir)
  })

  it('project without a folder is a VALIDATION error', async () => {
    expect((await caught(configLocation('project', undefined, { home: home() }))).code).toBe('VALIDATION')
  })
})

describe('backup store', () => {
  it('ids sort chronologically even within one millisecond', () => {
    const ids = Array.from({ length: 5 }, () => newBackupId(1_760_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(ids[0]).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{4}$/)
  })

  it('rotates to the newest BACKUPS_KEEP and lists newest first, then last-good', async () => {
    const loc = await userLoc()
    for (let i = 0; i < BACKUPS_KEEP + 3; i++) await createBackup(loc, `{"n": ${i}}`)
    await writeLastGood(loc, '{"good": true}')
    const list = await listBackups(loc)
    expect(list.filter((b) => b.kind === 'write')).toHaveLength(BACKUPS_KEEP)
    expect(list.at(-1)).toMatchObject({ id: 'last-good', kind: 'last-good' })
    expect(await readBackup(loc, list[0]?.id ?? '')).toBe(`{"n": ${BACKUPS_KEEP + 2}}`)
    expect(await readBackup(loc, list[BACKUPS_KEEP - 1]?.id ?? '')).toBe('{"n": 3}')
    expect(await readBackup(loc, 'last-good')).toBe('{"good": true}')
  })

  it('rejects a backup id that could escape the backup folder', async () => {
    const loc = await userLoc()
    expect((await caught(readBackup(loc, '..\\..\\x'))).code).toBe('VALIDATION')
  })

  it('writeLastGood skips an identical copy', async () => {
    const loc = await userLoc()
    expect(await writeLastGood(loc, 'a')).toBe(true)
    expect(await writeLastGood(loc, 'a')).toBe(false)
    expect(await readLastGood(loc)).toBe('a')
  })
})

describe('restore', () => {
  it('restoreLastGood uses the last-good text first and backs up the broken file', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    const good = await readFile(userFile(), 'utf8')
    await writeFile(userFile(), '{ "profile": "thorough", oops }')
    const out = await restoreLastGood('user', undefined, { home: home() })
    expect(out.restoredFrom).toBe('last-good')
    expect(await readFile(userFile(), 'utf8')).toBe(good)
    expect(await readBackup(await userLoc(), out.backupId ?? '')).toBe('{ "profile": "thorough", oops }')
  })

  it('falls back to the newest write backup when there is no last-good copy', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    await rm(join(home(), 'backups', 'last-good-user.jsonc'))
    await writeFile(userFile(), 'garbage')
    const out = await restoreLastGood('user', undefined, { home: home() })
    expect(out.restoredFrom).toMatch(/^\d{8}T/)
    // The newest write backup is the text before the patch.
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "fast" }\n')
  })

  it('a second "Restore last good" reports "already matches" and never brings the broken text back', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    const good = await readFile(userFile(), 'utf8')
    await writeFile(userFile(), '{ "profile": "thorough", "stalMs": 1 }\n')
    const first = await restoreLastGood('user', undefined, { home: home() })
    expect(first).toMatchObject({ changed: true, restoredFrom: 'last-good' })
    expect(await readFile(userFile(), 'utf8')).toBe(good)
    const second = await restoreLastGood('user', undefined, { home: home() })
    expect(second).toMatchObject({ changed: false, restoredFrom: 'last-good', diff: '', undoToken: null })
    expect(await readFile(userFile(), 'utf8')).toBe(good)
  })

  it('without a last-good copy, falls back only to a write backup that loads without errors', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    const loc = await userLoc()
    await createBackup(loc, '{ "profile": "fast" }\n')
    await createBackup(loc, '{ "profile": "fast", "stalMs": 1 }\n')
    await writeFile(userFile(), 'garbage')
    const out = await restoreLastGood('user', undefined, { home: home() })
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "fast" }\n')
    expect(out.restoredFrom).toMatch(/^\d{8}T/)
    // Only broken backups left: nothing to restore.
    await writeFile(userFile(), '{ "profile": "fast", "stalMs": 2 }\n')
    await rm(loc.backupDir, { recursive: true })
    await createBackup(loc, 'still garbage')
    expect((await caught(restoreLastGood('user', undefined, { home: home() }))).code).toBe('NOT_FOUND')
  })

  it('NOT_FOUND when there is nothing to restore', async () => {
    expect((await caught(restoreLastGood('user', undefined, { home: home() }))).code).toBe('NOT_FOUND')
  })

  it('restoreBackup puts a specific backup back and is itself undoable', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    const first = await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    const restored = await restoreBackup('user', undefined, first.backupId ?? '', { home: home() })
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "fast" }\n')
    await undoConfigWrite(restored.undoToken ?? '', { home: home() })
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "thorough" }\n')
  })
})

describe('undo tokens', () => {
  it('reject tampering', () => {
    expect(() => decodeUndoToken('nope')).toThrow(DimFactoryError)
    const forged =
      'cfgundo1.' +
      Buffer.from(JSON.stringify({ w: [{ s: 'user', b: '../x', h: null }] })).toString('base64url')
    expect(() => decodeUndoToken(forged)).toThrow(/Invalid undo token/)
  })

  it('refuse (CONFLICT) when the file changed after the write, unless forced', async () => {
    await writeFile(userFile(), '{ "profile": "fast" }\n')
    const out = await patchConfig({
      home: home(),
      scope: 'user',
      ops: [{ op: 'replace', path: '/profile', value: 'thorough' }],
    })
    await writeFile(userFile(), '{ "profile": "balanced" }\n')
    expect((await caught(undoConfigWrite(out.undoToken ?? '', { home: home() }))).code).toBe('CONFLICT')
    await undoConfigWrite(out.undoToken ?? '', { home: home(), force: true })
    expect(await readFile(userFile(), 'utf8')).toBe('{ "profile": "fast" }\n')
  })
})

describe('unifiedDiff', () => {
  it('produces hunks with 3 lines of context and ignores EOL style', () => {
    const a = [
      '{',
      '  "a": 1,',
      '  "b": 2,',
      '  "c": 3,',
      '  "d": 4,',
      '  "e": 5,',
      '  "f": 6',
      '}',
      '',
    ].join('\r\n')
    const b = a.replace('"b": 2', '"b": 20')
    expect(unifiedDiff(a, b, 'x/dimfactory.json')).toBe(
      [
        '--- a/x/dimfactory.json',
        '+++ b/x/dimfactory.json',
        '@@ -1,6 +1,6 @@',
        ' {',
        '   "a": 1,',
        '-  "b": 2,',
        '+  "b": 20,',
        '   "c": 3,',
        '   "d": 4,',
        '   "e": 5,',
        '',
      ].join('\n'),
    )
    expect(unifiedDiff(a, a, 'x')).toBe('')
    expect(unifiedDiff(null, '{}\n', 'n')).toBe('--- /dev/null\n+++ b/n\n@@ -0,0 +1,1 @@\n+{}\n')
    expect(unifiedDiff('{}\n', null, 'n')).toBe('--- a/n\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-{}\n')
  })
})
