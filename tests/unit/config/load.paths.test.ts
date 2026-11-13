import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_DEFAULTS } from '@core/config/builtins.ts'
import {
  configJsonSchema,
  lastGoodPath,
  locateProjectConfig,
  projectConfigCandidates,
  userConfigPath,
  writeConfigSchema,
} from '@core/config/paths.ts'
import { homePaths } from '@core/home.ts'

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'cfg-paths-'))

describe('config file locations', () => {
  it('user file is DIM_FACTORY_HOME/dimfactory.json', () => {
    expect(userConfigPath('/h')).toBe(homePaths('/h').userConfig)
  })

  it('project candidates: the folder, then the scope root (once)', () => {
    expect(projectConfigCandidates('/r/sub', '/r')).toEqual([
      join(resolve('/r/sub'), '.dimfactory', 'dimfactory.json'),
      join(resolve('/r'), '.dimfactory', 'dimfactory.json'),
    ])
    expect(projectConfigCandidates('/r', '/r')).toHaveLength(1)
    expect(projectConfigCandidates('/r', null)).toHaveLength(1)
  })

  it('uses the folder file, else the scope root file; never both', async () => {
    const root = await tmp()
    const sub = join(root, 'packages', 'app')
    await mkdir(join(sub, '.dimfactory'), { recursive: true })
    await mkdir(join(root, '.dimfactory'), { recursive: true })

    const none = await locateProjectConfig(sub, root)
    expect(none).toMatchObject({
      exists: false,
      path: join(sub, '.dimfactory', 'dimfactory.json'),
      root: sub,
    })

    await writeFile(join(root, '.dimfactory', 'dimfactory.json'), '{}')
    const atRoot = await locateProjectConfig(sub, root)
    expect(atRoot).toMatchObject({ exists: true, path: join(root, '.dimfactory', 'dimfactory.json'), root })

    await writeFile(join(sub, '.dimfactory', 'dimfactory.json'), '{}')
    const atSub = await locateProjectConfig(sub, root)
    expect(atSub).toMatchObject({
      exists: true,
      path: join(sub, '.dimfactory', 'dimfactory.json'),
      root: sub,
    })
    expect(atSub.candidates).toHaveLength(2)
  })

  it('a directory named dimfactory.json does not count', async () => {
    const root = await tmp()
    await mkdir(join(root, '.dimfactory', 'dimfactory.json'), { recursive: true })
    expect((await locateProjectConfig(root, root)).exists).toBe(false)
  })

  it('last-good locations', () => {
    const paths = homePaths('/h')
    expect(lastGoodPath(paths, 'user')).toBe(paths.lastGoodUserConfig)
    expect(lastGoodPath(paths, 'project', 'abc')).toBe(paths.lastGoodProjectConfig('abc'))
    expect(lastGoodPath(paths, 'project')).toBeUndefined()
  })
})

describe('editor schema', () => {
  it('is JSON Schema draft-07 for dimfactory.json, JSONC-friendly and strict', () => {
    const s = configJsonSchema()
    expect(s['$schema']).toBe('http://json-schema.org/draft-07/schema#')
    expect(s).toMatchObject({ type: 'object', allowComments: true, allowTrailingCommas: true })
    expect(s['additionalProperties']).toBe(false)
    expect(Object.keys(s['properties'] as object)).toEqual(
      expect.arrayContaining(['profile', 'profiles', 'passes', 'vendors', 'timeouts', 'local']),
    )
    expect(Object.keys(s['properties'] as object)).toEqual(
      expect.arrayContaining(Object.keys(BUILTIN_DEFAULTS).filter((k) => k !== 'profiles')),
    )
  })

  it('writes DIM_FACTORY_HOME/schema/dimfactory.schema.json, only when it changed', async () => {
    const paths = homePaths(await tmp())
    expect(await writeConfigSchema(paths)).toEqual({ path: paths.schemaFile, changed: true })
    const first = await stat(paths.schemaFile)
    const parsed: unknown = JSON.parse(await readFile(paths.schemaFile, 'utf8'))
    expect(parsed).toEqual(configJsonSchema())
    expect(await writeConfigSchema(paths)).toEqual({ path: paths.schemaFile, changed: false })
    expect((await stat(paths.schemaFile)).mtimeMs).toBe(first.mtimeMs)
    await writeFile(paths.schemaFile, '{}')
    expect((await writeConfigSchema(paths)).changed).toBe(true)
  })
})
