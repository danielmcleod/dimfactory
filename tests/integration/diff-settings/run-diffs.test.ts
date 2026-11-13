// The Diff tab and storage through a real core (diffs, revert to S0, the Diff tab and Settings
// "Diagnostics"; diff.spec.ts's data): a claude-only run whose Implement leaves a CRLF edit (core.autocrlf=true), a deleted
// file, an added and a changed image, an SVG, an EOL-only file and a large file:
//   - while Implement runs, diff.revert and storage.clearShadow are refused (FOLDER_BUSY, with a reason to show)
//   - diff.files rows carry the special rows; diff.blob serves the images (only paths the segment lists), not SVG
//   - reviewed marks per segment, and for every segment without one; they survive a new core on the same home
//   - revert per file and per segment round-trip byte-exactly with their undo (sha256 of every file)
//   - a hand edit after the run reads edited-after-run
//   - storage.usage names the folder's shadow; Clear snapshots removes it, and the diffs then come from the saved
//     patches (persisted, same rows, marks kept) with revert and image previews unavailable, and nothing re-creates
//     the shadow
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../src/core/app-core.ts'
import { SNAPSHOTS_CLEARED_BLOB, SNAPSHOTS_CLEARED_REVERT } from '../../../src/core/run-diffs.ts'
import type { FileChange, Result } from '../../../src/shared/ipc.ts'
import { workTreeHashes } from '../git/fingerprint.ts'
import { World, allowAsks, gitOut, settled, value, versionWrite } from '../run-branch/helpers.ts'
import { hermeticEnv } from '../run/scenario.ts'

const w = new World()
afterEach(() => w.dispose())

const PNG = (tail: number[]): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...tail])
const LOGO_S0 = PNG([1, 2, 3])
const LOGO_S1 = PNG([4, 5, 6, 7])
const NEW_PNG = PNG([9, 9, 9, 0, 13, 10])
const CRLF_S0 = Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8')
const CRLF_S1 = Buffer.from('alpha\r\nBETA changed\r\ngamma\r\ndelta\r\n', 'utf8')
const bigText = Array.from({ length: 3001 }, (_, i) => `line ${i}`).join('\n') + '\n'

const err = <T>(r: Result<T>): { code: string; message: string } | null =>
  r.ok ? null : { code: r.error.code, message: r.error.message }

const write = (root: string, rel: string, data: string | Buffer): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), data)
}

describe('run diffs (core + git + fake Claude)', () => {
  it('special rows, images, reviewed marks, revert round trips, edited after the run, Clear snapshots', async () => {
    const b = await w.boot({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite, delayMs: 6000 }],
    })
    const f = b.folder
    gitOut(f, 'config', 'core.autocrlf', 'true')
    write(f, 'data/crlf.txt', CRLF_S0)
    write(f, 'data/gone.txt', 'deleted by the run\n')
    write(f, 'data/eol.txt', 'one\ntwo\nthree\n')
    write(f, 'assets/logo.png', LOGO_S0)
    gitOut(f, 'add', '-A')
    gitOut(f, 'commit', '-q', '-m', 'data')

    const started = value(
      await b.core.invoke('runs.start', {
        folder: f,
        task: 'add a --version flag',
        overrides: { gates: { afterPlan: false } },
      }),
    )
    const runId = started.runId
    const c = b.core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    allowAsks({ c, core: b.core })
    await c.waitFor((s) => s.steps.implement.proc?.live === true, 90_000)
    const scope = c.doc().scope
    const folderKey = scope.folderKey

    // ---- busy: revert and Clear snapshots are refused with a reason the UI shows ----
    const busy = err(await b.core.invoke('diff.revert', { runId, paths: 'all' }))
    expect(busy?.code).toBe('FOLDER_BUSY')
    expect(busy?.message).toMatch(/\S/)
    const busyClear = err(await b.core.invoke('storage.clearShadow', { folderKey }))
    expect(busyClear).toEqual({
      code: 'FOLDER_BUSY',
      message: `Run #${started.displayNo} is using this folder. Clear its snapshots once the run has finished.`,
    })
    for (const e of [busy, busyClear]) expect(e?.message).not.toContain('—')
    // storage.usage names the same reason on the folder's shadow, so Settings shows it before any click.
    const busyUsage = value(await b.core.invoke('storage.usage'))
    expect(busyUsage.shadows.find((s) => s.folderKey === folderKey)?.busy).toBe(busyClear?.message)

    // What Implement leaves (written while it runs, so it is all in S0..S1).
    write(f, 'data/crlf.txt', CRLF_S1)
    rmSync(join(f, 'data/gone.txt'))
    write(f, 'data/eol.txt', 'one\r\ntwo\r\nthree\r\n')
    write(f, 'assets/logo.png', LOGO_S1)
    write(f, 'assets/new.png', NEW_PNG)
    write(f, 'assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    write(f, 'big.txt', bigText)

    const done = await c.waitFor(settled, 150_000)
    await c.settle(15_000)
    expect(done.status, done.notes.join(' | ')).toBe('completed')
    const atS1 = workTreeHashes(f)

    // ---- rows ----
    const files = value(await b.core.invoke('diff.files', { runId, seg: 'implement' }))
    expect(files).toMatchObject({ seg: 'implement', persisted: false, reviewed: [] })
    expect(files.available).toContain('implement')
    expect(files.available).toContain('combined')
    expect(files.revertUnavailable).toBeUndefined()
    const by = new Map(files.files.map((r) => [r.path, r]))
    expect([...by.keys()].sort()).toEqual(
      [
        'assets/icon.svg',
        'assets/logo.png',
        'assets/new.png',
        'big.txt',
        'data/crlf.txt',
        'data/eol.txt',
        'data/gone.txt',
        versionWrite.path,
      ].sort(),
    )
    expect(by.get('data/crlf.txt')).toMatchObject({ status: 'M', added: 2, deleted: 1, eolOnly: false })
    expect(by.get('data/eol.txt')).toMatchObject({ status: 'M', eolOnly: true })
    expect(by.get('data/gone.txt')).toMatchObject({ status: 'D' })
    expect(by.get('assets/new.png')).toMatchObject({ status: 'A', binary: true })
    expect(by.get('assets/logo.png')).toMatchObject({ status: 'M', binary: true })
    expect(by.get('big.txt')).toMatchObject({ status: 'A', large: true })
    expect(files.files.every((r) => r.editedAfterRun === false)).toBe(true)

    // ---- one file's patch ----
    const crlfPatch = value(
      await b.core.invoke('diff.file', { runId, seg: 'implement', path: 'data/crlf.txt' }),
    )
    expect(crlfPatch.patch).toContain('-beta\r\n+BETA changed\r\n')
    const eolIgnored = value(
      await b.core.invoke('diff.file', { runId, seg: 'implement', path: 'data/eol.txt', ignoreEol: true }),
    )
    expect(eolIgnored.patch).not.toContain('@@')

    // ---- images: only the segment's own paths, PNG bytes exact, SVG never an image ----
    const newImg = value(
      await b.core.invoke('diff.blob', { runId, seg: 'implement', side: 'new', path: 'assets/new.png' }),
    )
    expect(newImg).toMatchObject({ mime: 'image/png', bytes: NEW_PNG.length })
    expect(Buffer.from(newImg.base64, 'base64').equals(NEW_PNG)).toBe(true)
    const oldLogo = value(
      await b.core.invoke('diff.blob', { runId, seg: 'implement', side: 'old', path: 'assets/logo.png' }),
    )
    expect(Buffer.from(oldLogo.base64, 'base64').equals(LOGO_S0)).toBe(true)
    expect(
      value(
        await b.core.invoke('diff.blob', { runId, seg: 'implement', side: 'new', path: 'assets/icon.svg' }),
      ),
    ).toEqual({ base64: '', bytes: 42, mime: null })
    expect(
      err(await b.core.invoke('diff.blob', { runId, seg: 'implement', side: 'old', path: 'assets/new.png' }))
        ?.code,
    ).toBe('NOT_FOUND')
    expect(
      err(await b.core.invoke('diff.blob', { runId, seg: 'implement', side: 'new', path: 'package.json' }))
        ?.code,
    ).toBe('NOT_FOUND')

    // ---- reviewed marks: per segment, or every segment that lists the path ----
    value(
      await b.core.invoke('diff.markReviewed', {
        runId,
        seg: 'implement',
        paths: [versionWrite.path, 'data/crlf.txt'],
        reviewed: true,
      }),
    )
    value(await b.core.invoke('diff.markReviewed', { runId, paths: ['assets/new.png'], reviewed: true }))
    value(
      await b.core.invoke('diff.markReviewed', {
        runId,
        seg: 'implement',
        paths: ['data/crlf.txt'],
        reviewed: false,
      }),
    )
    const missing = err(
      await b.core.invoke('diff.markReviewed', { runId, paths: ['not/in/run.txt'], reviewed: true }),
    )
    expect(missing).toEqual({
      code: 'NOT_FOUND',
      message: 'not/in/run.txt did not change in this part of the run.',
    })
    const reviewedIn = async (core: typeof b.core, seg: 'implement' | 'combined'): Promise<string[]> =>
      value(await core.invoke('diff.files', { runId, seg })).reviewed.sort()
    expect(await reviewedIn(b.core, 'implement')).toEqual(['assets/new.png', versionWrite.path].sort())
    expect(await reviewedIn(b.core, 'combined')).toEqual(['assets/new.png'])

    // ---- the marks survive a new core on the same home (a relaunch) ----
    await b.core.shutdown()
    w.cores.splice(w.cores.indexOf(b.core), 1)
    const core = await createCore({ home: b.home, host: { kind: 'app' }, env: hermeticEnv() })
    w.cores.push(core)
    expect(await reviewedIn(core, 'implement')).toEqual(['assets/new.png', versionWrite.path].sort())

    // ---- revert one file and undo: byte-exact both ways, nothing else moves ----
    const one = value(await core.invoke('diff.revert', { runId, seg: 'implement', paths: ['data/crlf.txt'] }))
    expect(one).toMatchObject({ restored: ['data/crlf.txt'], deleted: [], skipped: [] })
    expect(readFileSync(join(f, 'data/crlf.txt')).equals(CRLF_S0)).toBe(true)
    const afterOne = workTreeHashes(f)
    for (const p of Object.keys(atS1).filter((x) => x !== 'data/crlf.txt'))
      expect(afterOne[p], p).toBe(atS1[p])
    value(await core.invoke('diff.undoRevert', { runId, undoToken: one.undoToken }))
    expect(workTreeHashes(f)).toEqual(atS1)

    // ---- revert the whole segment and undo ----
    const all = value(await core.invoke('diff.revert', { runId, seg: 'implement', paths: 'all' }))
    expect(all.deleted.sort()).toEqual(
      ['assets/icon.svg', 'assets/new.png', 'big.txt', versionWrite.path].sort(),
    )
    expect(existsSync(join(f, 'data/gone.txt'))).toBe(true)
    expect(readFileSync(join(f, 'assets/logo.png')).equals(LOGO_S0)).toBe(true)
    expect(readFileSync(join(f, 'data/crlf.txt')).equals(CRLF_S0)).toBe(true)
    value(await core.invoke('diff.undoRevert', { runId, undoToken: all.undoToken }))
    expect(workTreeHashes(f)).toEqual(atS1)

    // ---- a hand edit after the run ----
    write(f, 'data/crlf.txt', 'edited by hand\n')
    const edited = value(await core.invoke('diff.files', { runId, seg: 'implement' }))
    const flags = new Map(edited.files.map((r: FileChange) => [r.path, r.editedAfterRun]))
    expect(flags.get('data/crlf.txt')).toBe(true)
    expect(flags.get(versionWrite.path)).toBe(false)

    // ---- storage: the folder's shadow by name; Clear snapshots ----
    const usage = value(await core.invoke('storage.usage'))
    const shadow = usage.shadows.find((s) => s.folderKey === folderKey)
    expect(shadow?.path?.toLowerCase()).toBe(scope.scopeRoot.toLowerCase())
    expect(shadow?.bytes).toBeGreaterThan(0)
    expect(usage.runs.count).toBe(1)
    const shadowDir = join(b.home, 'shadow', folderKey)
    expect(existsSync(shadowDir)).toBe(true)
    // Once the run has ended, nothing holds the folder: no reason on its shadow.
    expect(shadow?.busy).toBeUndefined()
    // A run whose diffs cannot be saved first (here a file where its diffs folder belongs) keeps the snapshots:
    // Clear snapshots refuses with the reason and clears nothing.
    const diffsDir = join(b.home, 'runs', runId, 'diffs')
    renameSync(diffsDir, `${diffsDir}-aside`)
    writeFileSync(diffsDir, 'in the way')
    const refused = err(await core.invoke('storage.clearShadow', { folderKey }))
    expect(refused?.code).toBe('STORAGE')
    expect(refused?.message).toMatch(
      /^Nothing was cleared: Dim Factory could not save a copy of the changes of Run #\d+ first/,
    )
    expect(refused?.message).not.toContain('—')
    expect(existsSync(shadowDir)).toBe(true)
    rmSync(diffsDir)
    renameSync(`${diffsDir}-aside`, diffsDir)
    // The saved copies are made again by the clear below (none is there now).
    for (const f of readdirSync(diffsDir)) rmSync(join(diffsDir, f))
    const cleared = value(await core.invoke('storage.clearShadow', { folderKey }))
    expect(cleared.shadows.map((s) => s.folderKey)).not.toContain(folderKey)
    expect(existsSync(shadowDir)).toBe(false)

    // ---- the diffs now come from the saved patches ----
    const saved = value(await core.invoke('diff.files', { runId, seg: 'implement' }))
    expect(saved).toMatchObject({ persisted: true, revertUnavailable: SNAPSHOTS_CLEARED_REVERT })
    const rowFacts = (r: FileChange) =>
      `${r.status} ${r.path} +${r.added ?? '-'} -${r.deleted ?? '-'} ${r.eolOnly}`
    expect(saved.files.map(rowFacts)).toEqual(files.files.map(rowFacts))
    expect(saved.reviewed.sort()).toEqual(['assets/new.png', versionWrite.path].sort())
    expect(saved.available).toEqual(expect.arrayContaining(['implement', 'combined']))
    const combined = value(await core.invoke('diff.files', { runId, seg: 'combined' }))
    expect(combined.persisted).toBe(true)
    expect(combined.reviewed).toEqual(['assets/new.png'])
    const savedPatch = value(
      await core.invoke('diff.file', { runId, seg: 'implement', path: 'data/crlf.txt' }),
    )
    expect(savedPatch.patch).toContain('+BETA changed\r\n')
    expect(
      err(await core.invoke('diff.blob', { runId, seg: 'implement', side: 'new', path: 'assets/new.png' })),
    ).toEqual({ code: 'UNSUPPORTED', message: SNAPSHOTS_CLEARED_BLOB })
    expect(err(await core.invoke('diff.revert', { runId, paths: 'all' }))).toEqual({
      code: 'NOT_FOUND',
      message: SNAPSHOTS_CLEARED_REVERT,
    })
    expect(err(await core.invoke('diff.undoRevert', { runId, undoToken: all.undoToken }))?.code).toBe(
      'NOT_FOUND',
    )
    // Reading never re-creates the shadow.
    expect(existsSync(shadowDir)).toBe(false)
    // Clearing again is a no-op.
    expect(value(await core.invoke('storage.clearShadow', { folderKey })).shadows).toEqual(cleared.shadows)
  }, 300_000)
})
