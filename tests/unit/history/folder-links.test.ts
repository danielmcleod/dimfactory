// Links to folders (snapshots): the walk finds Windows junctions and symbolic
// links to folders, never enters them, skips `.git`, nested repositories, DIM_FACTORY_HOME and generated folders, and the
// run's note names what was left out (no em dash).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isFolderLink,
  linksLeftOutNote,
  outermostLinks,
  scanFolderLinks,
  underLink,
  walkCovers,
} from '../../../src/core/git/folder-links.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dim-factory-links-'))
  made.push(d)
  return d
}
const file = (root: string, rel: string, text = 'x\n'): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** A junction on Windows (no privilege needed), a symbolic link to a folder elsewhere. */
const folderLink = (target: string, at: string): void =>
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')

describe('scanFolderLinks', () => {
  it('finds links to folders at any depth, never inside one, and leaves file links alone', async () => {
    const root = temp()
    const outside = temp()
    file(outside, 'lib/shared.h')
    file(root, 'src/main.c')
    file(root, 'notes.txt')
    folderLink(outside, join(root, 'vendor'))
    mkdirSync(join(root, 'deep', 'er'), { recursive: true })
    folderLink(outside, join(root, 'deep', 'er', 'shared'))
    // A link inside a linked folder is never reached (the walk does not enter links).
    folderLink(outside, join(outside, 'loop'))
    let fileLink = false
    try {
      symlinkSync(join(root, 'notes.txt'), join(root, 'notes-link.txt'), 'file')
      fileLink = true
    } catch {
      // no symbolic-link privilege on this Windows account: the file-link case is skipped
    }
    const scan = await scanFolderLinks(root)
    expect(scan.links).toEqual(['deep/er/shared', 'vendor'])
    expect(scan.visited.has('src')).toBe(true)
    expect(scan.visited.has('vendor')).toBe(false)
    expect(walkCovers(scan, 'vendor')).toBe(true)
    expect(walkCovers(scan, 'vendor/lib/shared.h')).toBe(false)
    if (fileLink) expect(scan.links).not.toContain('notes-link.txt')
    expect(await isFolderLink(join(root, 'vendor'))).toBe(true)
    expect(await isFolderLink(join(root, 'src'))).toBe(false)
    expect(await isFolderLink(join(root, 'nope'))).toBe(false)
  })

  it('skips .git, nested repositories, the skipped folders and generated folders (partial)', async () => {
    const root = temp()
    const outside = temp()
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    folderLink(outside, join(root, '.git', 'linked'))
    file(root, 'nested/.git/HEAD', 'ref: refs/heads/main\n')
    folderLink(outside, join(root, 'nested', 'inner-link'))
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    folderLink(outside, join(root, 'node_modules', 'dep'))
    mkdirSync(join(root, 'home', 'shadow'), { recursive: true })
    folderLink(outside, join(root, 'home', 'link'))
    folderLink(outside, join(root, 'top'))
    const scan = await scanFolderLinks(root, { skip: ['home'] })
    expect(scan.links).toEqual(['top'])
    expect(scan.repos).toEqual(['nested'])
    expect(scan.partial).toBe(true)
    expect(scan.visited.has('nested')).toBe(false)
    expect(scan.visited.has('node_modules')).toBe(false)
  })

  it('a dangling link is not a link to a folder', async () => {
    const root = temp()
    const gone = temp()
    folderLink(gone, join(root, 'dangling'))
    rmSync(gone, { recursive: true, force: true })
    made.splice(made.indexOf(gone), 1)
    expect((await scanFolderLinks(root)).links).toEqual([])
  })

  it('stops reading past the cap', async () => {
    const root = temp()
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `d${i}`, 'x'), { recursive: true })
    const scan = await scanFolderLinks(root, { maxDirs: 3 })
    expect(scan.partial).toBe(true)
    expect(scan.visited.size).toBeLessThanOrEqual(3)
  })
})

describe('link helpers', () => {
  it('underLink and outermostLinks (case folded on request)', () => {
    expect(underLink('vendor/lib/a.h', ['vendor'])).toBe(true)
    expect(underLink('vendor', ['vendor'])).toBe(true)
    expect(underLink('vendored/a.h', ['vendor'])).toBe(false)
    expect(underLink('Vendor/a.h', ['vendor'])).toBe(false)
    expect(underLink('Vendor/a.h', ['vendor'], true)).toBe(true)
    expect(outermostLinks(['b/c', 'a', 'b', 'a/x', 'b'])).toEqual(['a', 'b'])
  })

  it('the run note names the links, at most five, with no em dash', () => {
    expect(linksLeftOutNote([])).toBeUndefined()
    expect(linksLeftOutNote(['vendor'])).toBe(
      'vendor is a link to another folder, so Dim Factory leaves it out of its snapshots: changes there do not show in diffs, and Dim Factory never reverts or applies them.',
    )
    expect(linksLeftOutNote(['a', 'b'])).toMatch(
      /^a and b are links to other folders, so Dim Factory leaves them out/,
    )
    const many = linksLeftOutNote(['a', 'b', 'c', 'd', 'e', 'f', 'g']) ?? ''
    expect(many).toMatch(/^a, b, c, d, e and 2 more are links/)
    for (const n of [['x'], ['x', 'y'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
      expect(linksLeftOutNote(n)).not.toContain(String.fromCharCode(0x2014))
    }
  })
})
