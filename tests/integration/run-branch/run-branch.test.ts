// Run branch through a real core and the fake Claude (branch prep; state-machine row R5; "cancel at plan gate
// leaves no dim/* ref"):
//   - `isolation.branch: runBranch` makes the branch at R5, with a dirty tree: every working file, the user's index
//     and the refs other than the new branch stay byte-identical; RunSnapshot.branch {name, base, previous}
//   - end of run: Delete refused while checked out (copyable commands) → Return → Delete → a second Return refused
//   - cancel at the plan gate: no dim/* ref, HEAD where it was
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  World,
  allowAsks,
  choose,
  gitOut,
  gitTry,
  settled,
  sha256,
  snapshotOf,
  value,
  versionWrite,
  waitCard,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const SPEC = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
}

describe('run branch (core + git + fake Claude)', () => {
  it('runBranch: made at R5 on a dirty tree (files, index, refs byte-identical); return and delete with the guards', async () => {
    const b = await w.boot(SPEC)
    const f = b.folder
    const prev = gitOut(f, 'symbolic-ref', 'HEAD')
    const base = gitOut(f, 'rev-parse', 'HEAD')
    // A dirty tree: a modified tracked file, a staged change, an untracked file (CRLF bytes kept as they are).
    writeFileSync(
      join(f, 'src/index.ts'),
      `${readFileSync(join(f, 'src/index.ts'), 'utf8')}// local edit\r\n`,
    )
    writeFileSync(join(f, 'package.json'), `${readFileSync(join(f, 'package.json'), 'utf8')}\n`)
    gitOut(f, 'add', 'package.json')
    writeFileSync(join(f, 'scratch.txt'), 'notes\r\nmore\r\n')
    const files = ['src/index.ts', 'package.json', 'scratch.txt', 'src/cli.ts']
    const before = Object.fromEntries(files.map((p) => [p, sha256(join(f, p))]))
    const index = sha256(join(f, '.git', 'index'))
    const staged = gitOut(f, 'diff', '--cached', '--name-only')

    const started = value(
      await b.core.invoke('runs.start', {
        folder: f,
        task: 'add a --version flag',
        overrides: { gates: { afterPlan: false }, isolation: { branch: 'runBranch' } },
      }),
    )
    const c = b.core.controller(started.runId)
    if (c === undefined) throw new Error('no controller')
    const t = { ...b, c, runId: started.runId }
    allowAsks(t)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status, done.notes.join(' | ')).toBe('completed')

    const branch = done.branch
    expect(branch?.name).toMatch(/^dim\/\d{8}-add-a-version-flag$/)
    expect(branch).toEqual({ name: branch?.name, base, previous: prev })
    expect((await snapshotOf(t)).branch).toEqual(branch)
    expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branch?.name}`)
    expect(gitOut(f, 'rev-parse', `refs/heads/${branch?.name}`)).toBe(base)
    expect(gitOut(f, 'rev-parse', prev)).toBe(base)
    // Byte-identical: every file the user had, the index (staged change included).
    for (const p of files) expect(sha256(join(f, p)), p).toBe(before[p])
    expect(sha256(join(f, '.git', 'index'))).toBe(index)
    expect(gitOut(f, 'diff', '--cached', '--name-only')).toBe(staged)
    expect(readFileSync(join(f, 'src/version.ts'), 'utf8')).toBe(versionWrite.content)
    expect(done.notes).toContain(`Working on the run branch ${branch?.name}.`)

    // Delete is refused while the branch is checked out; core says why and what to run instead.
    const refused = value(await b.core.invoke('runs.branch', { runId: t.runId, action: 'delete' }))
    expect(refused.done).toBe(false)
    expect(refused.reason).toContain('is checked out')
    expect(refused.commands.join('\n')).toContain('git checkout')
    // Return: HEAD back on the previous branch (it still points at HEAD's commit), files untouched.
    expect(value(await b.core.invoke('runs.branch', { runId: t.runId, action: 'return' }))).toEqual({
      done: true,
      commands: [],
    })
    expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(prev)
    for (const p of files) expect(sha256(join(f, p)), p).toBe(before[p])
    expect(sha256(join(f, '.git', 'index'))).toBe(index)
    // Delete: not checked out and its tip is still base.
    expect(value(await b.core.invoke('runs.branch', { runId: t.runId, action: 'delete' })).done).toBe(true)
    expect(gitTry(f, 'rev-parse', '--verify', '-q', `refs/heads/${branch?.name}`).ok).toBe(false)
    // Return again: HEAD is not on the run branch any more, so core leaves it.
    const again = value(await b.core.invoke('runs.branch', { runId: t.runId, action: 'return' }))
    expect(again).toMatchObject({ done: false })
    expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(prev)
  }, 240_000)

  it('cancel at the plan gate leaves no dim/* ref (the branch is made only at R5)', async () => {
    const t = await w.start(SPEC, { overrides: { isolation: { branch: 'runBranch' } } })
    const head = gitOut(t.folder, 'symbolic-ref', 'HEAD')
    const gate = await waitCard(t.c, 'gate:afterPlan')
    await choose(t, gate, 'cancel')
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('cancelled')
    expect(done.branch).toBeUndefined()
    expect(gitOut(t.folder, 'for-each-ref', '--format=%(refname)', 'refs/heads/dim/')).toBe('')
    expect(gitOut(t.folder, 'symbolic-ref', 'HEAD')).toBe(head)
    // runs.branch on a run without one.
    const r = await t.core.invoke('runs.branch', { runId: t.runId, action: 'delete' })
    expect(r.ok ? null : r.error.code).toBe('NOT_FOUND')
  }, 240_000)
})
