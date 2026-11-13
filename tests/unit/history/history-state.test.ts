// runs/history.json (runs history Pin / Remove (undo)): pins and pending removals are durable,
// memory never says more than the disk, the overlay pins and hides, and a read-only process never writes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { HistoryState, degradedText, historyStateFile } from '../../../src/core/store/history-state.ts'
import { summary } from './helpers.ts'

const paths = (): ReturnType<typeof homePaths> => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')

describe('HistoryState', () => {
  it('starts empty, then keeps pins and removals across a reload', async () => {
    const p = paths()
    const st = await HistoryState.load(p)
    expect(st.pinnedIds()).toEqual([])
    expect(st.removals()).toEqual([])
    await st.setPinned('run-1', true, 50)
    await st.setPinned('run-1', true, 99) // pinned again: the first time stays
    await st.addRemoval({
      token: 't1',
      runIds: ['run-2'],
      requestedAt: 10,
      deleteAt: 20,
      summaries: [summary(2)],
    })
    const again = await HistoryState.load(p)
    expect(again.isPinned('run-1')).toBe(true)
    expect(again.isHidden('run-2')).toBe(true)
    expect(again.removal('t1')).toMatchObject({ runIds: ['run-2'], deleteAt: 20 })
    expect(JSON.parse(readFileSync(historyStateFile(p), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      pinned: { 'run-1': 50 },
    })
    await again.setPinned('run-1', false, 1)
    await again.dropRemoval('t1')
    const third = await HistoryState.load(p)
    expect(third.isPinned('run-1')).toBe(false)
    expect(third.isHidden('run-2')).toBe(false)
  })

  it('the overlay pins a summary and leaves out a removed run', async () => {
    const st = await HistoryState.load(paths())
    await st.setPinned('run-1', true, 1)
    await st.addRemoval({ token: 't', runIds: ['run-3'], requestedAt: 0, deleteAt: 1, summaries: [] })
    expect(st.overlay(summary(1))?.pinned).toBe(true)
    expect(st.overlay(summary(2, { pinned: true }))?.pinned).toBe(false)
    const same = summary(4)
    expect(st.overlay(same)).toBe(same)
    expect(st.overlay(summary(3))).toBeNull()
  })

  it('forget drops the pins and the removal entries of runs deleted for real', async () => {
    const st = await HistoryState.load(paths())
    await st.setPinned('run-1', true, 1)
    await st.addRemoval({
      token: 't',
      runIds: ['run-1', 'run-2'],
      requestedAt: 0,
      deleteAt: 1,
      summaries: [summary(1), summary(2)],
    })
    await st.forget(['run-1'])
    expect(st.isPinned('run-1')).toBe(false)
    expect(st.removal('t')).toMatchObject({ runIds: ['run-2'] })
    expect(st.removal('t')?.summaries.map((s) => s.runId)).toEqual(['run-2'])
    await st.forget(['run-2'])
    expect(st.removal('t')).toBeUndefined()
  })

  it('a failed write changes nothing in memory', async () => {
    const p = paths()
    const st = await HistoryState.load(p)
    // A folder where the file should be: every atomic write fails.
    mkdirSync(historyStateFile(p), { recursive: true })
    await expect(st.setPinned('run-1', true, 1)).rejects.toThrow()
    expect(st.isPinned('run-1')).toBe(false)
    await expect(
      st.addRemoval({ token: 't', runIds: ['run-2'], requestedAt: 0, deleteAt: 1, summaries: [] }),
    ).rejects.toThrow()
    expect(st.isHidden('run-2')).toBe(false)
  })

  it('a read-only process never writes; an unreadable file reads as empty', async () => {
    const p = paths()
    mkdirSync(dirname(historyStateFile(p)), { recursive: true })
    writeFileSync(historyStateFile(p), '{ not json')
    const st = await HistoryState.load(p)
    expect(st.pinnedIds()).toEqual([])
    const ro = await HistoryState.load(p, { readOnly: true })
    await expect(ro.setPinned('run-1', true, 1)).rejects.toThrow(/read-only/)
    expect(readFileSync(historyStateFile(p), 'utf8')).toBe('{ not json')
  })

  it('a file from a newer Dim Factory is read-only', async () => {
    const p = paths()
    mkdirSync(dirname(historyStateFile(p)), { recursive: true })
    writeFileSync(
      historyStateFile(p),
      JSON.stringify({ schemaVersion: 2, pinned: { 'run-9': 1 }, removals: [] }),
    )
    const st = await HistoryState.load(p)
    expect(st.readOnly).toBe(true)
    expect(st.isPinned('run-9')).toBe(true)
    await expect(st.setPinned('run-1', true, 1)).rejects.toThrow()
  })

  // ---- A damaged or unreadable file never reads as "no pins" ----

  it('a corrupt file is kept as history.json.bad and the state is degraded: pins adopted from the index, then repaired', async () => {
    const p = paths()
    mkdirSync(dirname(historyStateFile(p)), { recursive: true })
    const damaged = '{"schemaVersion":1,"pinned":{"2026'
    writeFileSync(historyStateFile(p), damaged)
    const st = await HistoryState.load(p)
    expect(st.degraded).toMatchObject({ kind: 'corrupt' })
    expect(st.readOnly).toBe(false)
    expect(readFileSync(`${historyStateFile(p)}.bad`, 'utf8')).toBe(damaged)
    // The index's pins are taken (a union: a later adopt never unpins).
    st.adoptPins(['run-1', 'run-2'], 7)
    st.adoptPins(['run-3'], 8)
    expect(st.pinnedIds().sort()).toEqual(['run-1', 'run-2', 'run-3'])
    expect(st.overlay(summary(2))?.pinned).toBe(true)
    await st.repair()
    const again = await HistoryState.load(p)
    expect(again.degraded).toBeUndefined()
    expect(again.pinnedIds().sort()).toEqual(['run-1', 'run-2', 'run-3'])
    expect(degradedText({ kind: 'corrupt', error: 'x' })).not.toContain(String.fromCharCode(0x2014))
  })

  it('a file that cannot be read (after retries) gives a degraded, read-only state; nothing is written over it', async () => {
    const p = paths()
    // A folder where the file should be: every read fails (EISDIR), as a file held by other software would.
    mkdirSync(historyStateFile(p), { recursive: true })
    const st = await HistoryState.load(p, { retryMs: 1 })
    expect(st.degraded).toMatchObject({ kind: 'unreadable' })
    expect(st.readOnly).toBe(true)
    st.adoptPins(['run-1'], 1)
    expect(st.isPinned('run-1')).toBe(true)
    await expect(st.setPinned('run-2', true, 1)).rejects.toMatchObject({ code: 'STORAGE' })
    await expect(st.repair()).rejects.toThrow(/could not be read/)
    expect(existsSync(`${historyStateFile(p)}.bad`)).toBe(false)
  })

  it('a healthy state never adopts pins from the index (the file is the record)', async () => {
    const st = await HistoryState.load(paths())
    expect(st.degraded).toBeUndefined()
    st.adoptPins(['run-1'], 1)
    expect(st.isPinned('run-1')).toBe(false)
  })
})
