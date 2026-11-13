// Settings v0 (performance.spec.ts "Settings navigation < 200 ms"): the section list and
// deep links, Appearance → ui.setTheme reflecting ThemeState, the read-only Vendors view with Test, and a section
// switch that renders at once without any IPC.
import '../helpers/rtl.ts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState } from '@shared/catalog.ts'
import { ACCENTS, THEMES } from '@shared/config-schema.ts'
import type { ThemeState } from '@shared/ipc.ts'
import { useRoute } from '@renderer/lib/router.ts'
import { ACCENT_OPTIONS, THEME_OPTIONS } from '@renderer/pages/settings/AppearanceSection.tsx'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/general/ProjectFolder.tsx'
import { RUN_LOCATION_LABEL } from '@renderer/pages/settings/isolation/IsolationGroup.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SETTINGS_SECTIONS } from '@renderer/pages/settings/sections.ts'
import { setThemeState, upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
let theme: ThemeState

beforeEach(() => {
  theme = { theme: 'system', resolved: 'light', accent: 'slate' }
  mock = setUp({
    handlers: {
      'ui.setTheme': (req) => {
        const next = req.theme ?? theme.theme
        theme = {
          theme: next,
          resolved: next === 'dark' ? 'dark' : 'light',
          accent: req.accent ?? theme.accent,
        }
        return theme
      },
    },
  })
  setThemeState(theme)
})

afterEach(() => {
  tearDown(mock)
  const html = document.documentElement
  html.classList.remove('dark')
  delete html.dataset['accent']
  html.style.colorScheme = ''
})

function Routed(): React.JSX.Element | null {
  const r = useRoute()
  if (r.name !== 'settings') return null
  return r.section !== undefined ? <SettingsPage section={r.section} /> : <SettingsPage />
}

function go(hash: string): void {
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

function mount(hash: string): void {
  window.location.hash = hash
  render(
    <Providers>
      <Routed />
    </Providers>,
  )
}

const content = (): HTMLElement => screen.getByTestId('settings-content')

/** A catalog with one price (Settings → Catalog shows its tables once catalog.get answers). */
const CATALOG: CatalogState = {
  models: { schemaVersion: 1, updatedAt: 0, vendors: {} },
  pricing: {
    schemaVersion: 1,
    updatedAt: 0,
    entries: [
      {
        vendor: 'claude',
        model: 'claude-opus-5-5',
        aliases: ['opus'],
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.4,
        cacheWritePerMTok: 8,
        sourceUrl: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
        fetchedAt: 0,
        confidence: 'unverified',
      },
    ],
  },
  status: {
    pricingUpdatedAt: 0,
    confidence: 'unverified',
    stale: false,
    refreshDue: false,
    jobRunning: false,
    schedule: { enabled: true, intervalDays: 14, lastRefreshAt: null, snoozedUntil: null, nextDueAt: null },
  },
  job: null,
  history: [],
}

describe('Settings sections', () => {
  it('lists every Settings section with a deep link and opens Vendors by default', () => {
    mount('#/settings')
    expect(SETTINGS_SECTIONS.map((s) => s.title)).toEqual([
      'General',
      'Vendors',
      'Profiles',
      'Extensions',
      'Prompts',
      'Recipes',
      'Guardrails',
      'Self-heal',
      'Catalog',
      'Isolation & Verify',
      'Preview',
      'Deploy',
      'Factory',
      'Appearance',
      'Notifications',
      'Outside agents',
      'Diagnostics',
      'Config file',
    ])
    expect(screen.getByTestId('settings-section-isolation').getAttribute('href')).toBe('#/settings/isolation')
    expect(content().dataset['section']).toBe('vendors')
    expect(screen.getByTestId('settings-section-vendors').getAttribute('aria-current')).toBe('page')
  })

  // UI standard "One scroll region per screen": the section flows in the page (main scrolls), the list stays in view.
  it('keeps the section list in view (sticky in the page) and gives no section a scroller of its own', () => {
    mount('#/settings/profiles')
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    // Beside the section (sticky) on a page 600 px wide or more; above it, a row of links that wraps, on a narrower
    // one (a small window at a large zoom). The page is a size container, so this follows its own width.
    expect(nav.className.split(' ')).toEqual(
      expect.arrayContaining(['@min-[37.5rem]:sticky', '@min-[37.5rem]:top-4', '@min-[37.5rem]:self-start']),
    )
    expect(nav.className).not.toMatch(/overflow/)
    expect(nav.querySelector('ul')?.className.split(' ')).toEqual(
      expect.arrayContaining(['flex-wrap', '@min-[37.5rem]:flex-col']),
    )
    const grid = nav.parentElement as HTMLElement
    expect(grid.className.split(' ')).toEqual(
      expect.arrayContaining(['grid-cols-1', '@min-[37.5rem]:grid-cols-[10rem_minmax(0,1fr)]']),
    )
    expect(grid.parentElement?.className.split(' ')).toContain('@container')
  })

  it('fits every table to its column, never scrolling sideways at any zoom: columns share it, headers wrap', async () => {
    // Catalog's tables (prices, models, history) are core's catalog, shown once catalog.get answers.
    mock.on('catalog.get', () => CATALOG)
    for (const id of ['profiles', 'self-heal', 'catalog', 'isolation', 'diagnostics']) {
      mount(`#/settings/${id}`)
      // A section shows what it reads once it is read (Profiles' list and passes table come with your files).
      await settle(LOAD_DELAY_MS)
      const tables = within(content()).getAllByRole('table')
      expect(tables.length, id).toBeGreaterThan(0)
      for (const table of tables) {
        const box = table.parentElement as HTMLElement
        expect(box.className, id).not.toMatch(/overflow-(x-|y-)?(auto|scroll)/)
        expect(box.className.split(' '), id).toContain('overflow-clip')
        expect(table.className.split(' '), id).toEqual(expect.arrayContaining(['w-full', 'table-fixed']))
        for (const th of table.querySelectorAll('th')) {
          expect(th.className, id).not.toContain('whitespace-nowrap')
          expect(th.className.split(' '), id).toContain('[overflow-wrap:anywhere]')
        }
      }
      cleanup()
    }
  })

  it('switches sections at once, without fetching anything', () => {
    // General and Isolation & Verify (both halves) are live: start from that section,
    // whose controls are there (disabled) before it has read anything.
    mount('#/settings/isolation')
    expect(within(content()).getByRole('group', { name: RUN_LOCATION_LABEL })).toBeTruthy()
    const before = mock.calls.length
    for (const s of SETTINGS_SECTIONS) {
      const t0 = performance.now()
      act(() => go(`#/settings/${s.id}`))
      const ms = performance.now() - t0
      expect(content().dataset['section']).toBe(s.id)
      expect(within(content()).getByRole('heading', { name: s.title })).toBeTruthy()
      expect(within(content()).queryByText('Arrives in a later version') === null).toBe(s.live)
      expect(ms).toBeLessThan(200)
    }
    expect(mock.calls.length).toBe(before)
  })

  it('maps the routes core links to, and says when a section does not exist', () => {
    mount('#/settings/storage')
    expect(content().dataset['section']).toBe('diagnostics')
    act(() => go('#/settings/passes'))
    expect(content().dataset['section']).toBe('profiles')
    act(() => go('#/settings/nowhere'))
    expect(screen.getByText('This settings section does not exist')).toBeTruthy()
  })
})

describe('Settings → Appearance', () => {
  it('offers exactly the themes and accents of the config schema', () => {
    expect(THEME_OPTIONS.map((t) => t.value).sort()).toEqual([...THEMES].sort())
    expect(ACCENT_OPTIONS.map((a) => a.value)).toEqual([...ACCENTS])
  })

  it('sets the theme and accent through ui.setTheme and reflects the ThemeState', async () => {
    mount('#/settings/appearance')
    expect(screen.getByLabelText<HTMLInputElement>('System').checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Slate').checked).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dark'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('ui.setTheme')).toEqual([{ theme: 'dark' }])
    expect(screen.getByLabelText<HTMLInputElement>('Dark').checked).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Blue'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('ui.setTheme')).toEqual([{ theme: 'dark' }, { accent: 'blue' }])
    expect(document.documentElement.dataset['accent']).toBe('blue')
    expect(screen.getByLabelText<HTMLInputElement>('Blue').checked).toBe(true)
    // A change made elsewhere (the theme event from main) shows here too.
    act(() => setThemeState({ theme: 'light', resolved: 'light', accent: 'rose' }))
    expect(screen.getByLabelText<HTMLInputElement>('Light').checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Rose').checked).toBe(true)
  })

  it('shows the error and keeps the old choice when ui.setTheme fails', async () => {
    mock.on('ui.setTheme', () => {
      throw new Error('nativeTheme is not available')
    })
    mount('#/settings/appearance')
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dark'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByLabelText<HTMLInputElement>('System').checked).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('Settings → Vendors', () => {
  it('shows each check with its status and detail, and Test forces a probe', async () => {
    upsertProbes([
      probeView('claude', 'login-needed', {
        healthDetail: 'Login needed',
        probe: {
          vendor: 'claude',
          at: Date.now(),
          ok: false,
          route: 'stdio',
          transport: 'claude-stdio',
          version: '2.1.3',
          checks: [
            {
              id: 'vendor.claude.bin',
              scope: 'vendor',
              status: 'pass',
              blocking: true,
              title: 'Claude CLI found',
              detail: 'C:\\tools\\claude.exe',
              recovery: [],
              at: 0,
              ttlMs: 0,
            },
            {
              id: 'vendor.claude.auth',
              scope: 'vendor',
              status: 'fail',
              blocking: true,
              title: 'Not logged in',
              detail: 'claude auth status exited with code 1.',
              recovery: [],
              at: 0,
              ttlMs: 0,
            },
          ],
          capabilities: {} as never,
          models: [],
        },
      }),
      probeView('grok', 'not-built', { built: false }),
    ])
    mock.on('vendors.probe', () => [probeView('claude', 'ready')])
    mount('#/settings/vendors')
    const card = screen.getByTestId('settings-vendor-claude')
    expect(card.textContent).toContain('2.1.3')
    expect(card.textContent).toContain('stdio (claude-stdio)')
    expect(within(card).getByRole('img', { name: 'Passed' })).toBeTruthy()
    expect(within(card).getByRole('img', { name: 'Failed' })).toBeTruthy()
    expect(card.textContent).toContain('claude auth status exited with code 1.')
    expect(content().textContent).toContain('Not in this version: Grok.')
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(screen.getByTestId('settings-vendor-claude').textContent).toContain('Ready')
  })
})
