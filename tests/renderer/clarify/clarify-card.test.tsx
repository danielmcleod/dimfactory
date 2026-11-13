// Clarify before Plan in the renderer:
//   - the clarify card: each question as a radio group (core's options, "Other" with a text box, "Leave it to Plan"),
//     "Use these answers" sends one answer per question in order ('' for one left to Plan, the Other text as typed),
//     "Skip questions" sends core's skip id; the choices keep their labels and the card its rows while typing;
//   - the Clarify step: its node before Plan only when core plans it, its card's facts (asking, answered, skipped,
//     nothing asked);
//   - the composer's "Clarify first" switch (a run override of passes.plan.clarify) and the Settings rows.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { CardView as CardData, ClarifyView, RunSnapshot } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { clarifyAnswers, LEAVE_TO_PLAN } from '@renderer/components/cards/ClarifyBody.tsx'
import { CLARIFY_CHOICE, clarifyOf } from '@renderer/components/cards/payload.ts'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { ClarifyFacts, clarifyLine, LEFT_TO_PLAN } from '@renderer/components/run/ClarifyFacts.tsx'
import { cardStep, timelineColumns } from '@renderer/components/run/steps.ts'
import { SKIPPABLE } from '@renderer/components/run/text.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { RUN_PHASE_LABEL, stepLabel } from '@renderer/lib/format.ts'
import { CLARIFY_NOTE } from '@renderer/pages/dashboard/composer/model.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import coreCards from '../../../src/core/supervisor/cards.ts?raw'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle as settleUi, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

function clarifyCard(): CardData {
  return {
    id: 'clarify-1',
    kind: 'clarify',
    title: '3 questions before Plan',
    body: 'Your answers join the brief that Plan, Implement and the reviewers read.',
    payload: {
      step: 'clarify',
      questions: [
        { question: 'Which database should the cache use?', options: ['Redis', 'In memory'] },
        { question: 'Keep the old endpoint?', options: ['Yes, deprecated', 'No, remove it'] },
        { question: 'Who may call it?', options: ['Admins', 'Everyone'] },
      ],
    },
    blocking: true,
    choices: [
      { id: 'answer', label: 'Use these answers', primary: true, input: 'answers' },
      { id: 'skip', label: 'Skip questions' },
    ],
  }
}

// ---- the card ----------------------------------------------------------------------------------------------------------

describe('the clarify card', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    resetBridgeForTests()
    resetStore()
    clearToasts()
    resetLaterChoicesForTests()
    mock = installMockDimFactory({
      handlers: { 'cards.resolve': () => undefined, 'runs.get': () => snapWith() },
    })
  })
  afterEach(() => {
    mock.uninstall()
    cancelRefetches()
    clearToasts()
    resetBridgeForTests()
  })

  const mount = (): HTMLElement => {
    renderUi(<CardView runId={RUN} card={clarifyCard()} folder={FOLDER} />)
    return screen.getByTestId('card-clarify')
  }

  it('shows each question as a radio group: its options, Other with a text box, and Leave it to Plan', () => {
    const card = mount()
    expect(within(card).getByRole('heading', { name: '3 questions before Plan' })).toBeTruthy()
    const groups = within(card).getAllByRole('group')
    expect(groups).toHaveLength(3)
    const first = within(card).getByRole('group', { name: 'Which database should the cache use?' })
    const radios = within(first).getAllByRole('radio')
    // Redis, In memory, Other, Leave it to Plan.
    expect(radios).toHaveLength(4)
    expect(within(first).getByRole('radio', { name: 'Redis' })).toBeTruthy()
    expect(within(first).getByRole('radio', { name: 'Other' })).toBeTruthy()
    const leave = within(first).getByRole<HTMLInputElement>('radio', { name: LEAVE_TO_PLAN })
    // Nothing is chosen for the user: every question starts left to Plan.
    expect(leave.checked).toBe(true)
    expect(within(first).getByRole('textbox', { name: 'Your own answer to question 1' })).toBeTruthy()
    expect(card.textContent).not.toContain(EM_DASH)
  })

  it('Use these answers sends one answer per question in order: an option, blank for Leave it to Plan, the Other text', async () => {
    const card = mount()
    fireEvent.click(screen.getByTestId('clarify-q-0-opt-1'))
    // Typing in the Other box picks Other.
    fireEvent.change(screen.getByTestId('clarify-q-2-other-text'), {
      target: { value: '  Only the owner  ' },
    })
    expect(screen.getByTestId<HTMLInputElement>('clarify-q-2-other').checked).toBe(true)
    // Picking an option after typing keeps the text but sends the option.
    const answer = screen.getByTestId('card-choice-answer')
    const skip = screen.getByTestId('card-choice-skip')
    expect(answer.textContent).toBe('Use these answers')
    expect(skip.textContent).toBe('Skip questions')
    await act(async () => {
      fireEvent.click(answer)
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      {
        runId: RUN,
        cardId: 'clarify-1',
        choiceId: CLARIFY_CHOICE.answer,
        input: ['In memory', '', 'Only the owner'],
      },
    ])
    // The choices keep their labels after the press (they never change size).
    expect(screen.getByTestId('card-choice-answer').textContent).toBe('Use these answers')
    expect(screen.getByTestId('card-choice-skip').textContent).toBe('Skip questions')
    expect(card.textContent).not.toContain(EM_DASH)
  })

  it('every row and the Other boxes are there from the start, so picking and typing add nothing', () => {
    const card = mount()
    const count = (): number => card.querySelectorAll('label, input').length
    const before = count()
    fireEvent.click(screen.getByTestId('clarify-q-1-other'))
    fireEvent.change(screen.getByTestId('clarify-q-1-other-text'), { target: { value: 'Keep it a week' } })
    fireEvent.click(screen.getByTestId('clarify-q-0-opt-0'))
    expect(count()).toBe(before)
  })

  it('Skip questions sends core’s skip id with no answers', async () => {
    mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-choice-skip'))
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'clarify-1', choiceId: CLARIFY_CHOICE.skip },
    ])
  })

  it('reads the payload defensively and builds answers the way core takes them', () => {
    expect(clarifyOf({ ...clarifyCard(), payload: null })).toEqual([])
    expect(
      clarifyOf({ ...clarifyCard(), payload: { questions: [{ question: '' }, { question: 'Q?' }] } }),
    ).toEqual([{ question: 'Q?', options: [] }])
    const qs = [
      { question: 'A?', options: ['x', 'y'] },
      { question: 'B?', options: [] },
    ]
    expect(
      clarifyAnswers(qs, [
        { pick: 1, other: 'ignored' },
        { pick: 'other', other: ' ' },
      ]),
    ).toEqual(['y', ''])
    expect(clarifyAnswers(qs, [])).toEqual(['', ''])
    expect(
      clarifyAnswers(qs, [
        { pick: 'other', other: 'z'.repeat(600) },
        { pick: 'none', other: '' },
      ])[0],
    ).toHaveLength(500)
  })

  it('its choice ids match core’s', () => {
    const start = coreCards.indexOf('const CLARIFY_CHOICE')
    expect(start).toBeGreaterThan(-1)
    const block = coreCards.slice(start, coreCards.indexOf('}', start))
    expect(block).toContain("answer: 'answer'")
    expect(block).toContain("skip: 'skip'")
  })
})

// ---- the step ----------------------------------------------------------------------------------------------------------

const keysOf = (snap: RunSnapshot): string[] =>
  timelineColumns(snap).map((c) => (c.kind === 'gate' ? `<${c.gate}>` : c.steps.map((s) => s.key).join('+')))

describe('the Clarify step', () => {
  it('sits before Plan in the timeline only when core plans it', () => {
    const planned = snapWith({ summary: { auto: true }, steps: { clarify: { planned: true } } })
    expect(keysOf(planned)).toEqual(['preflight', 'clarify', 'plan', 'implement', 'review+critic', 'fix'])
    const without = snapWith({
      summary: { auto: true },
      steps: { clarify: { status: 'skipped', reason: 'not used' } },
    })
    expect(keysOf(without)).not.toContain('clarify')
    // In Auto core skips it (unless set to ask): never planned, so no node either.
    const auto = snapWith({
      summary: { auto: true },
      steps: { clarify: { status: 'skipped', reason: 'skipped in Auto' } },
    })
    expect(keysOf(auto)).not.toContain('clarify')
  })

  it('has its labels, belongs with its card and may be skipped', () => {
    expect(stepLabel('clarify')).toBe('Clarify')
    expect(RUN_PHASE_LABEL.clarifying).toBe('Clarifying')
    expect(cardStep(clarifyCard())).toBe('clarify')
    expect(SKIPPABLE.has('clarify')).toBe(true)
  })

  const view = (o: Partial<ClarifyView>): ClarifyView => ({
    status: 'answered',
    questions: [
      { question: 'Which database?', options: ['Redis'] },
      { question: 'Keep the old endpoint?', options: ['Yes'] },
    ],
    ...o,
  })

  it('shows each question with the answer given, and Left to Plan for one left blank', () => {
    render(<ClarifyFacts view={view({ answers: ['Redis', ''] })} />)
    expect(screen.getByTestId('clarify-line').textContent).toBe('You answered 1 of 2 questions')
    expect(screen.getByTestId('clarify-answer-0').textContent).toBe('Which database?Redis')
    expect(screen.getByTestId('clarify-answer-1').textContent).toBe(`Keep the old endpoint?${LEFT_TO_PLAN}`)
  })

  it('says when it is asking, when the questions were skipped, and core’s note when it asked nothing', () => {
    expect(clarifyLine(view({ status: 'asking' }))).toBe('2 questions waiting for your answers below')
    expect(clarifyLine(view({ status: 'skipped' }))).toBe('You skipped the questions: Plan decides')
    expect(clarifyLine(view({ status: 'none', questions: [], note: 'The task was clear.' }))).toBe(
      'The task was clear.',
    )
    expect(clarifyLine(view({ status: 'none', questions: [] }))).toBe('Clarify had no questions')
    for (const s of ['asking', 'answered', 'skipped', 'none'] as const)
      expect(clarifyLine(view({ status: s, answers: ['', ''] }))).not.toContain(EM_DASH)
  })
})

// ---- the composer ------------------------------------------------------------------------------------------------------

describe('the composer: Clarify first', () => {
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

  it('is off by default with a constant note; turning it on is a run override of passes.plan.clarify', async () => {
    await mountComposer()
    await settleUi(300)
    const sw = screen.getByTestId('composer-clarify')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('composer-clarify-note').textContent).toBe(CLARIFY_NOTE)
    expect(CLARIFY_NOTE).not.toContain(EM_DASH)
    fireEvent.click(sw)
    await settleUi(300)
    const last = mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }
    expect(last.overrides).toEqual({ passes: { plan: { clarify: true } } })
    expect(screen.getByTestId('composer-clarify').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('composer-clarify-note').textContent).toBe(CLARIFY_NOTE)
    fireEvent.click(screen.getByTestId('composer-clarify'))
    await settleUi(300)
    const off = mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }
    expect(off.overrides).toEqual({ passes: { plan: { clarify: false } } })
  })

  it('reads on from the resolved config (the thorough profile or a project setting)', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.plan.clarify = true) }))
    await mountComposer()
    await settleUi(300)
    expect(screen.getByTestId('composer-clarify').getAttribute('aria-checked')).toBe('true')
  })
})

// ---- Settings ------------------------------------------------------------------------------------------------------------

describe('Settings: Clarify before Plan', () => {
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

  it('writes passes.plan.clarify, clarifyQuestions (1 to 8) and clarifyInAuto to the chosen project', async () => {
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settleUi(SECTION_LOAD_DELAY_MS)
    await settleUi()
    const on = screen.getByTestId('setting-/passes/plan/clarify')
    expect(on.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(on)
    await settleUi()
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/plan/clarify', value: true }],
    })

    const questions = screen.getByTestId<HTMLInputElement>('setting-/passes/plan/clarifyQuestions')
    expect(questions.value).toBe('4')
    const patches = mock.callsOf('config.patch').length
    fireEvent.change(questions, { target: { value: '9' } })
    fireEvent.keyDown(questions, { key: 'Enter' })
    await settleUi()
    // Refused before anything is written, with the reason under the label.
    expect(mock.callsOf('config.patch')).toHaveLength(patches)
    expect(screen.getByRole('alert').textContent).toBe('Type a whole number from 1 to 8.')
    fireEvent.change(questions, { target: { value: '3' } })
    fireEvent.keyDown(questions, { key: 'Enter' })
    await settleUi()
    expect(lastOps()).toEqual([{ op: 'replace', path: '/passes/plan/clarifyQuestions', value: 3 }])

    const inAuto = screen.getByTestId('setting-/passes/plan/clarifyInAuto')
    expect(inAuto.getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('Off: Auto skips Clarify')
    fireEvent.click(inAuto)
    await settleUi()
    expect(lastOps()).toEqual([{ op: 'replace', path: '/passes/plan/clarifyInAuto', value: true }])
    expect(document.body.textContent).not.toContain(EM_DASH)
  })
})
