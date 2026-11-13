// Runs index with the history overlay (`runs/index.jsonl`: compacted at 2×live+100 lines or
// 8 MB): a rebuild after corruption (or a lost file) keeps pins and never brings back a
// removed run, compaction keeps both, a late upsert of a removed run is dropped, and the corrupt file is kept as .bad.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { HistoryState } from '../../../src/core/store/history-state.ts'
import { IndexStore } from '../../../src/core/store/index-store.ts'
import { readJsonlAll } from '../../../src/core/store/jsonl.ts'
import { isPlainObject } from '../../../src/core/store/versions.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { summary, writeRun } from './helpers.ts'

const paths = (): ReturnType<typeof homePaths> => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')

async function open(state: HistoryState): Promise<IndexStore> {
  return IndexStore.open(paths(), {
    summarize: (doc) =>
      isPlainObject(doc['state']) ? toRunSummary(doc['state'] as unknown as RunState) : null,
    overlay: (s) => state.overlay(s),
  })
}

/** Three finished runs on disk; run 1 pinned and run 2 removed (waiting for its undo window). */
async function seeded(): Promise<{ state: HistoryState; idx: IndexStore }> {
  const p = paths()
  for (const n of [1, 2, 3]) await writeRun(p, { runId: `run-${n}`, displayNo: n, createdAt: 1_000 * n })
  const state = await HistoryState.load(p)
  const idx = await open(state)
  expect(idx.list().map((s) => s.runId)).toEqual(['run-3', 'run-2', 'run-1'])
  await state.setPinned('run-1', true, 5)
  await idx.put(idx.get('run-1') ?? summary(1))
  const two = idx.get('run-2')
  await state.addRemoval({
    token: 't',
    runIds: ['run-2'],
    requestedAt: 0,
    deleteAt: 1,
    summaries: two ? [two] : [],
  })
  await idx.del('run-2')
  return { state, idx }
}

describe('runs index with pins and removals', () => {
  it('a rebuild after a corrupt line keeps the pin and leaves the removed run out; the bad file is kept', async () => {
    const { state, idx } = await seeded()
    await idx.close()
    const file = paths().runIndex
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.splice(1, 0, '{"v":1,"op":"put","s":') // a corrupt line in the middle
    writeFileSync(file, lines.join('\n'))
    const again = await open(state)
    expect(again.openInfo).toMatchObject({ source: 'rebuilt', rebuildReason: 'corrupt' })
    expect(again.list().map((s) => [s.runId, s.pinned])).toEqual([
      ['run-3', false],
      ['run-1', true],
    ])
    expect(existsSync(`${file}.bad`)).toBe(true)
    expect(readFileSync(`${file}.bad`, 'utf8')).toContain('{"v":1,"op":"put","s":\n')
    await again.close()
    // The rebuilt file says the same without the overlay (what a read-only core reads).
    const plain = await IndexStore.open(paths())
    expect(plain.list().map((s) => [s.runId, s.pinned])).toEqual([
      ['run-3', false],
      ['run-1', true],
    ])
    await plain.close()
  })

  it('a lost index is rebuilt the same way', async () => {
    const { state, idx } = await seeded()
    await idx.close()
    rmSync(paths().runIndex)
    const again = await open(state)
    expect(again.openInfo).toMatchObject({ source: 'rebuilt', rebuildReason: 'missing' })
    expect(again.get('run-1')?.pinned).toBe(true)
    expect(again.get('run-2')).toBeUndefined()
    await again.close()
  })

  it('compaction keeps the pin and the removal', async () => {
    const { state, idx } = await seeded()
    // 2 live runs: compaction once lines > 104.
    for (let i = 0; i < 110; i++) await idx.put({ ...(idx.get('run-3') ?? summary(3)), title: `t${i}` })
    await idx.flush()
    // Compacted to one line per live run on the way (2), then the remaining puts appended.
    expect((await readJsonlAll(paths().runIndex)).values.length).toBeLessThan(20)
    await idx.close()
    const again = await open(state)
    expect(again.openInfo.source).toBe('file')
    expect(again.get('run-1')?.pinned).toBe(true)
    expect(again.get('run-2')).toBeUndefined()
    expect(again.get('run-3')?.title).toBe('t109')
    await again.close()
  })

  it('a late upsert of a removed run is dropped; an unpin goes through', async () => {
    const { state, idx } = await seeded()
    const lines = async (): Promise<number> => (await readJsonlAll(paths().runIndex)).values.length
    await idx.flush()
    const before = await lines()
    await idx.put(summary(2))
    idx.putDebounced(summary(2, { title: 'late' }))
    await idx.flush()
    expect(idx.get('run-2')).toBeUndefined()
    expect(await lines()).toBe(before)
    await state.setPinned('run-1', false, 9)
    await idx.put({ ...(idx.get('run-1') ?? summary(1)) })
    expect(idx.get('run-1')?.pinned).toBe(false)
    await idx.close()
  })
})
