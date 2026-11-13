// Copy-ins (isolated run Prepare step 2: `isolation.worktree.copy` globs; ignored
// or untracked files only). Tracked files are refused (the run uses the committed version), a link or junction is
// never followed on either side, a glob outside the folder (absolute, `..`, `~`) or into `.git` is refused, nothing in
// the run's copy is overwritten, nested repositories are left alone, and the limits stop a runaway glob.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyIns, expandBraces } from '../../../../src/core/prepare/copyIns.ts'
import type { CopyInOptions, TrackedFiles } from '../../../../src/core/prepare/copyIns.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'

let folder = ''
let wt = ''
let outside = ''
beforeEach(() => {
  folder = tempDir('dim-factory-copy-src-')
  wt = tempDir('dim-factory-copy-wt-')
  outside = tempDir('dim-factory-copy-out-')
})
afterEach(() => {
  for (const d of [folder, wt, outside]) removeDir(d)
})

const tracked = (files: string[], gitlinks: string[] = []): NonNullable<CopyInOptions['tracked']> => {
  const t: TrackedFiles = { files: new Set(files), gitlinks }
  return () => Promise.resolve(t)
}

/** A directory link: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function dirLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')

describe('copyIns', () => {
  it('copies ignored and untracked files the globs match; a tracked file is refused', async () => {
    writeFiles(folder, {
      '.env': 'SECRET=1\n',
      '.env.local': 'LOCAL=1\n',
      'config/dev.local.json': '{}\n',
      'config/app.json': '{"tracked":true}\n',
      'src/index.ts': 'export {}\n',
    })
    const r = await copyIns(folder, wt, ['.env*', 'config/*.json'], {
      tracked: tracked(['config/app.json', 'src/index.ts']),
    })
    expect(r.copied.sort()).toEqual(['.env', '.env.local', 'config/dev.local.json'])
    expect(r.skipped).toEqual([
      { path: 'config/app.json', reason: 'It is tracked by git: the run uses the committed version' },
    ])
    expect(r.refused).toEqual([])
    expect(read(wt, '.env')).toBe('SECRET=1\n')
    expect(read(wt, 'config/dev.local.json')).toBe('{}\n')
    expect(existsSync(join(wt, 'config/app.json'))).toBe(false)
    expect(existsSync(join(wt, 'src'))).toBe(false)
    expect(r.bytes).toBe('SECRET=1\n'.length + 'LOCAL=1\n'.length + 3)
  })

  it('a plain path names a file or a whole folder; ** reaches any depth; {a,b} alternatives', async () => {
    writeFiles(folder, {
      'certs/dev.pem': 'pem\n',
      'certs/nested/ca.pem': 'ca\n',
      'packages/a/.env': 'a\n',
      'packages/b/deep/.env': 'b\n',
      'packages/b/deep/other.txt': 'x\n',
      'one.txt': '1\n',
      'two.txt': '2\n',
      'three.txt': '3\n',
    })
    const r = await copyIns(folder, wt, ['certs', 'packages/**/.env', '{one,two}.txt'], {
      tracked: tracked([]),
    })
    expect(r.copied.sort()).toEqual([
      'certs/dev.pem',
      'certs/nested/ca.pem',
      'one.txt',
      'packages/a/.env',
      'packages/b/deep/.env',
      'two.txt',
    ])
    expect(expandBraces('a/{x,y}/{1,2}')).toEqual(['a/x/1', 'a/x/2', 'a/y/1', 'a/y/2'])
  })

  it('a plain path that is not there is listed as not found', async () => {
    const r = await copyIns(folder, wt, ['.env', 'config/dev.env', 'config/*.env'], { tracked: tracked([]) })
    expect(r.copied).toEqual([])
    expect(r.skipped).toEqual([
      { path: '.env', reason: 'Not found in the folder' },
      { path: 'config/dev.env', reason: 'Not found in the folder' },
    ])
  })

  it('globs outside the folder or into .git are refused as written', async () => {
    writeFiles(folder, { '.git/config': '[core]\n', 'a.txt': 'a\n' })
    const globs = [
      '',
      '../x',
      'sub/../../x',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '~/.ssh/id_rsa',
      '.git/config',
      '**/.git/**',
      '.',
    ]
    const r = await copyIns(folder, wt, globs, { tracked: tracked([]) })
    expect(r.copied).toEqual([])
    expect(r.refused.map((x) => x.glob)).toEqual(globs)
    expect(r.refused.map((x) => x.reason)).toEqual([
      'It is empty',
      'It is outside the folder',
      'It is outside the folder',
      'It is outside the folder',
      'It is outside the folder',
      'It is outside the folder',
      "Dim Factory never copies git's own files",
      "Dim Factory never copies git's own files",
      'It names the whole folder',
    ])
    expect(readdirSync(wt)).toEqual([])
  })

  it('.git is never walked: ** copies the untracked files only', async () => {
    writeFiles(folder, { '.git/HEAD': 'ref: refs/heads/main\n', 'notes.md': 'n\n', 'src/a.ts': 'a\n' })
    const r = await copyIns(folder, wt, ['**'], { tracked: tracked(['src/a.ts']) })
    expect(r.copied).toEqual(['notes.md'])
    expect(existsSync(join(wt, '.git'))).toBe(false)
  })

  it('never copies through a link or junction in the folder', async () => {
    writeFiles(outside, { 'secret.txt': 'outside\n' })
    writeFiles(folder, { 'local/ok.txt': 'ok\n' })
    dirLink(outside, join(folder, 'linked'))
    dirLink(outside, join(folder, 'local', 'inner'))
    const r = await copyIns(folder, wt, ['linked/secret.txt', 'linked', 'local/**', '**/secret.txt'], {
      tracked: tracked([]),
    })
    expect(r.copied).toEqual(['local/ok.txt'])
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { path: 'linked', reason: 'It is a link: Dim Factory never copies through links' },
        { path: 'local/inner', reason: 'It is a link: Dim Factory never copies through links' },
      ]),
    )
    expect(existsSync(join(wt, 'linked'))).toBe(false)
    expect(existsSync(join(wt, 'local', 'inner'))).toBe(false)
  })

  it('never writes through a link or junction in the run’s copy, and never over its files', async () => {
    writeFiles(folder, { 'config/dev.env': 'dev\n', 'README.md': 'mine\n', 'data/x.db': 'db\n' })
    dirLink(outside, join(wt, 'config'))
    writeFiles(wt, { 'README.md': 'committed\n', data: 'a file where the folder is\n' })
    const r = await copyIns(folder, wt, ['config/dev.env', 'README.md', 'data/x.db'], {
      tracked: tracked([]),
    })
    expect(r.copied).toEqual([])
    expect(r.skipped).toEqual([
      { path: 'config/dev.env', reason: "The run's copy has a link at config" },
      { path: 'README.md', reason: "The run's copy already has it" },
      { path: 'data/x.db', reason: "The run's copy has a file at data" },
    ])
    expect(readdirSync(outside)).toEqual([])
    expect(read(wt, 'README.md')).toBe('committed\n')
  })

  it('nested repositories and gitlinks are left alone', async () => {
    writeFiles(folder, { 'vendor/lib/.git/HEAD': 'x\n', 'vendor/lib/file.c': 'c\n', 'sub/m/x.txt': 'x\n' })
    const r = await copyIns(folder, wt, ['vendor/**', 'sub/m/x.txt'], {
      tracked: tracked(['sub/m'], ['sub/m']),
    })
    expect(r.copied).toEqual([])
    expect(r.skipped).toEqual([
      { path: 'vendor/lib', reason: 'It is a nested repository' },
      { path: 'sub/m/x.txt', reason: 'It is inside a nested repository' },
    ])
  })

  it('tracked paths compare without case on Windows and macOS', async () => {
    writeFiles(folder, { 'Config.JSON': '{}\n' })
    const win = await copyIns(folder, wt, ['*.json'], {
      tracked: tracked(['config.json']),
      platform: 'win32',
    })
    expect(win.copied).toEqual([])
    expect(win.skipped[0]?.reason).toMatch(/tracked/)
  })

  it('when the tracked files cannot be listed, nothing is copied', async () => {
    writeFiles(folder, { '.env': 'x\n' })
    const r = await copyIns(folder, wt, ['.env'], { tracked: () => Promise.resolve(null) })
    expect(r.copied).toEqual([])
    expect(r.refused).toEqual([
      { glob: '.env', reason: 'Dim Factory could not list the tracked files, so it copies nothing' },
    ])
  })

  it('stops at the file, byte and entry limits', async () => {
    writeFiles(folder, { 'a/1': '1\n', 'a/2': '2\n', 'a/3': '3\n', 'big.bin': 'x'.repeat(100) })
    const files = await copyIns(folder, wt, ['a/*'], { tracked: tracked([]), maxFiles: 2 })
    expect(files.copied).toEqual(['a/1', 'a/2'])
    expect(files).toMatchObject({ truncated: true })
    expect(files.skipped.at(-1)?.reason).toBe('Stopped after 2 files')

    const wt2 = tempDir('dim-factory-copy-wt2-')
    try {
      const bytes = await copyIns(folder, wt2, ['big.bin'], { tracked: tracked([]), maxBytes: 50 })
      expect(bytes.copied).toEqual([])
      expect(bytes.truncated).toBe(true)
      const visited = await copyIns(folder, wt2, ['**/nothing'], { tracked: tracked([]), maxVisited: 2 })
      expect(visited.truncated).toBe(true)
      expect(visited.skipped.at(-1)?.reason).toBe('Stopped after looking at 2 files and folders')
    } finally {
      removeDir(wt2)
    }
  })

  it('the run’s copy must be a real folder', async () => {
    writeFiles(folder, { '.env': 'x\n' })
    const linkedWt = join(outside, 'wt-link')
    mkdirSync(join(outside, 'real'))
    dirLink(join(outside, 'real'), linkedWt)
    const r = await copyIns(folder, linkedWt, ['.env'], { tracked: tracked([]) })
    expect(r.copied).toEqual([])
    expect(r.refused[0]?.reason).toMatch(/is not a folder/)
    expect(readdirSync(join(outside, 'real'))).toEqual([])
  })
})
