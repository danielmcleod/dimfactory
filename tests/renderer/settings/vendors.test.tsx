// Settings → Vendors, full: the executable path (save with Undo,
// core's validation message, auto-detect, candidates), version against floor / recommended / tested-up-to with core's
// warning, the default model (vendors.models → config.patch on the user file, with Undo), Test (= forced probe),
// every check with its fixes, the install command, later-version controls, and deep links that focus a field. The
// local models are live (tests/renderer/codex).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigReadResult } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { useRoute } from '@renderer/lib/router.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { vendorTarget } from '@renderer/pages/settings/vendors/deepLink.ts'
import { vendorSettingsOf } from '@renderer/pages/settings/vendors/userConfig.ts'
import { bumpConfigEpoch, upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory
let userValue: unknown
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

function readResult(value: unknown): ConfigReadResult {
  return {
    path: 'C:\\home\\dimfactory.json',
    exists: true,
    text: '{}',
    value,
    issues: [],
    version: 1,
    backups: [],
  }
}

beforeEach(() => {
  userValue = {}
  mock = setUp({
    handlers: {
      'config.read': () => readResult(userValue),
      'config.patch': () => ({ path: 'C:\\home\\dimfactory.json', changed: true, diff: '', backupId: 'b1' }),
    },
  })
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

function check(id: string, over: Partial<CheckResult> = {}): CheckResult {
  return {
    id: `vendor.claude.${id}`,
    scope: 'vendor',
    status: 'pass',
    blocking: true,
    title: id,
    detail: '',
    recovery: [],
    at: NOW,
    ttlMs: 0,
    ...over,
  }
}

function claude(
  over: Partial<ProbeView> = {},
  checks: CheckResult[] = [check('bin', { title: 'Claude Code found' })],
): ProbeView {
  return probeView('claude', 'ready', {
    displayName: 'Claude',
    healthDetail: 'Ready · 2.1.288',
    versionFloor: '2.1.281',
    versionRecommended: '2.1.287',
    testedUpTo: '2.1.289',
    candidates: ['C:\\tools\\claude.exe', 'C:\\Users\\me\\.local\\bin\\claude.exe'],
    probe: {
      vendor: 'claude',
      at: NOW,
      ok: true,
      route: 'stdio',
      transport: 'claude-stdio',
      version: '2.1.288',
      binary: {
        path: 'C:\\tools\\claude.exe',
        command: 'C:\\tools\\claude.exe',
        argvPrefix: [],
        kind: 'native',
        source: 'path',
        mtimeMs: 0,
        size: 0,
        pathPrepend: [],
        warnings: [],
      },
      checks,
      capabilities: {} as never,
      models: [
        { id: 'opus', source: 'cli', isDefault: true },
        { id: 'sonnet', source: 'cli' },
      ],
    },
    ...over,
  })
}

function Routed(): React.JSX.Element | null {
  const r = useRoute()
  if (r.name !== 'settings') return null
  return r.section !== undefined ? <SettingsPage section={r.section} /> : <SettingsPage />
}

async function mount(hash = '#/settings/vendors'): Promise<void> {
  window.location.hash = hash
  render(
    <Providers>
      <Routed />
    </Providers>,
  )
  await settle()
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const card = (): HTMLElement => screen.getByTestId('settings-vendor-claude')
const pathInput = (): HTMLInputElement => screen.getByTestId<HTMLInputElement>('vendor-path-claude')
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('executable path', () => {
  it('saves a typed path through vendors.setPath, stores the re-probed view, and offers Undo', async () => {
    upsertProbes([claude()])
    mock.on('vendors.setPath', (req) =>
      claude({ healthDetail: req.path === null ? 'Ready · 2.1.288' : 'Ready · 2.1.289' }),
    )
    await mount()
    expect(card().textContent).toContain('In use: C:\\tools\\claude.exe (from PATH)')
    const save = screen.getByTestId<HTMLButtonElement>('vendor-path-save-claude')
    expect(save.disabled).toBe(true)
    fireEvent.change(pathInput(), { target: { value: '  D:\\cli\\claude.exe ' } })
    expect(save.disabled).toBe(false)
    await click(save)
    expect(mock.callsOf('vendors.setPath')).toEqual([{ vendor: 'claude', path: 'D:\\cli\\claude.exe' }])
    expect(useStore.getState().probes.byVendor['claude']?.healthDetail).toBe('Ready · 2.1.289')
    expect(toasts()).toContain('Claude path saved')
    // Saving re-reads the user file.
    expect(mock.callsOf('config.read').length).toBeGreaterThanOrEqual(2)
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('vendors.setPath')).toEqual([
      { vendor: 'claude', path: 'D:\\cli\\claude.exe' },
      { vendor: 'claude', path: null },
    ])
  })

  it("shows core's validation message under the field and keeps what was typed", async () => {
    upsertProbes([claude()])
    mock.on('vendors.setPath', () => {
      throw mockError('VALIDATION', 'C:\\nope.exe is not a Claude Code executable.')
    })
    await mount()
    fireEvent.change(pathInput(), { target: { value: 'C:\\nope.exe' } })
    await act(async () => {
      fireEvent.keyDown(pathInput(), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    const alert = within(card()).getByRole('alert')
    expect(alert.textContent).toBe('C:\\nope.exe is not a Claude Code executable.')
    expect(pathInput().getAttribute('aria-invalid')).toBe('true')
    expect(pathInput().getAttribute('aria-describedby')).toBe(alert.id)
    expect(pathInput().value).toBe('C:\\nope.exe')
    fireEvent.change(pathInput(), { target: { value: 'C:\\other.exe' } })
    expect(within(card()).queryByRole('alert')).toBeNull()
  })

  it('auto-detects again with path null, and starts from the configured path', async () => {
    userValue = { vendors: { claude: { path: 'D:\\cli\\claude.exe' } } }
    upsertProbes([claude()])
    mock.on('vendors.setPath', () => claude())
    await mount()
    expect(pathInput().value).toBe('D:\\cli\\claude.exe')
    await click(screen.getByTestId('vendor-autodetect-claude'))
    expect(mock.callsOf('vendors.setPath')).toEqual([{ vendor: 'claude', path: null }])
    expect(toasts()).toContain('Claude is found automatically again')
    expect(pathInput().value).toBe('')
  })

  it('fills the field from a candidate the resolver found', async () => {
    upsertProbes([claude()])
    await mount()
    const found = within(card()).getByRole('list', { name: 'Claude executables found' })
    expect(within(found).getAllByRole('listitem')[0]?.textContent).toContain('in use')
    fireEvent.click(within(found).getByRole('button', { name: 'Use C:\\Users\\me\\.local\\bin\\claude.exe' }))
    expect(pathInput().value).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
  })
})

describe('default model', () => {
  const options: ModelOption[] = [
    { id: 'opus', source: 'cli', isDefault: true, hasPricing: true },
    { id: 'sonnet', source: 'cli', hasPricing: true },
    { id: 'haiku-next', source: 'catalog', hasPricing: false },
  ]

  async function pick(name: string): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('vendor-default-model-claude'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
  }

  it('lists vendors.models with "no pricing", writes the user file, and undoes it', async () => {
    mock.on('vendors.models', () => options)
    upsertProbes([claude()])
    await mount()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    expect(screen.getByTestId('vendor-default-model-claude').textContent).toContain(
      "The CLI's default (opus)",
    )
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('vendor-default-model-claude'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole('option', { name: 'haiku-next · no pricing' })).toBeTruthy()
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'sonnet' }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/vendors/claude/defaultModel', value: 'sonnet' }] },
    ])
    expect(toasts()).toContain('Claude default model: sonnet')
    expect(screen.getByTestId('vendor-default-model-claude').textContent).toContain('sonnet')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'remove', path: '/vendors/claude/defaultModel' }],
    })
  })

  it("shows the user's setting, falls back to the probe's models, and returns to the CLI default", async () => {
    userValue = { vendors: { claude: { defaultModel: 'sonnet' } } }
    upsertProbes([claude()])
    await mount()
    expect(screen.getByTestId('vendor-default-model-claude').textContent).toContain('sonnet')
    await pick("The CLI's default (opus)")
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'remove', path: '/vendors/claude/defaultModel' }] },
    ])
    expect(toasts()).toContain("Claude uses the CLI's default model")
  })

  it("keeps the old choice and shows core's message when the write fails", async () => {
    mock.on('config.patch', () => {
      throw mockError('CONFLICT', 'dimfactory.json changed on disk.')
    })
    upsertProbes([claude()])
    await mount()
    await pick('sonnet')
    expect(toasts()).toContain('dimfactory.json changed on disk.')
    expect(screen.getByTestId('vendor-default-model-claude').textContent).toContain("The CLI's default")
  })

  it('reads the user file again after a config change', async () => {
    upsertProbes([claude()])
    await mount()
    expect(mock.callsOf('config.read')).toEqual([{ scope: 'user' }])
    userValue = { vendors: { claude: { defaultModel: 'opus' } } }
    act(() => bumpConfigEpoch())
    await settle()
    expect(mock.callsOf('config.read')).toHaveLength(2)
    expect(screen.getByTestId('vendor-default-model-claude').textContent).toContain('opus')
  })
})

describe('version, checks, Test', () => {
  it("shows the version against floor / recommended / tested-up-to with core's warning", async () => {
    upsertProbes([
      claude({ health: 'warning', healthDetail: 'Claude Code 2.1.290 is newer than tested (2.1.289)' }, [
        check('version', {
          status: 'warn',
          blocking: false,
          title: 'Claude Code 2.1.290 is newer than tested (2.1.289)',
          detail: 'If a flag fails, apply the suggested flagMap patch or install 2.1.289.',
          recovery: [
            {
              id: 'claude.pin',
              label: 'Copy the install command for 2.1.289',
              kind: 'shell_copy',
              command: 'npm install -g @anthropic-ai/claude-code@2.1.289',
              shell: 'powershell',
              reason: 'Install the tested version',
              recheck: 'vendor.claude.version',
            },
          ],
        }),
      ]),
    ])
    await mount()
    expect(card().textContent).toContain(
      '2.1.288 · at least 2.1.281 · recommended 2.1.287 · tested up to 2.1.289',
    )
    expect(screen.getByTestId('vendor-version-note-claude').textContent).toBe(
      'Claude Code 2.1.290 is newer than tested (2.1.289)',
    )
    const versionCheck = screen.getByTestId('vendor-check-vendor.claude.version')
    expect(within(versionCheck).getByRole('img', { name: 'Warning' })).toBeTruthy()
    expect(within(versionCheck).getByTestId('recovery-claude.pin').textContent).toBe(
      'Copy the install command for 2.1.289',
    )
  })

  it('lists a failing check with its fixes, and the install command', async () => {
    mock.on('recovery.execute', () => ({
      kind: 'shell_copy' as const,
      copied: 'irm https://claude.ai/install.ps1 | iex',
    }))
    mock.on('vendors.probe', () => [claude()])
    upsertProbes([
      claude({ health: 'not-installed', healthDetail: 'Not installed', candidates: [] }, [
        check('bin', {
          status: 'fail',
          title: 'Claude Code is not installed',
          detail: 'No Claude Code CLI was found on this computer.',
          category: 'cli_missing',
          recovery: [
            {
              id: 'claude.install',
              label: 'Copy the install command',
              kind: 'shell_copy',
              command: 'irm https://claude.ai/install.ps1 | iex',
              shell: 'powershell',
              reason: 'Claude Code is not installed',
              recheck: 'vendor.claude.bin',
            },
            {
              id: 'claude.switch-vendor',
              label: 'Use Codex instead',
              kind: 'switch_vendor',
              pass: 'all',
              to: 'codex',
              model: null,
            },
          ],
        }),
      ]),
    ])
    await mount()
    const bin = screen.getByTestId('vendor-check-vendor.claude.bin')
    expect(within(bin).getByRole('img', { name: 'Failed' })).toBeTruthy()
    expect(bin.textContent).toContain('No Claude Code CLI was found on this computer.')
    expect(within(bin).getByTestId<HTMLButtonElement>('recovery-claude.switch-vendor').disabled).toBe(true)
    expect(card().textContent).toContain('Install command')
    await click(within(bin).getByTestId('recovery-claude.install'))
    await click(within(bin).getByTestId('recheck-claude.install'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(card().textContent).toContain('Ready · 2.1.288')
  })

  it('Test runs a forced probe and shows "Checking…" meanwhile', async () => {
    upsertProbes([claude()])
    let release: (v: ProbeView[]) => void = () => undefined
    mock.on('vendors.probe', () => new Promise<ProbeView[]>((r) => (release = r)))
    await mount()
    await click(screen.getByTestId('vendor-test-claude'))
    expect(card().textContent).toContain('Checking…')
    await act(async () => {
      release([claude({ healthDetail: 'Ready · 2.1.289' })])
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(card().textContent).toContain('Ready · 2.1.289')
  })

  // The local models are live (tests/renderer/codex/localPresets.test.tsx); flag overrides stay a later version.
  it('renders flag overrides disabled for a later version, and local models live', async () => {
    upsertProbes([claude()])
    await mount()
    expect(
      within(card()).getByRole('group', { name: 'Edit overrides Available in a later version' }),
    ).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Add a local model Available in a later version' })).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await settle()
    expect(screen.getByTestId<HTMLButtonElement>('local-preset-add').disabled).toBe(false)
  })
})

// UI delivery notes ("Up to 200%"): on a narrow page (a small window at a large zoom) a value goes under its
// label rather than past the card's edge, and nothing in the card is wider than the card.
describe('a narrow card', () => {
  it('puts each value under its label where both do not fit, and never makes a value wider than the card', async () => {
    upsertProbes([claude()])
    await mount()
    const values = card().querySelectorAll('dd')
    expect(values.length).toBeGreaterThan(2)
    for (const dd of values) {
      const cls = dd.className.split(' ')
      // Beside the label from 12 rem of room (flex-basis), else wrapped under it, and free to be narrower there.
      expect(cls).toEqual(expect.arrayContaining(['grow', 'basis-48', 'min-w-0']))
      expect(cls.some((c) => /^min-w-(?!0$)/.test(c))).toBe(false)
      expect(dd.parentElement?.className.split(' ')).toContain('flex-wrap')
    }
    // The path box keeps 10 rem where it can, never more than its row.
    expect(pathInput().className.split(' ')).toContain('min-w-[min(10rem,100%)]')
  })
})

describe('deep links', () => {
  it('focuses the path field from #/settings/vendors/<id>?field=path', async () => {
    upsertProbes([claude(), probeView('codex', 'not-installed')])
    await mount('#/settings/vendors/claude?field=path')
    expect(document.activeElement).toBe(pathInput())
  })

  it("focuses the model from core's pointer link, and the card for a bare vendor link", async () => {
    upsertProbes([claude()])
    await mount('#/settings/vendors?field=%2Fvendors%2Fclaude%2FdefaultModel')
    expect(document.activeElement).toBe(screen.getByTestId('vendor-default-model-claude'))
    act(() => {
      window.location.hash = '#/settings/vendors/claude'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle()
    expect(document.activeElement).toBe(card())
  })

  // UI standard: nothing scrolls on its own except as the direct result of the user's action (here, the link).
  it('scrolls the field into view once, as the link is followed, and focuses it without a second scroll', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      upsertProbes([claude()])
      await mount('#/settings/vendors/claude?field=path')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
      expect(document.activeElement).toBe(pathInput())
    } finally {
      focus.mockRestore()
      scrollIntoView.mockRestore()
    }
  })

  it('leaves the page where the user scrolled it when the model field only exists later, and focuses it there', async () => {
    let answer: (r: ConfigReadResult) => void = () => {}
    mock.on('config.read', () => new Promise<ConfigReadResult>((r) => (answer = r)))
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      upsertProbes([claude()])
      window.location.hash = '#/settings/vendors?field=%2Fvendors%2Fclaude%2FdefaultModel'
      render(
        <Providers>
          <Shell>
            <Routed />
          </Shell>
        </Providers>,
      )
      await settle()
      expect(screen.queryByTestId('vendor-default-model-claude')).toBeNull()
      // The user scrolls while their settings are read.
      screen.getByRole('main').scrollTop = 250
      await act(async () => {
        answer(readResult({}))
        await vi.advanceTimersByTimeAsync(0)
      })
      await settle()
      expect(document.activeElement).toBe(screen.getByTestId('vendor-default-model-claude'))
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(screen.getByRole('main').scrollTop).toBe(250)
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('parses both link forms', () => {
    const settings = (subpath: string[], query: Record<string, string>) =>
      ({ name: 'settings', section: 'vendors', subpath, query }) as const
    expect(vendorTarget(settings(['codex'], { field: 'path' }))).toEqual({ vendor: 'codex', field: 'path' })
    expect(vendorTarget(settings([], { field: '/vendors/claude/path' }))).toEqual({
      vendor: 'claude',
      field: 'path',
    })
    expect(vendorTarget(settings(['claude'], {}))).toEqual({ vendor: 'claude', field: null })
    expect(vendorTarget(settings([], {}))).toBeNull()
    expect(vendorTarget({ name: 'dashboard', query: {} })).toBeNull()
  })
})

describe('user settings', () => {
  it('reads vendors.<id>.path and defaultModel from the parsed file', () => {
    expect(
      vendorSettingsOf({
        vendors: { claude: { path: 'C:\\c.exe', defaultModel: null }, codex: 'x', grok: {} },
      }),
    ).toEqual({ claude: { path: 'C:\\c.exe', defaultModel: null }, grok: {} })
    expect(vendorSettingsOf(null)).toEqual({})
  })

  it('does not read anything when there is no vendor card', async () => {
    await mount()
    expect(mock.callsOf('config.read')).toEqual([])
  })
})

describe('default effort', () => {
  const options: ModelOption[] = [
    { id: 'opus', source: 'cli', isDefault: true, hasPricing: true, efforts: ['low', 'high', 'max'] },
    { id: 'sonnet', source: 'cli', hasPricing: true, efforts: ['low', 'medium', 'high'] },
  ]

  async function pick(name: string): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('pass-effort-vendor-claude'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
  }

  it("offers the default model's levels from the same model list, writes the user file, and undoes it", async () => {
    mock.on('vendors.models', () => options)
    upsertProbes([claude()])
    await mount()
    // One read of the models serves the default model and the default effort.
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    expect(screen.getByTestId('pass-effort-vendor-claude').textContent).toBe('Default effort')
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('pass-effort-vendor-claude'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Default effort',
      'low',
      'high',
      'max',
    ])
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'max' }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/vendors/claude/defaultEffort', value: 'max' }] },
    ])
    expect(toasts()).toContain('Claude default effort: max')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'remove', path: '/vendors/claude/defaultEffort' }],
    })
  })

  it("shows the user's setting and returns to the default effort", async () => {
    userValue = { vendors: { claude: { defaultModel: 'sonnet', defaultEffort: 'medium' } } }
    mock.on('vendors.models', () => options)
    upsertProbes([claude()])
    await mount()
    expect(vendorSettingsOf(userValue)['claude']).toEqual({ defaultModel: 'sonnet', defaultEffort: 'medium' })
    expect(screen.getByTestId('pass-effort-vendor-claude').textContent).toBe('medium')
    await pick('Default effort')
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'remove', path: '/vendors/claude/defaultEffort' }] },
    ])
    expect(toasts()).toContain('Claude uses the default effort')
  })
})
