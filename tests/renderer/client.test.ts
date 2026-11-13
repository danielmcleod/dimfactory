// ipc/client.ts: typed invoke over window.dimFactory that never rejects, unwrap/IpcError, prepared calls.
import { afterEach, describe, expect, it } from 'vitest'
import type { DimFactoryApi } from '@shared/ipc.ts'
import {
  IpcError,
  NO_BRIDGE_MESSAGE,
  call,
  hasBridge,
  invoke,
  invokeCall,
  unwrap,
} from '@renderer/ipc/client.ts'
import { installMockDimFactory, mockError } from './helpers/mockDimFactory.ts'

afterEach(() => {
  delete (window as unknown as { dimFactory?: unknown }).dimFactory
})

describe('client', () => {
  it('answers INTERNAL without a usable bridge (scaffold preload or none)', async () => {
    expect(hasBridge()).toBe(false)
    expect(await invoke('runs.list', {})).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: NO_BRIDGE_MESSAGE },
    })
    ;(window as unknown as { dimFactory: unknown }).dimFactory = { platform: 'win32' }
    expect(hasBridge()).toBe(false)
    expect((await invoke('app.info')).ok).toBe(false)
  })

  it('passes results through and maps a rejected IPC call to INTERNAL', async () => {
    const mock = installMockDimFactory({ handlers: { 'runs.stop': () => undefined } })
    expect(await invoke('runs.stop', { runId: 'r1' })).toEqual({ ok: true, value: undefined })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: 'r1' }])
    ;(window as unknown as { dimFactory: Partial<DimFactoryApi> }).dimFactory = {
      invoke: () => Promise.reject(new Error("No handler registered for 'dimf:cmd'")),
      subscribe: () => () => {},
    }
    expect(await invoke('app.info')).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: "No handler registered for 'dimf:cmd'" },
    })
  })

  it('unwraps values and throws IpcError with the code', async () => {
    installMockDimFactory({
      handlers: {
        'runs.get': () => {
          throw mockError('NOT_FOUND', 'Run r1 not found.')
        },
      },
    })
    expect(unwrap({ ok: true, value: 3 })).toBe(3)
    await expect(call('runs.get', { runId: 'r1' })).rejects.toMatchObject({
      name: 'IpcError',
      code: 'NOT_FOUND',
      cmd: 'runs.get',
      message: 'Run r1 not found.',
    })
    expect(() => unwrap({ ok: false, error: { code: 'CONFLICT', message: 'busy' } })).toThrow(IpcError)
  })

  it('runs a prepared CommandCall', async () => {
    const mock = installMockDimFactory({ handlers: { 'cards.resolve': () => undefined } })
    const r = await invokeCall({
      cmd: 'cards.resolve',
      req: { runId: 'r', cardId: 'c', choiceId: 'approve' },
    })
    expect(r.ok).toBe(true)
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: 'r', cardId: 'c', choiceId: 'approve' }])
  })
})
