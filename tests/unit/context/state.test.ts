// Context state (core/context/state.ts) and its reducer wiring: the meter's window (vendor first, then the catalog),
// the peak, the baseline, compactions, the throttled `context` run event, StepView.context and RunSummaryStep.context.
import { describe, expect, it } from 'vitest'
import type { AdapterSignal } from '@shared/events.ts'
import {
  applyContextSignal,
  applyToolEvent,
  contextEventDue,
  contextSummary,
  contextView,
  fillPerMin,
  newContextState,
  readTarget,
  worstLoop,
} from '@core/context/state.ts'
import type { ContextFacts } from '@core/context/state.ts'
import { toRunSnapshot, toRunSummary, toStepView } from '@core/supervisor/derive.ts'
import { Harness, T0 } from '../supervisor/helpers.ts'

const FACTS: ContextFacts = {
  promptTokens: 2_000,
  window: 128_000,
  resumed: false,
  extensions: 'passthrough',
  projectFiles: [],
  mcpNames: [],
  skillNames: [],
}

const ctx = (used: number, o: Partial<Extract<AdapterSignal, { type: 'context' }>> = {}): AdapterSignal => ({
  type: 'context',
  used,
  source: 'request',
  ...o,
})

describe('context state', () => {
  it('uses the vendor window first and the catalog window until the vendor says', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(32_000), T0)
    expect(contextView(cs)).toMatchObject({
      used: 32_000,
      window: 128_000,
      windowFrom: 'catalog',
      percent: 25,
    })
    applyContextSignal(cs, ctx(40_000, { window: 200_000 }), T0 + 1)
    expect(contextView(cs)).toMatchObject({ window: 200_000, windowFrom: 'vendor', percent: 20 })
  })

  it('reads n/a (no percent) when no window is known at all', () => {
    const { window: _window, ...noWindow } = FACTS
    const cs = newContextState(noWindow)
    applyContextSignal(cs, ctx(10_000), T0)
    const v = contextView(cs)
    expect(v?.percent).toBeUndefined()
    expect(v?.window).toBeUndefined()
    expect(v?.used).toBe(10_000)
  })

  it('takes the baseline from the first request of a fresh session, less Dim Factory own prompt', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(30_000), T0)
    applyContextSignal(cs, ctx(50_000), T0 + 1)
    expect(cs.baseline).toBe(28_000)
    const resumed = newContextState({ ...FACTS, resumed: true })
    applyContextSignal(resumed, ctx(30_000), T0)
    expect(resumed.baseline).toBeUndefined()
  })

  it('keeps the peak; a compaction counts once at its end and sets the context it left', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(110_000), T0)
    applyContextSignal(cs, { type: 'compaction', phase: 'start' }, T0 + 1)
    expect(contextView(cs)).toMatchObject({ compacting: true, compactions: 0 })
    // A repeated start changes nothing.
    expect(applyContextSignal(cs, { type: 'compaction', phase: 'start' }, T0 + 2)).toBe(false)
    applyContextSignal(cs, { type: 'compaction', phase: 'end', trigger: 'auto', postTokens: 20_000 }, T0 + 3)
    const v = contextView(cs)
    expect(v).toMatchObject({ compactions: 1, used: 20_000, peakPercent: 86 })
    expect(v?.compacting).toBeUndefined()
  })

  it('a failed compaction is not counted', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, { type: 'compaction', phase: 'start' }, T0)
    applyContextSignal(cs, { type: 'compaction', phase: 'end', failed: true }, T0 + 1)
    expect(cs.compactions).toBe(0)
    expect(cs.failedCompactions).toBe(1)
  })

  it('turns amber from 80% or from two compactions', () => {
    const a = newContextState(FACTS)
    applyContextSignal(a, ctx(101_000), T0)
    expect(contextView(a)?.warn).toBeUndefined()
    applyContextSignal(a, ctx(103_000), T0)
    expect(contextView(a)?.warn).toBe(true)
    const b = newContextState(FACTS)
    applyContextSignal(b, ctx(1_000), T0)
    applyContextSignal(b, { type: 'compaction', phase: 'end' }, T0)
    expect(contextView(b)?.warn).toBeUndefined()
    applyContextSignal(b, { type: 'compaction', phase: 'end' }, T0)
    expect(contextView(b)?.warn).toBe(true)
  })

  it("Claude's breakdown estimate shows until a request reports, and never sets the peak or the baseline", () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(38_436, { window: 200_000, source: 'breakdown' }), T0)
    expect(contextView(cs)).toMatchObject({ used: 38_436, percent: 19 })
    expect(cs.peakPercent).toBeUndefined()
    applyContextSignal(cs, ctx(25_424, { window: 200_000 }), T0 + 1)
    expect(contextView(cs)).toMatchObject({ used: 25_424, percent: 13, peakPercent: 13 })
    expect(cs.baseline).toBe(23_424)
    // A later breakdown leaves the request's figure alone.
    applyContextSignal(cs, ctx(35_309, { source: 'breakdown' }), T0 + 2)
    expect(cs.used).toBe(25_424)
  })

  it('fill rate: tokens per minute from the first report to the peak, after 30 s', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(10_000), T0)
    applyContextSignal(cs, ctx(12_000), T0 + 10_000)
    expect(fillPerMin(cs)).toBeUndefined()
    applyContextSignal(cs, ctx(40_000), T0 + 120_000)
    expect(fillPerMin(cs)).toBe(15_000)
  })

  it('sends a context event only for a whole point, a compaction or the window becoming known', () => {
    const cs = newContextState(FACTS)
    applyContextSignal(cs, ctx(12_800), T0)
    expect(contextEventDue(cs)).toMatchObject({ percent: 10, compactions: 0, compacting: false })
    applyContextSignal(cs, ctx(13_300), T0)
    expect(contextEventDue(cs)).toBeUndefined()
    applyContextSignal(cs, ctx(14_200), T0)
    expect(contextEventDue(cs)).toMatchObject({ percent: 11 })
    applyContextSignal(cs, { type: 'compaction', phase: 'start' }, T0)
    expect(contextEventDue(cs)).toMatchObject({ compacting: true })
    expect(contextEventDue(cs)).toBeUndefined()
  })

  it('summary for the run history: peak, compactions, baseline and no names', () => {
    const cs = newContextState(FACTS)
    expect(contextSummary(cs)).toBeUndefined()
    applyContextSignal(cs, ctx(64_000), T0)
    applyContextSignal(cs, { type: 'compaction', phase: 'end' }, T0)
    expect(contextSummary(cs)).toEqual({ peakPercent: 50, compactions: 1, baseline: 62_000 })
  })
})

describe('tool counters', () => {
  const start = (name: string, summary: string, fp: string) =>
    ({ type: 'tool', name, summary, phase: 'start', fp }) as const

  it('a call repeated three times in ten is a loop; its count is every call of it', () => {
    const cs = newContextState(FACTS)
    for (let i = 0; i < 4; i++) {
      applyToolEvent(cs, start('Bash', '$ npm test', 'aaa'))
      applyToolEvent(cs, start('Grep', `x${i}`, `g${i}`))
    }
    expect(worstLoop(cs.tools)).toEqual({ name: 'Bash', summary: '$ npm test', count: 4 })
  })

  it('a call spread wider than ten calls is no loop', () => {
    const cs = newContextState(FACTS)
    for (let i = 0; i < 30; i++) applyToolEvent(cs, start('Grep', `x${i}`, i % 12 === 0 ? 'same' : `g${i}`))
    expect(worstLoop(cs.tools)).toBeUndefined()
  })

  it('rereads count per file and reset on a change; steps without a change are counted', () => {
    const cs = newContextState(FACTS)
    for (let i = 0; i < 3; i++) applyToolEvent(cs, start('Read', 'src/a.ts', `r${i}`))
    applyToolEvent(cs, start('Edit', 'src/a.ts', 'e1'))
    applyToolEvent(cs, start('Read', 'src/a.ts', 'r9'))
    expect(cs.tools.reread).toEqual({ target: 'src/a.ts', count: 3 })
    expect(cs.tools.maxSinceEdit).toBe(3)
    expect(cs.tools.sinceEdit).toBe(1)
  })

  it('the largest output; a subagent progress row (no fingerprint) is not a call', () => {
    const cs = newContextState(FACTS)
    applyToolEvent(cs, { type: 'tool', name: 'Agent', summary: 'x', phase: 'start' })
    applyToolEvent(cs, { type: 'tool', name: 'Grep', summary: 'q', phase: 'end', status: 'ok', outTokens: 9 })
    applyToolEvent(cs, {
      type: 'tool',
      name: 'Bash',
      summary: 'big',
      phase: 'end',
      status: 'ok',
      outTokens: 30_000,
    })
    expect(cs.tools.calls).toBe(0)
    expect(cs.tools.biggest).toEqual({ name: 'Bash', summary: 'big', tokens: 30_000 })
  })

  it('read targets: Claude Read, ACP read, Codex shell "Read <path>"', () => {
    expect(readTarget('Read', 'src/a.ts')).toBe('src/a.ts')
    expect(readTarget('read', 'ReadFile a')).toBe('ReadFile a')
    expect(readTarget('shell', 'Read src/a.ts')).toBe('src/a.ts')
    expect(readTarget('shell', '$ ls')).toBeUndefined()
  })
})

describe('reducer wiring', () => {
  it('facts, signals and tool events reach StepView.context, the context event and the run summary', () => {
    const h = new Harness().toImplementRunning()
    h.send({ t: 'context-facts', step: 'implement', spawnNo: h.spawnNo('implement'), facts: FACTS })
    h.signal('implement', ctx(64_000))
    expect(h.bodies('context')).toEqual([
      {
        t: 'context',
        step: 'implement',
        attempt: 1,
        used: 64_000,
        window: 128_000,
        percent: 50,
        compactions: 0,
        compacting: false,
      },
    ])
    expect(h.last?.transition).toBe(true)
    // Under a point: no event.
    h.signal('implement', ctx(64_500))
    expect(h.bodies('context')).toEqual([])
    h.signal('implement', { type: 'compaction', phase: 'start' })
    expect(h.bodies('context')[0]).toMatchObject({ compacting: true })
    h.signal('implement', { type: 'compaction', phase: 'end', postTokens: 12_800 })
    expect(h.bodies('context')[0]).toMatchObject({ compacting: false, compactions: 1, percent: 10 })
    h.ev('implement', { type: 'tool', id: 't1', name: 'Bash', summary: '$ ls', phase: 'start', fp: 'f1' })

    const view = toStepView(h.step('implement'), h.now)
    expect(view.context).toMatchObject({ percent: 10, peakPercent: 50, compactions: 1, baseline: 62_000 })
    expect(h.step('implement').context?.tools.calls).toBe(1)
    const row = toRunSummary(h.state, h.now).steps.find((s) => s.key === 'implement')
    expect(row?.context).toEqual({ peakPercent: 50, compactions: 1, baseline: 62_000 })
  })

  it('a signal for another spawn changes nothing', () => {
    const h = new Harness().toImplementRunning()
    const first = h.spawnNo('implement')
    h.signal('implement', ctx(64_000))
    h.signal('implement', ctx(90_000), first + 5)
    expect(h.step('implement').context?.used).toBe(64_000)
  })

  it('the snapshot carries Context health only once the run is over', () => {
    const h = new Harness().toImplementRunning()
    h.send({ t: 'context-facts', step: 'implement', spawnNo: h.spawnNo('implement'), facts: FACTS })
    h.signal('implement', ctx(64_000))
    expect(toRunSnapshot(h.state, 1, h.now).contextHealth).toBeUndefined()
    const over = { ...h.state, status: 'completed' as const }
    const health = toRunSnapshot(over, 1, h.now).contextHealth
    expect(health?.passes).toEqual([
      {
        step: 'implement',
        vendor: h.step('implement').vendor,
        peakPercent: 50,
        compactions: 0,
        baseline: 62_000,
        window: 128_000,
        extensions: 'passthrough',
        contributors: [],
      },
    ])
    // A 62k baseline is past the 30k overhead threshold (`D1`).
    expect(health?.items.map((i) => i.id)).toEqual(['D1'])
  })
})
