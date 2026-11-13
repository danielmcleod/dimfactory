// Settings → Catalog's AI vendor (the catalog refresh's AI vendor; the Codex refresh route
// (X17)). Codex is offered once its probe says it can read the
// price pages (installed, logged in; the read-only refresh does not need the Windows sandbox), and listed disabled with
// why until then. Choosing it writes `catalog.refresh.vendor` with the model back to Codex's CLI default, with Undo.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState } from '@shared/catalog.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import type { ModelOption } from '@shared/vendors.ts'
import { LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { refreshVendorReason, REFRESH_VENDORS } from '@renderer/pages/settings/catalog/RefreshGroup.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { resetCatalogForTests } from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { catalogState, plan, write } from '../catalog-refresh/fixtures.ts'
import { codex, CODEX_MODELS } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState
let refresh: { enabled: boolean; intervalDays: number; vendor: string; model: string | null }

const claudeModels: ModelOption[] = [
  { id: 'opus', source: 'cli', isDefault: true, hasPricing: true },
  { id: 'sonnet', source: 'cli', hasPricing: true },
]
const codexModels: ModelOption[] = CODEX_MODELS.map((m) => ({ ...m, hasPricing: true }))

function resolved(): ResolvedWithProvenance {
  const base = resolvedView()
  return { ...base, config: { ...base.config, catalog: { refresh } } }
}

beforeEach(() => {
  resetCatalogForTests()
  state = catalogState()
  refresh = { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' }
  mock = setUp({
    handlers: {
      'catalog.get': () => state,
      'catalog.refreshPlan': () => plan({ due: false }),
      'config.resolve': () => resolved(),
      'config.patch': (req) => {
        for (const op of req.ops) {
          if (op.op !== 'replace') continue
          if (op.path === '/catalog/refresh/vendor') refresh = { ...refresh, vendor: op.value as string }
          if (op.path === '/catalog/refresh/model') refresh = { ...refresh, model: op.value as string | null }
        }
        return write('b-1')
      },
      'config.restoreBackup': () => write(null),
      'vendors.models': (req) => (req.vendor === 'codex' ? codexModels : claudeModels),
    },
  })
  upsertProbes([probeView('claude', 'ready')])
})

afterEach(() => {
  tearDown(mock)
  resetCatalogForTests()
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <SettingsPage section="catalog" />
    </Providers>,
  )
  await settle(SECTION_LOAD_DELAY_MS)
  await settle()
}

async function openSelect(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
}

const option = (name: string): HTMLElement => screen.getByRole('option', { name })
const disabled = (el: HTMLElement): boolean => el.hasAttribute('data-disabled')
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('Codex as the refresh vendor', () => {
  it('names Claude and Codex as the vendors that can read price pages', () => {
    expect(REFRESH_VENDORS.map((v) => v.id)).toEqual(['claude', 'codex'])
  })

  it('says why Codex cannot read them now, from its probe', () => {
    expect(refreshVendorReason(undefined)).toBe(LATER_VERSION)
    expect(refreshVendorReason(probeView('codex', 'not-built', { built: false }))).toBe(LATER_VERSION)
    expect(refreshVendorReason(probeView('codex', 'checking', { displayName: 'Codex' }))).toBe(
      'Checking Codex…',
    )
    expect(
      refreshVendorReason(
        probeView('codex', 'login-needed', { displayName: 'Codex', healthDetail: 'Login needed' }),
      ),
    ).toBe('Codex is not ready: Login needed')
    expect(
      refreshVendorReason(
        probeView('codex', 'not-installed', { displayName: 'Codex', healthDetail: 'Not installed' }),
      ),
    ).toBe('Codex is not ready: Not installed')
    expect(refreshVendorReason(codex({ sandbox: 'ready' }))).toBeNull()
    // A read-only refresh: the Windows sandbox is not needed.
    expect(refreshVendorReason(codex())).toBeNull()
    const noWeb = codex({ sandbox: 'ready' })
    if (noWeb.probe !== null) noWeb.probe.capabilities = { ...noWeb.probe.capabilities, web: false }
    expect(refreshVendorReason(noWeb)).toBe('Codex cannot search the web here')
  })

  it('is listed disabled with why while Codex needs a login', async () => {
    upsertProbes([codex({ health: 'login-needed', over: { healthDetail: 'Login needed' } })])
    await mount()
    await openSelect('catalog-refresh-vendor')
    const c = option('Codex (Codex is not ready: Login needed)')
    expect(disabled(c)).toBe(true)
    expect(disabled(option('Claude'))).toBe(false)
  })

  it('once ready (even without its Windows sandbox) it is offered; choosing it writes the vendor and its default model', async () => {
    upsertProbes([codex()])
    await mount()
    expect(screen.getByTestId('catalog-refresh-model').textContent).toBe('sonnet')
    await openSelect('catalog-refresh-vendor')
    expect(disabled(option('Codex'))).toBe(false)
    await act(async () => {
      fireEvent.keyDown(option('Codex'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    // One write: the vendor, and the model back to the new vendor's CLI default ("sonnet" is Claude's).
    expect(mock.callsOf('config.patch')).toEqual([
      {
        scope: 'user',
        ops: [
          { op: 'replace', path: '/catalog/refresh/vendor', value: 'codex' },
          { op: 'replace', path: '/catalog/refresh/model', value: null },
        ],
      },
    ])
    expect(toasts()).toContain('Prices are read by Codex')
    expect(screen.getByTestId('catalog-refresh-vendor').textContent).toBe('Codex')
    expect(mock.callsOf('vendors.models')).toContainEqual({ vendor: 'codex' })
    expect(screen.getByTestId('catalog-refresh-model').textContent).toBe("The CLI's default (gpt-5.1-codex)")
    await openSelect('catalog-refresh-model')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain(
      'GPT-5.1 Codex Mini (gpt-5.1-codex-mini)',
    )
    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('option')[0] as HTMLElement, { key: 'Escape' })
      await vi.advanceTimersByTimeAsync(0)
    })
    // Undo puts the file back as it was (its backup).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b-1' }])
  })

  it('a configured Codex that is not ready now stays shown as chosen (core falls back and says so)', async () => {
    refresh = { ...refresh, vendor: 'codex', model: null }
    upsertProbes([codex({ health: 'login-needed', over: { healthDetail: 'Login needed' } })])
    await mount()
    expect(screen.getByTestId('catalog-refresh-vendor').textContent).toBe(
      'Codex (Codex is not ready: Login needed)',
    )
    await openSelect('catalog-refresh-vendor')
    // The current choice is never disabled: the user can see it and move off it.
    expect(disabled(option('Codex (Codex is not ready: Login needed)'))).toBe(false)
  })
})
