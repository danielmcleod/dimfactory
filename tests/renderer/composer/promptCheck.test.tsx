// The prompt check in the composer: one line under the task box that is always there (its answer moves nothing), core's
// hints for the task as typed, Hide until the hints change, and "Sharpen it": the cost before the click, a panel of
// fixed size on the click, and the task changed only by "Use this".
import '../helpers/rtl.ts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROMPT_HINT_TEXT, promptCheckLine } from '@shared/prompt-check.ts'
import type { PromptCheckView, PromptHint } from '@shared/prompt-check.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  PROMPT_CHECK_CLEAR,
  PROMPT_CHECK_HIDDEN,
  PROMPT_CHECK_IDLE,
  PROMPT_CHECK_NO_FOLDER,
  SHARPEN_NOTHING,
  SHARPEN_READY,
  promptCheckRowText,
  sharpenCostText,
  sharpenWaitingText,
} from '@renderer/pages/dashboard/composer/PromptCheckRow.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

const NO_TARGET: PromptHint = { kind: 'no-target', ...PROMPT_HINT_TEXT.noTarget }
const NO_OUTCOME: PromptHint = { kind: 'no-outcome', ...PROMPT_HINT_TEXT.noOutcome }
const HELPER = { vendor: 'claude', model: 'haiku', usd: 0.004 }
const WEAK: PromptCheckView = { hints: [NO_TARGET, NO_OUTCOME], sharpen: HELPER }
const CLEAR: PromptCheckView = { hints: [], sharpen: null }
const SHARPENED = 'On the [which page?] page, make the list load faster. It should [what should be true?].'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'task.check': (req: { task: string }) =>
        /better/.test(req.task)
          ? WEAK
          : /faster$/.test(req.task)
            ? { hints: [NO_TARGET], sharpen: HELPER }
            : CLEAR,
      'task.sharpen': () => ({ task: SHARPENED, vendor: 'claude' }),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const line = (): HTMLElement => screen.getByTestId('composer-prompt-check-line')
const type = async (task: string): Promise<void> => {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: task } })
  await settle(500)
}
const taskBox = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>('composer-task')

describe('the prompt check row', () => {
  it('is there from the start at one height, and says what it does before anything is typed', async () => {
    await mountComposer()
    const row = screen.getByTestId('composer-prompt-check-row')
    expect(row.className).toContain('h-7')
    expect(line().className).toContain('truncate')
    expect(line().textContent).toBe(PROMPT_CHECK_IDLE)
    // Nothing typed: core is not asked.
    expect(mock.callsOf('task.check')).toHaveLength(0)
    expect(screen.queryByTestId('composer-sharpen-panel')).toBeNull()
  })

  it("shows core's first hint and how many more, with every hint in the title", async () => {
    await mountComposer()
    await type('Make it better')
    expect(mock.callsOf('task.check').at(-1)).toEqual({ folder: FOLDER, task: 'Make it better' })
    expect(line().textContent).toBe(promptCheckLine(WEAK.hints))
    expect(line().textContent).toMatch(/\(1 more\)$/)
    expect(line().getAttribute('data-hints')).toBe('no-target,no-outcome')
    expect(line().getAttribute('title')).toContain(NO_OUTCOME.text)
  })

  it('a clear task reads so, and the buttons are off', async () => {
    await mountComposer()
    await type('Rename getUser to fetchUser')
    expect(line().textContent).toBe(PROMPT_CHECK_CLEAR)
    expect(screen.getByTestId('composer-sharpen')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('composer-prompt-check-hide')).toHaveProperty('disabled', true)
  })

  it('never blocks Run', async () => {
    await mountComposer()
    await type('Make it better')
    expect(screen.getByTestId('composer-run')).toHaveProperty('disabled', false)
  })

  it('Hide puts the hints away until they change', async () => {
    await mountComposer()
    await type('Make it better')
    const hide = screen.getByTestId('composer-prompt-check-hide')
    fireEvent.click(hide)
    expect(line().textContent).toBe(PROMPT_CHECK_HIDDEN)
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    // The same hints for other words stay hidden.
    await type('Make it much better')
    expect(line().textContent).toBe(PROMPT_CHECK_HIDDEN)
    // Other hints show again.
    await type('Make it faster')
    expect(line().textContent).toBe(promptCheckLine([NO_TARGET]))
    // Show brings hidden hints back.
    await type('Make it better')
    fireEvent.click(hide)
    expect(line().textContent).toBe(promptCheckLine(WEAK.hints))
  })

  it('an older core leaves the line as it was', async () => {
    mock.on('task.check', () => {
      throw mockError('UNSUPPORTED')
    })
    await mountComposer()
    await type('Make it better')
    expect(line().textContent).toBe(PROMPT_CHECK_IDLE)
  })
})

describe('Sharpen it', () => {
  it('says what it sends and costs before the click', async () => {
    await mountComposer()
    await type('Make it better')
    const button = screen.getByTestId('composer-sharpen')
    const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toBe(sharpenCostText(HELPER))
    expect(hint?.textContent).toMatch(/It costs less than \$0\.01\./)
    expect(mock.callsOf('task.sharpen')).toHaveLength(0)
  })

  it('opens a panel on the click, fills it when the answer comes, and changes the task only on Use this', async () => {
    const answer = deferred<{ task: string; vendor: string }>()
    mock.on('task.sharpen', () => answer.promise)
    await mountComposer()
    await type('Make it better')
    fireEvent.click(screen.getByTestId('composer-sharpen'))
    await settle()
    const note = screen.getByTestId('composer-sharpen-note')
    const box = screen.getByTestId<HTMLTextAreaElement>('composer-sharpen-text')
    expect(note.textContent).toBe(sharpenWaitingText('claude'))
    expect(note.className).toContain('h-5')
    expect(box.className).toContain('h-28')
    expect(box.value).toBe('')
    expect(screen.getByTestId('composer-sharpen-use')).toHaveProperty('disabled', true)
    answer.resolve({ task: SHARPENED, vendor: 'claude' })
    await settle()
    expect(mock.callsOf('task.sharpen')).toEqual([{ folder: FOLDER, task: 'Make it better' }])
    expect(box.value).toBe(SHARPENED)
    expect(note.textContent).toBe(SHARPEN_READY)
    // The task box is still the person's own words.
    expect(taskBox().value).toBe('Make it better')
    fireEvent.change(box, { target: { value: `${SHARPENED} Thanks.` } })
    fireEvent.click(screen.getByTestId('composer-sharpen-use'))
    await settle()
    expect(taskBox().value).toBe(`${SHARPENED} Thanks.`)
    expect(screen.queryByTestId('composer-sharpen-panel')).toBeNull()
  })

  it('Keep mine closes the panel and leaves the task alone', async () => {
    await mountComposer()
    await type('Make it better')
    fireEvent.click(screen.getByTestId('composer-sharpen'))
    await settle()
    fireEvent.click(screen.getByTestId('composer-sharpen-keep'))
    expect(screen.queryByTestId('composer-sharpen-panel')).toBeNull()
    expect(taskBox().value).toBe('Make it better')
  })

  it('a failed call says why in the panel and leaves the task alone', async () => {
    mock.on('task.sharpen', () => {
      throw mockError(
        'VALIDATION',
        'The answer could not be read. Your task is unchanged, and you can try again.',
      )
    })
    await mountComposer()
    await type('Make it better')
    fireEvent.click(screen.getByTestId('composer-sharpen'))
    await settle()
    const note = screen.getByTestId('composer-sharpen-note')
    expect(note.textContent).toMatch(/could not be read/)
    expect(note.className).toContain('text-destructive')
    expect(screen.getByTestId('composer-sharpen-use')).toHaveProperty('disabled', true)
    expect(taskBox().value).toBe('Make it better')
  })

  it('is off, with the reason, when nobody can answer', async () => {
    mock.on('task.check', () => ({
      hints: [NO_TARGET],
      sharpen: null,
      sharpenReason: 'Sharpen it needs Claude or Codex signed in.',
    }))
    await mountComposer()
    await type('Make it better')
    const button = screen.getByTestId('composer-sharpen')
    expect(button).toHaveProperty('disabled', true)
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Sharpen it needs Claude or Codex signed in.',
    )
  })
})

describe('prompt check words', () => {
  it('the row text for each state', () => {
    const on = { hasFolder: true, blank: false, hidden: false }
    expect(promptCheckRowText(null, { ...on, hasFolder: false })).toBe(PROMPT_CHECK_NO_FOLDER)
    expect(promptCheckRowText(WEAK, { ...on, blank: true })).toBe(PROMPT_CHECK_IDLE)
    expect(promptCheckRowText(null, on)).toBe(PROMPT_CHECK_IDLE)
    expect(promptCheckRowText(CLEAR, on)).toBe(PROMPT_CHECK_CLEAR)
    expect(promptCheckRowText(WEAK, { ...on, hidden: true })).toBe(PROMPT_CHECK_HIDDEN)
    expect(promptCheckRowText(WEAK, on)).toBe(promptCheckLine(WEAK.hints))
  })

  it('the cost line names the vendor and a cost when there is a price, with no em dashes', () => {
    expect(sharpenCostText({ vendor: 'codex', model: null, usd: 0.02 })).toBe(
      'Sends your task to Codex once, on its cheapest model, for a clearer wording. It costs about $0.02. Your task changes only if you use the answer.',
    )
    expect(sharpenCostText({ vendor: 'claude', model: null, usd: null })).not.toMatch(/costs/)
    for (const s of [
      PROMPT_CHECK_CLEAR,
      PROMPT_CHECK_HIDDEN,
      PROMPT_CHECK_IDLE,
      PROMPT_CHECK_NO_FOLDER,
      SHARPEN_NOTHING,
      SHARPEN_READY,
      sharpenCostText(HELPER),
    ]) {
      expect(s).not.toMatch(/[—–]/)
    }
  })
})
