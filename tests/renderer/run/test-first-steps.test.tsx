// Test-first in the Run view: the Tests step and its red check sit between the plan gate and Implement, shown from the
// start only in a Test-first run (core marks them planned); the Tests step is an agent step (its pass actions take
// `tests`); its card lists the test files and keeps a line for the guard; the red check's failures are expected;
// the testsNotRed card lists the commands that passed; findings from the guard carry a "Tests" chip.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { CardView as CardData, RunEnvelope, RunSnapshot, StepView } from '@shared/run.ts'
import { TESTS_SOURCE_LABEL } from '@renderer/components/cards/BeforeFixBody.tsx'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { testsNotRedOf } from '@renderer/components/cards/payload.ts'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard, testGuardText } from '@renderer/components/run/PassCard.tsx'
import { cardStep, shownSteps, timelineColumns } from '@renderer/components/run/steps.ts'
import { isAgent, isPass, SKIPPABLE } from '@renderer/components/run/text.ts'
import { RED_CHECK_NOTE, VerifyCard } from '@renderer/components/run/VerifyCard.tsx'
import { isVerifyStep, verifyOutcome, verifyOutputFile } from '@renderer/components/run/VerifyModel.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { RUN_PHASE_LABEL, STEP_LABEL, stepLabel } from '@renderer/lib/format.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { TEST_FAIL, TYPECHECK } from '../verify/fixtures.ts'
import { Providers } from '../dashboard/setup.tsx'
import { RUN, eventsHandler, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  log = []
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
      'runs.retryPass': () => undefined,
      'runs.skipPass': () => undefined,
      'cards.resolve': () => undefined,
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'no output')
      },
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetTicker()
  resetBridgeForTests()
})

const columns = (snap: RunSnapshot): string[] =>
  timelineColumns(snap).map((c) => (c.kind === 'step' ? c.steps.map((s) => s.key).join('+') : `<${c.gate}>`))

describe('the Test-first steps in the timeline', () => {
  it('shows Tests and the red check after the plan gate, before Implement, when core plans them', () => {
    const snap = snapWith({
      steps: {
        plan: { status: 'running', attempt: 1 },
        tests: { planned: true },
        'verify:red': { planned: true },
        'verify:1': { planned: true },
      },
    })
    expect(columns(snap)).toEqual([
      'preflight',
      'plan',
      '<afterPlan>',
      'tests',
      'verify:red',
      'implement',
      'verify:1',
      'review+critic',
      '<beforeFix>',
      'fix',
    ])
    expect(shownSteps(snap).map((v) => v.key)).toEqual([
      'preflight',
      'plan',
      'tests',
      'verify:red',
      'implement',
      'verify:1',
      'review',
      'critic',
      'fix',
    ])
  })

  it('leaves them out of a run without Test-first (queued, attempt 0, not planned)', () => {
    const snap = snapWith({ steps: { plan: { status: 'running', attempt: 1 } } })
    const keys = shownSteps(snap).map((v) => v.key)
    expect(keys).not.toContain('tests')
    expect(keys).not.toContain('verify:red')
    expect(columns(snap)).toEqual([
      'preflight',
      'plan',
      '<afterPlan>',
      'implement',
      'review+critic',
      '<beforeFix>',
      'fix',
    ])
  })

  it('places the testsNotRed card with the red check', () => {
    const card: CardData = {
      id: 'c1',
      kind: 'testsNotRed',
      title: 'The new tests already pass',
      body: '',
      payload: { step: 'verify:red', ran: true, passed: ['test'], attempt: 1 },
      blocking: true,
      choices: [],
    }
    expect(cardStep(card)).toBe('verify:red')
    expect(cardStep({ ...card, payload: {} })).toBeNull()
  })

  it('treats the red check as a verify round and Tests as an agent step, not a pass', () => {
    expect(isVerifyStep('verify:red')).toBe(true)
    expect(verifyOutputFile('verify:red')).toBe('verify:red')
    expect(isPass('tests')).toBe(false)
    expect(isAgent('tests')).toBe(true)
    expect(isAgent('verify:red')).toBe(false)
    expect(SKIPPABLE.has('tests')).toBe(true)
  })

  it('labels the steps and the phase', () => {
    expect(STEP_LABEL.tests).toBe('Tests')
    expect(stepLabel('verify:red')).toBe('Red check')
    expect(RUN_PHASE_LABEL['writing-tests']).toBe('Writing tests')
  })

  it('reads the red check the other way round: no failing command is the problem', () => {
    const red = (commands: StepView['verify']): StepView =>
      ({ key: 'verify:red', status: 'done', attempt: 1, activeMs: 1, verify: commands }) as StepView
    expect(verifyOutcome(red({ commands: [TEST_FAIL] }))).toBe('fine')
    expect(verifyOutcome(red({ commands: [TYPECHECK] }))).toBe('problem')
    const v1 = { ...red({ commands: [TEST_FAIL] }), key: 'verify:1' } as StepView
    expect(verifyOutcome(v1)).toBe('problem')
  })
})

describe('the Tests card', () => {
  const testsSnap = (over: Partial<StepView>): RunSnapshot =>
    snapWith({
      steps: {
        plan: { status: 'done', attempt: 1 },
        tests: { status: 'done', attempt: 1, vendor: 'claude', model: null, planned: true, ...over },
      },
    })

  it('offers Retry and Continue without for a failed Tests step, sent with pass "tests"', async () => {
    const snap = testsSnap({ status: 'failed' })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.tests} />)
    fireEvent.pointerDown(screen.getByTestId('pass-menu-tests'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    const retry = await screen.findByTestId('pass-retry')
    expect(retry.textContent).toBe('Retry Tests')
    await act(async () => {
      fireEvent.click(retry)
      await settle()
    })
    expect(mock.callsOf('runs.retryPass')).toEqual([{ runId: RUN, pass: 'tests' }])
    fireEvent.pointerDown(screen.getByTestId('pass-menu-tests'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('pass-skip'))
      await settle()
    })
    expect(mock.callsOf('runs.skipPass')).toEqual([{ runId: RUN, pass: 'tests' }])
  })

  it('lists the test files and keeps the guard line from the moment the files are known', () => {
    const snap = testsSnap({ testFirst: { files: ['tests/cli.test.ts', 'tests/version.test.ts'] } })
    const { rerender } = renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.tests} />)
    expect(screen.getByTestId('tests-files').textContent).toContain('Wrote 2 test files')
    expect(within(screen.getByTestId('tests-files-list')).getAllByRole('listitem')).toHaveLength(2)
    const guard = screen.getByTestId('tests-guard')
    expect(guard.className).toContain('h-4')
    expect(guard.dataset['guard']).toBe('pending')

    const weakened = testsSnap({
      testFirst: { files: ['tests/cli.test.ts'], guard: 'weakened', weakened: 2 },
    })
    rerender(
      <Providers>
        <PassCard runId={RUN} snap={weakened} view={weakened.steps.tests} />
      </Providers>,
    )
    expect(screen.getByTestId('tests-guard').textContent).toBe('Implement weakened the tests: 2 findings')
    expect(screen.getByTestId('tests-files').textContent).toContain('Wrote 1 test file')
  })

  it('words every guard state', () => {
    expect(testGuardText({ files: [], guard: 'checking' })).toBe(
      'Checking that Implement kept the tests whole…',
    )
    expect(testGuardText({ files: [], guard: 'ok' })).toBe('Implement kept the tests whole')
    expect(testGuardText({ files: [], guard: 'weakened', weakened: 1 })).toBe(
      'Implement weakened the tests: 1 finding',
    )
    expect(testGuardText({ files: [], guard: 'failed' })).toBe('The check could not run')
  })
})

describe('the red check card', () => {
  it('says its checks should fail and does not draw their failures as failures', () => {
    const snap = snapWith({
      steps: {
        tests: { status: 'done', attempt: 1, planned: true },
        'verify:red': { status: 'done', attempt: 1, activeMs: 5000, verify: { commands: [TEST_FAIL] } },
      },
    })
    render(
      <Providers>
        <VerifyCard runId={RUN} snap={snap} view={snap.steps['verify:red']} finishedAtOpen={false} />
      </Providers>,
    )
    expect(screen.getByTestId('red-check-note').textContent).toBe(RED_CHECK_NOTE)
    expect(screen.getByTestId('verify-summary-verify:red').className).not.toContain('text-st-failed')
    expect(screen.getByTestId('verify-command-verify:red-0-status').className).not.toContain('text-st-failed')
  })

  it('warns when no command failed', () => {
    const snap = snapWith({
      steps: {
        'verify:red': { status: 'done', attempt: 1, activeMs: 5000, verify: { commands: [TYPECHECK] } },
      },
    })
    render(
      <Providers>
        <VerifyCard runId={RUN} snap={snap} view={snap.steps['verify:red']} finishedAtOpen={false} />
      </Providers>,
    )
    expect(screen.getByTestId('verify-summary-verify:red').className).toContain('text-warning')
  })
})

describe('the testsNotRed card', () => {
  const card: CardData = {
    id: 'testsNotRed-1',
    kind: 'testsNotRed',
    title: 'The new tests already pass',
    body: 'The red check found no failing command, so the tests may not test the change.',
    payload: { step: 'verify:red', ran: true, passed: ['test', 'typecheck'], attempt: 1 },
    blocking: true,
    choices: [
      { id: 'rewrite', label: 'Rewrite the tests', primary: true },
      { id: 'continue', label: 'Continue anyway' },
      { id: 'stop', label: 'Stop run', danger: true },
    ],
  }

  it('reads its payload', () => {
    expect(testsNotRedOf(card)).toEqual({ ran: true, passed: ['test', 'typecheck'], attempt: 1 })
    expect(testsNotRedOf({ ...card, payload: null })).toEqual({ ran: true, passed: [], attempt: null })
  })

  it('lists the commands that passed and sends core choice ids', async () => {
    renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
    const list = screen.getByTestId('tests-not-red-passed')
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['test', 'typecheck'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Rewrite the tests/ }))
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'testsNotRed-1', choiceId: 'rewrite' },
    ])
  })
})

describe('findings from the Tests guard', () => {
  it('carry a Tests chip in the gate before Fix', () => {
    const f: Finding = {
      id: 'f1',
      n: 1,
      severity: 'must',
      source: 'tests',
      title: 'Implement removed an assertion from tests/cli.test.ts',
      body: '',
    } as Finding
    const gate: CardData = {
      id: 'g1',
      kind: 'gate:beforeFix',
      title: 'Findings',
      body: '',
      payload: { findings: [f], selected: ['f1'] },
      blocking: true,
      choices: [{ id: 'continue', label: 'Continue with 1', primary: true }],
    }
    renderUi(<CardView runId={RUN} card={gate} folder="C:\\work\\repo" />)
    expect(screen.getByTestId('finding-source-f1').textContent).toBe(TESTS_SOURCE_LABEL)
  })
})
