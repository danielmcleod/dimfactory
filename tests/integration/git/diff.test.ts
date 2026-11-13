// Diff segments, the prompt patch and the live files-changed count against real git.
import { rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openShadow } from '../../../src/core/git/shadow.ts'
import type { Shadow } from '../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  initRepo,
  shadowGit,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] diff suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261005T120000Z-d1ff'
const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

afterEach(() => cleanupTemps())

const lines = (n: number, tag: string, eol = '\n'): string =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} with some text to make it realistic`).join(eol) + eol

async function scenario(): Promise<{ dir: string; shadow: Shadow; s0: string; s1: string }> {
  const dir = tempDir('diff')
  initRepo(dir)
  write(dir, 'keep.txt', 'unchanged\n')
  write(dir, 'mod.txt', lines(10, 'mod'))
  write(dir, 'del.txt', 'to be deleted\n')
  write(dir, 'ren-old.txt', lines(40, 'rename'))
  write(dir, 'img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]))
  write(dir, 'eol.txt', lines(5, 'eol', '\r\n'))
  write(dir, 'package-lock.json', lines(50, '"dep"'))
  write(dir, 'dist/app.min.js', 'var a=1;\n')
  write(dir, '.gitattributes', 'gen/** linguist-generated\n')
  write(dir, 'gen/api.ts', lines(5, 'gen'))
  write(dir, 'big.txt', lines(20, 'big'))
  const shadow = await openShadow(dir, { home: home() })
  const s0 = (await shadow.snapshot(RUN, 'S0')).commit

  write(dir, 'mod.txt', lines(10, 'mod').replace('mod line 3 ', 'MOD LINE 3 '))
  rmSync(join(dir, 'del.txt'))
  write(dir, 'dir/ren-new.txt', lines(40, 'rename'))
  rmSync(join(dir, 'ren-old.txt'))
  write(dir, 'img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 9, 9]))
  write(dir, 'eol.txt', lines(5, 'eol', '\n'))
  write(dir, 'package-lock.json', lines(80, '"dep2"'))
  write(dir, 'dist/app.min.js', 'var a=2;\n')
  write(dir, 'gen/api.ts', lines(7, 'gen2'))
  write(dir, 'big.txt', lines(400, 'BIG'))
  write(dir, 'new.txt', 'brand new\n')
  const s1 = (await shadow.snapshot(RUN, 'S1')).commit
  return { dir, shadow, s0, s1 }
}

describe(`diffs (${version.raw})`, () => {
  it('changes(): raw + numstat merged — A/M/D/R, binary, EOL-only', async () => {
    const { shadow, s0, s1 } = await scenario()
    const changes = await shadow.changes(s0, s1)
    const by = new Map(changes.map((c) => [c.path, c]))
    expect(changes.map((c) => `${c.status} ${c.path}`)).toEqual([
      'M big.txt',
      'D del.txt',
      'R dir/ren-new.txt',
      'M dist/app.min.js',
      'M eol.txt',
      'M gen/api.ts',
      'M img.png',
      'M mod.txt',
      'A new.txt',
      'M package-lock.json',
    ])
    expect(by.get('mod.txt')).toMatchObject({ added: 1, deleted: 1, binary: false, eolOnly: false })
    expect(by.get('dir/ren-new.txt')).toMatchObject({ oldPath: 'ren-old.txt', added: 0, deleted: 0 })
    expect(by.get('img.png')).toMatchObject({ binary: true, added: null, deleted: null, eolOnly: false })
    expect(by.get('eol.txt')).toMatchObject({ added: 5, deleted: 5, eolOnly: true })
    expect(by.get('new.txt')).toMatchObject({ oldMode: '000000', newMode: '100644', added: 1, deleted: 0 })
    expect(by.get('del.txt')).toMatchObject({ newMode: '000000', newSha: '0'.repeat(40) })
    expect(changes.every((c) => !c.gitlink)).toBe(true)
  })

  it('patch(): UI patch keeps CRLF changes unless ignoreEol', async () => {
    const { shadow, s0, s1 } = await scenario()
    const ui = await shadow.patch(s0, s1)
    expect(ui.text).toContain('diff --git a/mod.txt b/mod.txt')
    expect(ui.text).toContain('diff --git a/eol.txt b/eol.txt')
    expect(ui.text).toContain('-eol line 0 with some text to make it realistic\r\n')
    expect(ui.text).toMatch(/Binary files a\/img\.png and b\/img\.png differ/)
    expect(ui.text).not.toContain('GIT binary patch')
    const ignoring = await shadow.patch(s0, s1, { ignoreEol: true })
    expect(ignoring.text).not.toContain('-eol line 0')
  })

  it('patch({forPrompt}): header, collapsed lockfile/minified/generated/binary, EOL-only list, cap stubs', async () => {
    const { shadow, s0, s1 } = await scenario()
    const full = await shadow.patch(s0, s1, { forPrompt: true })
    expect(full.text.startsWith('Files changed (10):\n')).toBe(true)
    expect(full.text).toContain('M mod.txt +1 -1\n')
    expect(full.text).toContain('R ren-old.txt -> dir/ren-new.txt +0 -0\n')
    expect(full.text).toContain('M eol.txt (line endings only)\n')
    expect(full.text).toContain('Line endings only (1): eol.txt\n')
    expect(full.text).not.toContain('diff --git a/eol.txt')
    expect(full.collapsed.sort()).toEqual(['dist/app.min.js', 'gen/api.ts', 'img.png', 'package-lock.json'])
    expect(full.text).toContain('[collapsed: package-lock.json +80 -50 (lockfile)]')
    expect(full.text).toContain('[collapsed: img.png (binary) (binary)]')
    expect(full.text).toContain('[collapsed: gen/api.ts +7 -5 (generated)]')
    expect(full.text).not.toContain('diff --git a/package-lock.json')
    expect(full.text).toContain('diff --git a/mod.txt b/mod.txt')
    expect(full.eolOnly).toEqual(['eol.txt'])
    expect(full.omitted).toEqual([])
    expect(full.capBytes).toBe(150 * 1024)

    const small = await shadow.patch(s0, s1, { forPrompt: true, maxBytes: 4000 })
    expect(small.bytes).toBeLessThanOrEqual(4000)
    expect(small.omitted[0]).toBe('big.txt')
    expect(small.text).toContain('[diff omitted: big.txt +400 -20 — read the file if needed]')
    expect(small.text).toContain('Files changed (10):')

    const tinyWindow = await shadow.patch(s0, s1, { forPrompt: true, contextWindow: 4000 })
    expect(tinyWindow.capBytes).toBe(3500)
    expect(tinyWindow.bytes).toBeLessThanOrEqual(3500)
  })

  it('reports gitlinks (160000) for nested repositories', async () => {
    const dir = tempDir('gitlink')
    write(dir, 'top.txt', 'top\n')
    const sub = join(dir, 'sub')
    write(dir, 'sub/inner.txt', 'inner\n')
    initRepo(sub)
    const shadow = await openShadow(dir, { home: home() })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(s0.warnings.some((w) => /embedded git repository/i.test(w))).toBe(true)
    write(dir, 'sub/README.md', '# changed\n')
    git(sub, ['commit', '-q', '-am', 'second'])
    const s1 = await shadow.snapshot(RUN, 'S1')
    const changes = await shadow.changes(s0.commit, s1.commit)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: 'sub', status: 'M', gitlink: true, oldMode: '160000' })
    const prompt = await shadow.patch(s0.commit, s1.commit, { forPrompt: true })
    expect(prompt.text).toContain('M sub (submodule)')
  })

  it('liveChanged(): modified ∪ deleted ∪ untracked since the last snapshot; skips while a snapshot runs', async () => {
    const { dir, shadow } = await scenario()
    expect(await shadow.liveChanged()).toEqual([])
    write(dir, 'keep.txt', 'now changed\n')
    rmSync(join(dir, 'new.txt'))
    write(dir, 'fresh/one.txt', '1\n')
    renameSync(join(dir, 'mod.txt'), join(dir, 'moved.txt'))
    write(dir, 'debug.tmp.log', 'x\n')
    expect(await shadow.liveChanged()).toEqual([
      'debug.tmp.log',
      'fresh/one.txt',
      'keep.txt',
      'mod.txt',
      'moved.txt',
      'new.txt',
    ])
    const pending = shadow.snapshot(RUN, 'stopped')
    expect(shadow.busy).toBe(true)
    expect(await shadow.liveChanged()).toBeNull()
    await pending
    expect(await shadow.liveChanged()).toEqual([])
    expect(shadowGit(shadow.gitDir, ['rev-parse', `refs/dimfactory/runs/${RUN}`]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    )
  })
})
