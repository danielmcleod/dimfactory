// Where the diagnosis text sits (nothing moves on its own): the snag card's AI diagnosis sits under core's recovery
// buttons, so an answer that takes more lines than the "on its way" line grows below the buttons and never moves them
// down. The AI's suggested fixes still come after it.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, StepView } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/execute.ts'
import { resetHealForTests } from '@renderer/components/recovery/heal.ts'
import { SnagCard } from '@renderer/components/run/SnagCard.tsx'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, snapWith } from '../run/helpers.tsx'
import {
  closeAction,
  docsAction,
  failedImplement,
  failure,
  heal,
  healAction,
  retryAction,
  snagEvent,
} from '../self-heal/fixtures.ts'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  log = []
  mock = setUp({
    handlers: { 'runs.events': eventsHandler(() => log), 'runs.get': () => snapWith() },
  })
  resetRecoveryForTests()
  resetHealForTests()
  resetCoreClock()
})

afterEach(() => {
  resetRecoveryForTests()
  resetHealForTests()
  resetCoreClock()
  tearDown(mock)
})

/** Whether `a` comes before `b` in the document. */
const before = (a: Element, b: Element): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

function card(view: StepView): ReturnType<typeof render> {
  return render(
    <Providers>
      <SnagCard runId={RUN} view={view} />
    </Providers>,
  )
}

describe('the snag card: the diagnosis under core’s buttons', () => {
  it('on its way and answered, the diagnosis follows every button of core’s row; the AI’s fixes follow it', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction, docsAction, closeAction])]
    const running = heal({ status: 'running', trigger: 'auto', actions: [] }, ['diagnosis', 'confidence'])
    const r = card(failedImplement(f, { heal: running }))
    await settle()
    const buttons = (): Element[] => [
      ...screen.getByTestId('snag-implement').querySelectorAll('button[data-testid^="recovery-"]'),
    ]
    const row = buttons()
    expect(row.length).toBe(4)
    const pending = screen.getByTestId('snag-heal-implement')
    for (const b of row) expect(before(b, pending)).toBe(true)

    // A long answer arrives on its own (with a fix): it is laid out after the buttons, the fix after it.
    const long = heal({
      trigger: 'auto',
      diagnosis: 'The CLI stopped because a flag it was given no longer exists in this release. '
        .repeat(6)
        .trim(),
    })
    r.rerender(
      <Providers>
        <SnagCard runId={RUN} view={failedImplement(f, { heal: long })} />
      </Providers>,
    )
    await settle()
    const answered = screen.getByTestId('snag-heal-implement')
    expect(answered.dataset['status']).toBe('ok')
    for (const b of row) expect(before(b, answered)).toBe(true)
    // The same buttons, the same elements, and nothing of the diagnosis above them.
    expect(buttons().slice(0, row.length)).toEqual(row)
    expect(before(answered, screen.getByTestId('snag-suggestions-implement'))).toBe(true)
  })
})
