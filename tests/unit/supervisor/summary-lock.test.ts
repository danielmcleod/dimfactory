// RunSummary.lock (the scheduler; the composer's Queue and "Folder busy" are core's folder.lock answer): the
// summary says whether the run holds or queues for its folder lock, so a released lock (not a status change: a
// stopped run is cancelled before its last snapshot lets the folder go) is visible to whoever re-asks core.
import { describe, expect, it } from 'vitest'
import { toRunSummary } from '@core/supervisor/derive.ts'
import { Harness } from './helpers.ts'

describe('RunSummary.lock', () => {
  it('is requested while queued, held while the run owns its folder, and absent once released', () => {
    const h = new Harness()
    h.create()
    expect(h.state.lock).toBe('requested')
    expect(toRunSummary(h.state).lock).toBe('requested')
    h.lock()
    expect(toRunSummary(h.state).lock).toBe('held')
    h.preflight()
    h.snapshot('run-start', 'tree-base')
    h.passPreflight('plan')
    h.user({ kind: 'stop' })
    // Cancelled, but the folder is not free yet: the stop still owes its snapshot.
    expect(h.state.status).toBe('cancelled')
    expect(toRunSummary(h.state).lock).toBe('held')
    h.exit('plan', { code: null })
    h.snapshot('stopped', 'tree-base')
    expect(h.log.some((e) => e.t === 'unlock')).toBe(true)
    expect(toRunSummary(h.state).lock).toBeUndefined()
  })
})
