// Links to folders in a real run (snapshots leave them out): a claude-only run through a real
// core and the fake Claude in a folder holding a link to a folder elsewhere (a junction on Windows). No snapshot of the
// run holds the link's target, the Diff tab never lists it, and the run says which link was left out (a run note the
// Run view shows), once.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linksLeftOutNote } from '../../../src/core/git/folder-links.ts'
import { shadowTreePaths } from '../git/helpers.ts'
import { World, allowAsks, settled, value, versionWrite } from '../run-branch/helpers.ts'

const w = new World()
const outside: string[] = []
afterEach(async () => {
  await w.dispose()
  for (const d of outside.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a run in a folder with a link to another folder', () => {
  it('leaves the link out of every snapshot and the diff, and notes it once', async () => {
    const b = await w.boot({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const shared = mkdtempSync(join(tmpdir(), 'shared-'))
    outside.push(shared)
    writeFileSync(join(shared, 'secret.txt'), 'not the project’s\n')
    symlinkSync(shared, join(b.folder, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')

    const started = value(
      await b.core.invoke('runs.start', {
        folder: b.folder,
        task: 'add a --version flag',
        overrides: { gates: { afterPlan: false } },
      }),
    )
    const c = b.core.controller(started.runId)
    if (c === undefined) throw new Error('no controller')
    allowAsks({ c, core: b.core })
    const done = await c.waitFor(settled, 150_000)
    await c.settle(15_000)
    expect(done.status, done.notes.join(' | ')).toBe('completed')

    const note = linksLeftOutNote(['shared'])
    expect(done.notes.filter((n) => n === note)).toHaveLength(1)
    const snap = value(await b.core.invoke('runs.get', { runId: started.runId }))
    expect(snap.notes).toContain(note)

    const gitDir = join(b.home, 'shadow', c.doc().scope.folderKey, 'repo.git')
    const snaps = Object.values(done.snapshots).filter((s) => s !== undefined)
    expect(snaps.length).toBeGreaterThan(1)
    for (const s of snaps) {
      expect(shadowTreePaths(gitDir, s.commit).filter((p) => p.startsWith('shared'))).toEqual([])
    }
    const files = value(await b.core.invoke('diff.files', { runId: started.runId, seg: 'combined' }))
    expect(files.files.map((f) => f.path)).toEqual([versionWrite.path])
  })
})
