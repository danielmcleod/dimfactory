// Codex in the Quick composer ("Pass rows": Claude and Codex first, local presets under "More",
// CLI models, "Approve everything" only with Auto; the mode table and honest copy, Codex sandbox-gated; the Critic
// swap; the Fix row's "Fresh, different vendor"; codex-sandbox.spec.ts "Preflight: Codex Windows sandbox chip clears the block").
// The mode copy under Mode is core's `pass.<p>.mode` detail, coloured by its status; the mode list says what Codex's
// probe reports for each mode; the sandbox chip in the strip runs vendor_setup on its click and the block clears.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetSandboxSetupForTests } from '@renderer/components/recovery/sandboxSetup.ts'
import {
  criticSwapTooltip,
  localChoiceLabel,
  modeChoiceNote,
  modeCopyStatus,
  modeSupportOf,
} from '@renderer/pages/dashboard/composer/model.ts'
import { SANDBOX_ABOVE } from '@renderer/pages/dashboard/composer/PreflightStrip.tsx'
import { forVendor } from '@renderer/pages/dashboard/composer/useVendorModels.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
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
import {
  APP_SERVER_COPY,
  codex,
  CODEX_MODELS,
  ELEVATED_ACTION,
  reprobed,
  SET_UP_MESSAGE,
  SETUP_ACTION,
  sandboxCheck,
  setupOutcome,
  setupResult,
  WIN_SANDBOX_AUTOEDIT_COPY,
  WIN_SANDBOX_READONLY_COPY,
} from './fixtures.ts'

let mock: MockDimFactory
let live: PreflightReport
let listed: ProbeView[]

const PRESET = {
  id: 'qwen',
  label: 'Qwen',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:14b',
}

/** Implement on Codex (the balanced shape), Fix inheriting it; a local preset in the user's settings. */
const codexImplement = (c: ResolvedConfig): void => {
  c.passes.implement.vendor = 'codex'
  c.passes.fix.vendor = 'codex'
  c.local = { presets: [PRESET] }
}

const codexModels: ModelOption[] = [
  ...CODEX_MODELS.map((m) => ({ ...m, hasPricing: true })),
  { id: 'gpt-5-preview', source: 'catalog', hasPricing: false },
]

/** Codex ready to run (its probe passed), its sandbox state as given. */
function codexReady(sandbox: 'ready' | 'notConfigured' = 'ready'): ProbeView {
  const v = codex({ sandbox })
  return v.probe === null ? v : { ...v, probe: { ...v.probe, ok: true } }
}

function install(resolve: FakeResolveOptions = { config: codexImplement }): void {
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(resolve),
      'preflight.run': () => live,
      'estimates.get': () => runEstimate(),
      'vendors.models': (req) => (req.vendor === 'codex' ? codexModels : []),
      'vendors.list': () => listed,
    },
  })
}

beforeEach(() => {
  resetRecoveryForTests()
  resetSandboxSetupForTests()
  setLiveSupportForTests()
  live = report()
  listed = []
  install()
  upsertProbes([probe('claude', 'ready'), codex()])
})

/** Another config for this test (a fresh mock and store), with the vendors as given. */
function reinstall(
  resolve: FakeResolveOptions,
  probes: ProbeView[] = [probe('claude', 'ready'), codex()],
): void {
  tearDown(mock)
  install(resolve)
  upsertProbes(probes)
}

afterEach(() => {
  resetSandboxSetupForTests()
  tearDown(mock)
})

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
}

async function openPasses(): Promise<void> {
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
}

async function openRow(pass: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId(`pass-row-toggle-${pass}`))
  await settle()
  return screen.getByTestId(`pass-row-${pass}`)
}

async function optionsOf(testId: string): Promise<{ name: string; disabled: boolean }[]> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle()
  const out = screen.getAllByRole('option').map((o) => ({
    name: o.textContent ?? '',
    disabled: o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('data-disabled'),
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
  await settle(300)
}

const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const lastResolve = () => mock.callsOf('config.resolve').at(-1)

/**
 * Core's live report while Codex's sandbox is not set up (pass.ts `pass.<p>.mode`, vendor.ts winSandbox). The
 * blocking mode check carries the vendor's own sandbox fixes first (sandbox_unavailable), its copy
 * without the internal reason code.
 */
function sandboxBlocked(): PreflightReport {
  return report({
    blocking: [
      check('pass.implement.mode', {
        status: 'fail',
        category: 'sandbox_unavailable',
        title: 'Codex cannot run Implement in autoedit mode',
        detail: WIN_SANDBOX_AUTOEDIT_COPY,
        recovery: [
          SETUP_ACTION,
          ELEVATED_ACTION,
          {
            id: 'pass.implement.mode.switch',
            label: 'Use Claude for Implement',
            kind: 'switch_vendor',
            pass: 'implement',
            to: 'claude',
            model: null,
          },
        ],
      }),
    ],
    warnings: [{ ...sandboxCheck('notConfigured'), blocking: false }],
  })
}

describe('the sandbox chip in the preflight strip clears the block', () => {
  it('runs vendor_setup from the chip, then the live check passes and Run is enabled', async () => {
    live = sandboxBlocked()
    mock.on('recovery.execute', () => setupResult(setupOutcome(), SET_UP_MESSAGE))
    await ready()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
    await settle()
    expect(screen.getByTestId<HTMLButtonElement>('composer-run').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    // The block's own copy is core's, word for word, and its fix is the sandbox chip.
    const block = screen.getByTestId('preflight-chip-pass.implement.mode')
    expect(block.textContent).toContain('Codex cannot run Implement in autoedit mode')
    const setup = within(block).getByTestId('preflight-sandbox-pass.implement.mode')
    expect(setup.textContent).toBe('Set up the Codex sandbox')
    // One setup control per strip: the sandbox warning points at the chip above.
    const chip = screen.getByTestId('preflight-chip-vendor.codex.winSandbox')
    expect(within(chip).queryByTestId('preflight-sandbox-vendor.codex.winSandbox')).toBeNull()
    expect(within(chip).getByTestId('preflight-sandbox-elsewhere-vendor.codex.winSandbox').textContent).toBe(
      SANDBOX_ABOVE,
    )
    expect(screen.getAllByText('Set up the Codex sandbox')).toHaveLength(1)
    const before = mock.callsOf('preflight.run').length

    listed = [probe('claude', 'ready'), reprobed(codexReady('ready'), 5000)]
    live = report()
    await act(async () => {
      fireEvent.click(setup)
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: SETUP_ACTION.id, folder: FOLDER }])
    // The setup ends with the live checks run again; the block is gone and Run can start.
    expect(mock.callsOf('preflight.run').length).toBeGreaterThan(before)
    expect(screen.queryByTestId('preflight-chip-pass.implement.mode')).toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>('composer-run').disabled).toBe(false)
  })

  it('a chip opened for its details lists the setup first, the elevated command under it, then the other fixes', async () => {
    live = sandboxBlocked()
    await ready()
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    const chip = screen.getByTestId('preflight-chip-pass.implement.mode')
    fireEvent.click(within(chip).getByRole('button', { name: /Show details and fixes/ }))
    await settle()
    // Review: the sandbox procedure's order (vendor_setup, then the elevated shell_copy), never the command above the setup.
    const setup = within(chip).getByTestId('preflight-sandbox-pass.implement.mode')
    const more = within(chip).getByTestId('preflight-sandbox-pass.implement.mode-more')
    const other = within(chip).getByTestId('recovery-pass.implement.mode.switch')
    const before = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(before(setup, more)).toBe(true)
    expect(before(more, other)).toBe(true)
    expect(chip.textContent).not.toContain(ELEVATED_ACTION.command)
    await act(async () => {
      fireEvent.click(more)
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    const elevated = within(chip).getByTestId('preflight-sandbox-pass.implement.mode-elevated')
    expect(elevated.textContent).toContain(ELEVATED_ACTION.command)
    expect(elevated.textContent).toContain('Windows asks you to allow it (a UAC prompt)')
    expect(before(setup, elevated)).toBe(true)
    expect(before(elevated, other)).toBe(true)
    expect(within(chip).queryByTestId(`recovery-${SETUP_ACTION.id}`)).toBeNull()
  })
})

describe('honest mode copy from core', () => {
  it('shows core’s pass.<p>.mode words under Mode, red when the mode is not available', async () => {
    live = sandboxBlocked()
    await ready()
    await openPasses()
    await openRow('implement')
    const copy = screen.getByTestId('pass-mode-copy-implement')
    expect(copy.textContent).toBe(WIN_SANDBOX_AUTOEDIT_COPY)
    expect(copy.getAttribute('data-support')).toBe('unsupported')
    expect(copy.className).toContain('text-destructive')
  })

  it('amber for a limited mode (Review on Codex without its sandbox), plain when supported', async () => {
    reinstall({
      config: (c) => {
        codexImplement(c)
        c.passes.review.vendor = 'codex'
      },
    })
    live = report({
      warnings: [
        check('pass.review.mode', {
          status: 'warn',
          title: 'Review: readonly is limited on Codex',
          detail: WIN_SANDBOX_READONLY_COPY,
        }),
      ],
      info: [
        check('pass.implement.mode', { title: 'Implement: autoedit', detail: APP_SERVER_COPY.autoedit }),
      ],
    })
    await ready()
    await openPasses()
    await openRow('review')
    const review = screen.getByTestId('pass-mode-copy-review')
    expect(review.textContent).toBe(WIN_SANDBOX_READONLY_COPY)
    expect(review.getAttribute('data-support')).toBe('degraded')
    expect(review.className).toContain('text-warning')
    await openRow('implement')
    const impl = screen.getByTestId('pass-mode-copy-implement')
    // Sandbox-gated wording, as core states it for Codex's app-server route.
    expect(impl.textContent).toBe(APP_SERVER_COPY.autoedit)
    expect(impl.textContent).toContain('Sandbox-gated')
    expect(impl.getAttribute('data-support')).toBe('supported')
    expect(impl.className).toContain('text-muted-foreground')
  })

  it('the mode list says what Codex can do here; "Approve everything" is offered only with Auto', async () => {
    await ready()
    await openPasses()
    await openRow('implement')
    expect(await optionsOf('pass-mode-implement')).toEqual([
      { name: 'Read-only · limited', disabled: false },
      // Still choosable: core's preflight then says why and offers the sandbox setup.
      { name: 'Approve edits · not available here', disabled: false },
    ])
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    // Without the sandbox, full is not available either (until the live X11 recording confirms it).
    expect(screen.getByTestId('pass-mode-implement').textContent).toBe(
      'Approve everything · not available here',
    )
    expect(screen.getByTestId<HTMLButtonElement>('pass-mode-implement').disabled).toBe(true)
  })

  it('reads mode support from the probe defensively', () => {
    const view = codex()
    expect(modeSupportOf(view, 'autoedit')).toEqual({
      status: 'unsupported',
      copy: WIN_SANDBOX_AUTOEDIT_COPY,
    })
    expect(modeChoiceNote(view, 'readonly')).toBe('limited')
    expect(modeChoiceNote(codexReady('ready'), 'autoedit')).toBe('')
    expect(modeSupportOf(undefined, 'full')).toBeUndefined()
    const odd = { ...view, probe: view.probe === null ? null : { ...view.probe, capabilities: {} as never } }
    expect(modeSupportOf(odd, 'full')).toBeUndefined()
    expect(modeCopyStatus(null, 'implement')).toBeNull()
    expect(modeCopyStatus(sandboxBlocked(), 'implement')).toBe('unsupported')
  })
})

describe('vendors and models', () => {
  it('lists Codex first beside Claude, and a local preset under More as "Local · <label>"', async () => {
    await ready()
    await openPasses()
    await openRow('review')
    const names = (await optionsOf('pass-vendor-review')).map((o) => o.name)
    // Codex's health is part of its name while its sandbox is not set up.
    expect(names.slice(0, 2)).toEqual(['Claude', 'Codex · Sandbox setup needed'])
    expect(names).toContain(localChoiceLabel('Qwen'))
    expect(localChoiceLabel('Qwen')).toBe('Local · Qwen')
  })

  it('offers Codex’s models (its model/list, merged with the catalog) in the model box', async () => {
    await ready()
    await openPasses()
    await openRow('implement')
    const box = screen.getByTestId<HTMLInputElement>('pass-model-implement')
    fireEvent.focus(box)
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'codex' }])
    const list = document.getElementById(box.getAttribute('list') ?? '')
    const options = [...(list?.querySelectorAll('option') ?? [])].map((o) => [o.value, o.textContent])
    expect(options).toEqual([
      ['gpt-5.1-codex', 'GPT-5.1 Codex · default'],
      ['gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'],
      ['gpt-5-preview', 'no pricing'],
    ])
    fireEvent.change(box, { target: { value: 'gpt-5.1-codex-mini' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle(300)
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { implement: { model: 'gpt-5.1-codex-mini' } } },
    })
  })

  it('a local preset: its model box says the preset’s model is used, and Codex’s probe says what each mode does', async () => {
    reinstall({
      config: (c) => {
        codexImplement(c)
        c.passes.implement.vendor = 'local-qwen'
      },
    })
    await ready()
    await openPasses()
    await openRow('implement')
    expect(screen.getByTestId('pass-vendor-implement').textContent).toBe('Local · Qwen')
    expect(screen.getByTestId<HTMLInputElement>('pass-model-implement').placeholder).toBe(
      'Preset model (qwen2.5-coder:14b)',
    )
    expect((await optionsOf('pass-mode-implement')).map((o) => o.name)).toContain(
      'Approve edits · not available here',
    )
  })

  it('never shows Codex’s own models for a local preset', () => {
    const opts: ModelOption[] = [
      { id: 'gpt-5.1-codex', source: 'cli', hasPricing: true },
      { id: 'qwen2.5-coder:14b', source: 'local-server', hasPricing: true },
    ]
    expect(forVendor('local-qwen', opts).map((o) => o.id)).toEqual(['qwen2.5-coder:14b'])
    expect(forVendor('codex', opts)).toHaveLength(2)
  })
})

describe('Critic swap and the Fix row across vendors', () => {
  it('offers [Swap Critic to Codex] on a Claude-only profile once Codex is ready', async () => {
    reinstall({}, [probe('claude', 'ready'), codexReady('ready')])
    await ready()
    expect(text('critic-swap')).toBe('Swap Critic to Codex')
    fireEvent.focus(screen.getByTestId('critic-swap'))
    await settle(400)
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Critic runs on Claude, like Implement. Another vendor reviews with fresh eyes. This run only.',
    )
    fireEvent.click(screen.getByTestId('critic-swap'))
    await settle(300)
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { critic: { vendor: 'codex', model: null } } },
    })
  })

  it('its tooltip says, in core’s words, when Codex reviews with limits here (no Windows sandbox)', async () => {
    reinstall({}, [probe('claude', 'ready'), codexReady('notConfigured')])
    await ready()
    fireEvent.focus(screen.getByTestId('critic-swap'))
    await settle(400)
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Critic runs on Claude, like Implement. Another vendor reviews with fresh eyes. This run only. ' +
        `Codex here: ${WIN_SANDBOX_READONLY_COPY}`,
    )
    expect(criticSwapTooltip('Claude', 'Codex', codexReady('ready'))).toBe(
      'Critic runs on Claude, like Implement. Another vendor reviews with fresh eyes. This run only.',
    )
  })

  it('Fix on Claude after Codex’s Implement: "Fresh session: Fix vendor differs" and why', async () => {
    reinstall({
      config: (c) => {
        codexImplement(c)
        c.passes.fix.vendor = 'claude'
      },
    })
    await ready()
    await openPasses()
    await openRow('fix')
    expect(text('fix-session-reason-text')).toBe('Fresh session: Fix vendor differs')
    fireEvent.click(screen.getByTestId('fix-session-reason-why-toggle'))
    await settle()
    expect(text('fix-session-reason-why')).toBe(
      'Fix runs on Claude, Implement runs on Codex; a session cannot move between vendors.',
    )
  })

  it('Fix reusing Codex’s Implement reads "Reuse Implement’s session"; Fresh, different vendor names Claude', async () => {
    upsertProbes([probe('claude', 'ready'), codexReady('ready')])
    await ready()
    await openPasses()
    expect(text('pass-summary-fix')).toBe("Fix · Codex · CLI default · Reuse Implement's session")
    await openRow('fix')
    const names = (await optionsOf('fix-session')).map((o) => o.name)
    expect(names).toEqual(["Reuse Implement's session", 'Fresh session', 'Fresh, different vendor (Claude)'])
    await pick('fix-session', 'Fresh, different vendor (Claude)')
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { fix: { reuseSession: false, vendor: 'claude', model: null, effort: null } } },
    })
  })
})
