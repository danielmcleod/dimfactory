// shell.open `uploadFile` (the Deploy helper's "Show the file"): only an existing .zip at an absolute path, shown
// selected in its folder (never opened or run); anything else is refused. The handler reveals it with
// showItemInFolder, else opens the folder it is in. "Open Netlify Drop" passes the https allowlist.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { createMainHandlers, resolveShellOpen } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import { NETLIFY_DROP_URL } from '../../../src/shared/deploy.ts'
import { allowedExternalUrl } from '../../../src/shared/external-links.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const noDirs = (): Promise<boolean> => Promise.resolve(false)

async function zipFile(): Promise<string> {
  const p = join(home(), 'projects', 'shop-site.zip')
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, 'PK')
  return p
}

describe('shell.open uploadFile', () => {
  it('reveals an existing .zip and refuses anything else', async () => {
    const paths = homePaths(home())
    const p = await zipFile()
    expect(await resolveShellOpen({ target: 'uploadFile', path: p }, paths, noDirs)).toEqual({
      kind: 'reveal',
      path: p,
    })
    const exe = join(home(), 'projects', 'calc.exe')
    await writeFile(exe, 'MZ')
    await expect(resolveShellOpen({ target: 'uploadFile', path: exe }, paths, noDirs)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    await expect(
      resolveShellOpen({ target: 'uploadFile', path: 'shop-site.zip' }, paths, noDirs),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      resolveShellOpen({ target: 'uploadFile', path: join(home(), 'gone.zip') }, paths, noDirs),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('shows the file in its folder, or opens the folder when the platform cannot select it', async () => {
    const p = await zipFile()
    const showItemInFolder = vi.fn()
    const openPath = vi.fn(() => Promise.resolve(''))
    const deps = {
      core: { paths: homePaths(home()), log: { child: () => ({}) } },
      openPath,
      openExternal: () => Promise.resolve(),
    } as unknown as MainHandlerDeps
    await createMainHandlers({ ...deps, showItemInFolder })['shell.open']?.({ target: 'uploadFile', path: p })
    expect(showItemInFolder).toHaveBeenCalledWith(p)
    expect(openPath).not.toHaveBeenCalled()
    await createMainHandlers(deps)['shell.open']?.({ target: 'uploadFile', path: p })
    expect(openPath).toHaveBeenCalledWith(dirname(p))
  })

  it('Open Netlify Drop is on the https allowlist', () => {
    expect(allowedExternalUrl(NETLIFY_DROP_URL)).toBe(NETLIFY_DROP_URL)
    expect(allowedExternalUrl('https://netlify.com.evil.example/drop')).toBeNull()
  })
})
