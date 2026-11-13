// components/run/runLog and StreamPane: the newest-match search reads the log backwards in windows; the Log tab's
// follower pages the whole log, keeps the newest rows, reads a gap back before applying live envelopes (no loss, no
// duplicates); StreamPane renders at most the last 400 blocks (performance.spec.ts) and says how many are hidden.
import '../helpers/rtl.ts'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { LogFollower, findLastEnvelope } from '@renderer/components/run/runLog.ts'
import type { LogTail } from '@renderer/components/run/runLog.ts'
import { StreamPane } from '@renderer/components/run/StreamPane.tsx'
import { STREAM_BLOCK_CAP, streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { env, runEvent, text } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  streamBuffer.reset()
  log = []
  mock = installMockDimFactory({ handlers: { 'runs.events': eventsHandler(() => log) } })
})

afterEach(() => {
  mock.uninstall()
})

describe('findLastEnvelope', () => {
  it('finds the newest match across several 2,000-envelope windows', async () => {
    log = Array.from({ length: 4500 }, (_, i) => env(RUN, i + 1, text('implement', 'x')))
    log[99] = env(RUN, 100, {
      t: 'snag',
      step: 'implement',
      failure: { category: 'network', message: 'm', raw: '', classifiedBy: 'errno' },
      actions: [],
    })
    log[199] = env(RUN, 200, {
      t: 'snag',
      step: 'implement',
      failure: { category: 'unknown', message: 'later', raw: '', classifiedBy: 'heuristic' },
      actions: [],
    })
    const found = await findLastEnvelope(RUN, (b) => b.t === 'snag')
    expect(found?.seq).toBe(200)
    // One call for the last seq, then windows (2500, 4500], (500, 2500], (0, 500].
    expect(mock.callsOf('runs.events').map((r) => [r.sinceSeq, r.limit])).toEqual([
      [Number.MAX_SAFE_INTEGER, 1],
      [2500, 2000],
      [500, 2000],
      [0, 500],
    ])
    expect(await findLastEnvelope(RUN, (b) => b.t === 'card')).toBeNull()
  })
})

describe('LogFollower', () => {
  it('pages the whole log, counts AUTO answers, keeps the newest rows and reads gaps back', async () => {
    log = Array.from({ length: 30 }, (_, i) =>
      i % 10 === 0
        ? env(RUN, i + 1, {
            t: 'auto-answered',
            step: 'plan',
            attempt: 1,
            tool: 'Read',
            decision: 'allow',
            why: 'readonly',
          })
        : env(RUN, i + 1, text('implement', `line ${i + 1}\n`)),
    )
    let tail: LogTail | null = null
    const f = new LogFollower(RUN, (t) => (tail = t), 20)
    f.start()
    await act(async () => {
      await settle(10)
    })
    expect(tail).not.toBeNull()
    const t1 = tail as unknown as LogTail
    expect(t1.status).toBe('ready')
    expect(t1.total).toBe(30)
    expect(t1.autoApproved).toBe(3)
    expect(t1.rows.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 11))

    // Live 31 applies directly; 34 arrives before 32-33 (not pushed): they are read back first.
    log.push(...[31, 32, 33, 34].map((s) => env(RUN, s, text('implement', `line ${s}\n`))))
    await act(async () => {
      mock.push(runEvent(log[30] as RunEnvelope))
      mock.push(runEvent(log[33] as RunEnvelope), runEvent(log[30] as RunEnvelope))
      await settle(10)
    })
    const t2 = tail as unknown as LogTail
    expect(t2.total).toBe(34)
    expect(t2.rows.map((e) => e.seq).slice(-5)).toEqual([30, 31, 32, 33, 34])
    expect(new Set(t2.rows.map((e) => e.seq)).size).toBe(t2.rows.length)
    f.stop()
  })
})

describe('StreamPane', () => {
  it('renders at most the last 400 blocks, a burst newest first, and says how many are hidden', async () => {
    const envs = Array.from({ length: 450 }, (_, i) =>
      env(RUN, i + 1, {
        t: 'ev',
        step: 'implement',
        attempt: 1,
        ev: { type: 'tool', name: 'Read', summary: `file ${i + 1}` },
      }),
    )
    renderUi(<StreamPane runId={RUN} step="implement" />)
    act(() => {
      streamBuffer.applyAll(envs.slice(0, 3))
      streamBuffer.flush()
    })
    const pane = screen.getByTestId('stream-implement')
    // A trickle renders at once.
    expect(pane.querySelectorAll('[data-kind="tool"]')).toHaveLength(3)
    act(() => {
      streamBuffer.applyAll(envs.slice(3))
      streamBuffer.flush()
    })
    // A burst mounts the newest rows first, then the rest over the next frames.
    const rows = pane.querySelectorAll('[data-kind="tool"]')
    expect(rows.length).toBeLessThan(STREAM_BLOCK_CAP)
    expect(rows[rows.length - 1]?.textContent).toContain('file 450')
    await waitFor(() => expect(pane.querySelectorAll('[data-kind="tool"]')).toHaveLength(STREAM_BLOCK_CAP))
    expect(pane.textContent).toContain('50 earlier blocks are hidden')
    expect(pane.querySelector('[data-kind="tool"]')?.textContent).toContain('file 51')
    expect(pane.getAttribute('aria-live')).toBe('off')
  })

  it('opens over a long stream with the newest rows first, then mounts the rest a slice per frame', async () => {
    act(() => {
      streamBuffer.applyAll(
        Array.from({ length: 450 }, (_, i) =>
          env(RUN, i + 1, {
            t: 'ev',
            step: 'implement',
            attempt: 1,
            ev: { type: 'tool', name: 'Read', summary: `file ${i + 1}` },
          }),
        ),
      )
      streamBuffer.flush()
    })
    renderUi(<StreamPane runId={RUN} step="implement" />)
    const pane = screen.getByTestId('stream-implement')
    const rows = (): NodeListOf<Element> => pane.querySelectorAll('[data-kind="tool"]')
    expect(rows().length).toBeLessThan(STREAM_BLOCK_CAP)
    expect(rows()[rows().length - 1]?.textContent).toContain('file 450')
    await waitFor(() => expect(rows()).toHaveLength(STREAM_BLOCK_CAP))
    expect(rows()[0]?.textContent).toContain('file 51')
  })
})
