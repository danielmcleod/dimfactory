// App shell: landmarks, the Dashboard needs-you badge, the Runs active count and mini-list,
// the Settings dot while a vendor is not ready, vendor health dots and the version in the footer, and the current
// screen marked. ⌘/Ctrl+1/2/3 are bound by App (tests/renderer/app.test.tsx); the sidebar shows them. The shell is
// locked to the window with <main> as the one scroller, and app banners overlay the page instead of pushing it.
import '../helpers/rtl.ts'
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMainScroller } from '@renderer/components/shell/mainScroll.ts'
import { screenKey, Shell } from '@renderer/components/shell/Shell.tsx'
import { setAppInfo, setAttention, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { defaultAppInfo } from '../helpers/mockDimFactory.ts'
import { readSource } from '../helpers/readSource.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp()
})

afterEach(() => tearDown(mock))

function mount(): void {
  render(
    <Providers>
      <Shell>
        <p>page</p>
      </Shell>
    </Providers>,
  )
}

describe('Shell', () => {
  it('has a main navigation and a main region with the page', () => {
    mount()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(within(screen.getByRole('main')).getByText('page')).toBeTruthy()
    expect(screen.getByTestId('nav-dashboard').getAttribute('href')).toBe('#/')
    expect(screen.getByTestId('nav-runs').getAttribute('href')).toBe('#/runs')
    expect(screen.getByTestId('nav-settings').getAttribute('href')).toBe('#/settings')
    expect(screen.getByTestId('nav-runs').getAttribute('aria-keyshortcuts')).toBe('Control+2')
    expect(screen.getByTestId('nav-dashboard').getAttribute('aria-current')).toBe('page')
  })

  it("badges Dashboard with core's needs-you count", () => {
    mount()
    expect(within(screen.getByTestId('nav-dashboard')).queryByLabelText(/need you/)).toBeNull()
    act(() => setAttention(3, []))
    expect(within(screen.getByTestId('nav-dashboard')).getByLabelText('3 items need you').textContent).toBe(
      '3',
    )
    act(() => setAttention(1, []))
    expect(within(screen.getByTestId('nav-dashboard')).getByLabelText('1 item needs you')).toBeTruthy()
  })

  it('counts active runs and lists up to five of them', () => {
    upsertSummaries(
      [
        ...Array.from({ length: 6 }, (_, i) =>
          makeSummary({ runId: `a${i}`, title: `Active ${i}`, status: 'running', createdAt: 100 + i }),
        ),
        makeSummary({ runId: 'done', title: 'Finished', status: 'completed', createdAt: 200 }),
      ],
      { loaded: true },
    )
    mount()
    expect(within(screen.getByTestId('nav-runs')).getByLabelText('6 active runs').textContent).toBe('6')
    const list = screen.getByRole('list', { name: 'Active runs' })
    const links = within(list).getAllByRole('link')
    expect(links).toHaveLength(5)
    expect(links[0]?.getAttribute('href')).toBe('#/runs/a5')
    expect(links[0]?.textContent).toContain('Active 5')
    expect(within(list).queryByText('Finished')).toBeNull()
  })

  it('marks the open run and screen', () => {
    upsertSummaries([makeSummary({ runId: 'a1', status: 'running' })], { loaded: true })
    window.location.hash = '#/runs/a1'
    mount()
    expect(screen.getByRole('link', { name: /Add a --version flag/ }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByTestId('nav-dashboard').getAttribute('aria-current')).toBeNull()
  })

  it('shows a Settings dot while a built vendor is not ready, and health dots with the version', () => {
    act(() => setAppInfo(defaultAppInfo()))
    upsertProbes([probeView('claude', 'ready'), probeView('gemini', 'not-built', { built: false })])
    mount()
    expect(screen.queryByTestId('settings-attention-dot')).toBeNull()
    expect(screen.getByTestId('app-version').textContent).toBe('v0.1.0-test')
    expect(screen.getByTestId('vendor-dot-claude').getAttribute('aria-label')).toBe('Claude · Ready')
    expect(screen.queryByTestId('vendor-dot-gemini')).toBeNull()
    act(() => upsertProbes([probeView('codex', 'login-needed')]))
    expect(screen.getByTestId('settings-attention-dot').getAttribute('aria-label')).toBe(
      'A vendor needs setup',
    )
  })
})

// UI standards: one scroll region per screen, and nothing moves on its own.
describe('Shell: one scroll region, locked to the window', () => {
  const classes = (el: Element): string[] => el.className.toString().split(/\s+/)

  it('locks html, body and #root to the window: the document never scrolls, #root cannot even be scrolled', () => {
    const css = readSource('src/renderer/src/styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow:\s*hidden;\s*\}/)
    expect(css).toMatch(/#root\s*\{\s*overflow:\s*clip;\s*\}/)
    // The utility every allowed inner region uses.
    expect(css).toMatch(
      /@utility scroll-region\s*\{\s*overscroll-behavior:\s*contain;\s*scrollbar-gutter:\s*stable;\s*\}/,
    )
  })

  it("makes <main> the page's one scroller: positioned, its scrollbar's room kept, a wheel never chained past it", () => {
    mount()
    const main = screen.getByRole('main')
    // data-scroll-region marks the allowed inner regions inside it (each with a max height); the page scroller is not
    // one of them, so no region ever nests in another.
    expect(main.hasAttribute('data-scroll-region')).toBe(false)
    expect(classes(main)).toEqual(
      expect.arrayContaining([
        'relative',
        'overflow-auto',
        'overscroll-contain',
        '[scrollbar-gutter:stable]',
        'page-scroller',
      ]),
    )
  })

  it("keeps the browser's own scrolling clear of the sticky bars, and of a sticky action row unless focus is in it", () => {
    const css = readSource('src/renderer/src/styles/index.css')
    const block = /@utility page-scroller\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/scroll-padding-top:\s*var\(--page-pad-top, 0px\);/)
    expect(block).toMatch(
      /scroll-padding-bottom:\s*calc\(var\(--page-pad-bottom, 0px\) \+ var\(--page-pad-row-now\)\);/,
    )
    expect(block).toMatch(/--page-pad-row-now:\s*var\(--page-pad-row, 0px\);/)
    // Focus in the row: the row is in view wherever it sticks, so its share goes (Tab never scrolls for nothing).
    expect(block).toMatch(
      /&:has\(\[data-sticky-actions\]:focus-within\)\s*\{\s*--page-pad-row-now:\s*0px;\s*\}/,
    )
    // Focus in a page's sticky bar: a control there sits inside the padding kept for that bar, so that side's padding
    // goes while focus is in it (Tab through the bar's controls never scrolls the page).
    expect(block).toMatch(
      /&:has\(\[data-sticky-bar='top'\]:focus-within\)\s*\{\s*scroll-padding-top:\s*0px;\s*\}/,
    )
    expect(block).toMatch(
      /&:has\(\[data-sticky-bar='bottom'\]:focus-within\)\s*\{\s*scroll-padding-bottom:\s*0px;\s*\}/,
    )
  })

  it("hangs a count or dot off the icon's corner on the icon rail, smaller, never over the icon", () => {
    mount()
    act(() => setAttention(3, []))
    const badge = within(screen.getByTestId('nav-dashboard')).getByLabelText('3 items need you')
    // The rail (below 768 CSS px of window): the label is for screen readers, the count leaves the line for the
    // icon's top-right corner (the icon is centred: its right edge is at 50% + 8 px).
    const slot = badge.parentElement as HTMLElement
    expect(classes(slot)).toEqual(
      expect.arrayContaining(['max-md:absolute', 'max-md:top-0', 'max-md:left-[calc(50%+7px)]']),
    )
    expect(classes(badge)).toEqual(
      expect.arrayContaining(['max-md:h-4', 'max-md:min-w-4', 'max-md:text-[10px]']),
    )
    expect(classes(screen.getByTestId('nav-dashboard'))).toEqual(
      expect.arrayContaining(['relative', 'max-md:justify-center', 'max-md:px-0']),
    )
  })

  it('gives pages the scroller through context', () => {
    let seen: HTMLElement | null = null
    function Page(): null {
      seen = useMainScroller()
      return null
    }
    render(
      <Providers>
        <Shell>
          <Page />
        </Shell>
      </Providers>,
    )
    expect(seen).toBe(screen.getByRole('main'))
  })

  it('never scrolls the sidebar, and keeps every nav target in place when runs start and end', () => {
    mount()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(classes(nav)).toContain('overflow-hidden')
    expect(nav.className).not.toMatch(/overflow-y-auto|overflow-auto/)
    act(() =>
      upsertSummaries([makeSummary({ runId: 'a1', title: 'Active', status: 'running' })], { loaded: true }),
    )
    // Dashboard, Runs, Queue and Run it at the top with the active runs below them; Plops and Settings held at the foot, so a
    // run that starts or ends moves no nav target.
    const order = [...nav.children].map((c) => c.getAttribute('data-testid'))
    expect(order).toEqual(['nav-top', 'nav-bottom'])
    const top = screen.getByTestId('nav-top')
    expect([...top.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'nav-dashboard',
      'nav-runs',
      'nav-queue',
      'nav-run-it',
      'nav-active-runs',
    ])
    expect(classes(top)).toEqual(expect.arrayContaining(['flex-1', 'min-h-0', 'overflow-hidden']))
    expect(top.className).not.toMatch(/overflow-y-auto|overflow-auto/)
    const bottom = screen.getByTestId('nav-bottom')
    expect([...bottom.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'nav-experience',
      'nav-plops',
      'nav-settings',
    ])
    expect(classes(bottom)).toContain('shrink-0')
    // Plops links to its page; it has no shortcut of its own.
    const plops = screen.getByTestId('nav-plops')
    expect(plops.getAttribute('href')).toBe('#/plops')
    expect(plops.hasAttribute('aria-keyshortcuts')).toBe(false)
    // Run it links to its page (Run & Preview for a folder), marked while it is open; no shortcut of its own.
    const runIt = screen.getByTestId('nav-run-it')
    expect(runIt.getAttribute('href')).toBe('#/preview')
    expect(runIt.textContent).toContain('Run it')
    expect(runIt.hasAttribute('aria-keyshortcuts')).toBe(false)
    expect(runIt.hasAttribute('aria-current')).toBe(false)
  })

  it('puts Settings at the foot of the sidebar, above the vendor health dots and the version', () => {
    mount()
    const aside = screen.getByRole('complementary', { name: 'Sidebar' })
    const settings = screen.getByTestId('nav-settings')
    const version = screen.getByTestId('app-version')
    const dots = screen.getByRole('list', { name: 'Vendor health' })
    // Document order: Settings comes after the top items and the active runs, before the footer.
    const follows = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(screen.getByTestId('nav-runs'), settings)).toBe(true)
    expect(follows(settings, dots)).toBe(true)
    expect(follows(settings, version)).toBe(true)
    expect(aside.contains(settings)).toBe(true)
    // Unchanged: its link, shortcut and the Main navigation it belongs to.
    expect(settings.getAttribute('href')).toBe('#/settings')
    expect(settings.getAttribute('aria-keyshortcuts')).toBe('Control+3')
    expect(screen.getByRole('navigation', { name: 'Main' }).contains(settings)).toBe(true)
  })

  it('draws the app banners over the top of the page, outside its flow', () => {
    render(
      <Providers>
        <Shell banners={<div data-testid="a-banner">Lost contact</div>}>
          <p>page</p>
        </Shell>
      </Providers>,
    )
    const layer = screen.getByTestId('banner-layer')
    expect(layer.contains(screen.getByTestId('a-banner'))).toBe(true)
    expect(screen.getByRole('main').contains(layer)).toBe(false)
    expect(classes(layer)).toEqual(
      expect.arrayContaining(['pointer-events-none', 'absolute', 'inset-x-0', 'top-0', 'z-40']),
    )
    // The layer and main share a positioned column: the layer covers main's top, it takes no room of its own.
    expect(layer.parentElement).toBe(screen.getByRole('main').parentElement)
    expect(classes(layer.parentElement as Element)).toContain('relative')
  })

  it("starts a new screen at its top (the user's navigation), but not a run's tab or a query", () => {
    mount()
    const main = screen.getByRole('main')
    const go = (hash: string): void =>
      act(() => {
        window.location.hash = hash
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
    main.scrollTop = 300
    go('#/runs')
    expect(main.scrollTop).toBe(0)
    go('#/runs/r1')
    main.scrollTop = 300
    go('#/runs/r1/log')
    expect(main.scrollTop).toBe(300)
    go('#/runs/r1/log?x=1')
    expect(main.scrollTop).toBe(300)
    go('#/settings/vendors')
    expect(main.scrollTop).toBe(0)
  })

  it('names what makes a new screen', () => {
    expect(screenKey({ name: 'run', runId: 'r1', tab: 'log', query: {} })).toBe('run/r1')
    expect(
      screenKey({ name: 'settings', section: 'vendors', subpath: ['codex'], query: { field: 'path' } }),
    ).toBe('settings/vendors/codex')
    expect(screenKey({ name: 'dashboard', query: {} })).toBe('dashboard')
  })
})
