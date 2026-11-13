// Small main-process helpers: quit/devtools keys (keys.ts), the e2e.state snapshot and globals (e2e.ts), and the
// event-loop statistics (perf.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import { bootFailure, recoveredNotice } from '../../../src/main/boot-messages.ts'
import { APP_ID, TOAST_ACTIVATOR_CLSID } from '../../../src/main/constants.ts'
import { E2E_GLOBAL, buildE2EState, installE2EGlobals, liveProcs } from '../../../src/main/e2e.ts'
import { keyAction } from '../../../src/main/keys.ts'
import { startEventLoopMonitor, statsOf } from '../../../src/main/perf.ts'

const key = (
  k: string,
  mods: Partial<Record<'control' | 'meta' | 'alt' | 'shift', boolean>> = {},
  type = 'keyDown',
) => ({
  type,
  key: k,
  control: mods.control ?? false,
  meta: mods.meta ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
})

describe('identity constants', () => {
  it('match the packaging values', () => {
    expect(APP_ID).toBe('com.dimfactory.desktop')
    expect(TOAST_ACTIVATOR_CLSID).toBe('{5623D05F-66EA-4E4C-993F-A156F0425595}')
  })
})

describe('keyAction', () => {
  const win = { platform: 'win32' as const, packaged: true }

  it('Ctrl+Q quits on Windows and Linux', () => {
    expect(keyAction(key('q', { control: true }), win)).toBe('quit')
    expect(keyAction(key('Q', { control: true }), { platform: 'linux', packaged: true })).toBe('quit')
  })

  it('ignores other chords, key-up, and macOS (the menu handles Cmd+Q)', () => {
    expect(keyAction(key('q', { control: true, shift: true }), win)).toBeNull()
    expect(keyAction(key('q', { control: true, alt: true }), win)).toBeNull()
    expect(keyAction(key('q'), win)).toBeNull()
    expect(keyAction(key('q', { control: true }, 'keyUp'), win)).toBeNull()
    expect(keyAction(key('q', { meta: true }), { platform: 'darwin', packaged: true })).toBeNull()
    expect(keyAction(key('q', { control: true }), { platform: 'darwin', packaged: true })).toBeNull()
  })

  it('F12 toggles DevTools only when unpackaged', () => {
    expect(keyAction(key('F12'), { platform: 'win32', packaged: false })).toBe('devtools')
    expect(keyAction(key('F12'), win)).toBeNull()
    expect(keyAction(key('F12', { shift: true }), { platform: 'win32', packaged: false })).toBeNull()
  })
})

describe('e2e.state', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[E2E_GLOBAL]
  })

  it('lists live vendor processes of the given runs', () => {
    const steps = {
      plan: { proc: { live: false, pid: 1 } },
      implement: { proc: { live: true, pid: 4242 } },
      review: { proc: { live: true } },
    } as Record<string, unknown>
    const core = {
      controller: (id: string) =>
        id === 'r1'
          ? ({ state: { steps: new Proxy(steps, { get: (t, k) => t[k as string] ?? {} }) } } as never)
          : undefined,
    }
    expect(liveProcs(core, ['r1', 'gone'])).toEqual([{ runId: 'r1', step: 'implement', pid: 4242 }])
  })

  it('builds the snapshot with no notifications and the event-loop extras', () => {
    const s = buildE2EState({
      clock: { now: () => 123, scale: 50 },
      activeRuns: 2,
      procs: [],
      windowFocused: true,
      tray: null,
      eventLoop: { read: () => ({ p50Ms: 1, p95Ms: 12.5, maxMs: 40, samples: 9 }) },
    })
    expect(s).toEqual({
      now: 123,
      timeScale: 50,
      activeRuns: 2,
      procs: [],
      windowFocused: true,
      notifications: [],
      tray: { icon: '', tooltip: '' },
      extra: { eventLoopP95Ms: 12.5, eventLoopMaxMs: 40 },
    })
  })

  it('installs the main-process global Playwright reaches', () => {
    let resets = 0
    installE2EGlobals({
      eventLoop: { read: () => ({ p50Ms: 0, p95Ms: 0, maxMs: 0, samples: 0 }), reset: () => void resets++ },
    })
    const g = (globalThis as Record<string, unknown>)[E2E_GLOBAL] as { eventLoop: { reset(): void } }
    g.eventLoop.reset()
    expect(resets).toBe(1)
  })
})

describe('event-loop stats', () => {
  it('converts nanoseconds to rounded milliseconds and reports an empty histogram as zero', () => {
    expect(statsOf({ count: 0, percentile: () => 9e18, max: 9e18 })).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      samples: 0,
    })
    expect(
      statsOf({
        count: 10,
        percentile: (p: number) => (p === 50 ? 10_120_000 : 20_160_000),
        max: 55_555_555,
      }),
    ).toEqual({ p50Ms: 10.1, p95Ms: 20.2, maxMs: 55.6, samples: 10 })
  })

  it('measures, resets and stops', async () => {
    const m = startEventLoopMonitor({ resolutionMs: 10, logEveryMs: 20 })
    const logged: Record<string, unknown>[] = []
    m.setLog((_msg, data) => logged.push(data))
    await new Promise((r) => setTimeout(r, 120))
    const s = m.read()
    expect(s.samples).toBeGreaterThan(0)
    expect(s.p95Ms).toBeGreaterThanOrEqual(0)
    expect(logged.length).toBeGreaterThan(0)
    m.reset()
    expect(m.read().samples).toBe(0)
    m.stop()
  })
})

describe('boot messages', () => {
  it('explains a home held by the app or by a CLI command', () => {
    const app = bootFailure(
      new DimFactoryError('HOME_LOCKED', 'x', { details: { pid: 1, kind: 'app' } }),
      '/home/h',
    )
    expect(app.code).toBe('HOME_LOCKED')
    expect(app.message).toContain('Dim Factory is already running with /home/h')
    const cli = bootFailure(
      new DimFactoryError('HOME_LOCKED', 'x', { details: { pid: 1, kind: 'cli' } }),
      '/home/h',
    )
    expect(cli.message).toContain('command-line session')
    expect(cli.message).not.toContain('tray')
  })

  it('explains a newer home and any other failure', () => {
    expect(bootFailure(new DimFactoryError('NEWER_SCHEMA', 'v2'), '/h').message).toContain('newer version')
    const other = bootFailure(new Error('EACCES'), '/h')
    expect(other).toMatchObject({ code: 'error', title: 'Dim Factory cannot start' })
    expect(other.message).toContain('EACCES')
  })

  it('builds the recovery notice only when runs were paused', () => {
    expect(recoveredNotice([], 3)).toBeNull()
    expect(recoveredNotice(['r1'], 1)).toEqual({
      kind: 'app',
      state: 'recovered',
      activeRuns: 1,
      runIds: ['r1'],
      detail: '1 run was paused because Dim Factory closed',
    })
    expect(recoveredNotice(['r1', 'r2'], 2)).toMatchObject({
      detail: '2 runs were paused because Dim Factory closed',
    })
  })
})
