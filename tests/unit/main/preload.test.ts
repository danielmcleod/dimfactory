// The preload side (src/preload/wire.ts, bridge.ts): the theme argument round trip, the command envelope, invoke
// never rejecting, and the single-listener fan-out of dimf:evt.
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { createDimFactoryApi } from '../../../src/preload/bridge.ts'
import type { IpcRendererLike } from '../../../src/preload/bridge.ts'
import {
  FALLBACK_THEME,
  THEME_ARG_PREFIX,
  decodeThemeArg,
  encodeThemeArg,
  makeEnvelope,
} from '../../../src/preload/wire.ts'
import { checkEnvelope } from '../../../src/main/router.ts'
import { ACCENTS, THEMES } from '../../../src/shared/config-schema.ts'
import { CMD_CHANNEL, EVT_CHANNEL, IPC_PROTOCOL } from '../../../src/shared/ipc.ts'
import type { AppEvent, ThemeState } from '../../../src/shared/ipc.ts'

const themeArb: fc.Arbitrary<ThemeState> = fc.record({
  theme: fc.constantFrom(...THEMES),
  resolved: fc.constantFrom('light' as const, 'dark' as const),
  accent: fc.constantFrom(...ACCENTS),
})

describe('theme argument', () => {
  it('round-trips every ThemeState', () => {
    fc.assert(
      fc.property(themeArb, (s) => {
        const arg = encodeThemeArg(s)
        expect(arg.startsWith(THEME_ARG_PREFIX)).toBe(true)
        expect(arg.slice(THEME_ARG_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(decodeThemeArg(['electron', '--foo', arg, '--bar'])).toEqual(s)
      }),
    )
  })

  it('is null when absent or malformed', () => {
    expect(decodeThemeArg(['electron', '.'])).toBeNull()
    expect(decodeThemeArg([`${THEME_ARG_PREFIX}%%%`])).toBeNull()
    const bad = (v: unknown): string =>
      THEME_ARG_PREFIX + Buffer.from(JSON.stringify(v)).toString('base64url')
    expect(decodeThemeArg([bad({ theme: 'neon', resolved: 'dark', accent: 'slate' })])).toBeNull()
    expect(decodeThemeArg([bad({ theme: 'dark', resolved: 'dim', accent: 'slate' })])).toBeNull()
    expect(decodeThemeArg([bad({ theme: 'dark', resolved: 'dark', accent: 'pink' })])).toBeNull()
    expect(decodeThemeArg([bad([1, 2])])).toBeNull()
  })

  it('drops unknown fields', () => {
    const arg =
      THEME_ARG_PREFIX +
      Buffer.from(JSON.stringify({ theme: 'dark', resolved: 'dark', accent: 'blue', x: 1 })).toString(
        'base64url',
      )
    expect(decodeThemeArg([arg])).toEqual({ theme: 'dark', resolved: 'dark', accent: 'blue' })
  })
})

describe('makeEnvelope', () => {
  it('builds the envelope main accepts', () => {
    const e = makeEnvelope('runs.get', { runId: 'r' }, 'c1')
    expect(e).toEqual({ v: IPC_PROTOCOL, cmd: 'runs.get', req: { runId: 'r' }, cid: 'c1' })
    expect(checkEnvelope(e).ok).toBe(true)
    expect(checkEnvelope(makeEnvelope('app.info', undefined, 'c2')).ok).toBe(true)
  })
})

function fakeIpc(reply: (channel: string, env: unknown) => Promise<unknown>) {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
  const invoke = vi.fn((channel: string, ...args: unknown[]) => reply(channel, args[0]))
  const removeListener = vi.fn((channel: string, l: (event: unknown, ...args: unknown[]) => void) => {
    listeners.get(channel)?.delete(l)
  })
  const ipc: IpcRendererLike = {
    invoke,
    on: (channel: string, l: (event: unknown, ...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(l)
      listeners.set(channel, set)
    },
    removeListener,
  }
  const emit = (batch: unknown): void => {
    for (const l of listeners.get(EVT_CHANNEL) ?? []) l({ sender: 'secret' }, batch)
  }
  const count = (): number => listeners.get(EVT_CHANNEL)?.size ?? 0
  return { ipc, emit, count, invoke, removeListener }
}

describe('createDimFactoryApi', () => {
  it('invokes dimf:cmd with an envelope and returns the Result', async () => {
    const { ipc, invoke } = fakeIpc(() =>
      Promise.resolve({ ok: true, value: { items: [], nextCursor: null } }),
    )
    const api = createDimFactoryApi(ipc, { platform: 'win32', argv: [] })
    const r = await api.invoke('runs.list', { limit: 1 })
    expect(r).toEqual({ ok: true, value: { items: [], nextCursor: null } })
    const call = invoke.mock.calls[0]
    expect(call?.[0]).toBe(CMD_CHANNEL)
    expect(call?.[1]).toMatchObject({ v: IPC_PROTOCOL, cmd: 'runs.list', req: { limit: 1 } })
    await api.invoke('app.info')
    const cids = invoke.mock.calls.map((c) => (c[1] as { cid: string }).cid)
    expect(new Set(cids).size).toBe(2)
  })

  it('never rejects: a transport error or a malformed reply becomes INTERNAL', async () => {
    const rejecting = createDimFactoryApi(
      fakeIpc(() => Promise.reject(new Error('No handler registered'))).ipc,
      {
        platform: 'linux',
        argv: [],
      },
    )
    expect(await rejecting.invoke('app.info')).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'No handler registered' },
    })
    const garbage = createDimFactoryApi(fakeIpc(() => Promise.resolve('nope')).ipc, {
      platform: 'linux',
      argv: [],
    })
    expect(await garbage.invoke('app.info')).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    const failed = createDimFactoryApi(
      fakeIpc(() => Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: 'no' } })).ipc,
      { platform: 'linux', argv: [] },
    )
    expect(await failed.invoke('app.info')).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'no' },
    })
  })

  it('fans one listener out to every subscriber and removes it after the last leaves', () => {
    const { ipc, emit, count, removeListener } = fakeIpc(() => Promise.resolve({ ok: true, value: null }))
    const api = createDimFactoryApi(ipc, { platform: 'darwin', argv: [] })
    const a: AppEvent[][] = []
    const b: AppEvent[][] = []
    const offA = api.subscribe((batch) => a.push(batch))
    const offB = api.subscribe((batch) => b.push(batch))
    expect(count()).toBe(1)
    const batch: AppEvent[] = [{ kind: 'heartbeat', at: 1 }]
    emit(batch)
    expect(a).toEqual([batch])
    expect(b).toEqual([batch])
    offA()
    offA()
    expect(count()).toBe(1)
    emit(batch)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    offB()
    expect(count()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(1)
    api.subscribe(() => undefined)
    expect(count()).toBe(1)
  })

  it('subscribing the same callback twice gives two independent subscriptions', () => {
    const { ipc, emit } = fakeIpc(() => Promise.resolve(null))
    const api = createDimFactoryApi(ipc, { platform: 'linux', argv: [] })
    const seen: number[] = []
    const cb = (): void => void seen.push(1)
    const off1 = api.subscribe(cb)
    api.subscribe(cb)
    emit([])
    expect(seen).toHaveLength(2)
    off1()
    emit([])
    expect(seen).toHaveLength(3)
  })

  it('a throwing subscriber does not starve the others; non-array payloads are ignored', () => {
    const { ipc, emit } = fakeIpc(() => Promise.resolve(null))
    const errors: unknown[] = []
    const api = createDimFactoryApi(ipc, {
      platform: 'linux',
      argv: [],
      onSubscriberError: (e) => errors.push(e),
    })
    const got: number[] = []
    api.subscribe(() => {
      throw new Error('bad subscriber')
    })
    api.subscribe((batch) => got.push(batch.length))
    emit([{ kind: 'heartbeat', at: 1 }])
    emit('not a batch')
    expect(got).toEqual([1])
    expect(errors).toHaveLength(1)
  })

  it('exposes platform and the initial theme (fallback light)', () => {
    const s: ThemeState = { theme: 'dark', resolved: 'dark', accent: 'violet' }
    const api = createDimFactoryApi(fakeIpc(() => Promise.resolve(null)).ipc, {
      platform: 'darwin',
      argv: ['x', encodeThemeArg(s)],
    })
    expect(api.platform).toBe('darwin')
    expect(api.initialTheme).toEqual(s)
    const plain = createDimFactoryApi(fakeIpc(() => Promise.resolve(null)).ipc, {
      platform: 'freebsd',
      argv: [],
    })
    expect(plain.platform).toBe('linux')
    expect(plain.initialTheme).toEqual(FALLBACK_THEME)
    expect(FALLBACK_THEME.resolved).toBe('light')
  })

  it('exposes only the DimFactoryApi members', () => {
    const api = createDimFactoryApi(fakeIpc(() => Promise.resolve(null)).ipc, { platform: 'win32', argv: [] })
    expect(Object.keys(api).sort()).toEqual(['initialTheme', 'invoke', 'platform', 'subscribe'])
  })
})
