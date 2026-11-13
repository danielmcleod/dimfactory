// Main's view of the core (src/main/core-host.ts): a core notification's facts per kind, the folder's last
// segment, answers from a notification (answered / stale / error, via 'notification'), pending asks per run, power
// and the E2E clock.
import { describe, expect, it, vi } from 'vitest'
import type { Core, CoreNotification } from '../../../src/core/app-core.ts'
import { STALE_ASK_MESSAGE } from '../../../src/core/app-core.ts'
import { DimFactoryError, fail, ok } from '../../../src/core/errors.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { AttentionItem } from '../../../src/shared/estimates.ts'
import { createCoreHostBridge, factsOf, folderName } from '../../../src/main/core-host.ts'

const RUN = '20261006T120000Z-ab12'
const run = {
  runId: RUN,
  displayNo: 3,
  title: 'add a --version flag',
  folder: 'C:\\src\\my-app',
  auto: false,
}
const note = (over: Partial<CoreNotification>): CoreNotification => ({
  runId: RUN,
  kind: 'ask',
  state: {} as RunState,
  run,
  ...over,
})

describe('folderName', () => {
  it.each([
    ['C:\\src\\my-app', 'my-app'],
    ['C:\\src\\my-app\\', 'my-app'],
    ['/home/u/proj', 'proj'],
    ['/home/u/proj/', 'proj'],
    ['C:\\', 'C:'],
    ['proj', 'proj'],
  ])('%s → %s', (folder, name) => {
    expect(folderName(folder)).toBe(name)
  })
})

describe('factsOf', () => {
  it('ask: vendor display name, detail, expiry, allowSession', () => {
    expect(
      factsOf(
        note({
          kind: 'ask',
          requestId: 'r1',
          ask: {
            requestId: 'r1',
            step: 'implement',
            vendor: 'codex',
            vendorName: 'Codex',
            kind: 'shell',
            detail: 'Bash: npm test',
            expiresAt: 600_000,
            allowSession: false,
            waiting: 1,
          },
        }),
      ),
    ).toEqual({
      kind: 'ask',
      runId: RUN,
      folder: 'my-app',
      vendor: 'Codex',
      requestId: 'r1',
      detail: 'Bash: npm test',
      expiresAt: 600_000,
      allowSession: false,
    })
  })

  it('gate, completed and failed', () => {
    expect(factsOf(note({ kind: 'gate', cardId: 'c1' }))).toEqual({
      kind: 'gate',
      runId: RUN,
      folder: 'my-app',
      title: 'add a --version flag',
    })
    expect(
      factsOf(
        note({
          kind: 'gate',
          cardId: 'c2',
          card: {
            id: 'c2',
            kind: 'gate:beforeFix',
            title: '3 findings before Fix: 2 must, 1 should',
            blocking: true,
          },
        }),
      ),
    ).toEqual({
      kind: 'gate',
      runId: RUN,
      folder: 'my-app',
      title: 'add a --version flag',
      beforeFix: { cardTitle: '3 findings before Fix: 2 must, 1 should' },
    })
    expect(
      factsOf(
        note({ kind: 'completed', completed: { outcome: 'clean', durationMs: 360_000, costUsd: 0.42 } }),
      ),
    ).toEqual({
      kind: 'completed',
      runId: RUN,
      folder: 'my-app',
      title: 'add a --version flag',
      outcome: 'clean',
      durationMs: 360_000,
      costUsd: 0.42,
    })
    expect(
      factsOf(
        note({
          kind: 'failed',
          failed: { step: 'implement', category: 'auth_expired', title: 'Claude login expired' },
        }),
      ),
    ).toEqual({
      kind: 'failed',
      runId: RUN,
      folder: 'my-app',
      title: 'add a --version flag',
      categoryTitle: 'Claude login expired',
    })
  })

  it('nothing for other cards, a stop, a gone subject or missing run facts', () => {
    expect(factsOf(note({ kind: 'card', cardId: 'c2' }))).toBeNull()
    expect(factsOf(note({ kind: 'stopped' }))).toBeNull()
    expect(factsOf(note({ kind: 'ask' }))).toBeNull()
    expect(factsOf(note({ kind: 'completed' }))).toBeNull()
    expect(factsOf(note({ kind: 'failed' }))).toBeNull()
    const { run: _run, ...bare } = note({ kind: 'gate' })
    expect(factsOf(bare)).toBeNull()
  })
})

type BridgeCore = Parameters<typeof createCoreHostBridge>[0]

function fakeCore(over: Partial<BridgeCore> = {}): BridgeCore {
  return {
    answerAsk: vi.fn(() => Promise.resolve(ok(undefined))),
    attention: () => ({ needsYou: 0, items: [] }),
    power: vi.fn(() => Promise.resolve()),
    advanceClock: vi.fn((ms: number) => Promise.resolve(ok({ now: 1_000 + ms }))),
    ...over,
  }
}

describe('createCoreHostBridge', () => {
  it('answers via the notification path', async () => {
    const core = fakeCore()
    const b = createCoreHostBridge(core)
    expect(await b.answer({ runId: RUN, requestId: 'r1', decision: 'deny' })).toEqual({ kind: 'answered' })
    expect(core.answerAsk).toHaveBeenCalledWith({
      runId: RUN,
      requestId: 'r1',
      decision: 'deny',
      via: 'notification',
    })
  })

  it('maps a stale ask and other errors', async () => {
    const stale = createCoreHostBridge(
      fakeCore({ answerAsk: () => Promise.resolve(fail('CONFLICT', STALE_ASK_MESSAGE, { stale: true })) }),
    )
    expect(await stale.answer({ runId: RUN, requestId: 'r1', decision: 'allow' })).toEqual({ kind: 'stale' })
    const conflict = createCoreHostBridge(
      fakeCore({ answerAsk: () => Promise.resolve(fail('CONFLICT', 'Something else.')) }),
    )
    expect(await conflict.answer({ runId: RUN, requestId: 'r1', decision: 'allow' })).toEqual({
      kind: 'error',
      message: 'Something else.',
    })
  })

  it('lists the pending asks of one run', () => {
    const item = (runId: string, requestId: string): AttentionItem =>
      ({
        id: `ask:${requestId}`,
        runId,
        displayNo: 1,
        title: 't',
        folder: 'f',
        since: 1,
        kind: 'ask',
        ask: { requestId },
      }) as AttentionItem
    const b = createCoreHostBridge(
      fakeCore({
        attention: () => ({
          needsYou: 3,
          items: [
            item(RUN, 'a'),
            item('20261006T120000Z-ffff', 'b'),
            item(RUN, 'c'),
            {
              id: 'stalled:implement',
              runId: RUN,
              displayNo: 1,
              title: 't',
              folder: 'f',
              since: 1,
              kind: 'stalled',
              step: 'implement',
            },
          ],
        }),
      }),
    )
    expect(b.pendingAsks(RUN)).toEqual(['a', 'c'])
  })

  it('forwards power and the E2E clock; a refused clock throws the core error', async () => {
    const core = fakeCore()
    const b = createCoreHostBridge(core)
    await b.power('suspend')
    expect(core.power).toHaveBeenCalledWith('suspend')
    expect(await b.advanceClock(500)).toBe(1_500)
    const refused = createCoreHostBridge(
      fakeCore({ advanceClock: () => Promise.resolve(fail('UNSUPPORTED', 'E2E only.')) }),
    )
    await expect(refused.advanceClock(1)).rejects.toBeInstanceOf(DimFactoryError)
    await expect(refused.advanceClock(1)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

// Keeps the fake in step with the real Core surface the bridge uses.
const _typecheck: (c: Core) => BridgeCore = (c) => c
void _typecheck
