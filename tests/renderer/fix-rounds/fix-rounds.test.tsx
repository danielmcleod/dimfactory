// Fix until green in the renderer:
//   - round 1 in the usual Fix, Final verify and Re-check cards, frozen as it ended once round 2 starts; round 1's
//     verdict after them (what Fix did, what verify said, the findings resolved and still open, cost and time, under
//     the head line with the cap and budget); a section per later round (its heading, its own cards, its verdict); the
//     stop line last (green in a positive tone, the cap, budget or no progress as a warning); all append only;
//   - the "Round 2 of 3" chip on the Fix, Final verify and Re-check cards, one width for every round;
//   - the re-check's label without the security advisor ("Re-check"), and the outcome of a loop that stopped short;
//   - the composer's "Fix until green" switch (passes.fix.rounds 3 on, 1 off, a configured 2 kept) and the Settings rows.
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { FixLoopView, FixRoundView, RunSnapshot, StepView } from '@shared/run.ts'
import {
  FirstRoundVerdict,
  FixRoundsStop,
  loopHeadText,
  openText,
  resolvedText,
  RoundChip,
  roundText,
  RoundVerdictBlock,
  roundVerifyText,
} from '@renderer/components/run/FixRounds.tsx'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { RecheckFacts, recheckText } from '@renderer/components/run/SecurityCard.tsx'
import { timelineColumns } from '@renderer/components/run/steps.ts'
import { VerifyCard } from '@renderer/components/run/VerifyCard.tsx'
import {
  fixStoppedText,
  outcomeText,
  RUN_PHASE_LABEL,
  runStepLabel,
  summaryStepLabel,
} from '@renderer/lib/format.ts'
import { FIX_UNTIL_GREEN_NOTE } from '@renderer/pages/dashboard/composer/model.ts'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import { eventsHandler, RUN, snapWith } from '../run/helpers.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

const round = (o: Partial<FixRoundView> & { n: number }): FixRoundView => ({
  status: 'done',
  resolved: [],
  open: [],
  usd: 0.42,
  activeMs: 65_000,
  ...o,
})

const loop = (o: Partial<FixLoopView> = {}): FixLoopView => ({
  max: 3,
  round: 1,
  rounds: [round({ n: 1, changed: true, failing: ['test'], resolved: [1, 3], open: [2] })],
  ...o,
})

// ---- the verdicts --------------------------------------------------------------------------------------------------------

describe('the round verdicts', () => {
  it('round 1: the head line, then what Fix did, verify, the resolved and still-open chips, cost and time', () => {
    render(
      <FirstRoundVerdict
        loop={loop()}
        r={round({ n: 1, changed: true, failing: ['test', 'lint'], resolved: [1, 3], open: [2] })}
      />,
    )
    const block = screen.getByTestId('fix-rounds')
    expect(within(block).getByRole('heading', { name: 'Fix until green' })).toBeTruthy()
    expect(screen.getByTestId('fix-rounds-head').textContent).toBe('Up to 3 rounds')
    expect(screen.getByTestId('fix-round-1').textContent).toContain('Round 1')
    expect(screen.getByTestId('fix-round-1-fix').textContent).toBe('Changed files')
    expect(screen.getByTestId('fix-round-1-verify').textContent).toBe('Still failing: test, lint')
    expect(screen.getByTestId('fix-round-1-resolved').textContent).toBe('F1, F3 resolved')
    expect(screen.getByTestId('fix-round-1-open').textContent).toBe('F2 still open')
    expect(screen.getByTestId('fix-round-1-cost').textContent).toBe('$0.42')
    expect(screen.getByTestId('fix-round-1-time').textContent).toBe('1m 5s')
    expect(block.textContent).not.toContain(EM_DASH)
  })

  it('a later round: its verdict, and words for a round that made no change or was not priced', () => {
    render(<RoundVerdictBlock r={round({ n: 2, changed: false, failing: [], usd: null })} />)
    expect(screen.getByTestId('fix-round-2-fix').textContent).toBe('Made no changes')
    expect(screen.getByTestId('fix-round-2-verify').textContent).toBe('Passed')
    expect(screen.getByTestId('fix-round-2-verify').className).toContain('text-st-done')
    expect(screen.getByTestId('fix-round-2-cost').textContent).toBe('No price')
    expect(screen.getByTestId('fix-round-2').textContent).toContain('Nothing to check')
  })

  it('says why it stopped: green in a positive tone, the round cap, budget or no progress as a warning', () => {
    const { rerender } = render(<FixRoundsStop stop={{ reason: 'green', text: 'Green after round 2.' }} />)
    const stop = screen.getByTestId('fix-rounds-stop')
    expect(stop.getAttribute('data-reason')).toBe('green')
    expect(stop.className).toContain('text-st-done')
    for (const reason of ['cap', 'budget', 'no-progress'] as const) {
      rerender(<FixRoundsStop stop={{ reason, text: 'Stopped with F2 still open.' }} />)
      expect(screen.getByTestId('fix-rounds-stop').className).toContain('text-warning')
    }
  })

  it('words', () => {
    expect(resolvedText([1, 3])).toBe('F1, F3 resolved')
    expect(openText([2])).toBe('F2 still open')
    expect(roundVerifyText(round({ n: 1, status: 'stopped' }))).toBe('Not run')
    expect(roundVerifyText(round({ n: 1, status: 'running' }))).toBe('Not yet')
    expect(loopHeadText(loop({ max: 2, budget: { minutes: 15 } }))).toBe('Up to 2 rounds · 15 min of work')
    expect(loopHeadText(loop({ budget: { usd: 2, minutes: 30 } }))).toBe(
      'Up to 3 rounds · budget $2.00 · 30 min of work',
    )
    expect(roundText({ n: 2, of: 3 })).toBe('Round 2 of 3')
  })
})

// ---- the flow ----------------------------------------------------------------------------------------------------------

describe('Fix until green in the flow', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'runs.events': eventsHandler(() => []),
        'runs.output': () => ({ text: '', mtime: 0, version: 0 }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  const R = (n: number) => ({ n, of: 3 })
  const reviewed = {
    plan: { status: 'done' as const, attempt: 1, vendor: 'claude' },
    implement: { status: 'done' as const, attempt: 1, vendor: 'claude' },
    review: { status: 'done' as const, attempt: 1, vendor: 'claude' },
    critic: { status: 'done' as const, attempt: 1, vendor: 'claude' },
  }
  const RECHECK_1 = { status: 'open' as const, resolved: [1, 2], open: [{ n: 5 }] }

  /** Round 1 under way: Fix runs, its final verify and re-check are planned. */
  const round1Running = (): RunSnapshot =>
    snapWith({
      summary: { status: 'running', phase: 'fixing' },
      steps: {
        ...reviewed,
        fix: { status: 'running', attempt: 1, vendor: 'claude', round: R(1), activeMs: 4_000 },
        'verify:2': { status: 'queued', planned: true, round: R(1) },
        recheck: { status: 'queued', planned: true, vendor: 'claude', round: R(1) },
      },
      extra: { fixLoop: loop({ rounds: [round({ n: 1, status: 'running' })] }) },
    })

  /** Round 1 over: verify still fails, the re-check left F5 open. */
  const round1Done = (): RunSnapshot =>
    snapWith({
      summary: { status: 'running', phase: 'fixing' },
      steps: {
        ...reviewed,
        fix: { status: 'done', attempt: 1, vendor: 'claude', round: R(1), activeMs: 9_000 },
        'verify:2': { status: 'done', attempt: 1, round: R(1), activeMs: 2_000 },
        recheck: {
          status: 'done',
          attempt: 1,
          vendor: 'claude',
          round: R(1),
          recheck: RECHECK_1,
          activeMs: 3_000,
        },
      },
      extra: {
        fixLoop: loop({
          rounds: [round({ n: 1, changed: true, failing: ['check'], resolved: [1, 2], open: [5] })],
        }),
      },
    })

  const views1 = (): NonNullable<FixRoundView['views']> => {
    const s = round1Done().steps
    return { fix: s.fix, verify: s['verify:2'], recheck: s.recheck }
  }
  const r1 = (): FixRoundView =>
    round({ n: 1, changed: true, failing: ['check'], resolved: [1, 2], open: [5], views: views1() })

  /** Round 2 under way: the steps hold round 2 (Fix running, the re-check's facts gone). */
  const round2Running = (): RunSnapshot =>
    snapWith({
      summary: { status: 'running', phase: 'fixing' },
      steps: {
        ...reviewed,
        fix: { status: 'running', attempt: 2, vendor: 'claude', round: R(2), activeMs: 1_000 },
        'verify:2': { status: 'done', attempt: 1, round: R(2), activeMs: 2_000 },
        recheck: { status: 'done', attempt: 1, vendor: 'claude', round: R(2), activeMs: 3_000 },
      },
      extra: { fixLoop: loop({ round: 2, rounds: [r1(), round({ n: 2, status: 'running' })] }) },
    })

  /** Round 2 over and green: the loop stopped. */
  const round2Green = (): RunSnapshot => {
    const base = snapWith({
      summary: { status: 'running', phase: 'fixing' },
      steps: {
        ...reviewed,
        fix: { status: 'done', attempt: 2, vendor: 'claude', round: R(2), activeMs: 5_000 },
        'verify:2': { status: 'done', attempt: 2, round: R(2), activeMs: 2_000 },
        recheck: {
          status: 'done',
          attempt: 2,
          vendor: 'claude',
          round: R(2),
          recheck: { status: 'resolved', resolved: [5], open: [] },
          activeMs: 1_000,
        },
      },
    })
    const views = { fix: base.steps.fix, verify: base.steps['verify:2'], recheck: base.steps.recheck }
    return {
      ...base,
      fixLoop: loop({
        round: 2,
        rounds: [r1(), round({ n: 2, changed: true, failing: [], resolved: [5], views })],
        stop: { reason: 'green', text: 'Fix until green: green after round 2.' },
      }),
    }
  }

  const TRACKED =
    /^(pass-card-(fix|verify:2|recheck)(-round-\d)?|fix-rounds|fix-round-\d|fix-round-section-\d|fix-round-\d-heading|fix-rounds-stop)$/
  const flowIds = (): string[] =>
    [...screen.getByTestId('flow-tab').querySelectorAll('[data-testid]')]
      .map((e) => e.getAttribute('data-testid') ?? '')
      .filter((id) => TRACKED.test(id))

  const show = (view: ReturnType<typeof render>, snap: RunSnapshot): void =>
    view.rerender(
      <Providers>
        <FlowTab snap={snap} />
      </Providers>,
    )

  it('runs round 1 in the usual cards, then appends its verdict, round 2 and the stop line; nothing above changes', async () => {
    const view = render(
      <Providers>
        <FlowTab snap={round1Running()} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('round-chip-fix').textContent).toContain('Round 1 of 3')
    expect(screen.queryByTestId('fix-rounds')).toBeNull()

    // Round 1 over: its verdict follows its Re-check card.
    show(view, round1Done())
    await settle()
    expect(flowIds()).toEqual([
      'pass-card-fix',
      'pass-card-verify:2',
      'pass-card-recheck',
      'fix-rounds',
      'fix-round-1',
    ])
    const fix1 = screen.getByTestId('pass-card-fix')
    const fix1Text = fix1.textContent
    const recheck1Text = screen.getByTestId('pass-card-recheck').textContent
    const row1 = screen.getByTestId('fix-round-1')
    expect(screen.getByTestId('fix-round-1-verify').textContent).toBe('Still failing: check')
    expect(screen.getByTestId('fix-round-1-resolved').textContent).toBe('F1, F2 resolved')
    expect(screen.getByTestId('fix-round-1-open').textContent).toBe('F5 still open')

    // Round 2 starts: round 1's cards keep round 1 (frozen views), and round 2's section is appended.
    show(view, round2Running())
    await settle()
    expect(flowIds()).toEqual([
      'pass-card-fix',
      'pass-card-verify:2',
      'pass-card-recheck',
      'fix-rounds',
      'fix-round-1',
      'fix-round-section-2',
      'fix-round-2-heading',
      'pass-card-fix-round-2',
    ])
    expect(screen.getByTestId('pass-card-fix')).toBe(fix1)
    expect(screen.getByTestId('pass-card-fix').textContent).toBe(fix1Text)
    expect(screen.getByTestId('round-chip-fix').textContent).toContain('Round 1 of 3')
    expect(screen.getByTestId('pass-card-recheck').textContent).toBe(recheck1Text)
    expect(screen.getByTestId('fix-round-1')).toBe(row1)
    expect(screen.getByTestId('fix-round-2-heading').textContent).toBe('Round 2 of 3')
    expect(screen.getByTestId('round-chip-fix-round-2').textContent).toContain('Round 2 of 3')
    expect(screen.getByTestId('pass-card-fix-round-2').getAttribute('data-status')).toBe('running')
    // Round 2's verify and re-check have not begun in round 2: no cards for them yet.
    expect(screen.queryByTestId('pass-card-verify:2-round-2')).toBeNull()

    // Round 2 over and green: its cards and verdict close its section, the stop line comes last.
    show(view, round2Green())
    await settle()
    expect(flowIds()).toEqual([
      'pass-card-fix',
      'pass-card-verify:2',
      'pass-card-recheck',
      'fix-rounds',
      'fix-round-1',
      'fix-round-section-2',
      'fix-round-2-heading',
      'pass-card-fix-round-2',
      'pass-card-verify:2-round-2',
      'pass-card-recheck-round-2',
      'fix-round-2',
      'fix-rounds-stop',
    ])
    expect(screen.getByTestId('pass-card-fix').textContent).toBe(fix1Text)
    expect(screen.getByTestId('pass-card-recheck').textContent).toBe(recheck1Text)
    expect(screen.getByTestId('fix-round-1')).toBe(row1)
    expect(screen.getByTestId('fix-round-2-verify').textContent).toBe('Passed')
    expect(screen.getByTestId('fix-rounds-stop').textContent).toBe('Fix until green: green after round 2.')
    expect(screen.getByTestId('flow-tab').textContent).not.toContain(EM_DASH)
  })

  it('offers no Retry, Continue without or snag actions on an earlier round’s card', async () => {
    const failed: StepView = {
      ...(r1().views?.fix as StepView),
      status: 'failed',
      failure: { category: 'network', message: 'm', raw: '', classifiedBy: 'errno' },
    }
    const snap = round2Running()
    const view = render(
      <Providers>
        <PassCard runId={RUN} snap={snap} view={failed} />
      </Providers>,
    )
    await settle()
    // The same view, live: its snag card (whose actions act on the step's latest attempt) shows.
    expect(screen.getByTestId('snag-fix')).toBeTruthy()
    view.unmount()
    render(
      <Providers>
        <PassCard runId={RUN} snap={snap} view={failed} frozen />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('snag-fix')).toBeNull()
  })
})

// ---- the round chip ----------------------------------------------------------------------------------------------------

describe('the round chip', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'runs.events': eventsHandler(() => []),
        'runs.output': () => ({ text: '', mtime: 0, version: 0 }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  it('reserves every round’s label, so it keeps one width', () => {
    render(<RoundChip round={{ n: 1, of: 3 }} testId="chip" />)
    const chip = screen.getByTestId('chip')
    const sizers = [...chip.querySelectorAll('[aria-hidden]')].map((e) => e.textContent)
    expect(sizers).toEqual(['Round 1 of 3', 'Round 2 of 3', 'Round 3 of 3'])
  })

  it('is on the Fix, Final verify and Re-check cards when the loop is on, and nowhere without it', () => {
    const on = snapWith({
      steps: {
        fix: { status: 'running', attempt: 2, vendor: 'claude', round: { n: 2, of: 3 } },
        'verify:2': { status: 'queued', planned: true, round: { n: 2, of: 3 } },
        recheck: { status: 'queued', planned: true, round: { n: 2, of: 3 } },
      },
    })
    render(
      <Providers>
        <PassCard runId={RUN} snap={on} view={on.steps.fix} />
        <VerifyCard runId={RUN} snap={on} view={on.steps['verify:2']} />
        <PassCard runId={RUN} snap={on} view={on.steps.recheck} />
      </Providers>,
    )
    for (const k of ['fix', 'verify:2', 'recheck'])
      expect(screen.getByTestId(`round-chip-${k}`).textContent).toContain('Round 2 of 3')
  })

  it('is absent in a run without the loop', () => {
    const off = snapWith({ steps: { fix: { status: 'running', attempt: 1, vendor: 'claude' } } })
    render(
      <Providers>
        <PassCard runId={RUN} snap={off} view={off.steps.fix} />
      </Providers>,
    )
    expect(screen.queryByTestId('round-chip-fix')).toBeNull()
  })
})

// ---- labels and the outcome --------------------------------------------------------------------------------------------

describe('labels and the outcome', () => {
  it('names the re-check by whether the run has the security advisor', () => {
    const without = snapWith({ steps: { security: { status: 'skipped', reason: 'not used' } } })
    expect(runStepLabel('recheck', without.steps)).toBe('Re-check')
    const withAdvisor = snapWith({ steps: { security: { status: 'queued' } } })
    expect(runStepLabel('recheck', withAdvisor.steps)).toBe('Security re-check')
    expect(runStepLabel('fix', without.steps)).toBe('Fix')
    // A summary lists only the steps that ran.
    const summary = makeSummary({ runId: 'r', steps: [{ key: 'recheck', status: 'done', activeMs: 1 }] })
    expect(summaryStepLabel('recheck', summary)).toBe('Re-check')
    expect(RUN_PHASE_LABEL.rechecking).toBe('Re-checking')
    // The timeline node of a run without the advisor reads Re-check.
    const cols = timelineColumns(
      snapWith({
        steps: {
          security: { status: 'skipped', reason: 'not used' },
          recheck: { status: 'queued', planned: true },
        },
      }),
    )
    expect(cols.some((c) => c.kind === 'step' && c.steps.some((s) => s.key === 'recheck'))).toBe(true)
  })

  it('words the re-check’s facts for every must finding without the advisor', () => {
    expect(recheckText(undefined, false)).toBe('Checks the findings once Fix ends.')
    expect(recheckText({ status: 'resolved', resolved: [1, 2], open: [] }, false)).toBe(
      'Fix resolved all 2 findings',
    )
    expect(recheckText({ status: 'open', resolved: [], open: [{ n: 2 }] }, false)).toBe(
      '1 finding is still open after Fix',
    )
    render(<RecheckFacts view={undefined} security={false} />)
    expect(screen.getByTestId('recheck-line').textContent).toBe('Checks the findings once Fix ends.')
  })

  it('reads Completed with failures and the reason when the loop stopped short of green', () => {
    const summary = (stop?: 'cap' | 'budget' | 'no-progress') =>
      makeSummary({
        runId: 'r',
        status: 'completed',
        outcome: 'fix-stopped',
        ...(stop !== undefined ? { fixLoop: { rounds: 3, max: 3, stop } } : {}),
      })
    expect(outcomeText(summary('cap'))).toBe('Completed with failures · round cap reached')
    expect(outcomeText(summary('budget'))).toBe('Completed with failures · budget reached')
    expect(outcomeText(summary('no-progress'))).toBe('Completed with failures · no progress')
    expect(outcomeText(summary())).toBe('Completed with failures')
    expect(fixStoppedText('green')).toBe('Completed with failures')
    for (const s of ['cap', 'budget', 'no-progress'] as const)
      expect(outcomeText(summary(s))).not.toContain(EM_DASH)
  })
})

// ---- the composer ------------------------------------------------------------------------------------------------------

describe('the composer: Fix until green', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'preflight.run': () => report(),
        'estimates.get': () => runEstimate(),
      },
    })
    upsertProbes([probe('claude', 'ready')])
  })
  afterEach(() => tearDown(mock))

  const lastOverrides = (): RunOverrides | undefined =>
    (mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }).overrides

  it('is off for a single Fix; on sets 3 rounds and off sets 1, with a constant note', async () => {
    await mountComposer()
    await settle(300)
    const sw = screen.getByTestId('composer-fix-loop')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('composer-fix-loop-note').textContent).toBe(FIX_UNTIL_GREEN_NOTE)
    expect(FIX_UNTIL_GREEN_NOTE).not.toContain(EM_DASH)
    fireEvent.click(sw)
    await settle(300)
    expect(lastOverrides()).toEqual({ passes: { fix: { rounds: 3 } } })
    expect(screen.getByTestId('composer-fix-loop').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('composer-fix-loop'))
    await settle(300)
    expect(lastOverrides()).toEqual({ passes: { fix: { rounds: 1 } } })
    expect(screen.getByTestId('composer-fix-loop-note').textContent).toBe(FIX_UNTIL_GREEN_NOTE)
  })

  it('reads on when the resolved config already has 2 rounds, and keeps that value', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.fix.rounds = 2) }))
    await mountComposer()
    await settle(300)
    expect(screen.getByTestId('composer-fix-loop').getAttribute('aria-checked')).toBe('true')
    // No override was needed to read it on.
    expect(lastOverrides() ?? {}).toEqual({})
  })
})

// ---- Settings ------------------------------------------------------------------------------------------------------------

describe('Settings: Fix until green', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'verify.detect': () => [],
        'folders.recent': () => [],
        'config.patch': () => ({
          path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
          changed: true,
          diff: '',
          backupId: 'b1',
        }),
        'config.restoreBackup': () => ({ path: '', changed: true, diff: '', backupId: null }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  const lastOps = (): JsonPatchOp[] | undefined =>
    (mock.callsOf('config.patch') as { ops: JsonPatchOp[] }[]).at(-1)?.ops

  it('writes the rounds, the re-check and the optional budgets to the chosen project', async () => {
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settle(SECTION_LOAD_DELAY_MS)
    await settle()
    const single = screen.getByTestId<HTMLInputElement>('setting-fix-rounds-1')
    expect(single.checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'Single Fix' })).toBe(single)
    fireEvent.click(screen.getByRole('radio', { name: 'Up to 3 rounds' }))
    await settle()
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/fix/rounds', value: 3 }],
    })

    const recheck = screen.getByTestId('setting-/passes/fix/recheck')
    expect(recheck.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(recheck)
    await settle()
    expect(lastOps()).toEqual([{ op: 'replace', path: '/passes/fix/recheck', value: false }])

    const cost = screen.getByTestId<HTMLInputElement>('setting-/passes/fix/maxCostUsd')
    expect(cost.value).toBe('')
    const before = mock.callsOf('config.patch').length
    fireEvent.change(cost, { target: { value: '-1' } })
    fireEvent.keyDown(cost, { key: 'Enter' })
    await settle()
    expect(mock.callsOf('config.patch')).toHaveLength(before)
    expect(screen.getByRole('alert').textContent).toContain('leave it empty for no limit')
    fireEvent.change(cost, { target: { value: '2.5' } })
    fireEvent.keyDown(cost, { key: 'Enter' })
    await settle()
    expect(lastOps()).toEqual([{ op: 'replace', path: '/passes/fix/maxCostUsd', value: 2.5 }])

    const minutes = screen.getByTestId<HTMLInputElement>('setting-/passes/fix/maxMinutes')
    fireEvent.change(minutes, { target: { value: '45' } })
    fireEvent.keyDown(minutes, { key: 'Enter' })
    await settle()
    expect(lastOps()).toEqual([{ op: 'replace', path: '/passes/fix/maxMinutes', value: 45 }])
    expect(document.body.textContent).toContain('Time spent waiting for you does not count')
    expect(document.body.textContent).not.toContain(EM_DASH)
  })
})
