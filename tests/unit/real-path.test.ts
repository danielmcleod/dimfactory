// One spelling per folder: a linked folder (macOS's /var -> /private/var, a Windows junction) and its real name are
// the same folder for containment and identity, including for a path that does not exist yet.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { realPath, realPathSync, relativeInside, samePath, withFolderSpellings } from '@core/real-path.ts'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'real-path-')))
const real = join(base, 'real')
const link = join(base, 'link')
mkdirSync(join(real, 'sub'), { recursive: true })
symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
mkdirSync(join(base, 'other'))

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('real paths', () => {
  it('spell a linked folder by its real name, and a missing path by its nearest existing parent', async () => {
    expect(realPathSync(link)).toBe(real)
    expect(await realPath(link)).toBe(real)
    expect(realPathSync(join(link, 'not', 'yet'))).toBe(join(real, 'not', 'yet'))
    expect(await realPath(join(link, 'not', 'yet'))).toBe(join(real, 'not', 'yet'))
  })

  it('count a folder inside its other spelling, and nothing else', () => {
    expect(relativeInside(real, join(link, 'sub'))).toBe('sub')
    expect(relativeInside(link, join(real, 'sub'))).toBe('sub')
    expect(relativeInside(link, join(real, 'missing', 'x'))).toBe(join('missing', 'x'))
    expect(relativeInside(link, real)).toBe('')
    expect(samePath(link, real)).toBe(true)
    expect(relativeInside(link, join(base, 'other'))).toBeNull()
    expect(relativeInside(join(real, 'sub'), real)).toBeNull()
    expect(samePath(join(real, 'sub'), real)).toBe(false)
  })
})

describe('a guardrail policy', () => {
  it('learns the real spelling of a linked run folder, and nothing for a folder spelled that way already', () => {
    const p = { rules: [], allowAgentSettings: false }
    expect(withFolderSpellings(p, link)).toEqual({ ...p, folderSpellings: [real] })
    expect(withFolderSpellings(p, real)).toBe(p)
    expect(withFolderSpellings(p, undefined)).toBe(p)
  })
})
