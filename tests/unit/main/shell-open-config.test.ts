// shell.open `configFile` (Settings → Config file "Open in editor"): the
// user's dimfactory.json, or the project file a folder uses, opened with the system's editor; NOT_FOUND when the file
// does not exist yet; the request schema accepts exactly this shape.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { resolveShellOpen } from '../../../src/main/main-handlers.ts'
import { parseRequest } from '../../../src/shared/ipc-schemas.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const noDirs = (): Promise<boolean> => Promise.resolve(false)

describe('shell.open configFile', () => {
  it('opens the user file, and refuses one that does not exist yet', async () => {
    const paths = homePaths(home())
    await expect(
      resolveShellOpen({ target: 'configFile', scope: 'user' }, paths, noDirs),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'This dimfactory.json does not exist yet.' })
    await writeFile(paths.userConfig, '{}\n')
    expect(await resolveShellOpen({ target: 'configFile', scope: 'user' }, paths, noDirs)).toEqual({
      kind: 'path',
      path: paths.userConfig,
    })
  })

  it('opens the project file a folder uses', async () => {
    const paths = homePaths(home())
    const folder = join(home(), 'project')
    const file = join(folder, '.dimfactory', 'dimfactory.json')
    await mkdir(join(folder, '.dimfactory'), { recursive: true })
    await writeFile(file, '{ "auto": false }\n')
    expect(await resolveShellOpen({ target: 'configFile', scope: 'project', folder }, paths, noDirs)).toEqual(
      { kind: 'path', path: file },
    )
  })

  it('validates the request: scope required, folder optional, nothing else', () => {
    expect(parseRequest('shell.open', { target: 'configFile', scope: 'user' }).ok).toBe(true)
    expect(parseRequest('shell.open', { target: 'configFile', scope: 'project', folder: 'C:\\x' }).ok).toBe(
      true,
    )
    expect(parseRequest('shell.open', { target: 'configFile' }).ok).toBe(false)
    expect(parseRequest('shell.open', { target: 'configFile', scope: 'user', path: 'C:\\evil.exe' }).ok).toBe(
      false,
    )
  })
})
