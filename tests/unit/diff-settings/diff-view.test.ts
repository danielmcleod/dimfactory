// Diff tab row facts (special rows, image preview ≤ 2 MB, edited-after-run):
// git/diff-view.ts imageMime (by signature only; SVG is never an image), withRowFacts (similarity, mode change,
// large), sameBlobId (full vs abbreviated ids) and markEditedAfterRun against a temp folder.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDiffViewCaches,
  imageMime,
  markEditedAfterRun,
  sameBlobId,
  withRowFacts,
} from '../../../src/core/git/diff-view.ts'
import type { FileChange } from '../../../src/shared/ipc.ts'
import { LARGE_DIFF_LINES } from '../../../src/shared/ipc.ts'

const Z = '0'.repeat(40)
const blobId = (data: string | Buffer): string => {
  const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
}

function row(path: string, over: Partial<FileChange> = {}): FileChange {
  return {
    status: 'M',
    path,
    oldMode: '100644',
    newMode: '100644',
    oldSha: 'a'.repeat(40),
    newSha: 'b'.repeat(40),
    added: 1,
    deleted: 1,
    binary: false,
    gitlink: false,
    eolOnly: false,
    ...over,
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  clearDiffViewCaches()
})

describe('imageMime', () => {
  it('knows png, jpeg, gif, webp, bmp and ico by their bytes', () => {
    expect(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image/jpeg')
    expect(imageMime(Buffer.from('GIF89a\x01\x00', 'latin1'))).toBe('image/gif')
    expect(imageMime(Buffer.from('GIF87a\x01\x00', 'latin1'))).toBe('image/gif')
    expect(imageMime(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp')
    expect(imageMime(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)]))).toBe('image/bmp')
    expect(imageMime(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon')
  })

  it('never serves SVG, text or unknown bytes as an image', () => {
    expect(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(imageMime(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull()
    expect(imageMime(Buffer.from('hello world'))).toBeNull()
    expect(imageMime(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull()
    expect(imageMime(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull()
    expect(imageMime(Buffer.alloc(0))).toBeNull()
  })
})

describe('withRowFacts', () => {
  it('adds a rename similarity, a mode change and the large flag only where they apply', () => {
    expect(withRowFacts(row('a'), 90)).toEqual(row('a'))
    expect(withRowFacts(row('b', { status: 'R', oldPath: 'a' }), 86)).toMatchObject({ similarity: 86 })
    expect(withRowFacts(row('x.sh', { newMode: '100755' }))).toMatchObject({ modeChanged: true })
    expect(withRowFacts(row('new', { status: 'A', oldMode: '000000' })).modeChanged).toBeUndefined()
    expect(withRowFacts(row('gone', { status: 'D', newMode: '000000' })).modeChanged).toBeUndefined()
    expect(withRowFacts(row('big', { added: LARGE_DIFF_LINES, deleted: 1 })).large).toBe(true)
    expect(withRowFacts(row('edge', { added: LARGE_DIFF_LINES, deleted: 0 })).large).toBeUndefined()
    expect(withRowFacts(row('bin', { binary: true, added: null, deleted: null })).large).toBeUndefined()
  })
})

describe('sameBlobId', () => {
  it('matches equal ids and a ≥ 7 hex abbreviation, nothing else', () => {
    const full = 'abcdef0123456789abcdef0123456789abcdef01'
    expect(sameBlobId(full, full)).toBe(true)
    expect(sameBlobId('abcdef0', full)).toBe(true)
    expect(sameBlobId(full, 'abcdef01234')).toBe(true)
    expect(sameBlobId('abcdef', full)).toBe(false)
    expect(sameBlobId('', full)).toBe(false)
    expect(sameBlobId('abcdef1', full)).toBe(false)
  })
})

describe('markEditedAfterRun', () => {
  const folder = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'dim-factory-edited-'))
    dirs.push(d)
    return d
  }

  it('compares each file with the segment’s new side: same, changed, gone, back, unchecked', async () => {
    const root = folder()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'same.ts'), 'same\n')
    writeFileSync(join(root, 'changed.txt'), 'changed after\n')
    writeFileSync(join(root, 'back.txt'), 'restored by the user\n')
    writeFileSync(join(root, 'abbrev.txt'), 'abbreviated id\n')
    const rows = [
      row('src/same.ts', { newSha: blobId('same\n') }),
      row('changed.txt', { newSha: blobId('as the run left it\n') }),
      row('gone.txt', { status: 'A', oldMode: '000000', oldSha: Z, newSha: blobId('added\n') }),
      row('back.txt', { status: 'D', newMode: '000000', newSha: Z }),
      row('still-gone.txt', { status: 'D', newMode: '000000', newSha: Z }),
      row('sub', { gitlink: true, oldMode: '160000', newMode: '160000' }),
      row('abbrev.txt', { newSha: blobId('abbreviated id\n').slice(0, 7) }),
    ]
    const out = new Map((await markEditedAfterRun(root, rows)).map((r) => [r.path, r.editedAfterRun]))
    expect(Object.fromEntries(out)).toEqual({
      'src/same.ts': false,
      'changed.txt': true,
      'gone.txt': true,
      'back.txt': true,
      'still-gone.txt': false,
      sub: undefined,
      'abbrev.txt': false,
    })
  })

  it('reads a file again only when its stat changes, and leaves files past the budget unchecked', async () => {
    const root = folder()
    const file = join(root, 'f.txt')
    writeFileSync(file, 'one\n')
    const r = row('f.txt', { newSha: blobId('one\n') })
    expect((await markEditedAfterRun(root, [r]))[0]?.editedAfterRun).toBe(false)
    writeFileSync(file, 'two, longer\n')
    expect((await markEditedAfterRun(root, [r]))[0]?.editedAfterRun).toBe(true)
    unlinkSync(file)
    expect((await markEditedAfterRun(root, [r]))[0]?.editedAfterRun).toBe(true)
    writeFileSync(file, 'x'.repeat(100))
    expect((await markEditedAfterRun(root, [r], 10))[0]?.editedAfterRun).toBeUndefined()
  })

  it('leaves a saved row that names no blob (a pure rename or a mode change) unchecked', async () => {
    const root = folder()
    writeFileSync(join(root, 'moved.txt'), 'same content')
    const r = row('moved.txt', { status: 'R', oldPath: 'old.txt', oldSha: '', newSha: '' })
    expect((await markEditedAfterRun(root, [r]))[0]?.editedAfterRun).toBeUndefined()
  })

  it('checks nothing when the folder is gone', async () => {
    const rows = [row('a.txt')]
    expect(await markEditedAfterRun(join(tmpdir(), 'dim-factory-missing-folder-x'), rows)).toEqual(rows)
  })
})
