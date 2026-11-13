// Close and quit policy (src/main/quit.ts): the decision tables and the one quit path
// (confirm banner, no re-entrancy, 8 s shutdown budget, exit even when shutdown hangs or fails).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuitController, decideClose, decideQuit, withinBudget } from '../../../src/main/quit.ts'
import type { CloseAction, CloseToTray, QuitControllerDeps, QuitDecision } from '../../../src/main/quit.ts'

describe('decideQuit', () => {
  it.each<[boolean, boolean, number, QuitDecision]>([
    // quitting, confirmed, interruptible → decision
    [false, false, 0, 'quit'],
    [false, true, 0, 'quit'],
    [false, false, 2, 'confirm'],
    [false, true, 2, 'quit'],
    [true, false, 0, 'already-quitting'],
    [true, false, 3, 'already-quitting'],
    [true, true, 3, 'already-quitting'],
  ])('quitting=%s confirmed=%s interruptible=%i → %s', (quitting, confirmed, interruptible, want) => {
    expect(decideQuit({ quitting, confirmed, interruptible })).toBe(want)
  })
})

describe('decideClose', () => {
  it.each<[CloseToTray, NodeJS.Platform, CloseAction]>([
    ['auto', 'win32', 'hide'],
    ['auto', 'darwin', 'hide'],
    ['auto', 'linux', 'minimize'],
    [true, 'win32', 'hide'],
    [true, 'darwin', 'hide'],
    [true, 'linux', 'hide'],
    [false, 'win32', 'quit'],
    [false, 'linux', 'quit'],
    [false, 'darwin', 'hide'],
  ])('closeToTray=%s on %s → %s', (closeToTray, platform, want) => {
    expect(decideClose({ quitting: false, closeToTray, platform })).toBe(want)
  })

  it('lets the window close while quitting', () => {
    expect(decideClose({ quitting: true, closeToTray: 'auto', platform: 'win32' })).toBe('allow')
  })
})

describe('QuitController', () => {
  afterEach(() => vi.useRealTimers())

  function make(over: Partial<QuitControllerDeps> = {}, runIds: string[] = []) {
    const calls: string[] = []
    const deps: QuitControllerDeps = {
      interruptible: () => runIds,
      requestConfirmation: (ids) => calls.push(`confirm:${ids.join(',')}`),
      beforeShutdown: () => calls.push('before'),
      shutdown: () => {
        calls.push('shutdown')
        return Promise.resolve()
      },
      exit: (code) => calls.push(`exit:${code}`),
      defer: (fn) => fn(),
      ...over,
    }
    return { q: new QuitController(deps), calls }
  }

  it('asks for confirmation when runs would be interrupted', async () => {
    const { q, calls } = make({}, ['r1', 'r2'])
    expect(await q.request(false)).toEqual({ quitting: false, activeRuns: 2 })
    expect(calls).toEqual(['confirm:r1,r2'])
    expect(q.quitting).toBe(false)
  })

  it('quits when confirmed: before-shutdown, shutdown, then exit(0)', async () => {
    const { q, calls } = make({}, ['r1'])
    expect(await q.request(true)).toEqual({ quitting: true, activeRuns: 1 })
    await q.done
    expect(calls).toEqual(['before', 'shutdown', 'exit:0'])
  })

  it('quits without asking when nothing would be interrupted', async () => {
    const { q, calls } = make()
    expect(await q.request(false)).toEqual({ quitting: true, activeRuns: 0 })
    await q.done
    expect(calls).toEqual(['before', 'shutdown', 'exit:0'])
  })

  it('is not re-entrant: later requests while quitting do nothing', async () => {
    const { q, calls } = make()
    await q.request(true)
    expect(await q.request(true)).toEqual({ quitting: true, activeRuns: 0 })
    q.endSession('test')
    await q.done
    expect(calls.filter((c) => c === 'shutdown')).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('exit'))).toHaveLength(1)
  })

  it('exits after the budget when shutdown hangs', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const { q } = make({ shutdown: () => new Promise<void>(() => undefined), exit, budgetMs: 8000 })
    await q.request(true)
    await vi.advanceTimersByTimeAsync(7999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await q.done
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits when shutdown rejects or throws, and when beforeShutdown throws', async () => {
    const warn = vi.fn()
    const a = make({ shutdown: () => Promise.reject(new Error('x')), log: { warn, info: vi.fn() } })
    await a.q.request(true)
    await a.q.done
    expect(a.calls.at(-1)).toBe('exit:0')

    const b = make({
      shutdown: () => {
        throw new Error('sync')
      },
      beforeShutdown: () => {
        throw new Error('tray')
      },
      log: { warn, info: vi.fn() },
    })
    await b.q.request(true)
    await b.q.done
    expect(b.calls.at(-1)).toBe('exit:0')
    expect(warn).toHaveBeenCalled()
  })

  it('endSession shuts down without asking, even with runs to interrupt', async () => {
    const { q, calls } = make({}, ['r1'])
    q.endSession('session end')
    await q.done
    expect(calls).toEqual(['before', 'shutdown', 'exit:0'])
  })

  it('answers the IPC request before the shutdown starts (deferred)', async () => {
    const order: string[] = []
    let run: (() => void) | undefined
    const { q } = make({
      defer: (fn) => {
        run = fn
      },
      shutdown: () => {
        order.push('shutdown')
        return Promise.resolve()
      },
    })
    const reply = await q.request(true)
    order.push(`reply:${String(reply.quitting)}`)
    run?.()
    await q.done
    expect(order).toEqual(['reply:true', 'shutdown'])
  })
})

describe('withinBudget', () => {
  it('reports done, failed and timeout', async () => {
    expect(await withinBudget(Promise.resolve(), 50)).toBe('done')
    expect(await withinBudget(Promise.reject(new Error('x')), 50)).toBe('failed')
    expect(await withinBudget(new Promise(() => undefined), 10)).toBe('timeout')
  })
})
