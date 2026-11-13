// The dimf:cmd pipeline after the sender check (src/main/router.ts): envelope, command gating, request schema,
// main vs core routing, and that every path resolves to a Result.
import { describe, expect, it, vi } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import { MAIN_COMMANDS, checkEnvelope, createRouter, isMainCommand } from '../../../src/main/router.ts'
import type { MainHandlers, RouterDeps } from '../../../src/main/router.ts'
import { makeEnvelope } from '../../../src/preload/wire.ts'
import { parseRequest } from '../../../src/shared/ipc-schemas.ts'
import { COMMAND_AREA, IPC_PROTOCOL } from '../../../src/shared/ipc.ts'
import type { Cmd, Result } from '../../../src/shared/ipc.ts'

const env = (cmd: string, req?: unknown): unknown => makeEnvelope(cmd as Cmd, req, 'cid-1')

function setup(over: Partial<RouterDeps> = {}) {
  const core = vi.fn((cmd: Cmd, req: unknown): Promise<Result<unknown>> =>
    Promise.resolve({ ok: true, value: { from: 'core', cmd, req } }),
  )
  const main: MainHandlers = {
    'app.info': vi.fn(() => Promise.reject(new Error('not used'))),
    'events.focus': vi.fn(() => Promise.resolve()),
    'e2e.state': vi.fn(() =>
      Promise.resolve({
        now: 1,
        timeScale: 1,
        activeRuns: 0,
        procs: [],
        windowFocused: false,
        notifications: [],
        tray: { icon: '', tooltip: '' },
      }),
    ),
    'ui.setTheme': vi.fn(() => Promise.reject(new DimFactoryError('STORAGE', 'disk full'))),
  }
  const onFailure = vi.fn()
  const router = createRouter({
    e2e: false,
    parse: (cmd, raw) => parseRequest(cmd, raw),
    main,
    core,
    onFailure,
    ...over,
  })
  return { router, core, main, onFailure }
}

describe('checkEnvelope', () => {
  it('accepts the preload envelope', () => {
    expect(checkEnvelope(makeEnvelope('runs.list', {}, 'c'))).toEqual({
      ok: true,
      value: { cmd: 'runs.list', req: {}, cid: 'c' },
    })
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['a string', 'runs.list'],
    ['extra keys', { v: IPC_PROTOCOL, cmd: 'runs.list', req: {}, cid: 'c', sender: 'x' }],
    ['another protocol', { v: IPC_PROTOCOL + 1, cmd: 'runs.list', req: {}, cid: 'c' }],
    ['no protocol', { cmd: 'runs.list', req: {}, cid: 'c' }],
    ['a non-string cmd', { v: IPC_PROTOCOL, cmd: 7, req: {}, cid: 'c' }],
    ['an empty cmd', { v: IPC_PROTOCOL, cmd: '', req: {}, cid: 'c' }],
    ['a huge cmd', { v: IPC_PROTOCOL, cmd: 'x'.repeat(200), req: {}, cid: 'c' }],
    ['a missing cid', { v: IPC_PROTOCOL, cmd: 'runs.list', req: {} }],
    ['a huge cid', { v: IPC_PROTOCOL, cmd: 'runs.list', req: {}, cid: 'c'.repeat(500) }],
  ])('rejects %s with VALIDATION', (_name, raw) => {
    const r = checkEnvelope(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('VALIDATION')
  })
})

describe('MAIN_COMMANDS', () => {
  it('are all real commands', () => {
    for (const c of MAIN_COMMANDS) expect(Object.keys(COMMAND_AREA)).toContain(c)
  })

  it('keep runs, asks and config commands in the core', () => {
    expect(isMainCommand('runs.start')).toBe(false)
    expect(isMainCommand('config.patch')).toBe(false)
    expect(isMainCommand('ui.setTheme')).toBe(true)
  })
})

describe('createRouter', () => {
  it('refuses an untrusted sender before looking at the request', async () => {
    const { router, core, onFailure } = setup()
    const r = await router(false, env('runs.list', {}))
    expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) as string } })
    expect(core).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith('?', undefined, expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('rejects a malformed envelope', async () => {
    const { router, core } = setup()
    const r = await router(true, { cmd: 'runs.list' })
    expect(r.ok === false && r.error.code).toBe('VALIDATION')
    expect(core).not.toHaveBeenCalled()
  })

  it('answers UNKNOWN_COMMAND for names outside the contract, including prototype keys', async () => {
    const { router } = setup()
    for (const name of ['runs.nope', 'toString', '__proto__', 'constructor']) {
      const r = await router(true, env(name))
      expect(r.ok === false && r.error.code).toBe('UNKNOWN_COMMAND')
    }
  })

  it('hides e2e.* unless DIM_FACTORY_E2E=1', async () => {
    const off = setup()
    const hidden = await off.router(true, env('e2e.state'))
    expect(hidden.ok === false && hidden.error.code).toBe('UNKNOWN_COMMAND')
    expect(off.main['e2e.state']).not.toHaveBeenCalled()

    const on = setup({ e2e: true })
    const shown = await on.router(true, env('e2e.state'))
    expect(shown.ok).toBe(true)
  })

  it('answers UNSUPPORTED for e2e.power / e2e.clock even under E2E', async () => {
    const { router } = setup({ e2e: true })
    const r = await router(true, env('e2e.clock', { advanceMs: 10 }))
    expect(r).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'e2e.clock is not available in this build.' },
    })
  })

  it('answers UNSUPPORTED for diagnostics.* and notifications.* without reaching the core', async () => {
    const { router, core } = setup()
    for (const [cmd, req] of [
      ['diagnostics.build', {}],
      ['diagnostics.copy', {}],
      ['diagnostics.save', {}],
      ['notifications.test', undefined],
      ['notifications.repairShortcut', undefined],
    ] as const) {
      const r = await router(true, env(cmd, req))
      expect(r.ok === false && r.error.code).toBe('UNSUPPORTED')
    }
    expect(core).not.toHaveBeenCalled()
  })

  it('returns VALIDATION from the request schema without calling the handler', async () => {
    const { router, core, main } = setup()
    const bad = await router(true, env('runs.get', { runId: 7 }))
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION')
    expect(core).not.toHaveBeenCalled()
    const focus = await router(true, env('events.focus', { runIds: 'r1' }))
    expect(focus.ok === false && focus.error.code).toBe('VALIDATION')
    expect(main['events.focus']).not.toHaveBeenCalled()
  })

  it('routes main-owned commands to main with the parsed request', async () => {
    const { router, core, main } = setup()
    const r = await router(true, env('events.focus', { runIds: ['a', 'b'] }))
    expect(r).toEqual({ ok: true, value: undefined })
    expect(main['events.focus']).toHaveBeenCalledWith({ runIds: ['a', 'b'] })
    expect(core).not.toHaveBeenCalled()
  })

  it('routes everything else to core.invoke with the parsed request', async () => {
    const { router, core } = setup()
    const r = await router(true, env('runs.list', { limit: 5 }))
    expect(core).toHaveBeenCalledWith('runs.list', { limit: 5 })
    expect(r).toEqual({ ok: true, value: { from: 'core', cmd: 'runs.list', req: { limit: 5 } } })
  })

  it('maps a throwing main handler to its DimFactoryError code', async () => {
    const { router, onFailure } = setup()
    const r = await router(true, env('ui.setTheme', { theme: 'dark' }))
    expect(r).toEqual({ ok: false, error: { code: 'STORAGE', message: 'disk full' } })
    expect(onFailure).toHaveBeenCalledWith(
      'ui.setTheme',
      'cid-1',
      expect.objectContaining({ code: 'STORAGE' }),
    )
  })

  it('maps a main command without a handler to UNSUPPORTED', async () => {
    const { router } = setup()
    const r = await router(true, env('state.get'))
    expect(r.ok === false && r.error.code).toBe('UNSUPPORTED')
  })

  it('never rejects: a throwing parser, core or logger still gives a Result', async () => {
    const parseThrows = setup({
      parse: () => {
        throw new Error('boom')
      },
    })
    expect(await parseThrows.router(true, env('runs.list', {}))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    })

    const coreRejects = setup({ core: () => Promise.reject(new Error('core exploded')) })
    expect(await coreRejects.router(true, env('runs.list', {}))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'core exploded' },
    })

    const loggerThrows = setup({
      onFailure: () => {
        throw new Error('log')
      },
    })
    expect(await loggerThrows.router(false, env('runs.list', {}))).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
  })
})
