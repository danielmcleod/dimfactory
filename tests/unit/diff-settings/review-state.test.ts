// Reviewed marks (the Diff tab's reviewed checkboxes; review-state.json
// {schemaVersion:1, reviewed:{[seg]:{[path]: blobSha}}}): store/review-state.ts reads tolerantly, writes atomically
// and serially, and a mark only counts while the row still shows the blob it names.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readReviewState, reviewedPaths, writeReviewMarks } from '../../../src/core/store/review-state.ts'
import type { FileChange } from '../../../src/shared/ipc.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const file = (): string => join(home(), 'review-state.json')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const row = (path: string, newSha: string): FileChange => ({
  status: 'M',
  path,
  oldMode: '100644',
  newMode: '100644',
  oldSha: '1'.repeat(40),
  newSha,
  added: 1,
  deleted: 0,
  binary: false,
  gitlink: false,
  eolOnly: false,
})

describe('review-state.json', () => {
  it('reads a missing or broken file as no marks', async () => {
    expect((await readReviewState(file())).state).toEqual({ schemaVersion: 1, reviewed: {} })
    writeFileSync(file(), '{ not json')
    expect((await readReviewState(file())).state.reviewed).toEqual({})
    writeFileSync(
      file(),
      JSON.stringify({ schemaVersion: 1, reviewed: { combined: { 'a.ts': 7 }, bogus: {} } }),
    )
    expect((await readReviewState(file())).state.reviewed).toEqual({ combined: {} })
  })

  it('writes the schema, per segment and path, and clears a mark', async () => {
    await writeReviewMarks(file(), 'combined', [{ path: 'src/a.ts', sha: A }], true)
    await writeReviewMarks(file(), 'implement', [{ path: 'src/a.ts', sha: B }], true)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({
      schemaVersion: 1,
      reviewed: { combined: { 'src/a.ts': A }, implement: { 'src/a.ts': B } },
    })
    await writeReviewMarks(file(), 'combined', [{ path: 'src/a.ts', sha: A }], false)
    expect((await readReviewState(file())).state.reviewed).toEqual({
      combined: {},
      implement: { 'src/a.ts': B },
    })
  })

  it('a mark counts only while the row shows the marked blob (a full id or its abbreviation)', async () => {
    await writeReviewMarks(
      file(),
      'combined',
      [
        { path: 'same.ts', sha: A },
        { path: 'changed.ts', sha: A },
        { path: 'abbrev.ts', sha: B },
      ],
      true,
    )
    const { state } = await readReviewState(file())
    const rows = [
      row('same.ts', A),
      row('changed.ts', B),
      row('abbrev.ts', B.slice(0, 7)),
      row('other.ts', A),
    ]
    expect(reviewedPaths(state, 'combined', rows)).toEqual(['same.ts', 'abbrev.ts'])
    expect(reviewedPaths(state, 'fix', rows)).toEqual([])
  })

  it('a saved pure rename names no blob: its mark is kept as an empty id and still counts', async () => {
    await writeReviewMarks(file(), 'implement', [{ path: 'moved.ts', sha: '' }], true)
    const { state } = await readReviewState(file())
    expect(reviewedPaths(state, 'implement', [row('moved.ts', ''), row('other.ts', '')])).toEqual([
      'moved.ts',
    ])
  })

  it('serializes concurrent writes so no mark is lost', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeReviewMarks(file(), 'combined', [{ path: `f${i}.ts`, sha: A }], true),
      ),
    )
    expect(Object.keys((await readReviewState(file())).state.reviewed.combined ?? {})).toHaveLength(20)
  })

  it('refuses to change a file a newer Dim Factory wrote (NEWER_SCHEMA), and reads it as no marks', async () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 2, reviewed: { combined: { 'a.ts': A } } }))
    const r = await readReviewState(file())
    expect(r).toMatchObject({ newer: true, state: { reviewed: {} } })
    await expect(
      writeReviewMarks(file(), 'combined', [{ path: 'a.ts', sha: A }], true),
    ).rejects.toMatchObject({
      code: 'NEWER_SCHEMA',
    })
  })
})
