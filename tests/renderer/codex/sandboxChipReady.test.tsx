// Live stage A (UI standards: nothing moves on its own, async
// content never shifts the page; codex-sandbox.spec.ts): the user's everyday Codex profile already read its Windows sandbox
// ready, and at the default window the setup card showed a disabled [Set up the Codex sandbox] beside a status cut to
// "Codex s…" (about 54 of 250 CSS px left for it). The chip's status now comes first, on a line of its own and one
// height, and a ready sandbox shows that line alone; the line stays the same node in the same place through every
// phase, its icon swapping in one slot, and the chip keeps the height it reached, so running → ready (core's answer
// seconds after the click) moves nothing. Review: while core's first probe runs the chip is its line alone, so a
// sandbox ready at launch leaves no empty room under "Codex sandbox ready". happy-dom lays nothing out: the
// chip's height is stubbed from the rows it holds, and ui-standards.spec.ts' walk measures the ready line in the app (not
// cut at the default and the smallest window).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, RecoveryResult } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { SANDBOX_PHASE_ICON, SandboxChip } from '@renderer/components/recovery/SandboxChip.tsx'
import { resetSandboxSetupForTests } from '@renderer/components/recovery/sandboxSetup.ts'
import { SetupCard } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  codex,
  ELEVATED_ACTION,
  reprobed,
  SET_UP_MESSAGE,
  SETUP_ACTION,
  setupOutcome,
  setupResult,
  vcheck,
} from './fixtures.ts'

let mock: MockDimFactory
let listed: ProbeView[]

const state: AppState = {
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: 0,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
}

// The rows' heights as the app lays them out (Tailwind: the status line h-4, a small button h-7, the disclosure h-6;
// gap-1.5 between rows). An invisible row still takes its room.
const LINE_PX = 16
const BUTTON_PX = 28
const MORE_PX = 24
const ELEVATED_PX = 60
const GAP_PX = 6

function rowHeight(row: Element): number {
  if (row.getAttribute('data-testid')?.endsWith('-line') === true) return LINE_PX
  if (row.querySelector('[data-kind="vendor_setup"]') !== null) return BUTTON_PX
  if (row.querySelector('[data-testid$="-more"]') !== null) return MORE_PX
  return ELEVATED_PX
}

/** The chip's height from the rows it holds now (its min-height, the room it keeps, aside). */
function contentHeight(chip: Element): number {
  const rows = [...chip.children]
  return rows.reduce((h, r) => h + rowHeight(r), 0) + GAP_PX * Math.max(0, rows.length - 1)
}

beforeEach(() => {
  listed = []
  mock = setUp({
    platform: 'win32',
    handlers: {
      'state.get': () => state,
      'config.resolve': () => resolvedView({ profile: 'codex-only' }),
      'vendors.list': () => listed,
      'vendors.probe': () => listed,
    },
  })
  resetRecoveryForTests()
  resetSandboxSetupForTests()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const h = this.getAttribute('data-testid')?.endsWith('-chip') === true ? contentHeight(this) : 0
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetRecoveryForTests()
  resetSandboxSetupForTests()
  tearDown(mock)
})

const claudeLogin = probeView('claude', 'login-needed')
const codexChecking = probeView('codex', 'checking', { displayName: 'Codex', checking: true, probe: null })

const chipOf = (id: string): HTMLElement => screen.getByTestId(`${id}-chip`)
const lineOf = (id: string): HTMLElement => screen.getByTestId(`${id}-line`)
const statusOf = (id: string): HTMLElement => screen.getByTestId(`${id}-status`)
const iconOf = (id: string): string | null =>
  lineOf(id).querySelector('svg')?.getAttribute('data-phase-icon') ?? null

/** The chip's height as laid out: what it holds, or the room it keeps when that is taller. */
function laidOut(id: string): number {
  const chip = chipOf(id)
  const min = Number.parseFloat(chip.style.minHeight)
  return Math.max(contentHeight(chip), Number.isNaN(min) ? 0 : min)
}

async function mountCard(): Promise<void> {
  render(
    <Providers>
      <SetupCard />
    </Providers>,
  )
  await settle()
}

/** The status line is the chip's first row (nothing above it can push it), the status inside it. */
function expectLineFirst(id: string): void {
  const chip = chipOf(id)
  expect(chip.firstElementChild).toBe(lineOf(id))
  expect(lineOf(id).contains(statusOf(id))).toBe(true)
}

describe('the ready sandbox in the setup card', () => {
  it('checking → ready (the sandbox ready at launch): the status line alone, no room held under it', async () => {
    upsertProbes([claudeLogin, codexChecking])
    await mountCard()
    const id = 'setup-codex-sandbox'
    expect(chipOf(id).getAttribute('data-phase')).toBe('unknown')
    expect(statusOf(id).textContent).toBe('Checking Codex…')
    expectLineFirst(id)
    // While core's first probe of Codex runs, the chip is its line alone (no disabled button, no invisible
    // disclosure row): the rows held then stayed 64 px empty under "Codex sandbox ready" for the whole visit.
    expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.queryByTestId(`${id}-more`)).toBeNull()
    expect(chipOf(id).children).toHaveLength(1)
    expect(laidOut(id)).toBe(LINE_PX)
    const status = statusOf(id)
    const line = lineOf(id)
    // One fixed height (text-xs leads 1rem): the rows under it never move up or down.
    expect(line.className).toContain('h-4')

    act(() => upsertProbes([codex({ sandbox: 'ready' })]))
    await settle()
    expect(chipOf(id).getAttribute('data-phase')).toBe('ready')
    // The same status node in the same first line (a new line in another place would be a layout shift, and a new
    // live region would not be announced), at the same height.
    expect(statusOf(id)).toBe(status)
    expect(lineOf(id)).toBe(line)
    expect(line.className).toContain('h-4')
    expectLineFirst(id)
    expect(status.textContent).toBe('Codex sandbox ready')
    expect(status.getAttribute('role')).toBe('status')
    // Nothing to set up and nothing held: the chip is as tall as its line, before and after (no gap, no shift).
    expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.queryByTestId(`${id}-more`)).toBeNull()
    expect(chipOf(id).children).toHaveLength(1)
    expect(laidOut(id)).toBe(LINE_PX)
    expect(chipOf(id).style.minHeight).toBe(`${LINE_PX}px`)
  })

  it('checking → needed (core’s first answer): the rows come under the line, which stays put', async () => {
    upsertProbes([claudeLogin, codexChecking])
    await mountCard()
    const id = 'setup-codex-sandbox'
    const status = statusOf(id)
    const line = lineOf(id)
    expect(laidOut(id)).toBe(LINE_PX)

    act(() => upsertProbes([codex()]))
    await settle()
    expect(chipOf(id).getAttribute('data-phase')).toBe('needed')
    expect(statusOf(id)).toBe(status)
    expect(lineOf(id)).toBe(line)
    expectLineFirst(id)
    expect(status.textContent).toBe('Codex Windows sandbox not set up')
    // The button right under the line, then the disclosure (core offers the elevated command).
    expect(chipOf(id).children.item(1)?.contains(screen.getByTestId(id))).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>(id).disabled).toBe(false)
    expect(screen.getByTestId<HTMLButtonElement>(`${id}-more`).disabled).toBe(false)
    // (The room the chip keeps from here on is the running → ready case below; happy-dom observes no resize.)
    expect(laidOut(id)).toBe(LINE_PX + BUTTON_PX + MORE_PX + 2 * GAP_PX)
  })

  it('running → ready (core’s answer seconds after the click): the button row goes, nothing moves', async () => {
    upsertProbes([claudeLogin, codex()])
    let answer: (r: RecoveryResult) => void = () => undefined
    mock.on('recovery.execute', () => new Promise<RecoveryResult>((res) => (answer = res)))
    await mountCard()
    const id = 'setup-codex-sandbox'
    expect(chipOf(id).getAttribute('data-phase')).toBe('needed')
    expectLineFirst(id)
    const status = statusOf(id)
    const before = laidOut(id)
    expect(before).toBe(LINE_PX + BUTTON_PX + MORE_PX + 2 * GAP_PX)
    // The button is the row right under the line in every phase it shows in.
    const buttonRow = (): Element | null => chipOf(id).children.item(1)
    expect(buttonRow()?.contains(screen.getByTestId(id))).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId(id))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(chipOf(id).getAttribute('data-phase')).toBe('running')
    expect(statusOf(id)).toBe(status)
    expect(buttonRow()?.contains(screen.getByTestId(id))).toBe(true)
    expect(laidOut(id)).toBe(before)

    listed = [claudeLogin, reprobed(codex({ sandbox: 'ready' }), 20_000)]
    await act(async () => {
      answer(setupResult(setupOutcome(), SET_UP_MESSAGE))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(chipOf(id).getAttribute('data-phase')).toBe('ready')
    expect(statusOf(id)).toBe(status)
    expectLineFirst(id)
    expect(status.textContent).toBe('Codex sandbox ready')
    expect(screen.queryByTestId(id)).toBeNull()
    expect(laidOut(id)).toBe(before)
  })

  it('the ready line has the chip’s whole width: no control beside it, cut only past that (whole in its title)', async () => {
    upsertProbes([claudeLogin, codex({ sandbox: 'ready' })])
    await mountCard()
    const id = 'setup-codex-sandbox'
    const line = lineOf(id)
    // At the default window the card leaves about 250 CSS px for the chip; "Codex sandbox ready" (text-xs) needs
    // about 120 px with its icon. Beside the button it had 54 px (stage A). Measured in the app by ui-standards.spec.ts.
    expect(chipOf(id).children).toHaveLength(1)
    expect(line.querySelectorAll('button, [data-disabled-hint]')).toHaveLength(0)
    expect([...line.children].map((c) => c.tagName.toLowerCase())).toEqual(['svg', 'p'])
    expect(statusOf(id).className).toContain('flex-1')
    expect(statusOf(id).getAttribute('title')).toBe('Codex sandbox ready')
    expect(line.className).toContain('text-success')
    expect(iconOf(id)).toBe('ready')
  })
})

describe('one status line in every phase (the strip’s and Settings’ chips are the same control)', () => {
  it('the icon swaps in its one slot, the words follow the phase', async () => {
    upsertProbes([codex()])
    let answer: (r: RecoveryResult) => void = () => undefined
    mock.on('recovery.execute', () => new Promise<RecoveryResult>((res) => (answer = res)))
    render(
      <Providers>
        <SandboxChip testId="v" />
      </Providers>,
    )
    await settle()
    expect(iconOf('v')).toBe('needed')
    expect([...lineOf('v').children].map((c) => c.tagName.toLowerCase())).toEqual(['svg', 'p'])
    await act(async () => {
      fireEvent.click(screen.getByTestId('v'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(iconOf('v')).toBe('running')
    expect(statusOf('v').textContent).toBe('Setting up the Codex sandbox… 0:00')
    listed = [reprobed(codex({ sandbox: 'ready' }), 20_000)]
    await act(async () => {
      answer(setupResult(setupOutcome(), SET_UP_MESSAGE))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(iconOf('v')).toBe('ready')
    expect([...lineOf('v').children].map((c) => c.tagName.toLowerCase())).toEqual(['svg', 'p'])
    expect(Object.keys(SANDBOX_PHASE_ICON).sort()).toEqual(
      ['failed', 'needed', 'ready', 'running', 'unavailable', 'unknown'].sort(),
    )
  })

  it('the strip’s chip says how the sandbox is (not its block’s title again), and once ready only that', async () => {
    // As the preflight strip offers it: core's pass.implement.mode block carries the sandbox's fixes.
    const block: CheckResult = vcheck('x', {
      id: 'pass.implement.mode',
      scope: 'pass',
      status: 'fail',
      blocking: true,
      category: 'sandbox_unavailable',
      title: 'Codex cannot run Implement in autoedit mode',
      recovery: [SETUP_ACTION, ELEVATED_ACTION],
    })
    upsertProbes([codex()])
    mock.on('recovery.execute', () => setupResult(setupOutcome(), SET_UP_MESSAGE))
    listed = [reprobed(codex({ sandbox: 'ready' }), 20_000)]
    render(
      <Providers>
        <SandboxChip testId="s" check={block} ctx={{ folder: 'C:\\work\\repo' }} />
      </Providers>,
    )
    await settle()
    expect(chipOf('s').getAttribute('data-phase')).toBe('needed')
    expect(statusOf('s').textContent).toBe('Codex Windows sandbox not set up')
    const status = statusOf('s')
    await act(async () => {
      fireEvent.click(screen.getByTestId('s'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(chipOf('s').getAttribute('data-phase')).toBe('ready')
    expect(statusOf('s')).toBe(status)
    expect(status.textContent).toBe('Codex sandbox ready')
    expect(screen.queryByTestId('s')).toBeNull()
    expect(screen.queryByTestId('s-more')).toBeNull()
  })
})
