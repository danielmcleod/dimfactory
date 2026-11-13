// The live files-changed count from a base commit (found on the live balanced run): `liveChanged({since})` adds
// the paths the snapshots since that commit changed, so while Fix runs (its own
// start snapshot is the last one) the count is still the run's, from S0.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openShadow } from '../../../src/core/git/shadow.ts'
import { cleanupTemps, initRepo, tempDir, write } from './helpers.ts'

const RUN = '20261011T150000Z-l1ve'
const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

afterEach(() => cleanupTemps())

describe('Shadow.liveChanged({since})', () => {
  it('counts the run from S0: the files changed before the last snapshot and the ones changed since', async () => {
    const dir = tempDir('live-since')
    initRepo(dir)
    write(dir, 'a.txt', 'a\n')
    write(dir, 'b.txt', 'b\n')
    write(dir, 'gone.txt', 'gone\n')
    const shadow = await openShadow(dir, { home: home() })
    const s0 = (await shadow.snapshot(RUN, 'S0')).commit

    // Implement: a.txt changed, new.txt added, gone.txt deleted; then S1 and Fix's start snapshot.
    write(dir, 'a.txt', 'a changed\n')
    write(dir, 'new.txt', 'new\n')
    rmSync(join(dir, 'gone.txt'))
    expect(await shadow.liveChanged({ since: s0 })).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    await shadow.snapshot(RUN, 'S1')
    await shadow.snapshot(RUN, 'fix-start')

    // Fix has not written yet: the plain count is 0, the run's is still 3.
    expect(await shadow.liveChanged()).toEqual([])
    expect(await shadow.liveChanged({ since: s0 })).toEqual(['a.txt', 'gone.txt', 'new.txt'])

    // Fix edits a.txt again and b.txt for the first time: b.txt joins, a.txt is counted once.
    write(dir, 'a.txt', 'a changed twice\n')
    write(dir, 'b.txt', 'b changed\n')
    expect(await shadow.liveChanged()).toEqual(['a.txt', 'b.txt'])
    expect(await shadow.liveChanged({ since: s0 })).toEqual(['a.txt', 'b.txt', 'gone.txt', 'new.txt'])

    // A base the shadow cannot read: the plain count.
    expect(await shadow.liveChanged({ since: 'f'.repeat(40) })).toEqual(['a.txt', 'b.txt'])
  })
})
