import { describe, expect, it } from 'vitest'
import {
  ADAPTER_ERROR_ALIASES,
  AdapterError,
  BufferedEmitter,
  TailBuffer,
  classifyFailure,
  errorEvent,
  failedRunHandle,
  makeFailure,
  toFailureCategory,
} from '@core/adapters/errors.ts'
import { FAILURE_CATEGORIES, isFailureCategory } from '@shared/failure.ts'

describe('aliases', () => {
  it('maps every alias to a canonical category', () => {
    for (const c of Object.values(ADAPTER_ERROR_ALIASES)) expect(isFailureCategory(c)).toBe(true)
    expect(toFailureCategory('auth-missing')).toBe('auth_required')
    expect(toFailureCategory('protocol-drift')).toBe('flag_drift')
    expect(toFailureCategory('stopped')).toBe('user_cancelled')
    expect(toFailureCategory('stall-timeout')).toBe('timeout_hard')
    expect(toFailureCategory('rate_limited')).toBe('rate_limited')
    expect(toFailureCategory('???')).toBe('unknown')
    for (const c of FAILURE_CATEGORIES) expect(toFailureCategory(c)).toBe(c)
  })
})

describe('failures and events', () => {
  it('makeFailure omits absent optional fields', () => {
    expect(makeFailure('network', 'down')).toEqual({
      category: 'network',
      message: 'down',
      raw: '',
      classifiedBy: 'app',
    })
    expect(
      makeFailure('rate_limited', 'x', {
        resetsAt: 5,
        retryAfterMs: 1,
        step: 'fix',
        classifiedBy: 'structured',
      }),
    ).toEqual({
      category: 'rate_limited',
      message: 'x',
      raw: '',
      classifiedBy: 'structured',
      step: 'fix',
      resetsAt: 5,
      retryAfterMs: 1,
    })
  })

  it('errorEvent carries the category', () => {
    const f = makeFailure('auth_required', 'Not logged in', { raw: 'r' })
    expect(errorEvent(f)).toEqual({
      type: 'error',
      message: 'Not logged in',
      raw: 'r',
      fatal: true,
      category: 'auth_required',
    })
    expect(errorEvent(f, false).fatal).toBe(false)
  })

  it('classifyFailure never returns null for a failed attempt', () => {
    expect(classifyFailure({ vendor: 'claude' }).category).toBe('unknown')
    expect(
      classifyFailure({ vendor: 'claude', stderrTail: 'Not logged in · Please run /login' }).category,
    ).toBe('auth_required')
  })

  it('AdapterError carries the failure', () => {
    const e = new AdapterError(makeFailure('cli_missing', 'gone'))
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('gone')
    expect(e.failure.category).toBe('cli_missing')
  })
})

describe('TailBuffer', () => {
  it('keeps the last N lines and caps line length', () => {
    const t = new TailBuffer(3, 5)
    for (const l of ['a', 'b', 'c', 'd', '1234567']) t.push(l)
    expect(t.lines()).toEqual(['c', 'd', '12345…'])
    expect(t.text()).toBe('c\nd\n12345…')
    expect(t.size).toBe(3)
    t.clear()
    expect(t.size).toBe(0)
  })
})

describe('BufferedEmitter', () => {
  it('replays items emitted before the first subscriber, then fans out', async () => {
    const e = new BufferedEmitter<number>()
    e.emit(1)
    e.emit(2)
    const a: number[] = []
    const b: number[] = []
    const offA = e.subscribe((v) => a.push(v))
    expect(a).toEqual([])
    await Promise.resolve()
    expect(a).toEqual([1, 2])
    e.subscribe((v) => b.push(v))
    e.emit(3)
    offA()
    e.emit(4)
    await Promise.resolve()
    expect(a).toEqual([1, 2, 3])
    expect(b).toEqual([3, 4])
  })
})

describe('failedRunHandle', () => {
  it('emits one fatal error and resolves exited', async () => {
    const h = failedRunHandle({
      vendor: 'claude',
      route: 'stdio',
      failure: makeFailure('cli_missing', 'ENOENT'),
      sessionId: 's1',
    })
    const seen: string[] = []
    h.onEvent((ev) => seen.push(ev.type))
    h.onSignal(() => seen.push('signal'))
    await expect(h.exited).resolves.toEqual({ code: null, signal: null, sawTerminal: true, ranMs: 0 })
    await Promise.resolve()
    expect(seen).toEqual(['error'])
    expect(h.sessionId()).toBe('s1')
    expect(h.cumulativeUsage()).toBeUndefined()
    expect(h.pid).toBeUndefined()
  })
})
