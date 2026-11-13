// Shadow snapshots against real git (a Dim Factory-owned shadow repo): byte-exact under autocrlf, untracked files included,
// the user's repo untouched, .git skipped, non-git folders, tree reuse. Honors DIM_FACTORY_TEST_GIT.
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureGit, runGit } from '../../../src/core/git/exec.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import { SHADOW_ATTRIBUTES, Shadow, openShadow } from '../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  initRepo,
  listTree,
  mtimeMs,
  sha256File,
  shadowBlob,
  shadowGit,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] shadow suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261005T120000Z-abcd'
const home = (): string => {
  const h = process.env['DIM_FACTORY_HOME']
  if (h === undefined) throw new Error('DIM_FACTORY_HOME not set by tests/setup/home.ts')
  return h
}

afterEach(() => {
  configureGit({ baseEnv: undefined })
  cleanupTemps()
})

/** Everything in a user repo's .git that Dim Factory must never change. */
function fingerprint(repo: string): Record<string, unknown> {
  const dotGit = join(repo, '.git')
  const read = (rel: string): string | null =>
    existsSync(join(dotGit, rel)) ? readFileSync(join(dotGit, rel), 'utf8') : null
  return {
    index: sha256File(join(dotGit, 'index')),
    indexMtime: mtimeMs(join(dotGit, 'index')),
    head: read('HEAD'),
    config: read('config'),
    packedRefs: read('packed-refs'),
    refs: listTree(join(dotGit, 'refs')).map((r) => `${r}=${read(join('refs', r))?.trim() ?? ''}`),
    objects: listTree(join(dotGit, 'objects')),
    logs: existsSync(join(dotGit, 'logs')) ? listTree(join(dotGit, 'logs')) : [],
    lock: existsSync(join(dotGit, 'index.lock')),
  }
}

describe(`shadow repo (${version.raw})`, () => {
  it('stores byte-exact blobs under core.autocrlf=true and never runs the user’s filters', async () => {
    const dir = tempDir('crlf')
    initRepo(dir, { autocrlf: true })
    write(
      dir,
      '.gitattributes',
      '*.txt text eol=crlf\n*.dat filter=evil\n*.enc working-tree-encoding=UTF-16LE\nident.txt ident\n',
    )
    write(dir, 'committed.txt', 'one\r\ntwo\r\n')
    git(dir, ['add', '.gitattributes', 'committed.txt'])
    git(dir, ['commit', '-q', '-m', 'attrs'])
    const files: Record<string, Buffer> = {
      'lf.txt': Buffer.from('a\nb\n'),
      'crlf.txt': Buffer.from('a\r\nb\r\n'),
      'mixed.txt': Buffer.from('a\r\nb\nc\r\n\n'),
      'lonecr.txt': Buffer.from('a\rb\r\n'),
      'noeol.txt': Buffer.from('tail\r\n\r\nend'),
      'ident.txt': Buffer.from('$Id: 0123456789abcdef $\r\n'),
      'f.dat': Buffer.from('clean me\r\n'),
      'w.enc': Buffer.from('﻿hi\r\n', 'utf16le'),
      'bin.bin': Buffer.from([0, 1, 13, 10, 255, 254, 10, 13]),
      'sub/deep/nested.txt': Buffer.from('x\r\ny\n'),
    }
    for (const [p, b] of Object.entries(files)) write(dir, p, b)

    // Global config via a fake HOME (git 2.17 has no GIT_CONFIG_GLOBAL): autocrlf, safecrlf and a required clean
    // filter that fails if it ever runs. Repo-level autocrlf=true above; system autocrlf is logged below.
    const fakeHome = tempDir('home')
    write(
      fakeHome,
      '.gitconfig',
      '[core]\n\tautocrlf = true\n\tsafecrlf = true\n[filter "evil"]\n\tclean = false\n\tsmudge = false\n\trequired = true\n',
    )
    configureGit({ baseEnv: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } })
    // the fake global config is live for every git call Dim Factory makes
    const global = await runGit(['config', '--global', '--get', 'filter.evil.clean'], { cwd: dir })
    expect(global.stdout.trim()).toBe('false')
    const system = git(dir, ['config', '--system', '--get', 'core.autocrlf'], { allowFail: true }).trim()
    console.info(`[git-compat] system core.autocrlf=${system === '' ? '(unset)' : system}`)

    const shadow = await Shadow.open(await resolveScope(dir), { home: home() })
    expect(readFileSync(join(shadow.gitDir, 'info', 'attributes'), 'utf8')).toBe(SHADOW_ATTRIBUTES)
    expect(shadowGit(shadow.gitDir, ['config', '--local', '--get', 'core.autocrlf']).trim()).toBe('false')
    const snap = await shadow.snapshot(RUN, 'run-start')
    expect(snap.unreadable).toEqual([])
    for (const [p, b] of Object.entries(files)) {
      expect(shadowBlob(shadow.gitDir, snap.commit, p).equals(b), p).toBe(true)
    }
    // A committed file whose worktree copy is CRLF (index normalized to LF by the user's autocrlf) stays CRLF.
    expect(shadowBlob(shadow.gitDir, snap.commit, 'committed.txt').toString('utf8')).toBe('one\r\ntwo\r\n')
  })

  it('includes untracked files, skips .git, and never writes the user’s index, HEAD, refs or objects', async () => {
    const dir = tempDir('iso')
    initRepo(dir)
    write(dir, '.gitignore', 'ignored/\n*.tmp\n')
    write(dir, 'ignored/tracked.txt', 'tracked though ignored\n')
    git(dir, ['add', '.gitignore'])
    git(dir, ['add', '-f', 'ignored/tracked.txt'])
    git(dir, ['commit', '-q', '-m', 'ignore rules'])
    git(dir, ['branch', 'feature'])
    git(dir, ['tag', 'v1'])
    write(dir, 'staged.txt', 'staged only\n')
    git(dir, ['add', 'staged.txt'])
    write(dir, 'untracked.txt', 'new file\n')
    write(dir, 'ignored/untracked.txt', 'ignored and untracked\n')
    write(dir, 'scratch.tmp', 'ignored by pattern\n')
    write(dir, '.git/info/exclude', 'secret.txt\n')
    write(dir, 'secret.txt', 'excluded via the user’s info/exclude\n')
    write(dir, 'nested/dir/file.txt', 'deep\n')
    const before = fingerprint(dir)

    const shadow = await openShadow(join(dir, 'nested'), { home: home() })
    expect(shadow.scopeRoot).toBe(await resolveScope(dir).then((s) => s.scopeRoot))
    const prep = await shadow.prepare()
    expect(prep.excludeSource).toBe('repo')
    expect(prep.forceAdded).toBe(1)
    const size = await shadow.sizePreflight()
    expect(size.blocked).toBe(false)
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'untracked.txt', 'changed\n')
    write(dir, 'ignored/tracked.txt', 'tracked though ignored, edited\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    await shadow.changes(s0.commit, s1.commit)
    await shadow.patch(s0.commit, s1.commit, { forPrompt: true })
    await shadow.patch(s0.commit, s1.commit)
    await shadow.liveChanged({ skipIfBusy: false })

    expect(fingerprint(dir)).toEqual(before)
    const paths = shadowTreePaths(shadow.gitDir, s0.commit)
    expect(paths).toEqual([
      '.gitignore',
      'README.md',
      'ignored/tracked.txt',
      'nested/dir/file.txt',
      'staged.txt',
      'untracked.txt',
    ])
    expect(paths.some((p) => p === '.git' || p.startsWith('.git/'))).toBe(false)
    const changed = (await shadow.changes(s0.commit, s1.commit)).map((c) => `${c.status} ${c.path}`)
    expect(changed).toEqual(['M ignored/tracked.txt', 'M untracked.txt'])
    // The shadow keeps its own ref; the user repo has none.
    expect(shadowGit(shadow.gitDir, ['rev-parse', `refs/dimfactory/runs/${RUN}`]).trim()).toBe(s1.commit)
    expect(git(dir, ['for-each-ref', '--format=%(refname)']).includes('refs/dim-factory')).toBe(false)
  })

  it('works in a non-git folder with the default excludes', async () => {
    const dir = tempDir('plain')
    write(dir, 'src/a.ts', 'export const a = 1\n')
    write(dir, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    write(dir, 'debug.log', 'noise\n')
    write(dir, 'build/out.js', 'built\n')
    write(dir, 'docs/.gitignore', 'drafts/\n')
    write(dir, 'docs/drafts/x.md', 'draft\n')
    write(dir, 'docs/guide.md', 'guide\n')
    const shadow = await openShadow(dir, { home: home() })
    expect(shadow.isRepo).toBe(false)
    expect((await shadow.prepare()).excludeSource).toBe('defaults')
    const snap = await shadow.snapshot(RUN, 'run-start')
    expect(shadowTreePaths(shadow.gitDir, snap.commit)).toEqual([
      'docs/.gitignore',
      'docs/guide.md',
      'src/a.ts',
    ])
    write(dir, 'src/b.ts', 'export const b = 2\n')
    const next = await shadow.snapshot(RUN, 'S1')
    expect((await shadow.changes(snap.commit, next.commit)).map((c) => `${c.status} ${c.path}`)).toEqual([
      'A src/b.ts',
    ])
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })

  it('reuses the previous commit when the tree is unchanged and keeps one ref per run', async () => {
    const dir = tempDir('reuse')
    initRepo(dir)
    write(dir, 'a.txt', 'a\n')
    const shadow = await openShadow(dir, { home: home() })
    const first = await shadow.snapshot(RUN, 'S0')
    expect(first.reused).toBe(false)
    const again = await shadow.snapshot(RUN, 'S1')
    expect(again.reused).toBe(true)
    expect(again.commit).toBe(first.commit)
    expect(again.tree).toBe(first.tree)
    write(dir, 'a.txt', 'b\n')
    const third = await shadow.snapshot(RUN, 'S2')
    expect(third.reused).toBe(false)
    expect(shadowGit(shadow.gitDir, ['rev-parse', `${third.commit}^`]).trim()).toBe(first.commit)
    expect(shadowGit(shadow.gitDir, ['log', '--format=%an <%ae>|%s', '-1', third.commit]).trim()).toBe(
      `Dim Factory <dim-factory@localhost>|${RUN} S2`,
    )
    // A second run in the same folder starts its own ref (no parent) and shares the object store.
    const other = await shadow.snapshot('20261005T130000Z-beef', 'run-start')
    expect(other.reused).toBe(false)
    expect(other.tree).toBe(third.tree)
    expect(await shadow.runRef(RUN)).toEqual({ commit: third.commit, tree: third.tree })
    expect(await shadow.runRef('20261005T999999Z-none')).toBeNull()
  })

  it('recovers from a stale shadow index.lock and a corrupt shadow index left by a crash', async () => {
    const dir = tempDir('crash')
    write(dir, 'a.txt', 'a\n')
    const shadow = await openShadow(dir, { home: home(), lockWaitMs: 0 })
    await shadow.snapshot(RUN, 'S0')
    const lock = join(shadow.gitDir, 'index.lock')
    writeFileSync(lock, '')
    utimesSync(lock, new Date(2000, 0, 1), new Date(2000, 0, 1))
    write(dir, 'b.txt', 'b\n')
    const s1 = await shadow.snapshot(RUN, 'interrupted')
    expect(s1.warnings.some((w) => w.includes('index.lock'))).toBe(true)
    expect(shadowTreePaths(shadow.gitDir, s1.commit)).toEqual(['a.txt', 'b.txt'])

    // a fresh lock may belong to a live git: it is respected and the snapshot fails (retryable)
    writeFileSync(lock, '')
    await expect(shadow.snapshot(RUN, 'S1')).rejects.toMatchObject({ category: 'snapshot_failed' })
    rmSync(lock)

    writeFileSync(join(shadow.gitDir, 'index'), 'garbage')
    write(dir, 'c.txt', 'c\n')
    const s2 = await shadow.snapshot(RUN, 'S2')
    expect(s2.warnings).toContain('rebuilt the shadow index (it was corrupt)')
    expect(shadowTreePaths(shadow.gitDir, s2.commit)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('reopens an existing shadow without reinitializing and survives a fresh process view', async () => {
    const dir = tempDir('reopen')
    write(dir, 'x.txt', 'x\n')
    const a = await openShadow(dir, { home: home() })
    const s = await a.snapshot(RUN, 'run-start')
    const b = await openShadow(dir, { home: home() })
    expect(b.gitDir).toBe(a.gitDir)
    expect(b.folderKey).toMatch(/^[0-9a-f]{16}$/)
    const again = await b.snapshot(RUN, 'S0')
    expect(again.commit).toBe(s.commit)
    const meta = JSON.parse(readFileSync(join(b.root, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta['schemaVersion']).toBe(1)
    expect(meta['scopeRoot']).toBe(b.scopeRoot)
  })
})
