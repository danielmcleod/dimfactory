// Settings → Catalog and Isolation & Verify. Catalog shows the prices and models
// core has (catalog.get, the built-in seed), after the section has been open a moment and after the refresh controls;
// those controls, price editing and the history are live (tests/renderer/catalog-refresh/* cover them), so nothing here is
// "Available in a later version" any more. Isolation & Verify has its Verify half and its Isolation half live, and it
// still reads only once it has been open a moment.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState, PriceEntry } from '@shared/catalog.ts'
import { LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { formatDay, formatPrice, NO_MODELS } from '@renderer/pages/settings/CatalogSection.tsx'
import { LATER_SECTION } from '@renderer/pages/settings/kit.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const AT = Date.UTC(2026, 9, 3)

function price(over: Partial<PriceEntry> & { model: string }): PriceEntry {
  return {
    vendor: 'claude',
    aliases: [],
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 8,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    sourceQuote: 'Claude Opus 5.5 | $4 / MTok',
    fetchedAt: AT,
    confidence: 'unverified',
    ...over,
  }
}

function catalog(over: Partial<CatalogState> = {}): CatalogState {
  return {
    models: { schemaVersion: 1, updatedAt: AT, vendors: {} },
    pricing: {
      schemaVersion: 1,
      updatedAt: AT,
      entries: [
        price({ model: 'claude-opus-5-5', aliases: ['opus'] }),
        price({
          model: 'claude-haiku-5',
          inputPerMTok: 0.075,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        }),
        price({ vendor: 'codex', model: 'gpt-6', confidence: 'user', sourceUrl: '' }),
      ],
    },
    status: {
      pricingUpdatedAt: AT,
      confidence: 'mixed',
      stale: false,
      refreshDue: false,
      jobRunning: false,
      schedule: { enabled: true, intervalDays: 14, lastRefreshAt: null, snoozedUntil: null, nextDueAt: null },
    },
    job: null,
    history: [],
    ...over,
  }
}

let mock: MockDimFactory
let state: CatalogState

beforeEach(() => {
  state = catalog()
  mock = setUp({ handlers: { 'catalog.get': () => state, 'shell.open': () => undefined } })
})

afterEach(() => tearDown(mock))

function mount(section: string): HTMLElement {
  render(
    <Providers>
      <SettingsPage section={section} />
    </Providers>,
  )
  return screen.getByTestId('settings-content')
}

describe('Settings → Catalog (live)', () => {
  it('is live, with no control "Available in a later version", and reads nothing until it has been open a moment', () => {
    expect(findSection('catalog')?.live).toBe(true)
    const content = mount('catalog')
    expect(within(content).queryByText(LATER_SECTION)).toBeNull()
    // The refresh, edit and history controls are live (tests/renderer/catalog-refresh/*); none is blocked for a later version.
    for (const label of [
      'Refresh interval',
      'Refresh vendor',
      'Update now',
      'Undo the last update',
      'Edit a price',
    ])
      expect(within(content).queryByRole('group', { name: `${label} ${LATER_VERSION}` }), label).toBeNull()
    // Until core answers, the refresh controls wait (disabled) and the catalog's place is one line.
    expect(screen.getByTestId<HTMLButtonElement>('catalog-schedule').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('catalog-update').disabled).toBe(true)
    // Nothing is read until the section has been open a moment.
    expect(mock.callsOf('catalog.get')).toHaveLength(0)
    expect(screen.getByTestId('catalog-state').textContent).toBe('Loading the catalog…')
  })

  it('shows the prices core has, per vendor, after the refresh controls', async () => {
    const content = mount('catalog')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    const claude = within(content).getByRole('table', { name: 'Claude prices' })
    const opus = screen.getByTestId('catalog-price-claude-claude-opus-5-5')
    expect(claude.contains(opus)).toBe(true)
    const cells = [...opus.querySelectorAll('td')].map((c) => c.textContent)
    expect(cells.slice(0, 4)).toEqual(['$4.00', '$20.00', '$0.20', '$8.00'])
    expect(cells[4]).toContain('Not verified')
    expect(cells[4]).toContain(formatDay(AT))
    expect(opus.querySelector('th')?.textContent).toBe('claude-opus-5-5opus')
    const haiku = screen.getByTestId('catalog-price-claude-claude-haiku-5')
    expect([...haiku.querySelectorAll('td')].slice(0, 4).map((c) => c.textContent)).toEqual([
      '$0.075',
      '$20.00',
      'No price',
      'No price',
    ])
    const codex = within(content).getByRole('table', { name: 'Codex prices' })
    expect(codex.textContent).toContain('Edited by you')
    expect(screen.getByTestId('catalog-status').textContent).toBe(
      `Prices from ${formatDay(AT)}, partly verified.`,
    )
    expect(within(content).getByRole('table', { name: 'Models' }).textContent).toContain(NO_MODELS)
    // The tables came after the fixed controls: the groups after the refresh controls are core's catalog, Models
    // and the update history last.
    const groups = screen.getByTestId('settings-catalog').querySelectorAll(':scope > section')
    expect(groups[0]?.textContent).toContain('Update now')
    expect(groups[groups.length - 2]?.textContent).toContain('Models')
    expect(groups[groups.length - 1]?.textContent).toContain('Update history')
  })

  it('opens a price’s source page, and marks stale prices', async () => {
    state = catalog({ status: { ...catalog().status, stale: true } })
    mount('catalog')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByTestId('catalog-status').textContent).toContain(
      'Older than twice the refresh interval',
    )
    await act(async () => {
      // The row also has Edit, so the source is found by its name.
      fireEvent.click(
        within(screen.getByTestId('catalog-price-claude-claude-opus-5-5')).getByRole('button', {
          name: 'Price page on platform.claude.com',
        }),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('shell.open')).toEqual([
      { target: 'url', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
    ])
  })

  it('lists the models core recorded', async () => {
    state = catalog({
      models: {
        schemaVersion: 1,
        updatedAt: AT,
        vendors: {
          claude: {
            source: 'cli',
            fetchedAt: AT,
            models: [{ id: 'opus', contextWindow: 200000, source: 'cli', fetchedAt: AT }],
          },
        },
      },
    })
    mount('catalog')
    await settle(SECTION_LOAD_DELAY_MS)
    const models = screen.getByTestId('catalog-models')
    expect(models.textContent).toContain('opus')
    expect(models.textContent).toContain('200,000 tokens')
    expect(models.textContent).toContain('The CLI')
  })

  it('says why when the catalog cannot be read', async () => {
    mock.on('catalog.get', () => {
      throw mockError('UNSUPPORTED', 'catalog.get is not available in this build.')
    })
    mount('catalog')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByTestId('catalog-state').textContent).toBe(
      'The catalog could not be read: catalog.get is not available in this build.',
    )
  })

  it('formats prices in dollars with at least two decimals and never a dash', () => {
    expect(formatPrice(4)).toBe('$4.00')
    expect(formatPrice(0.2)).toBe('$0.20')
    expect(formatPrice(0.075)).toBe('$0.075')
    expect(formatPrice(12.5)).toBe('$12.50')
    expect(formatPrice(0)).toBe('$0.00')
    expect(formatPrice(null)).toBe('No price')
  })
})

describe('Settings → Isolation & Verify (both halves live)', () => {
  it('renders the Isolation half live (disabled only until core answers), with the Settings index fields, and reads nothing until it has been open a moment', async () => {
    // The section is live (its Verify half: tests/renderer/verify/settingsVerify.test.tsx), and so are its Isolation
    // controls and the isolated-run baseline check live (tests/renderer/isolated-runs/settingsIsolation.test.tsx). Nothing in the
    // section is "Available in a later version" any more; its controls wait for core's values, disabled.
    expect(findSection('isolation')?.live).toBe(true)
    const content = mount('isolation')
    expect(within(content).queryByText(LATER_SECTION)).toBeNull()
    expect(within(content).queryByText(LATER_VERSION)).toBeNull()
    for (const label of ['Run location', 'New run branch', 'Install dependencies', 'Baseline check']) {
      expect(within(content).queryByRole('group', { name: `${label} ${LATER_VERSION}` }), label).toBeNull()
    }
    expect(within(content).getByRole('switch', { name: 'Baseline check' })).toBeTruthy()
    expect(within(content).getByRole('switch', { name: 'New run branch' })).toBeTruthy()
    expect(within(content).getByRole('table', { name: 'Verify commands' })).toBeTruthy()
    for (const field of [
      '/isolation/mode',
      '/isolation/branch',
      '/isolation/worktree/install',
      '/isolation/worktree/copy',
      '/isolation/worktree/installCommand',
      '/isolation/worktree/autoApply',
      '/verify/commands',
    ]) {
      expect(content.querySelector(`[data-setting-field="${field}"]`), field).not.toBeNull()
    }
    // Nothing is read on the switch itself (performance.spec.ts).
    expect(mock.calls.filter((c) => c.cmd !== 'subscribe')).toEqual([])
    await settle(SECTION_LOAD_DELAY_MS * 2)
    // Then the resolved settings and the recent folders; no project is chosen, so nothing is detected.
    const cmds = mock.calls.filter((c) => c.cmd !== 'subscribe').map((c) => c.cmd)
    expect(new Set(cmds)).toEqual(new Set(['config.resolve', 'folders.recent']))
    expect(mock.callsOf('config.resolve')).toEqual([{}])
  })
})
