// Snapshot refs and shadow gc against real git (a batched update-ref --stdin that works on git 2.17.1; the shadow
// shrinks after gc): one `update-ref --stdin` transaction deletes a run's refs and
// only those (checked by listing the refs), gcIfIdle shrinks the shadow on disk once a large blob is unreferenced,
// deletes a shadow with no ref left, and waits while a run uses (or just used) the folder, until refs were deleted,
// and once a day. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SHADOW_REF_PREFIX,
  deleteRunRefs,
  gcIfIdle,
  listRunRefs,
  listShadowKeys,
  openShadow,
  readShadowGcState,
} from '../../../src/core/git/shadow.ts'
import type { Shadow } from '../../../src/core/git/shadow.ts'
import { dirSize } from '../../../src/core/store/storage.ts'
import {
  TEST_GIT,
  cleanupTemps,
  gitBuf,
  initRepo,
  shadowGit,
  tempDir,
  testGitVersion,
  write,
} from '../git/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] refs and gc suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

const RUN_A = '20261009T120000Z-aaaa'
const RUN_B = '20261009T120100Z-bbbb'
const RUN_C = '20261009T120200Z-cccc'
const MB = 1024 * 1024

async function shadowIn(files: Record<string, string | Buffer>): Promise<{
  dir: string
  home: string
  shadow: Shadow
}> {
  const dir = tempDir('repo')
  initRepo(dir)
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data)
  const home = tempDir('home')
  const shadow = await openShadow(dir, { home })
  return { dir, home, shadow }
}

const refNames = (gitDir: string): string[] =>
  shadowGit(gitDir, ['for-each-ref', '--format=%(refname)'])
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .sort()

/** The shadow still has the object (`cat-file -e` exits 0). */
function has(gitDir: string, obj: string): boolean {
  try {
    gitBuf(dirname(gitDir), ['cat-file', '-e', obj], { env: { GIT_DIR: gitDir } })
    return true
  } catch {
    return false
  }
}

/** Make the shadow look unused for 10 minutes (its index, exclude, refs and meta written back then). */
function ageShadow(s: Shadow): void {
  const t = (Date.now() - 10 * 60_000) / 1000
  for (const p of [
    join(s.gitDir, 'index'),
    join(s.gitDir, 'info', 'exclude'),
    join(s.gitDir, ...SHADOW_REF_PREFIX.split('/').filter((x) => x !== '')),
    join(s.root, 'meta.json'),
  ]) {
    if (existsSync(p)) utimesSync(p, t, t)
  }
}

describe(`snapshot refs go in one update-ref --stdin batch (${version.raw})`, () => {
  it("deletes the named runs' refs and keeps every other; the shadow is marked for gc", async () => {
    const { dir, home, shadow } = await shadowIn({ 'a.txt': 'a\n' })
    for (const [i, run] of [RUN_A, RUN_B, RUN_C].entries()) {
      write(dir, 'a.txt', `a${i}\n`)
      await shadow.snapshot(run, 'S0')
    }
    expect(await listRunRefs(home, shadow.folderKey)).toEqual([RUN_A, RUN_B, RUN_C])
    expect(refNames(shadow.gitDir)).toEqual([RUN_A, RUN_B, RUN_C].map((r) => SHADOW_REF_PREFIX + r))
    const deleted = await deleteRunRefs(home, shadow.folderKey, [RUN_C, RUN_A, '20261009T130000Z-none'], {
      now: 1234,
    })
    expect(deleted).toEqual([RUN_A, RUN_C])
    expect(refNames(shadow.gitDir)).toEqual([SHADOW_REF_PREFIX + RUN_B])
    expect(await listRunRefs(home, shadow.folderKey)).toEqual([RUN_B])
    // The refs folder as the delete left it is recorded (gcIfIdle does not take it for a run's write).
    const marked = { refsDeletedAt: 1234, refsDirMtime: expect.any(Number) as number }
    expect(await readShadowGcState(home, shadow.folderKey)).toEqual(marked)
    // Nothing to delete: no git transaction, the mark stays as it was.
    expect(await deleteRunRefs(home, shadow.folderKey, [RUN_A], { now: 9999 })).toEqual([])
    expect(await readShadowGcState(home, shadow.folderKey)).toEqual(marked)
    // A shadow that does not exist has no refs.
    expect(await listRunRefs(home, '0000000000000000')).toEqual([])
  })

  it('packed refs are deleted too (after a gc packed them)', async () => {
    const { dir, home, shadow } = await shadowIn({ 'a.txt': 'a\n' })
    await shadow.snapshot(RUN_A, 'S0')
    write(dir, 'a.txt', 'b\n')
    await shadow.snapshot(RUN_B, 'S0')
    shadowGit(shadow.gitDir, ['pack-refs', '--all'])
    expect(await listRunRefs(home, shadow.folderKey)).toEqual([RUN_A, RUN_B])
    expect(await deleteRunRefs(home, shadow.folderKey, [RUN_A])).toEqual([RUN_A])
    expect(refNames(shadow.gitDir)).toEqual([SHADOW_REF_PREFIX + RUN_B])
  })
})

describe(`gcIfIdle (${version.raw})`, () => {
  it('the shadow shrinks on disk once a large blob is no longer referenced', async () => {
    const big = randomBytes(6 * MB)
    const { dir, home, shadow } = await shadowIn({ 'a.txt': 'a\n', 'big.bin': big })
    const a = await shadow.snapshot(RUN_A, 'S0')
    rmSync(join(dir, 'big.bin'))
    write(dir, 'a.txt', 'b\n')
    const b = await shadow.snapshot(RUN_B, 'S0')
    const bigSha = shadowGit(shadow.gitDir, ['rev-parse', `${a.commit}:big.bin`]).trim()
    expect(await deleteRunRefs(home, shadow.folderKey, [RUN_A], { now: 1000 })).toEqual([RUN_A])
    const before = (await dirSize(shadow.root)).bytes
    expect(before).toBeGreaterThan(5 * MB)
    const r = await gcIfIdle({ home, folderKey: shadow.folderKey, now: 2000, inUse: () => false, idleMs: 0 })
    expect(r).toMatchObject({ folderKey: shadow.folderKey, action: 'gc', refs: 1, bytesBefore: before })
    const after = (await dirSize(shadow.root)).bytes
    expect(r.bytesAfter).toBe(after)
    expect(before - after).toBeGreaterThan(5 * MB)
    // B's snapshot is whole; A's commit and the large blob are gone.
    expect(shadowGit(shadow.gitDir, ['cat-file', '-p', `${b.commit}:a.txt`])).toBe('b\n')
    expect(has(shadow.gitDir, bigSha)).toBe(false)
    expect(has(shadow.gitDir, a.commit)).toBe(false)
    expect(await readShadowGcState(home, shadow.folderKey)).toEqual({
      refsDeletedAt: 1000,
      lastGcAt: 2000,
      refsDirMtime: expect.any(Number) as number,
    })
    // The shadow keeps working.
    write(dir, 'c.txt', 'c\n')
    const c = await shadow.snapshot(RUN_B, 'S1')
    expect(shadowGit(shadow.gitDir, ['cat-file', '-p', `${c.commit}:c.txt`])).toBe('c\n')
  })

  it("retention's own ref delete is not taken for a run using the folder; a run's snapshot after it is", async () => {
    const { dir, home, shadow } = await shadowIn({ 'a.txt': 'a\n' })
    await shadow.snapshot(RUN_A, 'S0')
    write(dir, 'a.txt', 'b\n')
    await shadow.snapshot(RUN_B, 'S0')
    // Idle for 10 minutes, then retention deletes run A's ref (a loose ref: the delete writes the refs folder).
    ageShadow(shadow)
    await deleteRunRefs(home, shadow.folderKey, [RUN_A], { now: Date.now() })
    const gc = (o: Partial<Parameters<typeof gcIfIdle>[0]> = {}) =>
      gcIfIdle({ home, folderKey: shadow.folderKey, now: Date.now(), inUse: () => false, ...o })
    expect(await gc()).toMatchObject({ action: 'gc', refs: 1 })
    // A run's snapshot after that writes a new ref (the refs folder is newer than Dim Factory's own write): the folder was
    // used, even with every other file of the shadow aged.
    write(dir, 'a.txt', 'c\n')
    await shadow.snapshot(RUN_C, 'S0')
    const t = (Date.now() - 10 * 60_000) / 1000
    for (const p of [
      join(shadow.gitDir, 'index'),
      join(shadow.gitDir, 'info', 'exclude'),
      join(shadow.root, 'meta.json'),
    ])
      if (existsSync(p)) utimesSync(p, t, t)
    expect(await gc({ force: true })).toMatchObject({
      action: 'skipped',
      reason: 'a run used this folder in the last 5 minutes',
    })
  })

  it('a shadow with no ref left is deleted', async () => {
    const { home, shadow } = await shadowIn({ 'a.txt': 'a\n' })
    await shadow.snapshot(RUN_A, 'S0')
    await deleteRunRefs(home, shadow.folderKey, [RUN_A], { now: 1 })
    const r = await gcIfIdle({ home, folderKey: shadow.folderKey, now: 2, inUse: () => false, idleMs: 0 })
    expect(r).toMatchObject({ action: 'deleted', refs: 0, bytesAfter: 0 })
    expect(existsSync(shadow.root)).toBe(false)
    expect(await listShadowKeys(home)).toEqual([])
    expect(await gcIfIdle({ home, folderKey: shadow.folderKey, now: 3, inUse: () => false })).toMatchObject({
      action: 'none',
    })
  })

  it('waits while a run uses the folder, used it in the last 5 minutes, or until refs were deleted; once a day', async () => {
    const { dir, home, shadow } = await shadowIn({ 'a.txt': 'a\n' })
    await shadow.snapshot(RUN_A, 'S0')
    write(dir, 'a.txt', 'b\n')
    await shadow.snapshot(RUN_B, 'S0')
    const key = shadow.folderKey
    const NOW = 100 * 86_400_000
    const gc = (o: Partial<Parameters<typeof gcIfIdle>[0]> = {}) =>
      gcIfIdle({ home, folderKey: key, now: NOW, inUse: () => false, ...o })
    // Nothing was deleted since the last collection (never): nothing to do.
    expect(await gc({ idleMs: 0 })).toMatchObject({
      action: 'skipped',
      reason: 'no snapshots were deleted since',
    })
    await deleteRunRefs(home, key, [RUN_A], { now: NOW - 1 })
    // A run holds or waits for the folder.
    expect(await gc({ inUse: () => true, idleMs: 0 })).toMatchObject({
      action: 'skipped',
      reason: 'a run is using this folder',
    })
    // The shadow was written a moment ago (a snapshot).
    expect(await gc()).toMatchObject({
      action: 'skipped',
      reason: 'a run used this folder in the last 5 minutes',
    })
    ageShadow(shadow)
    // A lock on the folder was released 1 minute ago.
    expect(await gc({ lastLockAt: NOW - 60_000 })).toMatchObject({
      action: 'skipped',
      reason: 'a run used this folder in the last 5 minutes',
    })
    // A dry run says what it would do and changes nothing.
    const dry = await gc({ lastLockAt: NOW - 10 * 60_000, dryRun: true })
    expect(dry).toMatchObject({ action: 'gc', refs: 1 })
    expect(await readShadowGcState(home, key)).toEqual({
      refsDeletedAt: NOW - 1,
      refsDirMtime: expect.any(Number) as number,
    })
    expect(await gc({ lastLockAt: NOW - 10 * 60_000 })).toMatchObject({ action: 'gc', refs: 1 })
    // Refs deleted again within the day: the next collection waits for the day to pass (dimf gc does not).
    write(dir, 'a.txt', 'c\n')
    await shadow.snapshot(RUN_C, 'S0')
    await deleteRunRefs(home, key, [RUN_C], { now: NOW + 1 })
    ageShadow(shadow)
    expect(await gc({ now: NOW + 3_600_000 })).toMatchObject({
      action: 'skipped',
      reason: 'collected less than a day ago',
    })
    expect(await gc({ now: NOW + 3_600_000, force: true })).toMatchObject({ action: 'gc' })
    expect(await gc({ now: NOW + 3_600_000, force: true, inUse: () => true })).toMatchObject({
      action: 'skipped',
    })
  })
})
