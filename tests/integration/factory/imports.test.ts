// Queue imports through a real core: the GitHub CLI is a fake (tests/fixtures/fake-gh/gh.mjs, named by the
// DIM_FACTORY_TEST_GH seam), so nothing reaches the network.
//   - the check reads `gh --version` and `gh auth status` only; the import runs `gh issue list --json` on its click
//   - a missing gh, or one that is not signed in, is a check with copyable fixes, never a blocker; the import refuses
//     with the same words and adds nothing
//   - issues already queued are left out the second time
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { World, only, tasksSpec, value } from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

const FAKE_GH = fileURLToPath(new URL('../../fixtures/fake-gh/gh.mjs', import.meta.url))

function ghLog(file: string): string[][] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
  } catch {
    return []
  }
}

describe('import from GitHub issues', () => {
  it('checks gh without listing anything, then imports the open issues on the click, once', async () => {
    const w = await world.setup(tasksSpec([]))
    const log = join(mkdtempSync(join(tmpdir(), 'dim-run-ghlog-')), 'gh.jsonl')
    world.dirs.push(log)
    const { core } = await world.boot(w, {}, { DIM_FACTORY_TEST_GH: FAKE_GH, FAKE_GH_LOG: log })
    const check = value(await core.invoke('queue.githubCheck', { folder: w.folder }))
    expect(check.gh).toMatchObject({ installed: true, authenticated: true, version: '2.99.0', fixes: [] })
    expect(ghLog(log).map((a) => a.slice(0, 2).join(' '))).toEqual(['--version', 'auth status'])

    const r = value(await core.invoke('queue.importGithub', { folder: w.folder }))
    expect(r).toMatchObject({ added: 2, skipped: 0, overLimit: 0 })
    expect(ghLog(log).at(-1)).toEqual([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,title,body,url',
    ])
    const q = only(value(await core.invoke('queue.get')))
    // Oldest first; each task is the issue's title, where it came from, and its text.
    expect(q.tasks.map((t) => [t.title, t.source])).toEqual([
      ['Fix the help text', { kind: 'github', number: 9, url: 'https://github.com/acme/shop/issues/9' }],
      ['Add a --version flag', { kind: 'github', number: 12, url: 'https://github.com/acme/shop/issues/12' }],
    ])
    expect(q.tasks[1]?.task).toBe(
      'Add a --version flag\n\nGitHub issue #12 (https://github.com/acme/shop/issues/12).\n\nThe CLI should print its version.',
    )
    // Nothing starts on an import.
    expect(q.state).toBe('idle')
    const again = value(await core.invoke('queue.importGithub', { folder: w.folder }))
    expect(again).toMatchObject({ added: 0, skipped: 2 })
  }, 120_000)

  it('a gh that is not signed in is a non-blocking check with the fix to copy; the import adds nothing', async () => {
    const w = await world.setup(tasksSpec([]))
    const { core } = await world.boot(w, {}, { DIM_FACTORY_TEST_GH: FAKE_GH, FAKE_GH_AUTH: 'out' })
    const check = value(await core.invoke('queue.githubCheck', { folder: w.folder }))
    expect(check.gh).toMatchObject({
      installed: true,
      authenticated: false,
      problem:
        'gh is not signed in to GitHub. Sign in in a terminal (Dim Factory never asks for or stores a token).',
    })
    expect(check.gh.fixes).toEqual([expect.objectContaining({ id: 'gh:login', command: 'gh auth login' })])
    const r = await core.invoke('queue.importGithub', { folder: w.folder })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT')
      expect(r.error.message).toBe(check.gh.problem)
    }
    expect(value(await core.invoke('queue.get')).folders).toEqual([])
  }, 120_000)

  it('a missing gh offers the install and sign-in to copy', async () => {
    const w = await world.setup(tasksSpec([]))
    const { core } = await world.boot(w, {}, { DIM_FACTORY_TEST_GH: 'none' })
    const check = value(await core.invoke('queue.githubCheck', { folder: w.folder }))
    expect(check.gh).toMatchObject({ installed: false, authenticated: false })
    expect(check.gh.fixes.map((f) => f.id)).toEqual(['gh:install', 'gh:login'])
  }, 120_000)
})

describe('import from a TODO file', () => {
  it('a named file, relative to the folder; a missing one is NOT_FOUND', async () => {
    const w = await world.setup(tasksSpec([]), {}, { files: { 'notes.md': '1. [ ] numbered item\n' } })
    const { core } = await world.boot(w)
    expect(
      value(await core.invoke('queue.importTodo', { folder: w.folder, file: 'notes.md' })),
    ).toMatchObject({
      added: 1,
      from: 'notes.md',
    })
    const missing = await core.invoke('queue.importTodo', { folder: w.folder })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND')
  }, 120_000)
})
