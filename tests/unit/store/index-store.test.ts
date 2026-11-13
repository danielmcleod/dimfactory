import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '../../../src/shared/run.ts'
import { homePaths } from '../../../src/core/home.ts'
import { IndexStore } from '../../../src/core/store/index-store.ts'
import type { IndexChange } from '../../../src/core/store/index-store.ts'
import { readJsonlAll } from '../../../src/core/store/jsonl.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const indexFile = (): string => homePaths(home()).runIndex

function summary(n: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `run-${n}`,
    displayNo: n,
    folder: 'C:\\repo',
    folderKey: 'k',
    title: `task ${n}`,
    status: 'completed',
    phase: 'done',
    profile: 'balanced',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: 1_000 + n,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
    ...over,
  }
}

const lineCount = async (): Promise<number> => (await readJsonlAll(indexFile())).values.length

describe('IndexStore', () => {
  it('starts empty on a fresh home (rebuild from no runs) and persists put/del', async () => {
    const changes: IndexChange[] = []
    const idx = await IndexStore.open(home(), { onChange: (c) => changes.push(c) })
    expect(idx.openInfo).toMatchObject({ source: 'rebuilt', rebuildReason: 'missing' })
    expect(idx.size).toBe(0)
    expect(idx.nextDisplayNo()).toBe(1)
    await idx.put(summary(1))
    await idx.put(summary(2))
    await idx.put(summary(1, { status: 'cancelled' }))
    await idx.del('run-2')
    expect(idx.list().map((s) => [s.runId, s.status])).toEqual([['run-1', 'cancelled']])
    expect(changes.map((c) => c.op)).toEqual(['put', 'put', 'put', 'del'])
    expect(idx.nextDisplayNo()).toBe(3)
    await idx.close()

    const raw = (await readJsonlAll(indexFile())).values
    expect(raw).toHaveLength(4)
    expect(raw[3]).toEqual({ v: 1, op: 'del', id: 'run-2' })
    const again = await IndexStore.open(home())
    expect(again.openInfo).toMatchObject({ source: 'file', lines: 4, bad: 0 })
    expect(again.get('run-1')?.status).toBe('cancelled')
    expect(again.get('run-2')).toBeUndefined()
    expect(again.nextDisplayNo()).toBe(3)
    await again.close()
  })

  it('lists newest first and filters', async () => {
    const idx = await IndexStore.open(home())
    for (const n of [3, 1, 2]) await idx.put(summary(n, n === 2 ? { status: 'failed' } : {}))
    expect(idx.list().map((s) => s.displayNo)).toEqual([3, 2, 1])
    expect(idx.list((s) => s.status === 'failed').map((s) => s.runId)).toEqual(['run-2'])
    await idx.close()
  })

  it('compacts when lines exceed 2 × live + 100', async () => {
    const idx = await IndexStore.open(home())
    await idx.put(summary(1))
    await idx.put(summary(2))
    // 2 live runs → compaction once lines > 104.
    for (let i = 0; i < 102; i++) {
      await idx.put(summary(1, { progress: { tokens: i, costUsd: null, filesChanged: 0 } }))
    }
    expect(idx.lineCount).toBe(104)
    await idx.put(summary(2, { title: 'last' }))
    expect(idx.lineCount).toBe(2)
    await idx.flush()
    expect(await lineCount()).toBe(2)
    await idx.put(summary(3))
    await idx.close()
    const again = await IndexStore.open(home())
    expect(again.list().map((s) => s.runId)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(again.get('run-1')?.progress.tokens).toBe(101)
    expect(again.get('run-2')?.title).toBe('last')
    await again.close()
  })

  it('compacts when the file exceeds the byte bound', async () => {
    const idx = await IndexStore.open(home(), { compactBytes: 2048 })
    for (let i = 0; i < 30; i++) await idx.put(summary(1, { title: `t${i}`.padEnd(60, '.') }))
    await idx.flush()
    expect(await lineCount()).toBeLessThan(10)
    expect(idx.get('run-1')?.title.startsWith('t29')).toBe(true)
    await idx.close()
  })

  it('compacts at open when the file is already over the bound', async () => {
    const lines = Array.from({ length: 150 }, (_, i) =>
      JSON.stringify({ v: 1, op: 'put', s: summary(1, { title: `${i}` }) }),
    )
    await rm(indexFile(), { force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(homePaths(home()).runsDir, { recursive: true })
    await writeFile(indexFile(), `${lines.join('\n')}\n`)
    const idx = await IndexStore.open(home())
    expect(idx.openInfo.source).toBe('file')
    expect(idx.lineCount).toBe(1)
    expect(await lineCount()).toBe(1)
    expect(idx.get('run-1')?.title).toBe('149')
    await idx.close()
  })

  it('tolerates a torn trailing line without rebuilding', async () => {
    const idx = await IndexStore.open(home())
    await idx.put(summary(1))
    await idx.close()
    await appendFile(indexFile(), '{"v":1,"op":"put","s":{"runId":"run-')
    const again = await IndexStore.open(home())
    expect(again.openInfo).toMatchObject({ source: 'file', partialTail: true, bad: 0 })
    await again.put(summary(2))
    await again.close()
    const { values, stats } = await readJsonlAll(indexFile())
    expect(stats.bad).toBe(0)
    expect(values).toHaveLength(2)
  })

  it('rebuilds from runs/*/run.json when a non-trailing line is corrupt', async () => {
    await RunStore.create(home(), 'run-1', { summary: summary(1, { title: 'from run.json' }) })
    await RunStore.create(home(), 'run-2', { summary: summary(2) })
    await RunStore.create(home(), 'run-3', { noSummary: true })
    await writeFile(
      indexFile(),
      `${JSON.stringify({ v: 1, op: 'put', s: summary(9) })}\nGARBAGE\n${JSON.stringify({ v: 1, op: 'put', s: summary(1) })}\n`,
    )
    const idx = await IndexStore.open(home())
    expect(idx.openInfo).toMatchObject({ source: 'rebuilt', rebuildReason: 'corrupt', bad: 1 })
    expect(idx.list().map((s) => s.runId)).toEqual(['run-2', 'run-1'])
    expect(idx.get('run-1')?.title).toBe('from run.json')
    expect((await readJsonlAll(indexFile())).values).toHaveLength(2)
    await idx.close()
  })

  it('rebuilds with a custom summarize projection when the file is missing', async () => {
    await RunStore.create(home(), 'run-5', { id: 'run-5', n: 5 })
    const idx = await IndexStore.open(home(), {
      summarize: (doc, runId) => summary(Number(doc['n']), { runId }),
    })
    expect(idx.get('run-5')?.displayNo).toBe(5)
    expect(idx.nextDisplayNo()).toBe(6)
    await idx.rebuild()
    expect(idx.size).toBe(1)
    await idx.close()
  })

  it('putDebounced updates the Map now and writes the latest summary within 1 s', async () => {
    const idx = await IndexStore.open(home(), { debounceMs: 1000 })
    await idx.put(summary(1))
    vi.useFakeTimers()
    try {
      idx.putDebounced(summary(1, { progress: { tokens: 10, costUsd: null, filesChanged: 0 } }))
      idx.putDebounced(summary(1, { progress: { tokens: 20, costUsd: null, filesChanged: 0 } }))
      expect(idx.get('run-1')?.progress.tokens).toBe(20)
      expect(idx.lineCount).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
    } finally {
      vi.useRealTimers()
    }
    await idx.flush()
    expect(idx.lineCount).toBe(2)
    const values = (await readJsonlAll(indexFile())).values as { s: RunSummary }[]
    expect(values.at(-1)?.s.progress.tokens).toBe(20)
    await idx.close()
  })

  it('flush() writes pending debounced upserts; put() supersedes a pending one', async () => {
    const idx = await IndexStore.open(home(), { debounceMs: 60_000 })
    idx.putDebounced(summary(1, { title: 'debounced' }))
    await idx.flush()
    expect(JSON.parse((await readFile(indexFile(), 'utf8')).trim().split('\n').at(-1)!)).toMatchObject({
      s: { title: 'debounced' },
    })
    idx.putDebounced(summary(2, { title: 'stale' }))
    await idx.put(summary(2, { title: 'fresh' }))
    await idx.flush()
    const titles = ((await readJsonlAll(indexFile())).values as { s: RunSummary }[]).map((v) => v.s.title)
    expect(titles).toEqual(['debounced', 'fresh'])
    await idx.close()
  })
})
