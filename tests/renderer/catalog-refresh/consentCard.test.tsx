// Dashboard catalog consent card (the catalog refresh: the card names the vendor and model, says
// "read-only, web search, cannot change files", shows ~time and ≈cost, offers [Update now] [Not now (7 days)]
// [Turn off], and never auto-runs: catalog.refresh `{consent: true}` comes only from Update now's click; the
// Dashboard's right rail). While a job runs the card is its status line with elapsed time and [Cancel]; changes found link to
// the review in Settings → Catalog. It is the rail's last item, so its coming and going move nothing.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState } from '@shared/catalog.ts'
import {
  CatalogCard,
  catalogCardMode,
  resetCatalogCardForTests,
} from '@renderer/pages/dashboard/rail/CatalogCard.tsx'
import { RightRail } from '@renderer/pages/dashboard/RightRail.tsx'
import {
  noteCatalogStatus,
  onCatalogEvent,
  resetCatalogForTests,
  setCatalogState,
} from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { dashboardData } from '../dashboard/fixtures.tsx'
import { consentLine } from '@renderer/pages/settings/catalog/consent.ts'
import { catalogState, diff, job, plan, row, schedule, status } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState

beforeEach(() => {
  resetCatalogForTests()
  state = catalogState({ status: status({ refreshDue: true }) })
  mock = setUp({
    handlers: {
      'catalog.get': () => state,
      'catalog.refreshPlan': () => plan(),
      'catalog.refresh': () => ({ jobId: 'j1' }),
      'catalog.cancel': () => undefined,
      'catalog.setSchedule': (req) => {
        const s = state.status.schedule
        const next = schedule({
          enabled: req.enabled ?? s.enabled,
          intervalDays: req.intervalDays ?? s.intervalDays,
          snoozedUntil:
            req.snoozeDays !== undefined ? Date.now() + req.snoozeDays * 86_400_000 : s.snoozedUntil,
        })
        state = { ...state, status: status({ refreshDue: false, schedule: next }) }
        return next
      },
    },
  })
})

afterEach(() => {
  tearDown(mock)
  resetCatalogForTests()
  resetCatalogCardForTests()
})

async function mount(): Promise<HTMLElement | null> {
  render(
    <Providers>
      <CatalogCard />
    </Providers>,
  )
  await settle()
  return screen.queryByTestId('catalog-card')
}

const card = (): HTMLElement => screen.getByTestId('catalog-card')
const button = (name: string): HTMLButtonElement =>
  within(card()).getByRole<HTMLButtonElement>('button', { name })
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('consent', () => {
  it('chooses its state from core: running, then changes to review, then due; else nothing', () => {
    expect(catalogCardMode(null, null)).toBeNull()
    expect(catalogCardMode({ refreshDue: false }, null)).toBeNull()
    expect(catalogCardMode({ refreshDue: true }, null)).toBe('consent')
    expect(catalogCardMode({ refreshDue: true }, { state: 'failed' })).toBe('consent')
    expect(catalogCardMode({ refreshDue: true }, { state: 'running' })).toBe('running')
    expect(catalogCardMode({ refreshDue: false }, { state: 'diff-ready' })).toBe('review')
    expect(catalogCardMode({ refreshDue: false }, { state: 'applied' })).toBeNull()
  })

  it('is not shown until core says a refresh is due', async () => {
    noteCatalogStatus(status({ refreshDue: false }))
    expect(await mount()).toBeNull()
    expect(mock.callsOf('catalog.refreshPlan')).toEqual([])
    act(() => noteCatalogStatus(status({ refreshDue: true })))
    await settle()
    expect(screen.getByTestId('catalog-card').dataset['mode']).toBe('consent')
  })

  it('names the vendor and model, says read-only, web search, cannot change files, and shows ~time and ≈cost', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    expect(card().textContent).toContain('Model prices may be out of date')
    expect(screen.getByTestId('catalog-card-consent').textContent).toBe(
      'Claude (sonnet): read-only, web search, cannot change files',
    )
    expect(screen.getByTestId('catalog-card-estimate').textContent).toBe('~2 min · ≈$0.05')
    expect(mock.callsOf('catalog.refreshPlan')).toHaveLength(1)
    for (const name of ['Update now', 'Not now (7 days)', 'Turn off'])
      expect(button(name).disabled).toBe(false)
    // No em dash anywhere on the card (UI copy standards).
    expect(card().textContent).not.toContain('—')
  })

  it('uses core’s name for the vendor, lists the hosts it may read in the tooltip, and marks an API-equivalent cost', async () => {
    mock.on('catalog.refreshPlan', () =>
      plan({
        vendorName: 'Claude Code',
        hosts: ['docs.anthropic.com', 'www.anthropic.com', 'claude.com'],
        apiEquivalent: true,
      }),
    )
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    const consent = screen.getByTestId('catalog-card-consent')
    expect(consent.textContent).toBe('Claude Code (sonnet): read-only, web search, cannot change files')
    expect(consent.getAttribute('title')).toBe(
      'Claude Code (sonnet): read-only, web search, cannot change files. It reads pages only on docs.anthropic.com, www.anthropic.com, claude.com.',
    )
    expect(screen.getByTestId('catalog-card-estimate').textContent).toBe('~2 min · ≈$0.05 API-equiv.')
  })

  it('says so when core cannot estimate, and shows core’s fallback note after the buttons', async () => {
    mock.on('catalog.refreshPlan', () =>
      plan({
        estDurationMs: null,
        estCostUsd: null,
        fallbackNote: 'Claude is not ready, so Codex would read them.',
      }),
    )
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    expect(screen.getByTestId('catalog-card-estimate').textContent).toBe('Time not known · cost not known')
    const note = screen.getByTestId('catalog-card-note')
    expect(note.textContent).toBe('Claude is not ready, so Codex would read them.')
    // After the buttons: the note's arrival never pushes them.
    expect(button('Turn off').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('never runs by itself: a due event, re-renders and time send no catalog.refresh', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    act(() => onCatalogEvent({ kind: 'catalog', state: 'due' }))
    await settle(60_000)
    expect(mock.callsOf('catalog.refresh')).toEqual([])
    expect(card().dataset['mode']).toBe('consent')
  })

  it('Update now sends catalog.refresh {consent: true} once, from the click, and the card turns into the job', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    const hold = deferred<{ jobId: string }>()
    mock.on('catalog.refresh', () => hold.promise)
    await act(async () => {
      fireEvent.click(button('Update now'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // Busy without a new width: the spinner takes Update now's icon slot, the label stays.
    expect(button('Update now').getAttribute('aria-busy')).toBe('true')
    expect(button('Update now').querySelector('[data-spinner]')).not.toBeNull()
    state = { ...state, job: job({ state: 'running', startedAt: Date.now() }) }
    hold.resolve({ jobId: 'j1' })
    await settle()
    expect(mock.callsOf('catalog.refresh')).toEqual([{ consent: true }])
    expect(card().dataset['mode']).toBe('running')
    expect(screen.getByTestId('catalog-card-status').textContent).toBe(
      'Claude (sonnet) is reading the price pages · 0s',
    )
  })

  it('a refusal from core is shown, and the card stays', async () => {
    mock.on('catalog.refresh', () => {
      throw new Error('Claude is not logged in.')
    })
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    await click(button('Update now'))
    expect(toasts()).toContain('Claude is not logged in.')
    expect(card().dataset['mode']).toBe('consent')
  })

  it('Not now (7 days) snoozes through catalog.setSchedule and goes once core says nothing is due', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    await click(button('Not now (7 days)'))
    expect(mock.callsOf('catalog.setSchedule')).toEqual([{ snoozeDays: 7 }])
    expect(mock.callsOf('catalog.refresh')).toEqual([])
    expect(toasts()).toContain('Dim Factory asks about prices again in 7 days')
    expect(screen.queryByTestId('catalog-card')).toBeNull()
  })

  it('Turn off turns the schedule off, with an Undo that turns it back on', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    await click(button('Turn off'))
    expect(mock.callsOf('catalog.setSchedule')).toEqual([{ enabled: false }])
    expect(toasts()).toContain('Price checks are off')
    expect(screen.queryByTestId('catalog-card')).toBeNull()
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('catalog.setSchedule').at(-1)).toEqual({ enabled: true })
  })

  it('a failed update keeps the consent card, saying why after the buttons', async () => {
    setCatalogState(
      catalogState({
        status: status({ refreshDue: true }),
        job: job({ state: 'failed', error: 'The answer was not valid JSON.' }),
      }),
    )
    await mount()
    expect(card().dataset['mode']).toBe('consent')
    expect(screen.getByTestId('catalog-card-failed').textContent).toBe(
      'The price update failed: The answer was not valid JSON.',
    )
  })
})

describe('while a job runs, and after', () => {
  it('shows the status line with elapsed time and core’s progress, and Cancel sends catalog.cancel', async () => {
    setCatalogState(
      catalogState({
        status: status({ refreshDue: true, jobRunning: true }),
        job: job({ startedAt: Date.now() - 72_000, progress: 'Reading docs.anthropic.com' }),
      }),
    )
    await mount()
    expect(card().dataset['mode']).toBe('running')
    expect(card().textContent).toContain('Updating model prices')
    expect(screen.getByTestId('catalog-card-status').textContent).toBe(
      'Claude (sonnet) is reading the price pages · 1m 12s',
    )
    expect(screen.getByTestId('catalog-card-progress').textContent).toBe('Reading docs.anthropic.com')
    await settle(2000)
    expect(screen.getByTestId('catalog-card-status').textContent).toBe(
      'Claude (sonnet) is reading the price pages · 1m 14s',
    )
    // Progress from core's events replaces the line in place; nothing else is read for it.
    const reads = mock.callsOf('catalog.get').length
    act(() =>
      onCatalogEvent({ kind: 'catalog', state: 'running', jobId: 'j1', progress: 'Reading claude.com' }),
    )
    expect(screen.getByTestId('catalog-card-progress').textContent).toBe('Reading claude.com')
    expect(mock.callsOf('catalog.get')).toHaveLength(reads)
    state = { ...state, job: job({ state: 'cancelled' }), status: status({ refreshDue: true }) }
    await click(screen.getByTestId('catalog-card-cancel'))
    expect(mock.callsOf('catalog.cancel')).toEqual([{ jobId: 'j1' }])
    expect(toasts()).toContain('The price update was cancelled')
    expect(card().dataset['mode']).toBe('consent')
  })

  it('reads core’s account of a job its status reports but the window has not seen (a reload mid-job)', async () => {
    state = catalogState({ status: status({ jobRunning: true }), job: job({ startedAt: Date.now() - 5000 }) })
    noteCatalogStatus(status({ jobRunning: true }))
    await mount()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    expect(card().dataset['mode']).toBe('running')
  })

  it('changes found: links to the review in Settings → Catalog', async () => {
    setCatalogState(
      catalogState({
        job: job({ state: 'diff-ready', diff: diff([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]) }),
      }),
    )
    await mount()
    expect(card().dataset['mode']).toBe('review')
    expect(screen.getByTestId('catalog-card-status').textContent).toBe('3 changes ready to review')
    expect(screen.getByTestId('catalog-card-detail').textContent).toBe(
      'Nothing changes until you apply them.',
    )
    expect(screen.getByTestId('catalog-card-review').getAttribute('href')).toBe(
      '#/settings/catalog?field=review',
    )
    // Not now sets the card aside for this session (core keeps the changes; Settings still offers them).
    await click(screen.getByTestId('catalog-card-later'))
    expect(screen.queryByTestId('catalog-card')).toBeNull()
    expect(mock.calls.filter((c) => c.cmd.startsWith('catalog.') && c.cmd !== 'catalog.refreshPlan')).toEqual(
      [],
    )
  })

  it('a job ending moves the card on: applied, with nothing due, removes it', async () => {
    setCatalogState(catalogState({ job: job({ state: 'diff-ready', diff: diff([row({ id: 'a' })]) }) }))
    await mount()
    state = catalogState({ job: job({ state: 'applied' }) })
    act(() => onCatalogEvent({ kind: 'catalog', state: 'applied', jobId: 'j1' }))
    await settle()
    expect(screen.queryByTestId('catalog-card')).toBeNull()
  })
})

describe('a job ending on its own (ui-layout.spec.ts section 9)', () => {
  /** The card's rows: tag and the classes that set its height (one line, a reserved line, the button row). */
  const shape = (): string[] =>
    [...card().children].map((el) => {
      const cls = el.getAttribute('class') ?? ''
      const keep = ['truncate', 'min-h-4', 'flex'].filter((c) => cls.split(/\s+/).includes(c))
      return `${el.tagName.toLowerCase()}${keep.map((c) => `.${c}`).join('')}`
    })

  it('keeps the running card’s lines when the changes are ready, so the card keeps its height', async () => {
    setCatalogState(
      catalogState({
        status: status({ refreshDue: true, jobRunning: true }),
        job: job({ startedAt: Date.now() - 5000, progress: 'Reading claude.com' }),
      }),
    )
    await mount()
    expect(card().dataset['mode']).toBe('running')
    const running = shape()
    expect(running).toEqual(['h2.flex', 'p.truncate', 'p.truncate.min-h-4', 'div.flex'])
    state = catalogState({
      job: job({ state: 'diff-ready', diff: diff([row({ id: 'a' }), row({ id: 'b' })]) }),
    })
    act(() => onCatalogEvent({ kind: 'catalog', state: 'diff-ready', jobId: 'j1' }))
    await settle()
    expect(card().dataset['mode']).toBe('review')
    expect(shape()).toEqual(running)
    // Each line says itself in full when cut.
    expect(screen.getByTestId('catalog-card-status').getAttribute('title')).toBe('2 changes ready to review')
    expect(screen.getByTestId('catalog-card-detail').getAttribute('title')).toBe(
      'Nothing changes until you apply them.',
    )
  })
})

describe('in the rail', () => {
  it('is the rail’s last item, so it moves nothing when it comes or goes', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    render(
      <Providers>
        <RightRail dashboard={{ status: 'ready', data: dashboardData() }} />
      </Providers>,
    )
    await settle()
    const rail = screen.getByTestId('right-rail')
    expect(rail.lastElementChild).toBe(screen.getByTestId('catalog-card'))
  })
})

describe('a refresh that fails while the card shows it', () => {
  const shape = (): string[] =>
    [...card().children].map((el) => {
      const cls = el.getAttribute('class') ?? ''
      const keep = ['truncate', 'min-h-4', 'flex'].filter((c) => cls.split(/\s+/).includes(c))
      return `${el.tagName.toLowerCase()}${keep.map((c) => `.${c}`).join('')}`
    })

  it('picks the failed card only for a job it showed running', () => {
    expect(catalogCardMode({ refreshDue: false }, { state: 'failed' })).toBeNull()
    expect(catalogCardMode({ refreshDue: false }, { state: 'failed' }, true)).toBe('failed')
    expect(catalogCardMode({ refreshDue: true }, { state: 'failed' }, true)).toBe('failed')
    expect(catalogCardMode({ refreshDue: true }, { state: 'cancelled' }, true)).toBe('consent')
  })

  it('stays, in the running card’s layout, until the user closes it (nothing due: then it goes)', async () => {
    setCatalogState(
      catalogState({
        status: status({ refreshDue: false, jobRunning: true }),
        job: job({ startedAt: Date.now() - 5000, progress: 'Reading claude.com' }),
      }),
    )
    await mount()
    const running = shape()
    // It failed (here: the timeout), with no refresh due: the card used to vanish.
    state = catalogState({
      status: status({ refreshDue: false }),
      job: job({
        state: 'failed',
        error: 'The price refresh took longer than 10 min, so Dim Factory stopped it.',
      }),
    })
    act(() =>
      onCatalogEvent({
        kind: 'catalog',
        state: 'failed',
        jobId: 'j1',
        error: 'The price refresh took longer than 10 min, so Dim Factory stopped it.',
      }),
    )
    await settle()
    expect(card().dataset['mode']).toBe('failed')
    expect(card().textContent).toContain('Price update failed')
    expect(shape()).toEqual(running)
    const line = screen.getByTestId('catalog-card-status')
    expect(line.textContent).toBe(
      'The price update failed: The price refresh took longer than 10 min, so Dim Factory stopped it.',
    )
    expect(line.getAttribute('title')).toBe(line.textContent)
    // What Try again would run, in the consent card's words.
    expect(screen.getByTestId('catalog-card-detail').textContent).toBe(
      'Claude (sonnet): read-only, web search, cannot change files',
    )
    await settle(60_000)
    expect(card().dataset['mode']).toBe('failed')
    expect(mock.callsOf('catalog.refresh')).toEqual([])
    await click(button('Close'))
    expect(screen.queryByTestId('catalog-card')).toBeNull()
  })

  it('Try again sends catalog.refresh {consent: true} from its click; closing with a refresh due shows the consent card', async () => {
    setCatalogState(
      catalogState({
        status: status({ refreshDue: true, jobRunning: true }),
        job: job({ startedAt: Date.now() }),
      }),
    )
    await mount()
    state = catalogState({
      status: status({ refreshDue: true }),
      job: job({ state: 'failed', error: 'No answer.' }),
    })
    act(() => onCatalogEvent({ kind: 'catalog', state: 'failed', jobId: 'j1', error: 'No answer.' }))
    await settle()
    expect(card().dataset['mode']).toBe('failed')
    state = { ...state, job: job({ id: 'j2', state: 'running', startedAt: Date.now() }) }
    mock.on('catalog.refresh', () => ({ jobId: 'j2' }))
    await click(button('Try again'))
    expect(mock.callsOf('catalog.refresh')).toEqual([{ consent: true }])
    expect(card().dataset['mode']).toBe('running')
  })

  it('names the CLI default it prices when no model is set', async () => {
    mock.on('catalog.refreshPlan', () => plan({ model: null, defaultModel: 'claude-opus-5-5' }))
    noteCatalogStatus(status({ refreshDue: true }))
    await mount()
    expect(screen.getByTestId('catalog-card-consent').textContent).toBe(
      'Claude (CLI default: claude-opus-5-5): read-only, web search, cannot change files',
    )
    // A core that does not know the default: the vendor alone, as before.
    mock.on('catalog.refreshPlan', () => plan({ model: null }))
    expect(consentLine(plan({ model: null }))).toBe('Claude: read-only, web search, cannot change files')
  })
})
