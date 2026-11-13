// The Snag card (self-heal): category title and core's message, the AI
// diagnosis line once there is one ("Diagnosis (AI, medium confidence): …"), core's recovery buttons in its order with
// "Ask AI to diagnose" primary only for `unknown` (secondary otherwise, none where core never asks the AI), the AI's
// suggested fixes after core's (the first of them primary), [Close run] while the run is failed, the raw error
// disclosure, and every heal state: on its way (the button keeps its label, the spinner takes its icon slot), done,
// reused, failed (raw error + docs link), turned off (link to Settings) and "Dim Factory hid N unsafe suggestions".
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealView, RecoveryAction } from '@shared/failure.ts'
import type { RecoveryResult } from '@shared/ipc.ts'
import type { RunEnvelope, StepView } from '@shared/run.ts'
import { APPLY_RUN_LABEL } from '@renderer/components/recovery/ConfigPatchControl.tsx'
import { resetRecoveryForTests } from '@renderer/components/recovery/execute.ts'
import {
  HEAL_DISABLED_TEXT,
  HEAL_FAILED_TEXT,
  HEAL_LABEL,
  HEAL_RUNNING_TEXT,
  HEAL_WAIT_MS,
  resetHealForTests,
} from '@renderer/components/recovery/heal.ts'
import { OPEN_SELF_HEAL_LABEL } from '@renderer/components/recovery/HealDiagnosis.tsx'
import { SnagCard, SUGGESTED_BY_AI } from '@renderer/components/run/SnagCard.tsx'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, snapWith } from '../run/helpers.tsx'
import {
  T0,
  closeAction,
  docsAction,
  failedImplement,
  failure,
  flagPatch,
  flagPatchSave,
  heal,
  healAction,
  loginAction,
  retryAction,
  snagEvent,
  switchCodex,
  waitAction,
} from './fixtures.ts'

const EM_DASH = '\u2014'
let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  log = []
  mock = setUp({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
      'runs.close': () => undefined,
      'runs.retryPass': () => undefined,
    },
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

function card(view: StepView): ReturnType<typeof render> {
  return render(
    <Providers>
      <SnagCard runId={RUN} view={view} />
    </Providers>,
  )
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const button = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)
/** The card's buttons in reading order, by test id. */
const order = (): string[] =>
  [...screen.getByTestId('snag-implement').querySelectorAll('button[data-testid^="recovery-"]')].map(
    (b) => b.getAttribute('data-testid') ?? '',
  )
const primary = (): string[] =>
  [...screen.getByTestId('snag-implement').querySelectorAll('button.bg-primary')].map(
    (b) => b.getAttribute('data-testid') ?? '',
  )

describe('layout and order', () => {
  it('unknown: title, message, Ask AI first and primary, core’s order kept, raw error in a disclosure', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction, docsAction, closeAction])]
    card(failedImplement(f))
    await settle()
    const snag = screen.getByTestId('snag-implement')
    expect(snag.dataset['category']).toBe('unknown')
    expect(snag.textContent).toContain('Something went wrong')
    expect(snag.textContent).toContain('Claude exited with code 3')
    expect(order()).toEqual([
      'recovery-implement.heal',
      'recovery-implement:retry',
      'recovery-implement.docs',
      'recovery-run:close',
    ])
    expect(button('recovery-implement.heal').textContent).toBe(HEAL_LABEL)
    expect(primary()).toEqual(['recovery-implement.heal'])
    const raw = snag.querySelector('details')
    expect(raw?.querySelector('summary')?.textContent).toBe('Raw error')
    expect(raw?.querySelector('pre')?.textContent).toContain('unexpected token in frame 12')
    expect(raw?.querySelector('pre')?.getAttribute('data-scroll-region')).toBe('snag-output')
    expect(snag.textContent).not.toContain(EM_DASH)
  })

  it('a known category offers Ask AI as a secondary button (heal.diagnose), before Close run', async () => {
    mock.on('heal.diagnose', () => undefined)
    const f = failure({ category: 'auth_expired', message: 'OAuth token has expired', classifiedBy: 'regex' })
    log = [snagEvent(f, [loginAction, switchCodex, closeAction])]
    card(failedImplement(f))
    await settle()
    expect(screen.getByTestId('snag-implement').textContent).toContain('Claude login expired')
    expect(order()).toEqual([
      'recovery-implement.login',
      'recovery-implement.switch',
      'recovery-implement:heal',
      'recovery-run:close',
    ])
    expect(primary()).toEqual(['recovery-implement.login'])
    await click(button('recovery-implement:heal'))
    expect(mock.callsOf('heal.diagnose')).toEqual([{ runId: RUN, step: 'implement' }])
    expect(mock.callsOf('recovery.execute')).toEqual([])
  })

  it('flag_drift: core lists its heal first (the failure table), so it leads until a diagnosis shows', async () => {
    const f = failure({ category: 'flag_drift', message: "unknown option '--x'", classifiedBy: 'regex' })
    const findFlag: RecoveryAction = { id: 'implement:heal', label: 'Find the renamed flag', kind: 'heal' }
    log = [snagEvent(f, [findFlag, loginAction, retryAction, closeAction])]
    card(failedImplement(f))
    await settle()
    expect(order()).toEqual([
      'recovery-implement:heal',
      'recovery-implement.login',
      'recovery-implement:retry',
      'recovery-run:close',
    ])
    expect(button('recovery-implement:heal').textContent).toBe('Find the renamed flag')
    expect(primary()).toEqual(['recovery-implement:heal'])
  })

  it('a failed runner step (preflight, prepare) keeps core’s list: no Ask AI, which core would refuse', async () => {
    mock.on('heal.diagnose', () => undefined)
    const f = failure({
      category: 'auth_required',
      message: 'Not logged in',
      classifiedBy: 'regex',
      step: 'preflight',
    })
    const preflight: StepView = { ...failedImplement(f), key: 'preflight' }
    // R2b: no snag event at all.
    card(preflight)
    await settle()
    const snag = screen.getByTestId('snag-preflight')
    expect(snag.querySelectorAll('button[data-testid^="recovery-"]')).toHaveLength(0)
    expect(snag.textContent).toContain('Core recorded no recovery options for this failure.')
    expect(mock.callsOf('heal.diagnose')).toEqual([])
  })

  it('a category core never asks the AI about has no Ask AI button', async () => {
    const f = failure({ category: 'content_policy', message: 'Refused', classifiedBy: 'structured' })
    log = [snagEvent(f, [switchCodex, closeAction])]
    card(failedImplement(f))
    await settle()
    expect(order()).toEqual(['recovery-implement.switch', 'recovery-run:close'])
  })

  it('adds Close run while the run is failed and core listed none', async () => {
    const f = failure({ category: 'network', message: 'ECONNRESET', classifiedBy: 'errno' })
    log = [snagEvent(f, [retryAction])]
    act(() => {
      applySnapshot(snapWith({ summary: { status: 'failed' }, steps: { implement: failedImplement(f) } }))
    })
    card(failedImplement(f))
    await settle()
    expect(order().at(-1)).toBe('recovery-run:close')
    await click(button('recovery-run:close'))
    expect(mock.callsOf('runs.close')).toEqual([{ runId: RUN }])
    expect(mock.callsOf('recovery.execute')).toEqual([])
  })

  it('shows core’s wait (disarmed after a relaunch) in the snag', async () => {
    const f = failure({ category: 'rate_limited', message: '429', classifiedBy: 'structured' })
    const wait = {
      actionId: 'implement.wait',
      until: T0 + 60_000,
      armed: false,
      disarmed: 'relaunch' as const,
    }
    log = [snagEvent(f, [waitAction(), switchCodex])]
    card(failedImplement(f, { wait }))
    await settle()
    expect(screen.getByTestId('wait-implement.wait').dataset['disarmed']).toBe('relaunch')
    expect(button('recovery-implement.wait').textContent).toBe('Re-arm')
    expect(button('wait-retry-implement.wait').textContent).toBe('Retry now')
  })
})

describe('heal states', () => {
  it('on its way: the button keeps its label and width, one line says what is happening, nothing else moves', async () => {
    const hold = deferred<RecoveryResult>()
    mock.on('recovery.execute', () => hold.promise)
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction, closeAction])]
    const r = card(failedImplement(f))
    await settle()
    const ask = button('recovery-implement.heal')
    const before = order()
    await click(ask)
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'implement.heal', runId: RUN }])
    expect(ask.textContent).toBe(HEAL_LABEL)
    expect(ask.getAttribute('aria-busy')).toBe('true')
    expect(ask.disabled).toBe(true)
    expect(ask.querySelector('[data-spinner]')).not.toBeNull()
    expect(screen.getByTestId('snag-heal-implement').dataset['status']).toBe('running')
    expect(screen.getByTestId('snag-heal-implement-text').textContent).toBe(HEAL_RUNNING_TEXT)
    expect(order()).toEqual(before)
    await act(async () => {
      hold.resolve({ kind: 'heal', message: 'Diagnosing.' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    // Core has not reported yet: still on its way.
    expect(screen.getByTestId('snag-heal-implement').dataset['status']).toBe('running')
    // Core reports it runs, then its answer.
    r.rerender(
      <Providers>
        <SnagCard runId={RUN} view={failedImplement(f, { heal: heal({ status: 'running', actions: [] }) })} />
      </Providers>,
    )
    expect(screen.getByTestId('snag-heal-implement').dataset['status']).toBe('running')
    r.rerender(
      <Providers>
        <SnagCard runId={RUN} view={failedImplement(f, { heal: heal({ at: T0 + 30_000 }) })} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('snag-heal-implement').dataset['status']).toBe('ok')
    expect(button('recovery-implement.heal').getAttribute('aria-busy')).toBeNull()
  })

  it('a request core never answers stops showing as on its way after the healer’s time', async () => {
    mock.on('heal.diagnose', () => undefined)
    const f = failure({ category: 'process_crash', message: 'Crashed', classifiedBy: 'exit' })
    log = [snagEvent(f, [retryAction])]
    card(failedImplement(f))
    await settle()
    await click(button('recovery-implement:heal'))
    expect(screen.getByTestId('snag-heal-implement').dataset['status']).toBe('running')
    await settle(HEAL_WAIT_MS + 1000)
    expect(screen.queryByTestId('snag-heal-implement')).toBeNull()
    expect(button('recovery-implement:heal').disabled).toBe(false)
  })

  it('done: the diagnosis line, the AI’s fixes after core’s (first one primary), hidden suggestions', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'config_patch',
      message: 'Applied. Retrying Implement.',
    }))
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction, docsAction, closeAction])]
    card(failedImplement(f, { heal: heal({ hidden: 1 }) }))
    await settle()
    expect(screen.getByTestId('snag-heal-implement-text').textContent).toBe(
      'Diagnosis (AI, medium confidence): The CLI renamed --output-format to --format in 2.4.',
    )
    expect(screen.getByTestId('snag-heal-implement-hidden').textContent).toBe(
      'Dim Factory hid 1 unsafe suggestion',
    )
    const suggestions = screen.getByRole('group', { name: SUGGESTED_BY_AI })
    expect(within(suggestions).getByTestId('patch-heal.flagmap')).toBeTruthy()
    // After a diagnosis every button keeps its place (Ask AI only turns secondary) and the AI's fixes come after
    // core's row, Close run included; the AI's first fix is the primary.
    expect(order()).toEqual([
      'recovery-implement.heal',
      'recovery-implement:retry',
      'recovery-implement.docs',
      'recovery-run:close',
      'recovery-heal.flagmap',
      'recovery-heal.flagmap.save',
    ])
    expect(primary()).toEqual(['recovery-heal.flagmap'])
    expect(button('recovery-heal.flagmap').textContent).toBe(APPLY_RUN_LABEL)
    await click(button('recovery-heal.flagmap'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'heal.flagmap', runId: RUN }])
  })

  it('reused from the cache, and what autoApplyConfigPatches did', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction])]
    card(
      failedImplement(f, {
        heal: heal({ status: 'cached', confidence: 'high', autoApplied: flagPatch.id, trigger: 'auto' }),
      }),
    )
    await settle()
    expect(screen.getByTestId('snag-heal-implement-text').textContent).toBe(
      'Diagnosis (AI, high confidence, from an earlier diagnosis): The CLI renamed --output-format to --format in 2.4.',
    )
    expect(screen.getByTestId('snag-heal-implement-applied').textContent).toBe(
      'Dim Factory applied "Map --output-format to --format" on its own and retried the pass.',
    )
  })

  it('low confidence with nothing to apply says so', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction])]
    card(
      failedImplement(f, {
        heal: heal({ confidence: 'low', diagnosis: 'Not enough evidence.', actions: [] }),
      }),
    )
    await settle()
    expect(screen.getByTestId('snag-heal-implement').textContent).toContain(
      'The AI suggested nothing Dim Factory can apply.',
    )
    // No AI fixes: every button stays where it was; Ask AI turns secondary and core's first fix is the primary.
    expect(order()).toEqual(['recovery-implement.heal', 'recovery-implement:retry'])
    expect(primary()).toEqual(['recovery-implement:retry'])
  })

  it('an answer that arrives on its own moves no button: the order before equals the order after', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction, docsAction, closeAction])]
    const running = heal({ status: 'running', trigger: 'auto', actions: [] }, ['diagnosis', 'confidence'])
    const r = card(failedImplement(f, { heal: running }))
    await settle()
    const before = order()
    expect(before).toEqual([
      'recovery-implement.heal',
      'recovery-implement:retry',
      'recovery-implement.docs',
      'recovery-run:close',
    ])
    const rects = before.map((id) => button(id))
    for (const answer of [
      heal({ trigger: 'auto', at: T0 + 30_000 }),
      heal({ trigger: 'auto', confidence: 'low', actions: [] }),
      heal({ trigger: 'auto', status: 'failed', error: 'timed out', actions: [docsAction] }, ['diagnosis']),
    ]) {
      r.rerender(
        <Providers>
          <SnagCard runId={RUN} view={failedImplement(f, { heal: answer })} />
        </Providers>,
      )
      await settle()
      // Only the AI's fixes are added, after everything that was already there; the same elements stay.
      expect(order().slice(0, before.length)).toEqual(before)
      before.forEach((id, i) => expect(button(id)).toBe(rects[i]))
    }
  })

  it('failed: the healer’s raw error and the vendor’s docs link', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction])]
    const failed: HealView = heal(
      { status: 'failed', error: 'claude exited with code 1: Not logged in', actions: [docsAction] },
      ['diagnosis', 'confidence'],
    )
    card(failedImplement(f, { heal: failed }))
    await settle()
    expect(screen.getByTestId('snag-heal-implement-text').textContent).toBe(HEAL_FAILED_TEXT)
    expect(screen.getByTestId('snag-heal-implement-error').textContent).toBe(
      'claude exited with code 1: Not logged in',
    )
    expect(within(screen.getByRole('group', { name: SUGGESTED_BY_AI })).getByText('Claude docs')).toBeTruthy()
    // Ask again stays the primary for unknown while there is no diagnosis.
    expect(primary()[0]).toBe('recovery-implement.heal')
  })

  it('turned off: says so and links to Settings → Self-heal', async () => {
    const f = failure()
    log = [snagEvent(f, [healAction, retryAction])]
    card(failedImplement(f, { heal: heal({ status: 'disabled', actions: [] }, ['diagnosis']) }))
    await settle()
    expect(screen.getByTestId('snag-heal-implement-text').textContent).toBe(HEAL_DISABLED_TEXT)
    await click(screen.getByRole('button', { name: OPEN_SELF_HEAL_LABEL }))
    expect(window.location.hash).toBe('#/settings/self-heal')
  })

  it('a heal suggestion pair keeps its apply and save buttons in one block', async () => {
    const f = failure({
      category: 'flag_drift',
      message: 'unknown option --output-format',
      classifiedBy: 'regex',
    })
    const findFlag: RecoveryAction = {
      id: 'implement.findflag',
      label: 'Find the renamed flag',
      kind: 'heal',
    }
    log = [snagEvent(f, [findFlag, loginAction])]
    card(failedImplement(f, { heal: heal({ actions: [flagPatch, flagPatchSave] }) }))
    await settle()
    // flag_drift: core's specific label stays, and it is not primary.
    expect(button('recovery-implement.findflag').textContent).toBe('Find the renamed flag')
    expect(screen.getAllByTestId(/^patch-heal\.flagmap$/)).toHaveLength(1)
    expect(button('recovery-heal.flagmap.save').textContent).toBe('Apply and save to user')
  })
})
