// Easy mode's Add files (easy/attach.ts): the size caps (one file, how many, all together), guarded and secret paths
// refused (Dim Factory's own folder, a .git folder, system folders, hidden folders and files, key and credential
// files, links), folders only when clearly safe, and the copy into the new project's data/ or assets/ (never
// overwriting, the originals untouched). Temp folders only: nothing real is read or written.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACH_TEXT, checkAttachments, copyAttachments, destOf, refusedBy } from '@core/easy/attach.ts'
import type { AttachContext } from '@core/easy/attach.ts'
import {
  EASY_ATTACH_FOLDER_MAX_FILES,
  EASY_ATTACH_MAX_BYTES,
  EASY_ATTACH_MAX_FILES,
  EASY_ATTACH_TOTAL_MAX_BYTES,
} from '@shared/easy.ts'

const dirs: string[] = []
// Removing the size-cap test's large files can be slow on a busy disk.
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}, 60_000)

function world(): { root: string; ctx: AttachContext; downloads: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'dimf-attach-'))
  dirs.push(root)
  const userHome = join(root, 'me')
  const downloads = join(userHome, 'Downloads')
  const project = join(root, 'projects', 'report')
  mkdirSync(downloads, { recursive: true })
  mkdirSync(project, { recursive: true })
  const ctx: AttachContext = {
    platform: process.platform,
    home: userHome,
    dimFactoryHome: join(userHome, 'dimfactory-home'),
    env: { WINDIR: 'C:\\Windows' },
  }
  return { root, ctx, downloads, project }
}

/** A file of exactly `bytes` bytes. A large one is sized without writing its bytes (the caps read only the size). */
function file(path: string, bytes = 10): string {
  mkdirSync(join(path, '..'), { recursive: true })
  if (bytes <= 1024 * 1024) writeFileSync(path, Buffer.alloc(bytes, 65))
  else {
    writeFileSync(path, '')
    truncateSync(path, bytes)
  }
  return path
}

describe('checkAttachments', () => {
  it('accepts plain files, data to data/ and the rest to assets/', async () => {
    const { ctx, downloads } = world()
    const csv = file(join(downloads, 'sales.csv'), 1234)
    const logo = file(join(downloads, 'logo.png'), 99)
    const r = await checkAttachments([csv, logo], ctx)
    expect(r).toEqual([
      { path: csv, name: 'sales.csv', bytes: 1234, folder: false, dest: 'data' },
      { path: logo, name: 'logo.png', bytes: 99, folder: false, dest: 'assets' },
    ])
    expect(destOf('Sheet.XLSX')).toBe('data')
    expect(destOf('notes.docx')).toBe('assets')
  })

  it('caps one file, the number of files and all of them together', async () => {
    const { ctx, downloads } = world()
    const big = file(join(downloads, 'big.csv'), EASY_ATTACH_MAX_BYTES + 1)
    const [r] = await checkAttachments([big], ctx)
    expect(r?.error).toBe(ATTACH_TEXT.tooBig(EASY_ATTACH_MAX_BYTES + 1))

    const many = Array.from({ length: EASY_ATTACH_MAX_FILES + 1 }, (_, i) =>
      file(join(downloads, `f${i}.txt`)),
    )
    const rm = await checkAttachments(many, ctx)
    expect(rm.filter((a) => a.error === undefined)).toHaveLength(EASY_ATTACH_MAX_FILES)
    expect(rm[EASY_ATTACH_MAX_FILES]?.error).toBe(ATTACH_TEXT.tooMany)

    const near = Math.floor(EASY_ATTACH_MAX_BYTES * 0.99)
    const count = Math.floor(EASY_ATTACH_TOTAL_MAX_BYTES / near) + 1
    const heavy = Array.from({ length: count }, (_, i) => file(join(downloads, `h${i}.bin`), near))
    const rh = await checkAttachments(heavy, ctx)
    expect(rh.at(-1)?.error).toBe(ATTACH_TEXT.tooMuch)
    expect(rh.slice(0, -1).every((a) => a.error === undefined)).toBe(true)
  })

  it('refuses guarded and secret paths', async () => {
    const { ctx, downloads, root } = world()
    const cases: [string, string][] = [
      [file(join(ctx.dimFactoryHome, 'runs', 'x.json')), ATTACH_TEXT.guarded],
      [file(join(downloads, 'repo', '.git', 'config')), ATTACH_TEXT.hidden],
      [file(join(ctx.home, '.ssh', 'id_rsa')), ATTACH_TEXT.hidden],
      [file(join(ctx.home, '.claude', 'settings.json')), ATTACH_TEXT.hidden],
      [file(join(ctx.home, '.codex', 'auth.json')), ATTACH_TEXT.hidden],
      [file(join(downloads, '.env')), ATTACH_TEXT.hidden],
      [file(join(downloads, 'server.pem')), ATTACH_TEXT.secret],
      [file(join(downloads, 'id_ed25519')), ATTACH_TEXT.secret],
      [file(join(downloads, 'credentials')), ATTACH_TEXT.secret],
      [join(downloads, 'missing.csv'), ATTACH_TEXT.missing],
      ['relative/path.csv', ATTACH_TEXT.notAbsolute],
    ]
    for (const [p, why] of cases) {
      const [r] = await checkAttachments([p], ctx)
      expect(r?.error, p).toBe(why)
    }
    // Dim Factory's own data folder, by name (not hidden here): refused as guarded.
    const ownHome = { ...ctx, dimFactoryHome: join(root, 'df') }
    const own = file(join(root, 'df', 'trust.json'))
    expect((await checkAttachments([own], ownHome))[0]?.error).toBe(ATTACH_TEXT.guarded)
    // Windows system folders.
    expect(refusedBy('C:\\Windows\\System32\\drivers\\etc\\hosts', { ...ctx, platform: 'win32' })).toBe(
      ATTACH_TEXT.guarded,
    )
    expect(refusedBy('C:\\Program Files\\App\\data.csv', { ...ctx, platform: 'win32' })).toBe(
      ATTACH_TEXT.guarded,
    )
    // The same file twice is one.
    const once = file(join(downloads, 'a.csv'))
    const twice = await checkAttachments([once, once], ctx)
    expect(twice[1]?.error).toBe(ATTACH_TEXT.duplicate)
  })

  it('refuses a link to anywhere', async () => {
    const { ctx, downloads, root } = world()
    const target = file(join(root, 'secret.txt'))
    const link = join(downloads, 'link.txt')
    try {
      symlinkSync(target, link)
    } catch {
      return // creating links needs a privilege this machine does not give: nothing to check
    }
    expect((await checkAttachments([link], ctx))[0]?.error).toBe(ATTACH_TEXT.link)
  })

  it('copies a folder only when it is clearly safe', async () => {
    const { ctx, downloads } = world()
    const ok = join(downloads, 'photos')
    file(join(ok, 'a.png'))
    file(join(ok, 'more', 'b.png'))
    const [good] = await checkAttachments([ok], ctx)
    expect(good).toMatchObject({ folder: true, dest: 'assets', bytes: 20 })
    expect(good?.error).toBeUndefined()

    const hidden = join(downloads, 'with-hidden')
    file(join(hidden, 'a.csv'))
    file(join(hidden, '.env'))
    expect((await checkAttachments([hidden], ctx))[0]?.error).toBe(ATTACH_TEXT.folder)

    const deep = join(downloads, 'deep')
    file(join(deep, 'a', 'b', 'c', 'd.txt'))
    expect((await checkAttachments([deep], ctx))[0]?.error).toBe(ATTACH_TEXT.folder)

    const crowded = join(downloads, 'crowded')
    for (let i = 0; i <= EASY_ATTACH_FOLDER_MAX_FILES; i++) file(join(crowded, `f${i}.txt`))
    expect((await checkAttachments([crowded], ctx))[0]?.error).toBe(ATTACH_TEXT.folder)

    const data = join(downloads, 'tables')
    file(join(data, 'a.csv'))
    file(join(data, 'b.xlsx'))
    expect((await checkAttachments([data], ctx))[0]?.dest).toBe('data')
  })
})

describe('copyAttachments', () => {
  it('copies into data/ and assets/, never over a file, the originals untouched', async () => {
    const { ctx, downloads, project } = world()
    const csv = file(join(downloads, 'sales.csv'), 5)
    const logo = file(join(downloads, 'logo.png'), 7)
    file(join(project, 'data', 'sales.csv'), 1)
    const photos = join(downloads, 'photos')
    file(join(photos, 'a.png'))
    const written = await copyAttachments([csv, logo, photos], project, ctx)
    expect(written).toEqual(['data/sales (2).csv', 'assets/logo.png', 'assets/photos/'])
    expect(readFileSync(join(project, 'data', 'sales.csv'))).toHaveLength(1)
    expect(readFileSync(join(project, 'data', 'sales (2).csv'))).toHaveLength(5)
    expect(readdirSync(join(project, 'assets', 'photos'))).toEqual(['a.png'])
    expect(readFileSync(csv)).toHaveLength(5)
  })

  it('refuses the whole copy when one file is refused', async () => {
    const { ctx, downloads, project } = world()
    const ok = file(join(downloads, 'ok.csv'))
    const bad = file(join(downloads, '.env'))
    await expect(copyAttachments([ok, bad], project, ctx)).rejects.toThrow(ATTACH_TEXT.hidden)
    expect(readdirSync(project)).toEqual([])
  })
})
