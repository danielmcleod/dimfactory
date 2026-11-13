// StreamPane under a fast stream (performance.spec.ts): a burst of text blocks mounts only the newest rows that fit one
// frame's text budget — what a pinned pane shows — and the older rows follow a budget per frame once the burst is
// over. A trickle still renders at once.
import '../helpers/rtl.ts'
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StreamBlock } from '@renderer/lib/streamBuffer.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import {
  BURST_ROWS,
  FRAME_TEXT_BUDGET,
  StreamPane,
  rowsWithinBudget,
} from '@renderer/components/run/StreamPane.tsx'
import { env, text } from '../helpers/fixtures.ts'
import { RUN, renderUi } from './helpers.tsx'

const BLOCK = 2_500
/** One text block per delta: the leading newline ends the previous block (it is past the soft split). */
const delta = (i: number): string => `\nblock ${i} ${'x'.repeat(BLOCK - 10)}`

function apply(from: number, to: number): void {
  act(() => {
    streamBuffer.applyAll(
      Array.from({ length: to - from + 1 }, (_, k) => env(RUN, from + k, text('implement', delta(from + k)))),
    )
    streamBuffer.flush()
  })
}

const rows = (): HTMLElement[] => [
  ...screen.getByTestId('stream-implement').querySelectorAll<HTMLElement>('.stream-row'),
]
const mountedChars = (): number => rows().reduce((n, r) => n + (r.textContent?.length ?? 0), 0)

beforeEach(() => {
  streamBuffer.reset()
})

describe('rowsWithinBudget', () => {
  const tb = (id: number, len: number): StreamBlock => ({
    kind: 'text',
    id,
    seq: id,
    ts: 0,
    text: 'x'.repeat(len),
  })

  it('counts back from the newest rows until the text budget is spent, at least one row', () => {
    const blocks = [tb(1, 3000), tb(2, 3000), tb(3, 3000), tb(4, 3000)]
    expect(rowsWithinBudget(blocks, 0, 8000)).toBe(2)
    expect(rowsWithinBudget(blocks, 2, 8000)).toBe(2)
    expect(rowsWithinBudget([tb(1, 20_000)], 0, 8000)).toBe(1)
    expect(rowsWithinBudget(blocks, 4, 8000)).toBe(1)
  })
})

describe('StreamPane text budget', () => {
  it('mounts a burst newest-first within one frame budget, then the rest a budget per frame', async () => {
    renderUi(<StreamPane runId={RUN} step="implement" />)
    apply(1, BURST_ROWS)
    // A trickle renders at once.
    expect(rows()).toHaveLength(BURST_ROWS)

    apply(BURST_ROWS + 1, 60)
    // The burst: only the newest rows, about one budget of text, the newest block last.
    expect(rows().length).toBeLessThan(60)
    expect(mountedChars()).toBeLessThanOrEqual(FRAME_TEXT_BUDGET + BLOCK)
    expect(rows().at(-1)?.textContent).toContain('block 60 ')

    await waitFor(() => expect(rows()).toHaveLength(60))
    expect(rows()[0]?.textContent).toContain('block 1 ')
    expect(rows().at(-1)?.textContent).toContain('block 60 ')
  })
})
