// An approval's in-app toast ("Claude needs approval · folder", main's `askRunId`) is about what waits in that run now:
// one per run (a newer one replaces it), left out while Easy's view of the run is open (its ask card says it there), and
// taken down as soon as nothing waits in the run any more: the ask was answered or timed out (the attention list has no
// ask of the run), or the run ended. A finished run never leaves an approval toast behind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEvent } from '@shared/ipc.ts'
import type { AttentionItem } from '@shared/estimates.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from './helpers/mockDimFactory.ts'
import type { MockDimFactory } from './helpers/mockDimFactory.ts'
import { makeSummary } from './helpers/fixtures.ts'

let mock: MockDimFactory

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
})

afterEach(() => {
  resetBridgeForTests()
  cancelRefetches()
  mock.uninstall()
  clearToasts()
  vi.useRealTimers()
  window.location.hash = ''
})

const askToast = (runId: string, message = `Claude needs approval · ${runId}`): AppEvent => ({
  kind: 'toast',
  level: 'warn',
  message,
  askRunId: runId,
})

const askItem = (runId: string): AttentionItem =>
  ({
    id: `ask:${runId}`,
    kind: 'ask',
    runId,
    displayNo: 1,
    title: 't',
    folder: 'f',
    since: 1,
    ask: { runId, requestId: 'q1', step: 'implement', kind: 'shell', detail: 'npm install', expiresAt: 1 },
  }) as unknown as AttentionItem

const messages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('approval toasts', () => {
  it('one per run; gone once nothing waits there (answered, or the run ended)', async () => {
    mock = installMockDimFactory()
    startBridge()
    await settle()
    mock.push(askToast('r1'))
    mock.push(askToast('r1', 'Claude needs approval (2) · r1'))
    mock.push(askToast('r2'))
    expect(messages()).toEqual(['Claude needs approval (2) · r1', 'Claude needs approval · r2'])
    // r1's ask was answered: the attention list has only r2's.
    mock.push({ kind: 'attention', needsYou: 1, items: [askItem('r2')] })
    expect(messages()).toEqual(['Claude needs approval · r2'])
    // r2 ended (its ask with it).
    mock.push({ kind: 'run-summary', summary: makeSummary({ runId: 'r2', status: 'completed' }) })
    expect(messages()).toEqual([])
    // Other toasts are left alone.
    mock.push({ kind: 'toast', level: 'info', message: 'Saved' })
    mock.push({ kind: 'attention', needsYou: 0, items: [] })
    expect(messages()).toEqual(['Saved'])
  })

  it("is left out while Easy's view of that run is open", async () => {
    mock = installMockDimFactory()
    startBridge()
    await settle()
    window.location.hash = '#/easy/runs/r1'
    mock.push(askToast('r1'))
    mock.push(askToast('r2'))
    expect(messages()).toEqual(['Claude needs approval · r2'])
  })
})
