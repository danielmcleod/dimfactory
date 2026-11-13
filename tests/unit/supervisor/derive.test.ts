// "Run status derivation" and "Run phase derivation", row by row (first match wins), and the run's closing message.
import { describe, expect, it } from 'vitest'
import { STEP_KEYS } from '@shared/run.ts'
import type { CardKind, PassStatus, StepKey } from '@shared/run.ts'
import {
  closingMessage,
  deriveStatus,
  projectRelativePaths,
  derivePhase,
  toRunSnapshot,
  toRunSummary,
  toStepView,
} from '@core/supervisor/derive.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { T0, makeRun } from './helpers.ts'

function run(statuses: Partial<Record<StepKey, PassStatus>> = {}, cards: CardKind[] = []): RunState {
  const s = makeRun()
  s.started = true
  for (const [k, st] of Object.entries(statuses) as [StepKey, PassStatus][]) s.steps[k].status = st
  s.cards = cards.map((kind, i) => ({
    view: {
      id: `${kind}-${i}`,
      kind,
      title: kind,
      body: '',
      payload: null,
      blocking: kind !== 'stall',
      choices: [{ id: 'ok', label: 'OK' }],
    },
    openedAt: T0,
  }))
  return s
}

const allDone = (): Partial<Record<StepKey, PassStatus>> =>
  Object.fromEntries(STEP_KEYS.map((k) => [k, k === 'prepare' ? 'skipped' : 'done']))

describe('run status derivation', () => {
  it('1 cancelled: a stop request wins over everything', () => {
    const s = run({ implement: 'running' }, ['gate:afterPlan'])
    s.stop = { at: T0, by: 'stop', snapshot: 'none' }
    expect(deriveStatus(s)).toBe('cancelled')
  })

  it('2 completed: every step done/skipped (finalize included) and no open card', () => {
    expect(deriveStatus(run(allDone()))).toBe('completed')
    expect(deriveStatus(run({ ...allDone(), finalize: 'queued' }))).not.toBe('completed')
    expect(deriveStatus(run(allDone(), ['stall']))).toBe('waiting')
  })

  it('3 waiting: any card open, or a step waiting/stalled', () => {
    expect(deriveStatus(run({ plan: 'done' }, ['gate:afterPlan']))).toBe('waiting')
    expect(deriveStatus(run({ implement: 'waiting', plan: 'running' }))).toBe('waiting')
    expect(deriveStatus(run({ implement: 'stalled', review: 'paused' }))).toBe('waiting')
  })

  it('4 running: a step running (or boundary work owned by a step)', () => {
    expect(deriveStatus(run({ plan: 'running', review: 'paused', critic: 'failed' }))).toBe('running')
    const s = run({ preflight: 'done', plan: 'done', implement: 'done' })
    s.boundary = { name: 'post-implement', step: 'implement' }
    expect(deriveStatus(s)).toBe('running')
  })

  it('5 paused: a paused step and nothing running or waiting', () => {
    expect(deriveStatus(run({ plan: 'done', implement: 'paused', review: 'failed' }))).toBe('paused')
  })

  it('6 failed: a failed step and nothing paused', () => {
    expect(deriveStatus(run({ plan: 'done', implement: 'failed' }))).toBe('failed')
  })

  it('7 queued: otherwise', () => {
    expect(deriveStatus(run())).toBe('queued')
    expect(deriveStatus(run({ preflight: 'done', plan: 'done' }))).toBe('queued')
  })
})

describe('run phase derivation', () => {
  it('1 stopping: stop requested ∧ a live process', () => {
    const s = run({ implement: 'cancelled' })
    s.stop = { at: T0, by: 'stop', snapshot: 'todo' }
    s.steps.implement.proc = { spawnNo: 1, live: true, spawnedAt: T0, terminal: true }
    expect(derivePhase(s)).toBe('stopping')
    s.steps.implement.proc.live = false
    expect(derivePhase(s)).toBe('done')
  })

  it('2 done: completed / cancelled', () => {
    expect(derivePhase(run(allDone()))).toBe('done')
    const c = run({ plan: 'cancelled' })
    c.stop = { at: T0, by: 'close', snapshot: 'none' }
    expect(derivePhase(c)).toBe('done')
  })

  it('3 plan-review: open gate:afterPlan or insufficientContext (before needs-attention)', () => {
    expect(derivePhase(run({ plan: 'done' }, ['gate:afterPlan']))).toBe('plan-review')
    expect(derivePhase(run({ plan: 'waiting', review: 'failed' }, ['insufficientContext']))).toBe(
      'plan-review',
    )
  })

  it('4 findings-review: open gate:beforeFix', () => {
    expect(derivePhase(run({ review: 'done', critic: 'done' }, ['gate:beforeFix']))).toBe('findings-review')
  })

  it('5 ready-to-apply: open finalize / finalizeConflicts / interruptedApply', () => {
    for (const k of ['finalize', 'finalizeConflicts', 'interruptedApply'] as const) {
      expect(derivePhase(run({ finalize: 'running' }, [k]))).toBe('ready-to-apply')
    }
  })

  it('6 needs-attention: another blocking card, or a step paused/failed/stalled', () => {
    expect(derivePhase(run({ preflight: 'failed' }, ['preflight']))).toBe('needs-attention')
    expect(derivePhase(run({ plan: 'running' }, ['retryPartial']))).toBe('needs-attention')
    expect(derivePhase(run({ implement: 'paused' }))).toBe('needs-attention')
    expect(derivePhase(run({ implement: 'failed' }))).toBe('needs-attention')
    expect(derivePhase(run({ implement: 'stalled' }, ['stall']))).toBe('needs-attention')
  })

  it('7 preflight: step preflight running', () => {
    expect(derivePhase(run({ preflight: 'running' }))).toBe('preflight')
  })

  it('8 fixing: fix running/waiting (before final-verify and implementing)', () => {
    expect(derivePhase(run({ fix: 'running', 'verify:2': 'running' }))).toBe('fixing')
    expect(derivePhase(run({ fix: 'waiting' }))).toBe('fixing')
  })

  it('9 final-verify: verify:2 running', () => {
    expect(derivePhase(run({ 'verify:2': 'running' }))).toBe('final-verify')
  })

  it('10 reviewing: review or critic running/waiting', () => {
    expect(derivePhase(run({ review: 'running', critic: 'done' }))).toBe('reviewing')
    expect(derivePhase(run({ review: 'done', critic: 'waiting' }))).toBe('reviewing')
  })

  it('11 verifying: verify:1 running', () => {
    expect(derivePhase(run({ 'verify:1': 'running' }))).toBe('verifying')
  })

  it('12 implementing: implement running/waiting (a pending ask keeps the phase)', () => {
    expect(derivePhase(run({ implement: 'running' }))).toBe('implementing')
    expect(derivePhase(run({ implement: 'waiting' }))).toBe('implementing')
  })

  it('13 planning: plan running/waiting (before preparing)', () => {
    expect(derivePhase(run({ plan: 'running', prepare: 'running' }))).toBe('planning')
  })

  it('14 preparing: prepare / verify:0 running ∧ plan terminal', () => {
    expect(derivePhase(run({ plan: 'done', prepare: 'running' }))).toBe('preparing')
    expect(derivePhase(run({ plan: 'skipped', 'verify:0': 'running' }))).toBe('preparing')
  })

  it('15 queued: otherwise', () => {
    expect(derivePhase(run())).toBe('queued')
    expect(derivePhase(run({ prepare: 'running' }))).toBe('queued')
  })
})

describe('views', () => {
  it('StepView counts the live active time and maps usage to a cost basis', () => {
    const s = run({ implement: 'running' })
    const st = s.steps.implement
    st.activeMs = 1000
    st.activeSince = T0
    st.attempt = 1
    st.usage = { input: 10, output: 5, costUsd: 0.25 }
    const v = toStepView(st, T0 + 500)
    expect(v).toMatchObject({ activeMs: 1500, cost: { usd: 0.25, basis: 'vendor', apiEquivalent: false } })
  })

  it('RunSummary / RunSnapshot carry every step and only attempted steps in the summary', () => {
    const s = run({ preflight: 'done', plan: 'running' })
    s.steps.preflight.attempt = 1
    s.steps.plan.attempt = 1
    const summary = toRunSummary(s, T0)
    expect(summary.steps.map((x) => x.key)).toEqual(['preflight', 'plan'])
    expect(summary).toMatchObject({ runId: s.runId, displayNo: 7, title: 'add a --version flag' })
    const snap = toRunSnapshot(s, 42, T0)
    expect(Object.keys(snap.steps)).toEqual([...STEP_KEYS])
    expect(snap.lastSeq).toBe(42)
  })
})

describe("the run's closing message", () => {
  const ended = (implement?: string, fix?: string): RunState => {
    const s = makeRun()
    if (implement !== undefined) s.steps.implement.result = implement
    if (fix !== undefined) s.steps.fix.result = fix
    return s
  }

  it("is Fix's summary for the person, never its report lines", () => {
    const s = ended(
      'Fixed the coupon maths.',
      'Guarded the empty list.\n\nF1 fixed\nF2 fixed\n\n## Summary\nPercent coupons now use the whole order. I added a test for a three-item order; all 9 tests pass. Nothing is left for you to do.',
    )
    expect(closingMessage(s)).toBe(
      'Percent coupons now use the whole order. I added a test for a three-item order; all 9 tests pass. Nothing is left for you to do.',
    )
  })

  it("falls back to Implement's closing words when Fix wrote no summary, or did not run", () => {
    expect(
      closingMessage(ended('Built the site. Double-click index.html.', 'Updated README.md.\n\nF1 fixed')),
    ).toBe('Built the site. Double-click index.html.')
    expect(closingMessage(ended('Built the site.'))).toBe('Built the site.')
  })

  it('with nothing else said, is what Fix said besides its report; nothing at all is undefined', () => {
    expect(closingMessage(ended(undefined, 'Updated README.md.\n\nF1 fixed'))).toBe('Updated README.md.')
    expect(closingMessage(ended(undefined, 'F1 fixed'))).toBeUndefined()
    expect(closingMessage(ended())).toBeUndefined()
  })

  it('names files relative to the project, never by the folder the pass worked in', () => {
    const s = ended(
      'Fixed [coupons.js](/C:/Users/me/AppData/Local/Temp/proj-eW/work/src/coupons.js) and ' +
        '`' +
        String.raw`c:\users\me\appdata\local\temp\proj-eW\work\test\a.test.js` +
        '`.',
    )
    s.folder = String.raw`C:\Users\me\AppData\Local\Temp\proj-eW\work`
    expect(closingMessage(s)).toBe('Fixed [coupons.js](src/coupons.js) and `test/a.test.js`.')
  })

  it("reads an isolated run's copy as the project too", () => {
    const s = ended('Open /home/me/.dimfactory/worktrees/r1/site/index.html in a browser.')
    s.folder = '/home/me/projects/repo/site'
    s.isolation = {
      rows: [],
      worktree: { path: '/home/me/.dimfactory/worktrees/r1/', branch: 'b', base: 'c', rel: 'site' },
    }
    expect(closingMessage(s)).toBe('Open index.html in a browser.')
  })
})

describe('project-relative paths', () => {
  const root = String.raw`C:\Users\me\Temp\proj\work`

  it('rewrites every form a builder writes and leaves other folders alone', () => {
    expect(
      projectRelativePaths(
        String.raw`See file:///C:/Users/me/Temp/proj/work/index.html#L3, C:\Users\me\Temp\proj\work. ` +
          'Not C:/Users/me/Temp/proj/work2/x or D:/other/a.js.',
        [root],
      ),
    ).toBe('See index.html#L3, .. Not C:/Users/me/Temp/proj/work2/x or D:/other/a.js.')
  })

  it('keeps case on a POSIX root', () => {
    expect(projectRelativePaths('/tmp/p/a.js and /TMP/p/b.js and /tmp/pq', ['/tmp/p/'])).toBe(
      'a.js and /TMP/p/b.js and /tmp/pq',
    )
  })
})
