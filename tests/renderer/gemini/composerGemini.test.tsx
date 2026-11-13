// Gemini in the Quick composer ("Pass rows": "More" lists vendors whose --version succeeded, not
// installed greyed with the install command; when probes run, the "Gemini ACP" mode row and honest copy, models).
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { planModeText } from '@renderer/components/run/text.ts'
import {
  CHECKING_NOTE,
  modeChoiceNote,
  modeSupportOf,
  vendorChoices,
  versionFound,
} from '@renderer/pages/dashboard/composer/model.ts'
import { probePicked, resetProbePickForTests } from '@renderer/pages/dashboard/composer/probePick.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'
import type { FakeResolveOptions } from '../composer/fixtures.tsx'
import { GEMINI_COPY, GEMINI_INSTALL, GEMINI_MODEL_OPTIONS, gemini } from './fixtures.ts'

let mock: MockDimFactory
let live: PreflightReport

const geminiImplement = (c: ResolvedConfig): void => {
  c.passes.implement.vendor = 'gemini'
  c.passes.fix.vendor = 'gemini'
}

function install(resolve: FakeResolveOptions = {}): void {
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(resolve),
      'preflight.run': () => live,
      'estimates.get': () => runEstimate(),
      'vendors.models': (req) => (req.vendor === 'gemini' ? GEMINI_MODEL_OPTIONS : []),
      'vendors.list': (): ProbeView[] => [],
    },
  })
}

beforeEach(() => {
  resetRecoveryForTests()
  resetProbePickForTests()
  setLiveSupportForTests()
  live = report()
  install()
  upsertProbes([probe('claude', 'ready'), probe('codex', 'ready'), gemini()])
})

afterEach(() => {
  resetProbePickForTests()
  tearDown(mock)
})

function reinstall(resolve: FakeResolveOptions, probes: ProbeView[]): void {
  tearDown(mock)
  install(resolve)
  upsertProbes(probes)
}

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
}

async function openPasses(): Promise<void> {
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
}

async function openRow(pass: string): Promise<void> {
  fireEvent.click(screen.getByTestId(`pass-row-toggle-${pass}`))
  await settle()
}

async function optionsOf(
  testId: string,
): Promise<{ name: string; disabled: boolean; title: string | null }[]> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle()
  const out = screen.getAllByRole('option').map((o) => ({
    name: o.textContent ?? '',
    disabled: o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('data-disabled'),
    title: o.getAttribute('title'),
  }))
  act(() => {
    fireEvent.keyDown(screen.getAllByRole('option')[0] as HTMLElement, { key: 'Escape' })
  })
  await settle()
  return out
}

async function pick(testId: string, option: string | RegExp): Promise<void> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle()
  act(() => {
    fireEvent.keyDown(screen.getByRole('option', { name: option }), { key: 'Enter' })
  })
  await settle()
}

const text = (id: string): string => screen.getByTestId(id).textContent ?? ''

describe('the "More" list', () => {
  it('lists Gemini once its --version succeeded; a missing Gemini greyed with its install command', () => {
    const more = (v: ProbeView) => vendorChoices([probe('claude', 'ready'), v], [], 'claude').slice(2)
    expect(more(gemini())).toEqual([{ id: 'gemini', label: 'Gemini', group: 'more', disabled: false }])
    expect(more(gemini({ state: 'not-installed' }))).toEqual([
      {
        id: 'gemini',
        label: 'Gemini',
        group: 'more',
        disabled: true,
        note: 'Not installed',
        title: GEMINI_INSTALL,
      },
    ])
    // Signed out: listed, choosable, its state beside its name (the checks then offer the sign-in).
    expect(more(gemini({ state: 'login-needed' }))).toEqual([
      { id: 'gemini', label: 'Gemini', group: 'more', disabled: false, note: 'Login needed' },
    ])
    // --version answered but there is no --acp: listed with what it needs ("--version succeeded").
    expect(more(gemini({ state: 'no-acp', version: '0.55.0' }))).toEqual([
      { id: 'gemini', label: 'Gemini', group: 'more', disabled: false, note: 'Update needed' },
    ])
    // Not probed yet: nothing to list.
    expect(more(gemini({ over: { probe: null, health: 'checking' } }))).toEqual([])
    expect(versionFound(gemini())).toBe(true)
    expect(versionFound(gemini({ state: 'not-installed' }))).toBe(false)
  })

  it('shows Gemini under More in the picker, with the install command as the greyed choice’s tooltip', async () => {
    reinstall({}, [probe('claude', 'ready'), probe('codex', 'ready'), gemini({ state: 'not-installed' })])
    await ready()
    await openPasses()
    await openRow('review')
    expect(await optionsOf('pass-vendor-review')).toEqual([
      { name: 'Claude', disabled: false, title: null },
      { name: 'Codex', disabled: false, title: null },
      { name: 'Gemini · Not installed', disabled: true, title: GEMINI_INSTALL },
    ])
  })

  it('picking Gemini probes it, the choice reading Checking… until core answers', async () => {
    const answer = deferred<ProbeView[]>()
    mock.on('vendors.probe', () => answer.promise)
    await ready()
    await openPasses()
    await openRow('review')
    await pick('pass-vendor-review', 'Gemini')
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'gemini' }])
    expect(useStore.getState().probes.byVendor['gemini']?.checking).toBe(true)
    expect(text('pass-vendor-review')).toBe(`Gemini · ${CHECKING_NOTE}`)
    await act(async () => {
      answer.resolve([gemini()])
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(useStore.getState().probes.byVendor['gemini']?.checking).toBe(false)
    expect(text('pass-vendor-review')).toBe('Gemini')
    expect(text('pass-summary-review')).toBe('Review · Gemini · CLI default · Read-only')
  })

  it('picking Claude or Codex probes nothing; an older core without the command changes nothing', async () => {
    await ready()
    await openPasses()
    await openRow('review')
    await pick('pass-vendor-review', 'Codex')
    expect(mock.callsOf('vendors.probe')).toEqual([])
    // vendors.probe is not mocked here: UNSUPPORTED, and the view is left as it was, not checking.
    await probePicked('gemini')
    await settle()
    expect(useStore.getState().probes.byVendor['gemini']?.checking).toBe(false)
    expect(useStore.getState().toasts.items).toEqual([])
  })
})

describe('Gemini pass rows: models and honest mode copy from core', () => {
  beforeEach(() => {
    reinstall({ config: geminiImplement }, [probe('claude', 'ready'), probe('codex', 'ready'), gemini()])
    live = report({
      info: [
        check('pass.plan.native', { title: 'Native plan mode (Claude)', detail: "Claude's own plan mode." }),
        check('pass.implement.mode', { title: 'Implement: autoedit', detail: GEMINI_COPY.autoedit }),
      ],
    })
  })

  it('the passes line has the swap chip’s height before the chip comes (nothing moves when it does)', async () => {
    // Gemini ready seconds after the Dashboard showed brings "Swap Critic to Gemini": the line grew 20 → 24 px and
    // moved the strip and the estimate below it. The line (pending and loaded) holds the chip's h-6 from the start.
    await mountComposer()
    const lineOf = (el: HTMLElement): HTMLElement => el.parentElement as HTMLElement
    const pending = screen.queryByTestId('composer-passes-pending')
    if (pending !== null) expect((pending.firstElementChild as HTMLElement).className).toContain('min-h-6')
    await settle(300)
    expect(lineOf(screen.getByTestId('composer-passes')).className).toContain('min-h-6')
    const swap = screen.queryByTestId('critic-swap')
    if (swap !== null) expect(swap.className).toContain('h-6')
  })

  it('summarizes Implement on Gemini and shows core’s mode copy under Mode', async () => {
    await ready()
    await openPasses()
    expect(text('pass-summary-implement')).toBe('Implement · Gemini · CLI default · Approve edits')
    await openRow('implement')
    const copy = screen.getByTestId('pass-mode-copy-implement')
    expect(copy.textContent).toBe(GEMINI_COPY.autoedit)
    expect(copy.getAttribute('data-support')).toBe('supported')
  })

  it('a Gemini Plan pass reads as Gemini’s own plan mode over ACP (the PassCard chip)', () => {
    expect(planModeText('native', 'gemini')).toBe('Native plan · Gemini ACP')
    expect(planModeText('native', 'gemini', 'Gemini has no plan mode here')).toBe(
      'Fell back to template: Gemini has no plan mode here',
    )
    expect(planModeText('emulated', 'gemini')).toBe('Read-only + plan template')
  })

  it('lists the modes Gemini supports; "Approve everything" only with Auto', async () => {
    await ready()
    await openPasses()
    await openRow('implement')
    expect((await optionsOf('pass-mode-implement')).map((o) => o.name)).toEqual([
      'Read-only',
      'Approve edits',
    ])
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    expect(text('pass-mode-implement')).toBe('Approve everything')
    const view = gemini()
    expect(modeSupportOf(view, 'full')).toEqual({ status: 'supported', copy: GEMINI_COPY.full })
    expect(modeSupportOf(view, 'readonly')).toEqual({ status: 'supported', copy: GEMINI_COPY.readonly })
    expect(modeChoiceNote(view, 'autoedit')).toBe('')
  })

  it('offers Gemini’s models (core’s vendors.models) in the model box, "no pricing" where the catalog has none', async () => {
    await ready()
    await openPasses()
    await openRow('implement')
    const box = screen.getByTestId<HTMLInputElement>('pass-model-implement')
    fireEvent.focus(box)
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'gemini' }])
    const list = document.getElementById(box.getAttribute('list') ?? '')
    const options = [...(list?.querySelectorAll('option') ?? [])].map((o) => [o.value, o.textContent])
    expect(options).toEqual([
      ['auto', 'Auto · default · no pricing'],
      ['gemini-3-pro-preview', 'Gemini 3 Pro Preview'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ])
    fireEvent.change(box, { target: { value: 'gemini-3-pro-preview' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle(300)
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({
      folder: FOLDER,
      overrides: { passes: { implement: { model: 'gemini-3-pro-preview' } } },
    })
    expect(text('pass-summary-implement')).toBe('Implement · Gemini · gemini-3-pro-preview · Approve edits')
  })
})
