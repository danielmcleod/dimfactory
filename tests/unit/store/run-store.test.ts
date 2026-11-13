import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DimFactoryError } from '../../../src/core/errors.ts'
import { homePaths } from '../../../src/core/home.ts'
import {
  RUN_JSON_DEBOUNCE_MS,
  RunStore,
  listRunIds,
  readRunJson,
  removeRunDir,
  runExists,
} from '../../../src/core/store/run-store.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const readRunJsonFile = async (runId: string): Promise<unknown> =>
  JSON.parse(await readFile(homePaths(home()).run(runId).runJson, 'utf8'))

interface Doc {
  runId: string
  status: string
  lastSeq: number
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RunStore', () => {
  it('create makes the folder and writes run.json with schemaVersion:1 immediately', async () => {
    const s = await RunStore.create<Doc>(home(), 'r1', { runId: 'r1', status: 'queued', lastSeq: 0 })
    expect(await readRunJsonFile('r1')).toEqual({
      schemaVersion: 1,
      runId: 'r1',
      status: 'queued',
      lastSeq: 0,
    })
    expect(s.readOnly).toBe(false)
    expect(await runExists(home(), 'r1')).toBe(true)
    expect(await listRunIds(home())).toEqual(['r1'])
    await s.close()
  })

  it('create refuses an existing run folder with CONFLICT', async () => {
    await RunStore.create(home(), 'r1', { a: 1 })
    const err = await RunStore.create(home(), 'r1', { a: 2 }).catch((e: unknown) => e)
    expect((err as DimFactoryError).code).toBe('CONFLICT')
  })

  it('set() is debounced 250 ms (armed by the first change, not reset by later ones)', async () => {
    expect(RUN_JSON_DEBOUNCE_MS).toBe(250)
    const s = await RunStore.create<Doc>(home(), 'r2', { runId: 'r2', status: 'queued', lastSeq: 0 })
    vi.useFakeTimers()
    s.set((d) => ({ ...d, status: 'running', lastSeq: 1 }))
    await vi.advanceTimersByTimeAsync(200)
    s.set((d) => ({ ...d, lastSeq: 2 }))
    expect(s.dirty).toBe(true)
    expect(await readRunJsonFile('r2')).toMatchObject({ status: 'queued' })
    await vi.advanceTimersByTimeAsync(60)
    vi.useRealTimers()
    await s.flush()
    expect(await readRunJsonFile('r2')).toMatchObject({ status: 'running', lastSeq: 2 })
    expect(s.dirty).toBe(false)
  })

  it('checkpoint() writes now (transitions)', async () => {
    const s = await RunStore.create<Doc>(home(), 'r3', { runId: 'r3', status: 'queued', lastSeq: 0 })
    await s.checkpoint((d) => ({ ...d, status: 'waiting', lastSeq: 7 }))
    expect(await readRunJsonFile('r3')).toMatchObject({ status: 'waiting', lastSeq: 7 })
  })

  it('open() round-trips, keeping unknown fields', async () => {
    const a = await RunStore.create(home(), 'r4', { runId: 'r4', extra: { nested: [1, 2] } })
    await a.close()
    const b = await RunStore.open(home(), 'r4')
    expect(b.doc).toEqual({ schemaVersion: 1, runId: 'r4', extra: { nested: [1, 2] } })
    expect(b.version).toBe(1)
  })

  it('a run.json from a newer Dim Factory opens read-only; saving throws NEWER_SCHEMA', async () => {
    const p = homePaths(home()).run('r5')
    await mkdir(p.dir, { recursive: true })
    await writeFile(p.runJson, JSON.stringify({ schemaVersion: 2, runId: 'r5', futureField: true }))
    const s = await RunStore.open(home(), 'r5')
    expect(s.readOnly).toBe(true)
    expect(s.version).toBe(2)
    expect(s.doc).toMatchObject({ futureField: true })
    expect(() => s.set({ runId: 'r5' })).toThrow(/newer Dim Factory/)
    try {
      s.set({ runId: 'r5' })
    } catch (err) {
      expect((err as DimFactoryError).code).toBe('NEWER_SCHEMA')
    }
    await expect(s.writeText('plan', 'x')).rejects.toMatchObject({ code: 'NEWER_SCHEMA' })
    await expect(s.writeJson('findings', {})).rejects.toMatchObject({ code: 'NEWER_SCHEMA' })
    await s.close()
    expect(JSON.parse(await readFile(p.runJson, 'utf8'))).toEqual({
      schemaVersion: 2,
      runId: 'r5',
      futureField: true,
    })
  })

  it('open() reports NOT_FOUND for a missing run and STORAGE(corrupt) for junk', async () => {
    await expect(RunStore.open(home(), 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const p = homePaths(home()).run('bad')
    await mkdir(p.dir, { recursive: true })
    await writeFile(p.runJson, '{"truncated":')
    await expect(RunStore.open(home(), 'bad')).rejects.toMatchObject({
      code: 'STORAGE',
      details: { corrupt: true },
    })
    expect((await readRunJson(home(), 'bad')).kind).toBe('corrupt')
  })

  it('applies upgraders and validation on open', async () => {
    const p = homePaths(home()).run('old')
    await mkdir(p.dir, { recursive: true })
    await writeFile(p.runJson, JSON.stringify({ runId: 'old' }))
    const s = await RunStore.open<{ runId: string; schemaVersion: number }>(home(), 'old', {
      validate: (d) => (typeof d['runId'] === 'string' ? { runId: d['runId'], schemaVersion: 1 } : null),
    })
    expect(s.doc).toEqual({ runId: 'old', schemaVersion: 1 })
    await expect(RunStore.open(home(), 'old', { validate: () => null })).rejects.toMatchObject({
      code: 'STORAGE',
    })
  })

  it('writes and reads pass outputs and versioned side files', async () => {
    const s = await RunStore.create(home(), 'r6', { runId: 'r6' })
    expect(await s.readText('plan')).toBeNull()
    await s.writeText('plan', '# Goal\n')
    await s.writeText('plan.original', '# Goal (original)\n')
    const plan = await s.readText('plan')
    expect(plan?.text).toBe('# Goal\n')
    expect(plan?.mtime).toBeGreaterThan(0)
    expect(await readFile(join(s.paths.dir, 'plan.original.md'), 'utf8')).toBe('# Goal (original)\n')
    await s.writeJson('resolved', { profile: 'balanced' })
    expect(JSON.parse(await readFile(s.paths.resolvedJson, 'utf8'))).toEqual({
      schemaVersion: 1,
      profile: 'balanced',
    })
    const r = await s.readJson('resolved')
    expect(r.kind === 'ok' && r.value).toEqual({ schemaVersion: 1, profile: 'balanced' })
    expect((await s.readJson('findings')).kind).toBe('missing')
  })

  it('a failed write stays dirty and is retried by the next flush', async () => {
    const s = await RunStore.create<Doc>(home(), 'r7', { runId: 'r7', status: 'queued', lastSeq: 0 })
    s.set((d) => ({ ...d, lastSeq: 5 }))
    // Make run.json a directory so the rename fails, then restore.
    const { rm } = await import('node:fs/promises')
    await rm(s.paths.runJson)
    await mkdir(join(s.paths.runJson, 'blocker'), { recursive: true })
    await expect(s.flush()).rejects.toMatchObject({ code: 'STORAGE' })
    expect(s.dirty).toBe(true)
    await rm(s.paths.runJson, { recursive: true })
    await s.flush()
    expect(await readRunJsonFile('r7')).toMatchObject({ lastSeq: 5 })
  })

  it('removeRunDir deletes the folder; listRunIds skips files and odd names', async () => {
    await RunStore.create(home(), 'keep', {})
    await RunStore.create(home(), 'gone', {})
    await writeFile(join(homePaths(home()).runsDir, 'index.jsonl'), '')
    await removeRunDir(home(), 'gone')
    expect((await listRunIds(home())).sort()).toEqual(['keep'])
    expect(await readdir(homePaths(home()).runsDir)).toContain('index.jsonl')
    await expect(stat(homePaths(home()).run('gone').dir)).rejects.toThrow()
  })
})
