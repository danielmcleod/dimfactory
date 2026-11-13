// Settings → Catalog, its refresh controls (the catalog refresh: presets Off/7/14/30, due when enabled
// and the interval has elapsed; `catalog.refresh` {enabled, intervalDays, vendor, model}; the schedule and the AI
// vendor). The presets go through catalog.setSchedule with an Undo that puts the old schedule back; the vendor and
// model are config writes with Undo, Codex listed but "Available in a later version"; Update now
// asks in the consent card's words and sends catalog.refresh {consent: true} only from its click. Nothing is read until
// the section has been open a moment (performance.spec.ts).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState } from '@shared/catalog.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import type { ModelOption } from '@shared/vendors.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { UPDATE_RUNNING_REASON } from '@renderer/pages/settings/catalog/RefreshGroup.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { resetCatalogForTests } from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { catalogState, job, plan, schedule, status, write } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState
let refresh: { enabled: boolean; intervalDays: number; vendor: string; model: string | null }

const models: ModelOption[] = [
  { id: 'catalog-only', source: 'catalog', hasPricing: false },
  { id: 'opus', source: 'cli', isDefault: true, hasPricing: true },
  { id: 'sonnet', source: 'cli', hasPricing: true },
]

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
      'catalog.refresh': () => {
        state = { ...state, job: job({ startedAt: Date.now() }) }
        return { jobId: 'j1' }
      },
      'catalog.setSchedule': (req) => {
        const s = state.status.schedule
        const next = schedule({
          enabled: req.enabled ?? s.enabled,
          intervalDays: req.intervalDays ?? s.intervalDays,
        })
        state = { ...state, status: status({ schedule: next }) }
        return next
      },
      'config.resolve': () => resolved(),
      'config.patch': () => write('b-1'),
      'config.restoreBackup': () => write(null),
      'vendors.models': () => models,
    },
  })
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

const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

async function openSelect(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function choose(testId: string, name: string): Promise<void> {
  await openSelect(testId)
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('schedule', () => {
  it('offers the presets Off, 7, 14 and 30 days, showing core’s schedule', async () => {
    await mount()
    expect(screen.getByTestId('catalog-schedule').textContent).toBe('14 days')
    await openSelect('catalog-schedule')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Off',
      '7 days',
      '14 days',
      '30 days',
    ])
  })

  it('writes a preset through catalog.setSchedule, with an Undo that puts the old schedule back', async () => {
    await mount()
    await choose('catalog-schedule', '30 days')
    expect(mock.callsOf('catalog.setSchedule')).toEqual([{ enabled: true, intervalDays: 30 }])
    expect(toasts()).toContain('Dim Factory checks prices every 30 days')
    expect(screen.getByTestId('catalog-schedule').textContent).toBe('30 days')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('catalog.setSchedule').at(-1)).toEqual({ enabled: true, intervalDays: 14 })
    expect(screen.getByTestId('catalog-schedule').textContent).toBe('14 days')
  })

  it('Off turns checks off; turning a preset on again enables them with its interval', async () => {
    await mount()
    await choose('catalog-schedule', 'Off')
    expect(mock.callsOf('catalog.setSchedule')).toEqual([{ enabled: false }])
    expect(toasts()).toContain('Price checks are off')
    expect(screen.getByTestId('catalog-refresh-status').textContent).toBe(
      'Never updated with AI. Dim Factory does not ask.',
    )
    await choose('catalog-schedule', '7 days')
    expect(mock.callsOf('catalog.setSchedule').at(-1)).toEqual({ enabled: true, intervalDays: 7 })
  })

  it('keeps an interval from the file that is no preset, and states when it asks next', async () => {
    state = catalogState({
      status: status({
        schedule: schedule({
          intervalDays: 10,
          lastRefreshAt: Date.UTC(2026, 8, 20),
          nextDueAt: Date.UTC(2026, 8, 30),
        }),
      }),
    })
    await mount()
    expect(screen.getByTestId('catalog-schedule').textContent).toBe('10 days')
    const facts = screen.getByTestId('catalog-refresh-status').textContent ?? ''
    expect(facts).toMatch(/^Last updated with AI on .+\. Asks again on .+\.$/)
  })
})

describe('vendor and model', () => {
  it('lists Claude, and Codex disabled as "Available in a later version"', async () => {
    await mount()
    expect(screen.getByTestId('catalog-refresh-vendor').textContent).toBe('Claude')
    await openSelect('catalog-refresh-vendor')
    const codex = screen.getByRole('option', { name: 'Codex (Available in a later version)' })
    expect(codex.getAttribute('aria-disabled') ?? codex.getAttribute('data-disabled')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'Claude' }).getAttribute('data-disabled')).toBeNull()
  })

  it('lists the CLI’s models first, then the catalog’s with "no pricing", and writes the model with Undo', async () => {
    await mount()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    expect(screen.getByTestId('catalog-refresh-model').textContent).toBe('sonnet')
    await openSelect('catalog-refresh-model')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      "The CLI's default (opus)",
      'opus',
      'sonnet',
      'catalog-only · no pricing',
    ])
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'opus' }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/catalog/refresh/model', value: 'opus' }] },
    ])
    expect(toasts()).toContain('Prices are read with opus')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b-1' }])
  })

  it('the CLI’s default model is written as null', async () => {
    await mount()
    await choose('catalog-refresh-model', "The CLI's default (opus)")
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/catalog/refresh/model', value: null }] },
    ])
  })
})

describe('Update now', () => {
  it('asks in the consent card’s words and sends catalog.refresh {consent: true} only from its click', async () => {
    await mount()
    expect(screen.getByTestId('catalog-consent').textContent).toBe(
      'Claude (sonnet): read-only, web search, cannot change files',
    )
    expect(screen.getByTestId('catalog-estimate').textContent).toBe('~2 min · ≈$0.05')
    await settle(60_000)
    expect(mock.callsOf('catalog.refresh')).toEqual([])
    await click(screen.getByTestId('catalog-update'))
    expect(mock.callsOf('catalog.refresh')).toEqual([{ consent: true }])
    // The job's line beside the button, and the review's block reserved for what it finds, with Cancel.
    expect(screen.getByTestId('catalog-refresh-status').textContent).toBe(
      'Claude (sonnet) is reading the price pages · 0s',
    )
    const review = screen.getByTestId('catalog-review')
    expect(review.dataset['state']).toBe('running')
    expect(within(review).getByTestId('catalog-review-reserved').className).toContain('h-28')
    expect(within(review).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('is disabled with the reason while a job runs', async () => {
    state = catalogState({ status: status({ jobRunning: true }), job: job({ startedAt: Date.now() - 1000 }) })
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('catalog-update').disabled).toBe(true)
    expect(screen.getByRole('group', { name: `Update now ${UPDATE_RUNNING_REASON}` })).toBeTruthy()
  })

  it('says why when core cannot read the catalog, and nothing is offered', async () => {
    mock.on('catalog.get', () => {
      throw new Error('catalog/pricing.json is not valid JSON.')
    })
    await mount()
    expect(screen.getByTestId('catalog-state').textContent).toBe(
      'The catalog could not be read: catalog/pricing.json is not valid JSON.',
    )
    expect(screen.getByTestId<HTMLButtonElement>('catalog-update').disabled).toBe(true)
    expect(screen.getByTestId('catalog-schedule').textContent).toBe('Not available')
  })
})

describe('the prices status keeps its height', () => {
  it('two one-line rows of fixed height, the stale note in its own row, whether or not prices are stale', async () => {
    await mount()
    const rows = (): string[] =>
      [...screen.getByTestId('catalog-status').children].map((el) => el.getAttribute('class') ?? '')
    const fresh = rows()
    expect(fresh).toHaveLength(2)
    for (const cls of fresh) {
      expect(cls.split(/\s+/)).toContain('h-4')
      expect(cls.split(/\s+/)).toContain('truncate')
    }
    expect(screen.getByTestId('catalog-status-stale').textContent).toBe('')
    // Core's status turns stale (the scheduler's due event reads the catalog again): the same two rows.
    state = { ...state, status: status({ stale: true, refreshDue: true }) }
    await act(async () => {
      useStore.setState((s) => ({ catalog: { ...s.catalog, status: state.status, state } }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(rows()).toEqual(fresh)
    const note = screen.getByTestId('catalog-status-stale')
    expect(note.textContent).toBe('Older than twice the refresh interval, so estimates may be off.')
    expect(note.getAttribute('title')).toBe(note.textContent)
  })
})
