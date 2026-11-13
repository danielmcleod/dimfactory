import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commandGrantHash,
  getTrust,
  grantTrust,
  isCommandGranted,
  isLargeFolderGranted,
  isProjectAutoGranted,
  normalizeCwdRel,
  readTrustFile,
  revokeTrust,
  setTrust,
  trustGrantsFor,
} from '../../../src/core/config/trust.ts'
import type { TrustedCommand } from '../../../src/core/config/trust.ts'
import { loadConfigFile } from '../../../src/core/config/load.ts'
import { patchConfig } from '../../../src/core/config/save.ts'
import type { DimFactoryError } from '../../../src/core/errors.ts'
import { folderKeyOf, lockKey } from '../../../src/core/git/repo.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const trustFile = (): string => join(home(), 'trust.json')

async function folder(): Promise<{ folder: string; folderScope: { scopeRoot: string; folderKey: string } }> {
  const f = join(home(), 'work', 'proj')
  await mkdir(f, { recursive: true })
  return { folder: f, folderScope: { scopeRoot: f, folderKey: '00112233aabbccdd' } }
}

const verify: TrustedCommand = { kind: 'verify', argv: ['npm', 'test'], cwdRel: '.', body: 'vitest run' }

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('commandGrantHash', () => {
  it('is sha256(JSON{kind,argv,cwdRel,body}) and changes with the body', () => {
    const h = commandGrantHash(verify)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(commandGrantHash({ ...verify })).toBe(h)
    expect(commandGrantHash({ ...verify, body: 'vitest run --coverage' })).not.toBe(h)
    expect(commandGrantHash({ ...verify, argv: ['npm', 'run', 'test'] })).not.toBe(h)
    expect(commandGrantHash({ ...verify, kind: 'deps' })).not.toBe(h)
    const { body: _b, ...noBody } = verify
    expect(commandGrantHash(noBody)).not.toBe(h)
  })

  it('normalizes cwdRel so the same command hashes alike on every OS', () => {
    expect(normalizeCwdRel('')).toBe('.')
    expect(normalizeCwdRel('./')).toBe('.')
    expect(normalizeCwdRel('packages\\app\\')).toBe('packages/app')
    expect(commandGrantHash({ ...verify, cwdRel: 'pkg\\a' })).toBe(
      commandGrantHash({ ...verify, cwdRel: './pkg/a' }),
    )
  })
})

describe('trust store', () => {
  it('writes the canonical shape keyed by folderKey', async () => {
    const f = await folder()
    await grantTrust(
      f.folder,
      { kind: 'vendorFolder', vendor: 'gemini' },
      { home: home(), ...f, now: () => 1000 },
    )
    await grantTrust(f.folder, { kind: 'command', command: verify }, { home: home(), ...f, now: () => 2000 })
    const raw = JSON.parse(await readFile(trustFile(), 'utf8')) as unknown
    expect(raw).toEqual({
      schemaVersion: 1,
      folders: {
        '00112233aabbccdd': {
          path: f.folder,
          grants: {
            vendorFolder: { gemini: { at: 1000 } },
            commands: {
              [commandGrantHash(verify)]: {
                kind: 'verify',
                argv: ['npm', 'test'],
                cwdRel: '.',
                body: 'vitest run',
                at: 2000,
              },
            },
          },
        },
      },
    })
  })

  it('a command grant no longer matches once the script body changes', async () => {
    const f = await folder()
    const state = await grantTrust(f.folder, { kind: 'command', command: verify }, { home: home(), ...f })
    expect(isCommandGranted(state.grants, verify)).toBe(true)
    expect(isCommandGranted(state.grants, { ...verify, body: 'vitest run && curl evil' })).toBe(false)
  })

  it('revokes grants and drops the folder entry once empty', async () => {
    const f = await folder()
    const opts = { home: home(), ...f }
    await grantTrust(f.folder, { kind: 'vendorFolder', vendor: 'gemini' }, opts)
    await grantTrust(f.folder, { kind: 'command', command: verify }, opts)
    let s = await revokeTrust(f.folder, { kind: 'command', hash: commandGrantHash(verify) }, opts)
    expect(s.grants).toEqual({ vendorFolder: { gemini: { at: expect.any(Number) as number } } })
    s = await revokeTrust(f.folder, { kind: 'vendorFolder', vendor: 'gemini' }, opts)
    expect(s.grants).toEqual({})
    expect((await readTrustFile({ home: home() })).file.folders).toEqual({})
  })

  it('largeFolder is re-asked when files or bytes double', async () => {
    const f = await folder()
    const s = await grantTrust(
      f.folder,
      { kind: 'largeFolder', files: 60_000, bytes: 1e9 },
      { home: home(), ...f },
    )
    expect(isLargeFolderGranted(s.grants, { files: 120_000, bytes: 2e9 })).toBe(true)
    expect(isLargeFolderGranted(s.grants, { files: 120_001, bytes: 1e9 })).toBe(false)
    expect(isLargeFolderGranted(s.grants, { files: 1, bytes: 2e9 + 1 })).toBe(false)
  })

  it('setTrust maps the IPC trust.set shape', async () => {
    const f = await folder()
    const opts = { home: home(), ...f }
    const cmd = { kind: 'verify' as const, argv: ['npm', 'test'], cwdRel: '.' }
    let s = await setTrust(f.folder, { kind: 'command', command: cmd }, true, { ...opts, body: 'vitest run' })
    expect(isCommandGranted(s.grants, verify)).toBe(true)
    s = await setTrust(f.folder, { kind: 'command', command: cmd }, false, { ...opts, body: 'vitest run' })
    expect(s.grants.commands).toBeUndefined()
    await expect(setTrust(f.folder, { kind: 'largeFolder' }, true, opts)).rejects.toThrow(/folder size/)
  })

  it('fails closed on a corrupt trust.json and moves it aside on the next grant', async () => {
    const f = await folder()
    await writeFile(trustFile(), '{ not json')
    const read = await readTrustFile({ home: home() })
    expect(read.corrupt).toBe(true)
    expect((await getTrust(f.folder, { home: home(), ...f })).grants).toEqual({})
    await grantTrust(f.folder, { kind: 'vendorFolder', vendor: 'gemini' }, { home: home(), ...f })
    expect((await readdir(home())).some((n) => n.startsWith('trust.json.corrupt-'))).toBe(true)
    expect((await readTrustFile({ home: home() })).corrupt).toBe(false)
  })

  it('a trust.json from a newer Dim Factory is honored but never written', async () => {
    const f = await folder()
    await writeFile(
      trustFile(),
      JSON.stringify({
        schemaVersion: 2,
        folders: {
          [f.folderScope.folderKey]: { path: f.folder, grants: { vendorFolder: { gemini: { at: 1 } } } },
        },
      }),
    )
    expect((await getTrust(f.folder, { home: home(), ...f })).grants.vendorFolder).toEqual({
      gemini: { at: 1 },
    })
    const err = await grantTrust(
      f.folder,
      { kind: 'largeFolder', files: 1, bytes: 1 },
      { home: home(), ...f },
    ).catch((e: unknown) => e)
    expect((err as DimFactoryError).code).toBe('NEWER_SCHEMA')
  })

  it('derives folderKey with the git/repo.ts helpers when no scope is given', async () => {
    const f = await folder()
    const s = await getTrust(f.folder, { home: home() })
    expect(s.folderKey).toBe(folderKeyOf(await lockKey(s.scopeRoot)))
    expect(s.folderKey).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('projectAuto', () => {
  it('is bound to the project file sha and invalidated when the file changes', async () => {
    const f = await folder()
    const opts = { home: home(), ...f }
    await mkdir(join(f.folder, '.dimfactory'))
    await writeFile(join(f.folder, '.dimfactory', 'dimfactory.json'), '{ "auto": true }\n')
    const granted = await grantTrust(f.folder, { kind: 'projectAuto' }, opts)
    expect(granted.grants.projectAuto?.projectSha).toMatch(/^[0-9a-f]{64}$/)
    expect((await getTrust(f.folder, opts)).grants.projectAuto).toBeDefined()

    // Any edit to the committed file voids the grant (here: a config save that changes the profile).
    await patchConfig({
      ...opts,
      scope: 'project',
      folder: f.folder,
      ops: [{ op: 'replace', path: '/profile', value: 'fast' }],
    })
    const after = await getTrust(f.folder, opts)
    expect(after.grants.projectAuto).toBeUndefined()
    expect(isProjectAutoGranted(granted.grants, null)).toBe(false)

    // The stale grant is pruned on the next write to this folder's entry.
    await grantTrust(f.folder, { kind: 'vendorFolder', vendor: 'gemini' }, opts)
    const raw = (await readTrustFile({ home: home() })).file.folders[f.folderScope.folderKey]
    expect(raw?.grants.projectAuto).toBeUndefined()
  })

  it('a grant made from a subfolder never voids the scope root file’s grant; nested files keep their own', async () => {
    const f = await folder()
    const opts = { home: home(), folderScope: f.folderScope }
    const pkg = join(f.folder, 'packages', 'pkg')
    await mkdir(join(f.folder, '.dimfactory'), { recursive: true })
    await mkdir(join(pkg, '.dimfactory'), { recursive: true })
    await writeFile(join(f.folder, '.dimfactory', 'dimfactory.json'), '{ "auto": true }\n')
    await writeFile(join(pkg, '.dimfactory', 'dimfactory.json'), '{ "gates": { "beforeFix": true } }\n')
    const root = await grantTrust(f.folder, { kind: 'projectAuto' }, opts)
    // A grant from the subfolder (which has its own project file) keeps the root's projectAuto.
    await grantTrust(pkg, { kind: 'largeFolder', files: 1, bytes: 1 }, opts)
    const stored = (await readTrustFile({ home: home() })).file.folders[f.folderScope.folderKey]?.grants
    expect(stored?.projectAuto).toEqual(root.grants.projectAuto)
    // The subfolder's own auto file gets its own grant; neither voids the other.
    await writeFile(join(pkg, '.dimfactory', 'dimfactory.json'), '{ "auto": true, "gates": {} }\n')
    const nested = await grantTrust(pkg, { kind: 'projectAuto' }, opts)
    const pkgSha = sha256(await readFile(join(pkg, '.dimfactory', 'dimfactory.json')))
    expect(nested.grants.projectAuto?.projectSha).toBe(pkgSha)
    expect((await getTrust(f.folder, opts)).grants.projectAuto).toEqual(root.grants.projectAuto)
    expect((await getTrust(pkg, opts)).grants.projectAuto?.projectSha).toBe(pkgSha)
    expect(isProjectAutoGranted(await trustGrantsFor(pkg, opts), pkgSha)).toBe(true)
    expect(
      isProjectAutoGranted(await trustGrantsFor(f.folder, opts), root.grants.projectAuto?.projectSha ?? null),
    ).toBe(true)
    const raw = (await readTrustFile({ home: home() })).file.folders[f.folderScope.folderKey]?.grants
    expect(raw?.nestedProjectAuto).toEqual({ 'packages/pkg': nested.grants.projectAuto })
    // A folder without its own file uses the root's file, and so the root's grant.
    const other = join(f.folder, 'packages', 'other')
    await mkdir(other, { recursive: true })
    expect((await getTrust(other, opts)).grants.projectAuto).toEqual(root.grants.projectAuto)
    // Revoking the nested grant leaves the root's.
    await revokeTrust(pkg, { kind: 'projectAuto' }, opts)
    const after = (await readTrustFile({ home: home() })).file.folders[f.folderScope.folderKey]?.grants
    expect(after?.nestedProjectAuto).toBeUndefined()
    expect(after?.projectAuto).toEqual(root.grants.projectAuto)
  })

  it('is refused (CONFLICT) when the file changed since the version the user was shown', async () => {
    const f = await folder()
    const opts = { home: home(), ...f }
    const file = join(f.folder, '.dimfactory', 'dimfactory.json')
    await mkdir(join(f.folder, '.dimfactory'))
    await writeFile(file, '{ "auto": true }\n')
    const shown = sha256(await readFile(file))
    await writeFile(file, '{ "auto": true, "verify": { "enabled": true } }\n')
    const err = await grantTrust(f.folder, { kind: 'projectAuto', projectSha: shown }, opts).catch(
      (e: unknown) => e,
    )
    expect((err as DimFactoryError).code).toBe('CONFLICT')
    expect((await getTrust(f.folder, opts)).grants.projectAuto).toBeUndefined()
    const current = sha256(await readFile(file))
    const ok = await setTrust(f.folder, { kind: 'projectAuto', projectSha: current }, true, opts)
    expect(ok.grants.projectAuto?.projectSha).toBe(current)
  })

  it('matches the loader’s sha256 for a project file that is not valid UTF-8', async () => {
    const f = await folder()
    const opts = { home: home(), ...f }
    const file = join(f.folder, '.dimfactory', 'dimfactory.json')
    await mkdir(join(f.folder, '.dimfactory'))
    await writeFile(
      file,
      Buffer.concat([Buffer.from('{\n // caf'), Buffer.from([0xe9]), Buffer.from('\n "auto": true\n}\n')]),
    )
    const load = await loadConfigFile(file, { scope: 'project' })
    expect(load.value).toEqual({ auto: true })
    const granted = await grantTrust(f.folder, { kind: 'projectAuto' }, opts)
    expect(load.sha256).toBe(granted.grants.projectAuto?.projectSha)
    expect(isProjectAutoGranted(granted.grants, load.sha256)).toBe(true)
  })

  it('needs a project file to trust', async () => {
    const f = await folder()
    const err = await grantTrust(f.folder, { kind: 'projectAuto' }, { home: home(), ...f }).catch(
      (e: unknown) => e,
    )
    expect((err as DimFactoryError).code).toBe('NOT_FOUND')
  })
})
