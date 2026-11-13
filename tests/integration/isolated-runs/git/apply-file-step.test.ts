// Integration ("kill during apply → idempotent Finish"; the E2E hook pauses an apply
// between files): applyRun's `file` step comes once after each file it deleted or wrote itself, never for a file that
// was already the run's, so a hold there leaves part of the folder written and the rest for [Finish apply].
// Honors DIM_FACTORY_TEST_GIT.
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRun } from '../../../../src/core/git/finalize.ts'
import type { ApplyStep } from '../../../../src/core/git/finalize.ts'
import { cleanupTemps, write } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'

afterEach(() => cleanupTemps())

describe('applyRun reports each file it changed (the `file` step)', () => {
  it('one `file` per delete and write, after the deletes and before `written`', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n', 'd.txt': 'd1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    rmSync(join(f.wt.path, 'b.txt'))
    write(f.wt.path, 'n.txt', 'n\n')
    write(f.wt.path, 'd.txt', 'd2\n')
    // Already the run's in the folder: a no-op, no `file` step.
    write(f.repo, 'd.txt', 'd2\n')
    const target = await f.finish()
    const steps: { step: ApplyStep; written: string[] }[] = []
    const seen = (): string[] =>
      ['a.txt', 'n.txt'].filter((p) => existsSync(join(f.repo, p)) && textOf(f.repo, p) !== 'a1\n')
    const r = await applyRun(target, { onStep: (step) => void steps.push({ step, written: seen() }) })
    // Each write's `temp` (its bytes in the temp file, before the rename) comes before its `file`.
    expect(steps.map((s) => s.step)).toEqual([
      'started',
      'snapshot',
      'planned',
      'file',
      'deleted',
      'temp',
      'file',
      'temp',
      'file',
      'written',
    ])
    // Between files: the first write is on disk before the second one starts.
    const writes = steps.filter((s, i) => s.step === 'file' && i > 4)
    expect(writes.map((s) => s.written.length)).toEqual([1, 2])
    expect(r.applied.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
    expect(r.unchanged).toEqual(['d.txt'])
    expect(existsSync(join(f.repo, 'b.txt'))).toBe(false)
    expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
    expect(textOf(f.repo, 'c.txt')).toBe('c1\n')
  })
})
