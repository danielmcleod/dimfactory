// "Make an upload file": the zip of a static deliverable for drag-and-drop hosting. What goes in (the served folder,
// less hidden files, node_modules, keys and credential files, memory and agent notes, Dim Factory's own files and
// every link), the game allowance (only the node_modules files the page loads, their relative imports and the
// package's licence), a link out of the folder never followed, the size and file caps, the secret scanner's refusal
// with the list, where the zip goes (next to the project; a file of the user's is never replaced), and the zip itself
// (round-trips through inflate).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UPLOAD_ZIP_COMMENT,
  makeUploadFile,
  uploadFilePath,
  uploadSkipReason,
  uploadView,
} from '@core/deploy/upload.ts'
import { readZip, readZipFile } from '@core/deploy/zip.ts'
import { emptySignals } from '@core/deploy/signals.ts'
import type { DeployUploadResult } from '@shared/deploy.ts'

const FAKE_AWS = ['AKIA', 'QWERTYUIOPASDFGH'].join('')

let root: string
let project: string

function write(rel: string, content: string | Buffer = 'x'): void {
  const p = join(project, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function made(r: DeployUploadResult): Extract<DeployUploadResult, { status: 'made' }> {
  if (r.status !== 'made') throw new Error(`refused: ${r.reason} ${r.evidence.join(', ')}`)
  return r
}

async function names(path: string): Promise<string[]> {
  const z = await readZipFile(path)
  if (z === null) throw new Error('not a zip')
  return z.entries.map((e) => e.name).sort()
}

/** One entry's bytes, read back through its local header (inflated when deflated). */
function entryData(zip: Buffer, name: string): Buffer {
  const z = readZip(zip)
  const e = z?.entries.find((x) => x.name === name)
  if (e === undefined) throw new Error(`no ${name}`)
  const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28)
  const body = zip.subarray(start, start + e.compressed)
  return e.method === 8 ? inflateRawSync(body) : Buffer.from(body)
}

const opts = (
  over: Partial<Parameters<typeof makeUploadFile>[0]> = {},
): Parameters<typeof makeUploadFile>[0] => ({
  folder: project,
  dir: '.',
  outDir: root,
  baseName: 'My Shop',
  game: false,
  ...over,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dimf-upload-'))
  project = join(root, 'My Shop')
  mkdirSync(project)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('what is left out', () => {
  it.each([
    ['.env', 'hidden'],
    ['.env.local', 'hidden'],
    ['.git/config', 'hidden'],
    ['assets/.DS_Store', 'hidden'],
    ['node_modules/three/build/three.module.js', 'node_modules'],
    ['DIM_FACTORY.md', 'notes'],
    ['docs/CLAUDE.md', 'notes'],
    ['AGENTS.md', 'notes'],
    ['playtest.json', 'internal'],
    ['id_rsa', 'key'],
    ['certs/server.pem', 'key'],
    ['signing.p12', 'key'],
    ['client_secret.json', 'key'],
    ['firebase-adminsdk-abc.json', 'key'],
    ['prod.env', 'key'],
  ])('%s (%s)', (rel, why) => {
    expect(uploadSkipReason(rel)).toBe(why)
  })

  it.each(['index.html', 'src/main.js', 'secret-level.js', 'tokens.css', 'docs/playtest.json', 'README.md'])(
    'keeps %s',
    (rel) => {
      expect(uploadSkipReason(rel)).toBeNull()
    },
  )
})

describe('makeUploadFile', () => {
  it('zips the served folder next to the project, leaving out hidden files, node_modules, keys and notes', async () => {
    write('index.html', '<!doctype html><title>Shop</title><link rel="stylesheet" href="style.css">')
    write('style.css', 'body { color: #333 }\n'.repeat(50))
    write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    write('pages/about.html', '<p>About</p>')
    write('.env', 'API=1')
    write('.git/config', '[core]')
    write('.dimfactory/dimfactory.json', '{}')
    write('node_modules/left-pad/index.js', 'module.exports = 1')
    write('DIM_FACTORY.md', '# Memory')
    write('CLAUDE.md', '# Notes')
    write('playtest.json', '{}')
    write('id_rsa', 'not a real key')
    write('server.key', 'not a real key')
    const r = made(await makeUploadFile(opts()))
    expect(r.path).toBe(join(root, 'My-Shop-site.zip'))
    expect(r.name).toBe('My-Shop-site.zip')
    expect(r.files).toBe(4)
    expect(r.skipped).toBeGreaterThanOrEqual(9)
    expect(await names(r.path)).toEqual(['img/logo.png', 'index.html', 'pages/about.html', 'style.css'])
    const zip = readFileSync(r.path)
    expect(readZip(zip)?.comment).toBe(UPLOAD_ZIP_COMMENT)
    expect(entryData(zip, 'style.css').toString('utf8')).toBe('body { color: #333 }\n'.repeat(50))
    expect([...entryData(zip, 'img/logo.png')]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    // Nothing was written into the project.
    expect(readZip(readFileSync(r.path))?.entries.some((e) => e.name.endsWith('.zip'))).toBe(false)
  })

  it('zips only the build folder when the site is built', async () => {
    write('package.json', '{"name":"shop"}')
    write('src/main.ts', 'export {}')
    write('dist/index.html', '<p>built</p>')
    write('dist/assets/app.js', 'console.log(1)')
    const r = made(await makeUploadFile(opts({ dir: 'dist' })))
    expect(r.dir).toBe('dist')
    expect(await names(r.path)).toEqual(['assets/app.js', 'index.html'])
  })

  it('refuses a folder with no index.html, and a missing build folder', async () => {
    write('readme.txt', 'hi')
    const a = await makeUploadFile(opts())
    expect(a.status).toBe('refused')
    const b = await makeUploadFile(opts({ dir: 'dist' }))
    expect(b.status).toBe('refused')
  })

  it('a game gets only the node_modules files its page loads, their relative imports and the licence', async () => {
    write(
      'index.html',
      '<script type="importmap">{"imports":{"three":"./node_modules/three/build/three.module.js"}}</script>' +
        '<script type="module" src="src/main.js"></script>',
    )
    write('src/main.js', "import * as THREE from 'three'\n")
    write('node_modules/three/build/three.module.js', "import { A } from './three.core.js'\nexport { A }\n")
    write('node_modules/three/build/three.core.js', 'export const A = 1\n')
    write('node_modules/three/build/three.cjs', 'module.exports = {}\n')
    write('node_modules/three/build/three.webgpu.js', 'export {}\n')
    write('node_modules/three/package.json', '{"name":"three"}')
    write('node_modules/three/LICENSE', 'MIT')
    write('node_modules/other/index.js', 'export {}')
    write('package.json', '{"dependencies":{"three":"^0.186.1"}}')
    const r = made(await makeUploadFile(opts({ game: true })))
    expect(await names(r.path)).toEqual([
      'index.html',
      'node_modules/three/LICENSE',
      'node_modules/three/build/three.core.js',
      'node_modules/three/build/three.module.js',
      'package.json',
      'src/main.js',
    ])
    // The same folder as a plain site: node_modules stays out.
    const plain = made(await makeUploadFile(opts({ game: false })))
    expect((await names(plain.path)).some((n) => n.startsWith('node_modules/'))).toBe(false)
  })

  it('a game whose page loads a module that is not installed is refused with the file named', async () => {
    write(
      'index.html',
      '<script type="importmap">{"imports":{"three":"./node_modules/three/build/three.module.js"}}</script>',
    )
    const r = await makeUploadFile(opts({ game: true }))
    expect(r.status).toBe('refused')
    if (r.status === 'refused') {
      expect(r.reason).toContain('npm install')
      expect(r.evidence).toEqual(['node_modules/three/build/three.module.js'])
    }
  })

  it('a reference that climbs out of node_modules is ignored', async () => {
    write('index.html', '<script src="./node_modules/../../secret.js"></script>')
    writeFileSync(join(root, 'secret.js'), 'x')
    const r = made(await makeUploadFile(opts({ game: true })))
    expect(await names(r.path)).toEqual(['index.html'])
  })

  it('never follows a link out of the folder', async () => {
    write('index.html', '<p>x</p>')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.txt'), 'private')
    // A junction needs no special rights on Windows; elsewhere it is an ordinary directory link.
    symlinkSync(outside, join(project, 'linked'), 'junction')
    const r = made(await makeUploadFile(opts()))
    expect(await names(r.path)).toEqual(['index.html'])
    expect(r.skipped).toBeGreaterThanOrEqual(1)
  })

  it('refuses a build folder that is a link to a folder outside the project', async () => {
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    writeFileSync(join(outside, 'index.html'), '<p>x</p>')
    symlinkSync(outside, join(project, 'dist'), 'junction')
    const r = await makeUploadFile(opts({ dir: 'dist' }))
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toContain('outside the project')
  })

  it('refuses past the size and file caps', async () => {
    write('index.html', 'x'.repeat(2000))
    write('a.js', 'x'.repeat(2000))
    write('b.js', 'x')
    const big = await makeUploadFile(opts({ maxBytes: 1000 }))
    expect(big.status).toBe('refused')
    if (big.status === 'refused') expect(big.reason).toContain('MB')
    const many = await makeUploadFile(opts({ maxFiles: 2 }))
    expect(many.status).toBe('refused')
    if (many.status === 'refused') expect(many.reason).toContain('more than 2 files')
  })

  it('refuses when the secret scanner finds one, with the list (masked), and writes no zip', async () => {
    write('index.html', '<p>x</p>')
    write('js/config.js', `const key = "${FAKE_AWS}"\n`)
    const r = await makeUploadFile(opts())
    expect(r.status).toBe('refused')
    if (r.status === 'refused') {
      expect(r.reason).toContain('secret scanner')
      expect(r.evidence).toHaveLength(1)
      expect(r.evidence[0]).toContain('js/config.js:1')
      expect(r.evidence[0]).not.toContain(FAKE_AWS)
    }
    expect(await readZipFile(join(root, 'My-Shop-site.zip'))).toBeNull()
  })
})

describe('where the zip goes', () => {
  it('replaces an earlier upload file, never a file of the user', async () => {
    write('index.html', '<p>1</p>')
    const first = made(await makeUploadFile(opts()))
    const again = made(await makeUploadFile(opts()))
    expect(again.path).toBe(first.path)
    writeFileSync(join(root, 'Other-site.zip'), 'my own file')
    expect(await uploadFilePath(root, 'Other')).toBe(join(root, 'Other-site-2.zip'))
    expect(readFileSync(join(root, 'Other-site.zip'), 'utf8')).toBe('my own file')
  })

  it('a folder name that is not plain makes a plain file name', async () => {
    expect(await uploadFilePath(root, '..')).toBe(join(root, 'site-site.zip'))
    expect(await uploadFilePath(root, 'Café & bar')).toBe(join(root, 'Caf-bar-site.zip'))
  })

  it('refuses when the zip would land inside the folder it zips', async () => {
    write('index.html', '<p>x</p>')
    const r = await makeUploadFile(opts({ outDir: project }))
    expect(r.status).toBe('refused')
  })
})

describe('uploadView', () => {
  it('is offered for the static classes only, ready once index.html is there', async () => {
    const s = { ...emptySignals('shop'), html: true, files: ['index.html'] }
    expect(await uploadView(project, s, 'server-app', { game: false })).toBeUndefined()
    const before = await uploadView(project, s, 'static-site', { game: false })
    expect(before).toMatchObject({ dir: '.', ready: false })
    write('index.html', '<p>x</p>')
    expect(await uploadView(project, s, 'static-site', { game: true })).toEqual({
      dir: '.',
      ready: true,
      game: true,
    })
    const spa = await uploadView(
      project,
      {
        ...emptySignals('shop'),
        pkg: { deps: ['vite'], scripts: {}, private: true, library: false, bin: false },
      },
      'spa',
      { game: false },
    )
    expect(spa).toMatchObject({ dir: 'dist', ready: false })
    expect(spa?.problem).toContain('Build the project first')
  })
})
