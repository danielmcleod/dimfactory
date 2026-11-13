// Scheduler ("Isolated runs lock their own worktree path"; Apply "Lease the folder lock"): an
// isolated run's own lock is its worktree's; its apply leases the folder's lock, FIFO with the runs there.
import { describe, expect, it } from 'vitest'
import { FolderScheduler } from '@core/supervisor/scheduler.ts'

const FOLDER = 'c:\\repo'
const WORKTREE = 'c:\\home\\worktrees\\run-iso'

describe('FolderScheduler leases', () => {
  it('an isolated run holds its worktree path, so an in-place run in its folder starts at once', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    const order: string[] = []
    s.request('iso', WORKTREE, () => order.push('iso'))
    s.request('inplace', FOLDER, () => order.push('inplace'))
    expect(order).toEqual(['iso', 'inplace'])
  })

  it('the apply lease queues behind the in-place run holding the folder (FIFO), and is granted on its release', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    const order: string[] = []
    s.request('inplace', FOLDER, () => order.push('inplace'))
    s.request('iso', WORKTREE, () => order.push('iso'))
    expect(s.lease('iso', FOLDER, () => order.push('iso-lease'))).toBe('queued')
    expect(s.blockedBy('iso', { lease: true })).toMatchObject({ runId: 'inplace', state: 'holder' })
    // A later in-place run queues behind the lease.
    s.request('inplace-2', FOLDER, () => order.push('inplace-2'))
    s.release('inplace')
    expect(order).toEqual(['inplace', 'iso', 'iso-lease'])
    expect(s.isLeaseHolder('iso')).toBe(true)
    expect(s.isHolder('iso')).toBe(true)
    expect(s.holders().find((h) => h.lease === true)).toMatchObject({ runId: 'iso', lockKey: FOLDER })
    s.releaseLease('iso')
    expect(order).toEqual(['inplace', 'iso', 'iso-lease', 'inplace-2'])
    // The run's own lock is untouched by its lease's release.
    expect(s.isHolder('iso')).toBe(true)
  })

  it('a lease is its own entry: releasing the run lock leaves the lease, and the other way round', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    s.request('iso', WORKTREE, () => undefined)
    s.lease('iso', FOLDER, () => undefined)
    s.release('iso')
    expect(s.isLeaseHolder('iso')).toBe(true)
    expect(s.isHolder('iso')).toBe(false)
    expect(s.blockerFor(FOLDER)).toMatchObject({ runId: 'iso' })
    s.releaseLease('iso')
    expect(s.blockerFor(FOLDER)).toBeUndefined()
  })

  it('a run never waits for itself: its lease of the folder its own lock holds is granted at once', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    const order: string[] = []
    // A run.json without a worktree lock key: the isolated run holds the folder itself.
    s.request('iso', FOLDER, () => order.push('iso'))
    expect(s.lease('iso', FOLDER, () => order.push('iso-lease'))).toBe('granted')
    expect(order).toEqual(['iso', 'iso-lease'])
    // Another run still waits for both.
    s.request('other', FOLDER, () => order.push('other'))
    s.releaseLease('iso')
    expect(order).toEqual(['iso', 'iso-lease'])
    s.release('iso')
    expect(order).toEqual(['iso', 'iso-lease', 'other'])
  })

  it('a queued lease leaves the queue on release (Stop while it waited)', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    const order: string[] = []
    s.request('inplace', FOLDER, () => order.push('inplace'))
    s.lease('iso', FOLDER, () => order.push('iso-lease'))
    s.releaseLease('iso')
    s.release('inplace')
    expect(order).toEqual(['inplace'])
    expect(s.queued()).toEqual([])
  })
})
