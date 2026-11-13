// Main's runs view (src/main/runs-model.ts): active runs for the tray, needsYou from `attention`, and the runs a
// quit would interrupt.
import { describe, expect, it } from 'vitest'
import { ACTIVE_RUN_STATUSES, RunsModel, trayKey } from '../../../src/main/runs-model.ts'
import type { AttentionItem } from '../../../src/shared/estimates.ts'
import type { RunStatus, RunSummary } from '../../../src/shared/run.ts'

const s = (runId: string, status: RunStatus, displayNo: number, title = `Run ${displayNo}`): RunSummary =>
  ({ runId, status, displayNo, title }) as RunSummary
const item = (runId: string): AttentionItem =>
  ({
    id: `card:${runId}`,
    runId,
    kind: 'card',
    displayNo: 1,
    title: '',
    folder: '',
    since: 0,
  }) as AttentionItem

describe('RunsModel', () => {
  it('counts queued, running, waiting and paused runs as active', () => {
    expect([...ACTIVE_RUN_STATUSES]).toEqual(['queued', 'running', 'waiting', 'paused'])
    const m = new RunsModel()
    m.reset([
      s('a', 'running', 3),
      s('b', 'completed', 1),
      s('c', 'paused', 2),
      s('d', 'failed', 4),
      s('e', 'queued', 5),
      s('f', 'waiting', 6),
      s('g', 'cancelled', 7),
    ])
    expect(m.activeCount).toBe(4)
    expect(m.activeRunIds()).toEqual(['c', 'a', 'e', 'f'])
  })

  it('a quit interrupts queued, running and waiting runs, not paused ones', () => {
    const m = new RunsModel()
    m.reset([s('a', 'running', 1), s('b', 'paused', 2), s('c', 'waiting', 3), s('d', 'queued', 4)])
    expect(m.interruptibleRunIds()).toEqual(['a', 'c', 'd'])
  })

  it('upsert reports changes and drops finished runs', () => {
    const m = new RunsModel()
    expect(m.upsert(s('a', 'completed', 1))).toBe(false)
    expect(m.upsert(s('a', 'running', 1))).toBe(true)
    expect(m.upsert(s('a', 'running', 1))).toBe(false)
    expect(m.upsert(s('a', 'running', 1, 'Renamed'))).toBe(true)
    expect(m.upsert(s('a', 'waiting', 1, 'Renamed'))).toBe(true)
    expect(m.upsert(s('a', 'completed', 1))).toBe(true)
    expect(m.activeCount).toBe(0)
  })

  it('builds the tray state with needsYou per run', () => {
    const m = new RunsModel()
    m.reset([s('a', 'running', 1, 'Add flag'), s('b', 'waiting', 2, 'Fix bug')])
    expect(m.setAttention(1, [item('b')])).toBe(true)
    expect(m.setAttention(1, [item('b')])).toBe(false)
    expect(m.trayState()).toEqual({
      activeRuns: 2,
      needsYou: 1,
      runs: [
        { runId: 'a', title: 'Add flag', needsYou: false },
        { runId: 'b', title: 'Fix bug', needsYou: true },
      ],
    })
    expect(m.needsYou).toBe(1)
    expect(trayKey(m.trayState())).toBe(trayKey(m.trayState()))
    expect(m.setAttention(0, [])).toBe(true)
    expect(m.trayState().runs.every((r) => !r.needsYou)).toBe(true)
  })
})
