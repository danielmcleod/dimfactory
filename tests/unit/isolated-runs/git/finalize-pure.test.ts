// Finalize's pure parts (Apply: the journal; "never write or delete through a link"):
// the journal file and its reading (interrupted apply, latest applied, the summary the engine shows), the paths Apply
// refuses to write, and the copy for sizes. The real-git cases are tests/integration/isolated-runs/git/finalize*.test.ts.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FINALIZE_JOURNAL_SCHEMA,
  emptyJournal,
  fileJournal,
  interruptedOp,
  isFinalized,
  journalFile,
  lastAppliedOp,
  parseJournal,
  summarizeJournal,
  unsafeRunPath,
} from '../../../../src/core/git/finalize.ts'
import type { ApplyOp, FinalizeJournal } from '../../../../src/core/git/finalize.ts'
import { formatBytes } from '../../../../src/core/git/worktree.ts'

const SHA = 'a'.repeat(40)

function op(token: string, state: ApplyOp['state'], extra: Partial<ApplyOp> = {}): ApplyOp {
  return { token, state, startedAt: 1, from: SHA, to: SHA, ...extra }
}

const journal = (ops: ApplyOp[], extra: Partial<FinalizeJournal> = {}): FinalizeJournal => ({
  schemaVersion: FINALIZE_JOURNAL_SCHEMA,
  ops,
  ...extra,
})

describe('the journal file', () => {
  it('lives at runs/<id>/finalize.json; a missing or foreign file reads as an empty journal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'journal-'))
    const file = journalFile(home, '20261009T120000Z-abcd')
    expect(file).toBe(join(home, 'runs', '20261009T120000Z-abcd', 'finalize.json'))
    const io = fileJournal(file)
    expect(await io.read()).toEqual(emptyJournal())
    const j = journal([op('apply-1', 'applied', { entries: [] })])
    await io.write(j)
    expect(await io.read()).toEqual(j)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(j)
    await writeFile(file, '{"something":"else"}')
    expect(await io.read()).toEqual(emptyJournal())
    await writeFile(file, 'not json')
    expect(await io.read()).toEqual(emptyJournal())
    expect(parseJournal(null)).toEqual(emptyJournal())
  })

  it('a journal from a newer Dim Factory is refused, never overwritten blindly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'journal-'))
    const file = journalFile(home, '20261009T120000Z-abce')
    const io = fileJournal(file)
    await io.write(journal([]))
    await writeFile(file, JSON.stringify({ schemaVersion: 2, ops: [] }))
    await expect(io.read()).rejects.toMatchObject({ code: 'NEWER_SCHEMA' })
  })
})

describe('reading the journal', () => {
  it('an op left started or planned is the interrupted apply; only the last op counts', () => {
    expect(interruptedOp(journal([]))).toBeUndefined()
    expect(interruptedOp(journal([op('a', 'started')]))?.token).toBe('a')
    expect(interruptedOp(journal([op('a', 'applied'), op('b', 'planned')]))?.token).toBe('b')
    expect(interruptedOp(journal([op('a', 'planned'), op('b', 'applied')]))).toBeUndefined()
  })

  it('the latest apply still in the folder skips undone ones and stops at an interrupted one', () => {
    expect(lastAppliedOp(journal([op('a', 'applied'), op('b', 'undone')]))?.token).toBe('a')
    expect(lastAppliedOp(journal([op('a', 'applied'), op('b', 'started')]))).toBeUndefined()
    expect(lastAppliedOp(journal([op('a', 'undone')]))).toBeUndefined()
  })

  it('summarizes for the views: none, interrupted, applied (with counts), discard pending, discarded', () => {
    const wt = {
      path: '/h/worktrees/r',
      branch: 'dim/x',
      base: SHA,
      commonDir: '/r/.git',
      folder: '/r',
    }
    expect(summarizeJournal(journal([]))).toEqual({ state: 'none' })
    expect(summarizeJournal(journal([op('a', 'planned')]))).toEqual({ state: 'interrupted', undoToken: 'a' })
    const applied = op('b', 'applied', {
      entries: [
        {
          path: 'w',
          change: 'M',
          oldMode: '100644',
          oldSha: SHA,
          newMode: '100644',
          newSha: SHA,
          action: 'write',
          outcome: 'written',
        },
        {
          path: 'd',
          change: 'D',
          oldMode: '100644',
          oldSha: SHA,
          newMode: '000000',
          newSha: '0'.repeat(40),
          action: 'delete',
          outcome: 'deleted',
        },
        {
          path: 'c',
          change: 'M',
          oldMode: '100644',
          oldSha: SHA,
          newMode: '100644',
          newSha: SHA,
          action: 'conflict',
          outcome: 'conflict',
        },
        {
          path: 'n',
          change: 'M',
          oldMode: '100644',
          oldSha: SHA,
          newMode: '100644',
          newSha: SHA,
          action: 'noop',
          outcome: 'unchanged',
        },
      ],
    })
    const sum = summarizeJournal(journal([applied], { worktree: { ...wt, state: 'created', at: 1 } }))
    expect(sum).toEqual({
      state: 'applied',
      worktree: { path: wt.path, branch: wt.branch, base: SHA, state: 'created' },
      undoToken: 'b',
      applied: 2,
      conflicts: ['c'],
    })
    expect(isFinalized(journal([applied]))).toBe(true)
    expect(isFinalized(journal([op('a', 'undone')]))).toBe(false)
    const pending = journal([], {
      discard: { token: 'discard-1', requestedAt: 1, deleteAt: 10_001, state: 'pending' },
    })
    expect(summarizeJournal(pending)).toEqual({
      state: 'discard-pending',
      deleteAt: 10_001,
      discardToken: 'discard-1',
    })
    expect(isFinalized(pending)).toBe(false)
    const gone = journal([], {
      discard: { token: 'discard-1', requestedAt: 1, deleteAt: 2, state: 'removed' },
    })
    expect(summarizeJournal(gone).state).toBe('discarded')
    expect(isFinalized(gone)).toBe(true)
  })
})

describe('paths Apply never writes', () => {
  it('refuses anything that is not a plain path inside the folder, and anything inside .git', () => {
    for (const p of [
      '',
      '/etc/passwd',
      'C:/x',
      'a//b',
      'a/./b',
      'a/../b',
      '..',
      'a\0b',
      '.git/config',
      'sub/.GIT/hooks/x',
    ]) {
      expect(unsafeRunPath(p, 'linux'), p).toBeDefined()
    }
    for (const p of ['a\\b', 'x:y', '.git./config', 'GIT~1/config', 'sub/.git /x', 'a?b']) {
      expect(unsafeRunPath(p, 'win32'), p).toBeDefined()
    }
    for (const p of [
      'src/a.ts',
      'dir with space/file.txt',
      '.gitignore',
      '.github/workflows/ci.yml',
      'a..b',
      '..hidden',
    ]) {
      expect(unsafeRunPath(p, 'linux'), p).toBeUndefined()
      expect(unsafeRunPath(p, 'win32'), p).toBeUndefined()
    }
    // A backslash is an ordinary character in a POSIX file name.
    expect(unsafeRunPath('a\\b', 'linux')).toBeUndefined()
    expect(unsafeRunPath('.git/config', 'linux')).toContain('.git')
  })
})

describe('size copy', () => {
  it('formats bytes for the eligibility reasons', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(500 * 1024 ** 2)).toBe('500 MB')
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB')
  })
})
