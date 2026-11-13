// Review fix: Clear snapshots never loses a run's diff (Settings → Diagnostics "Clear snapshots"; history runs
// render the persisted `.patch` files). run-diffs.ts persistRuns saves each run's segments
// that have no copy yet, atomically, and reports every run whose copy could not be made (a write that failed, a patch
// cut at the output cap), so storage.clearShadow can refuse. Real git, a real shadow, a minimal run document.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import { ShadowReader } from '../../../src/core/git/diff-view.ts'
import { openShadow } from '../../../src/core/git/shadow.ts'
import { homePaths } from '../../../src/core/home.ts'
import { createRunDiffs, persistFailedText, persistFailureReason } from '../../../src/core/run-diffs.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import { cleanupTemps, initRepo, tempDir, write } from '../git/helpers.ts'

const RUN = '20261009T120000Z-m11p'

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTemps()
})

async function scenario() {
  const dir = tempDir('persist')
  const home = tempDir('persist-home')
  initRepo(dir)
  write(dir, 'a.txt', 'S0\n')
  const shadow = await openShadow(dir, { home })
  const s0 = await shadow.snapshot(RUN, 'S0')
  write(dir, 'a.txt', 'S1\n')
  write(dir, 'b.txt', 'new\n')
  const s1 = await shadow.snapshot(RUN, 'S1')
  const paths = homePaths(home)
  const doc = {
    runId: RUN,
    scope: { folderKey: shadow.folderKey, scopeRoot: shadow.scopeRoot },
    state: {
      steps: { implement: {}, fix: {} },
      snapshots: { S0: { ...s0, label: 'S0', at: 1 }, S1: { ...s1, label: 'S1', at: 2 } },
    },
  } as unknown as RunDoc
  const warn = vi.fn()
  const diffs = createRunDiffs({
    paths,
    readDoc: (id) => Promise.resolve(id === RUN ? doc : null),
    log: { warn } as never,
  })
  return { dir, shadow, s0, s1, paths, diffs, warn }
}

describe('persistRuns (before Clear snapshots)', () => {
  it('saves the copies a run has not got, whole, and the second time writes nothing', async () => {
    const { diffs, paths, s0, s1, shadow } = await scenario()
    const r = await diffs.persistRuns([RUN, 'not-a-run'])
    // Implement S0..S1 and Combined S0..S1 are the same file.
    expect(r).toEqual({ written: 1, failed: [] })
    const file = paths.run(RUN).diffPatch('S0..S1')
    const reader = new ShadowReader(shadow.gitDir, shadow.scopeRoot)
    expect(readFileSync(file, 'utf8')).toBe((await reader.patch(s0.commit, s1.commit)).text)
    // No temp file is left beside it.
    expect(readdirSync(dirname(file))).toEqual(['S0..S1.patch'])
    expect(await diffs.persistRuns([RUN])).toEqual({ written: 0, failed: [] })
  })

  it('a copy that cannot be written is reported (nothing partial counts as saved)', async () => {
    const { diffs, paths, warn } = await scenario()
    // Where the run's diffs folder belongs, a file: no copy can be written there.
    const diffsDir = dirname(paths.run(RUN).diffPatch('S0..S1'))
    mkdirSync(dirname(diffsDir), { recursive: true })
    writeFileSync(diffsDir, 'not a folder')
    const r = await diffs.persistRuns([RUN])
    expect(r.written).toBe(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.runId).toBe(RUN)
    expect(r.failed[0]?.reason).toMatch(/\S/)
    expect(r.failed[0]?.reason).not.toContain('—')
    expect(warn).toHaveBeenCalled()
  })

  it('a patch cut at the output cap is no copy: reported, nothing written', async () => {
    const { diffs, paths } = await scenario()
    vi.spyOn(ShadowReader.prototype, 'patch').mockResolvedValue({
      text: 'diff --git a/a b/a\n',
      truncated: true,
    })
    const r = await diffs.persistRuns([RUN])
    expect(r).toEqual({
      written: 0,
      failed: [{ runId: RUN, reason: 'its Implement changes are over 256.0 MB, too large to save' }],
    })
    expect(existsSync(paths.run(RUN).diffPatch('S0..S1'))).toBe(false)
  })

  it('a full drive reads as such; the refusal names the runs and says nothing was cleared', () => {
    const full = new DimFactoryError('STORAGE', 'Dim Factory could not write x: ENOSPC', {
      details: { errno: 'ENOSPC', category: 'disk_full' },
    })
    expect(persistFailureReason(full)).toBe('the drive is full')
    expect(persistFailureReason(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe(
      'the drive is full',
    )
    expect(persistFailureReason(new Error('EACCES: permission denied'))).toBe('EACCES: permission denied')
    expect(persistFailedText([{ label: 'Run #3', reason: 'the drive is full' }])).toBe(
      'Nothing was cleared: Dim Factory could not save a copy of the changes of Run #3 first (the drive is full). Its diff would be lost. Try again once that is fixed.',
    )
    const two = persistFailedText([
      { label: 'Run #3', reason: 'the drive is full' },
      { label: 'Run #5', reason: 'the drive is full' },
    ])
    expect(two).toBe(
      'Nothing was cleared: Dim Factory could not save a copy of the changes of 2 runs first (Run #3, Run #5: the drive is full). Their diffs would be lost. Try again once that is fixed.',
    )
    for (const t of [two]) expect(t).not.toContain('—')
  })
})
