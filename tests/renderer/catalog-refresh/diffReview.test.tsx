// Settings → Catalog's diff review (the refresh's validation table and "Apply": every proposed
// row old → new with core's flags as chips with their reason, core's default ticks (any flag unticks), tick and
// untick, Apply N changes → catalog.apply with exactly the ticked ids → "Prices updated · Undo"; "nothing moves on
// its own": rows never reorder while shown, the review's block keeps a reserved height while the job runs, and changes
// that arrive while the section is open wait behind Show changes).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogDiffRow, CatalogState } from '@shared/catalog.ts'
import { CATALOG_DIFF_FLAGS } from '@shared/catalog.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { DiffTable, FlagChip } from '@renderer/pages/settings/catalog/DiffReview.tsx'
import {
  applyLabel,
  deltaText,
  flagInfo,
  rowChange,
  rowWhat,
} from '@renderer/pages/settings/catalog/model.ts'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { onCatalogEvent, resetCatalogForTests } from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { catalogState, diff, job, price, row, status } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState

const ROWS: CatalogDiffRow[] = [
  row({ id: 'r-input', field: 'inputPerMTok', current: 4, proposed: 5, deltaPct: 25 }),
  row({
    id: 'r-big',
    field: 'outputPerMTok',
    current: 20,
    proposed: 32,
    deltaPct: 60,
    flags: ['bigChange'],
    ticked: false,
    reason: 'Changes by more than 50% (from $20.00).',
  }),
  row({
    id: 'r-sus',
    model: 'claude-haiku-5',
    field: 'inputPerMTok',
    current: 1,
    proposed: 12,
    deltaPct: 1100,
    flags: ['suspicious', 'unofficial'],
    ticked: false,
    sourceUrl: 'https://example.com/prices',
    reason: 'More than 10 times the current price ($1.00). The page is not on an official site.',
  }),
  row({
    id: 'r-new',
    kind: 'new-model',
    model: 'claude-sonnet-6',
    current: null,
    proposed: null,
    deltaPct: null,
    flags: ['notReportedByCli'],
    ticked: false,
    reason: 'The CLI does not list this model.',
  }),
  row({
    id: 'r-dep',
    kind: 'deprecate',
    model: 'claude-old',
    current: null,
    proposed: null,
    deltaPct: null,
    sourceUrl: null,
    sourceQuote: null,
    flags: ['deprecated', 'userEdited'],
    ticked: false,
  }),
  row({
    id: 'r-odd',
    field: 'cacheReadPerMTok',
    current: 0.2,
    proposed: 6,
    deltaPct: 2900,
    flags: ['inconsistent'],
    ticked: false,
  }),
]

function readyState(rows: CatalogDiffRow[] = ROWS): CatalogState {
  return catalogState({
    job: job({
      state: 'diff-ready',
      diff: diff(rows, {
        rejected: [
          {
            vendor: 'claude',
            model: 'claude-free',
            field: 'inputPerMTok',
            value: 0,
            reason: 'The input price must be more than $0.',
          },
        ],
        unverifiable: [
          { vendor: 'claude', model: 'claude-haiku-4', reason: 'No price on the official page.' },
        ],
      }),
    }),
  })
}

beforeEach(() => {
  resetCatalogForTests()
  state = readyState()
  mock = setUp({
    handlers: {
      'catalog.get': () => state,
      'catalog.refreshPlan': () => {
        throw new Error('no plan')
      },
      'catalog.apply': (req) => {
        state = catalogState({
          pricing: {
            schemaVersion: 1,
            updatedAt: Date.now(),
            entries: [price({ model: 'claude-opus-5-5', inputPerMTok: 5, confidence: 'verified' })],
          },
          job: job({ state: 'applied' }),
          history: [
            { id: 'h-new', at: Date.now(), source: 'refresh', entries: req.rowIds.length, jobId: 'j1' },
          ],
          undoId: 'h-new',
        })
        return state
      },
      'catalog.undo': () => {
        state = catalogState({ history: [], undoId: null })
        return state
      },
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
const rowEl = (id: string): HTMLElement => screen.getByTestId(`catalog-diff-row-${id}`)
const tick = (id: string): HTMLElement => screen.getByTestId(`catalog-diff-tick-${id}`)
const ticked = (id: string): boolean => tick(id).getAttribute('data-state') === 'checked'
const rowOrder = (): string[] =>
  [...screen.getByTestId('catalog-diff').querySelectorAll('tbody tr[data-testid^="catalog-diff-row-"]')].map(
    (r) => (r.getAttribute('data-testid') ?? '').slice('catalog-diff-row-'.length),
  )

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('the rows', () => {
  it('shows every proposed change old → new, in core’s order, with what it changes', async () => {
    await mount()
    expect(rowOrder()).toEqual(['r-input', 'r-big', 'r-sus', 'r-new', 'r-dep', 'r-odd'])
    const cells = (id: string): string[] => [...rowEl(id).children].map((c) => c.textContent ?? '')
    expect(cells('r-input').slice(1, 4)).toEqual(['Claudeclaude-opus-5-5', 'Input', '$4.00 →  to $5.00+25%'])
    expect(cells('r-new')[2]).toBe('New model')
    expect(cells('r-new')[3]).toContain('Not listed')
    expect(cells('r-dep')[2]).toBe('Mark deprecated')
    expect(cells('r-dep')[4]).toBe('No source')
    // The source is a link to the page, the quote in its tooltip.
    const source = within(rowEl('r-input')).getByRole('button', { name: 'Price page on docs.anthropic.com' })
    expect(source.getAttribute('title')).toBe('docs.anthropic.com: Input $5 / MTok')
  })

  it('shows each of core’s flags as a chip with its reason, and core’s reason under them', async () => {
    await mount()
    const chips = (id: string): string[] =>
      [...rowEl(id).querySelectorAll('[data-flag]')].map((c) => c.getAttribute('data-flag') ?? '')
    expect(chips('r-input')).toEqual([])
    expect(rowEl('r-input').textContent).toContain('None')
    expect(chips('r-big')).toEqual(['bigChange'])
    expect(chips('r-sus')).toEqual(['suspicious', 'unofficial'])
    expect(chips('r-new')).toEqual(['notReportedByCli'])
    expect(chips('r-dep')).toEqual(['deprecated', 'userEdited'])
    expect(chips('r-odd')).toEqual(['inconsistent'])
    const chip = rowEl('r-big').querySelector('[data-flag="bigChange"]') as HTMLElement
    expect(chip.textContent).toBe('Over 50%')
    expect(chip.getAttribute('title')).toBe('The price changes by more than 50%, so the row starts unticked.')
    expect(screen.getByTestId('catalog-diff-reason-r-sus').textContent).toBe(
      'More than 10 times the current price ($1.00). The page is not on an official site.',
    )
    // A big or suspicious change's percentage is amber.
    expect(screen.getByTestId('catalog-diff-delta-r-big').className).toContain('text-warning')
    expect(screen.getByTestId('catalog-diff-delta-r-input').className).not.toContain('text-warning')
  })

  it('names every flag core sets, and words one it does not know from its name', () => {
    for (const f of CATALOG_DIFF_FLAGS) {
      const info = flagInfo(f)
      expect(info.label, f).not.toBe('')
      expect(info.explain, f).not.toBe('')
      expect(`${info.label} ${info.explain}`, f).not.toContain('—')
    }
    expect(flagInfo('userEdited').label).toBe('You edited this')
    expect(flagInfo('over50').label).toBe('Over 50%')
    expect(flagInfo('notInCli').label).toBe('Not in the CLI')
    expect(flagInfo('outputBelowInput').label).toBe('Output below input')
    expect(flagInfo('cacheReadAboveInput').label).toBe('Cache read above input')
    expect(flagInfo('rejected').tone).toBe('bad')
    expect(flagInfo('someNewFlag')).toEqual({ label: 'Some new flag', explain: '', tone: 'info' })
    render(<FlagChip flag="someNewFlag" />)
    expect(screen.getByText('Some new flag').getAttribute('title')).toBeNull()
  })

  it('words a row’s change from core’s fields, in either name core may use for a kind', () => {
    expect(rowWhat(row({ id: 'a', field: 'cacheWritePerMTok' }))).toBe('Cache write')
    expect(rowWhat(row({ id: 'a', kind: 'model' as never }))).toBe('New model')
    expect(rowWhat(row({ id: 'a', kind: 'deprecated' as never }))).toBe('Mark deprecated')
    expect(rowChange(row({ id: 'a', current: null, proposed: 3, deltaPct: null }))).toEqual({
      from: 'No price',
      to: '$3.00',
      delta: null,
    })
    expect(deltaText(-40)).toBe('−40%')
    expect(deltaText(0.2)).toBe('+<1%')
    expect(deltaText(null)).toBeNull()
  })

  it('lists rejected proposals and models the AI could not confirm, never tickable', async () => {
    await mount()
    const rejected = screen.getByTestId('catalog-diff-rejected-0')
    expect(rejected.textContent).toContain('claude-free')
    expect(rejected.textContent).toContain('Rejected')
    expect(rejected.textContent).toContain('The input price must be more than $0.')
    expect(within(rejected).getByRole('checkbox').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('catalog-diff-unverifiable').textContent).toContain(
      'claude-haiku-4 (Claude): No price on the official page.',
    )
  })
})

describe('ticks and Apply', () => {
  it('starts from core’s ticks: only unflagged rows are ticked', async () => {
    await mount()
    expect(ticked('r-input')).toBe(true)
    for (const id of ['r-big', 'r-sus', 'r-new', 'r-dep', 'r-odd']) expect(ticked(id), id).toBe(false)
    expect(screen.getByTestId('catalog-diff-apply').textContent).toBe(applyLabel(1))
    expect(screen.getByTestId('catalog-diff-status').textContent).toBe(
      '1 of 6 ticked. Rows with a flag start unticked.',
    )
  })

  it('applies exactly the ticked rows, says "Prices updated" with Undo, and Undo puts the prices back', async () => {
    await mount()
    await click(tick('r-big'))
    await click(tick('r-input'))
    await click(tick('r-new'))
    expect(screen.getByTestId('catalog-diff-apply').textContent).toBe('Apply 2 changes')
    const epoch = useStore.getState().catalog.epoch
    await click(screen.getByTestId('catalog-diff-apply'))
    expect(mock.callsOf('catalog.apply')).toEqual([{ jobId: 'j1', rowIds: ['r-big', 'r-new'] }])
    expect(toasts()).toContain('Prices updated')
    expect(useStore.getState().catalog.epoch).toBe(epoch + 1)
    // The review closes; the tables show core's answer, and the history its new entry with Undo.
    expect(screen.queryByTestId('catalog-review')).toBeNull()
    expect(screen.getByTestId('catalog-price-claude-claude-opus-5-5').textContent).toContain('$5.00')
    expect(screen.getByTestId('catalog-history-h-new').dataset['undoable']).toBe('true')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('catalog.undo')).toHaveLength(1)
    expect(toasts()).toContain('The last price change was undone')
    expect(useStore.getState().catalog.epoch).toBe(epoch + 2)
  })

  it('Apply is disabled with nothing ticked, and keeps one width for every count', async () => {
    await mount()
    await click(tick('r-input'))
    const apply = screen.getByTestId<HTMLButtonElement>('catalog-diff-apply')
    expect(apply.disabled).toBe(true)
    expect(apply.textContent).toBe('Apply 0 changes')
    const reserved = [...apply.querySelectorAll('[data-label]')].map((e) => e.getAttribute('data-label'))
    expect(reserved).toEqual(expect.arrayContaining(['Apply 0 changes', 'Apply 1 change', 'Apply 6 changes']))
  })

  it('a refused apply is shown with core’s words and the review stays', async () => {
    mock.on('catalog.apply', () => {
      throw new Error('The prices changed since this update was read. Update again.')
    })
    await mount()
    await click(screen.getByTestId('catalog-diff-apply'))
    expect(toasts()).toContain('The prices changed since this update was read. Update again.')
    expect(screen.getByTestId('catalog-diff')).toBeTruthy()
  })
})

describe('nothing moves on its own', () => {
  it('a later copy of the diff in another order keeps the first order and the user’s ticks', async () => {
    await mount()
    await click(tick('r-big'))
    const reordered = [...ROWS].reverse().map((r) => (r.id === 'r-big' ? { ...r, ticked: false } : r))
    act(() =>
      onCatalogEvent({
        kind: 'catalog',
        state: 'diff-ready',
        jobId: 'j1',
        diff: diff([...reordered, row({ id: 'r-late' })]),
      }),
    )
    expect(rowOrder()).toEqual(['r-input', 'r-big', 'r-sus', 'r-new', 'r-dep', 'r-odd', 'r-late'])
    expect(ticked('r-big')).toBe(true)
  })

  it('a job reserves the review’s height; changes found while open wait behind Show changes in that height', async () => {
    state = catalogState({ status: status({ jobRunning: true }), job: job({ startedAt: Date.now() }) })
    await mount()
    const reserved = (): HTMLElement => screen.getByTestId('catalog-review-reserved')
    expect(reserved().className).toContain('h-28')
    expect(screen.getByTestId('catalog-review-line').textContent).toBe(
      'Claude (sonnet) is reading the price pages · 0s',
    )
    state = readyState()
    act(() => onCatalogEvent({ kind: 'catalog', state: 'diff-ready', jobId: 'j1' }))
    await settle()
    // Same block, same height: the rows wait for the user.
    expect(screen.queryByTestId('catalog-diff')).toBeNull()
    expect(reserved().className).toContain('h-28')
    expect(screen.getByTestId('catalog-review-line').textContent).toBe('6 changes ready to review')
    await click(screen.getByTestId('catalog-review-show'))
    expect(screen.getByTestId('catalog-diff')).toBeTruthy()
  })

  it('a job that fails while watched keeps its block (and height) until the user closes it', async () => {
    state = catalogState({ status: status({ jobRunning: true }), job: job({ startedAt: Date.now() }) })
    await mount()
    state = catalogState({ job: job({ state: 'failed', error: 'The CLI timed out after 10 minutes.' }) })
    act(() => onCatalogEvent({ kind: 'catalog', state: 'failed', jobId: 'j1' }))
    await settle()
    expect(screen.getByTestId('catalog-review-line').textContent).toBe(
      'The price update failed: The CLI timed out after 10 minutes.',
    )
    expect(screen.getByTestId('catalog-review-reserved').className).toContain('h-28')
    await click(screen.getByTestId('catalog-review-close'))
    expect(screen.queryByTestId('catalog-review')).toBeNull()
  })

  it('Not now hides the review; Review changes beside Update now brings it back', async () => {
    await mount()
    await click(screen.getByTestId('catalog-diff-close'))
    expect(screen.queryByTestId('catalog-review')).toBeNull()
    expect(screen.getByTestId('catalog-refresh-status').textContent).toBe('6 changes ready to review.')
    await click(screen.getByTestId('catalog-review-open'))
    expect(screen.getByTestId('catalog-diff')).toBeTruthy()
  })

  it('Cancel stops a running job from the review block', async () => {
    mock.on('catalog.cancel', () => {
      state = catalogState({ job: job({ state: 'cancelled' }) })
      return undefined
    })
    state = catalogState({ status: status({ jobRunning: true }), job: job({ startedAt: Date.now() }) })
    await mount()
    await click(screen.getByTestId('catalog-review-cancel'))
    expect(mock.callsOf('catalog.cancel')).toEqual([{ jobId: 'j1' }])
    expect(screen.queryByTestId('catalog-review')).toBeNull()
  })
})

describe('DiffTable alone', () => {
  it('reads a diff with missing lists defensively', () => {
    render(
      <Providers>
        <DiffTable
          jobId="j9"
          diff={{ ...diff([]), rejected: undefined as never, unverifiable: undefined as never }}
        />
      </Providers>,
    )
    expect(screen.getByTestId('catalog-diff').textContent).toContain('The update found no price to change.')
    expect(screen.getByTestId<HTMLButtonElement>('catalog-diff-apply').disabled).toBe(true)
  })
})

describe('confirm rows and pages the job did not read', () => {
  it('a confirm row says what ticking it does, starts ticked, and is applied only when ticked', async () => {
    state = readyState([
      row({ id: 'r-input', field: 'inputPerMTok', current: 4, proposed: 5, deltaPct: 25 }),
      (() => {
        const r = row({
          id: 'c-haiku',
          kind: 'confirm',
          model: 'claude-haiku-4-5',
          current: null,
          proposed: null,
          deltaPct: null,
          verified: true,
        })
        delete r.field
        return r
      })(),
      row({
        id: 'r-read',
        model: 'claude-sonnet-5-5',
        flags: ['notFetched'],
        ticked: false,
        reason: 'The update read no page on this site, so this price is not confirmed.',
      }),
    ])
    await mount()
    const cells = [...rowEl('c-haiku').children].map((c) => c.textContent ?? '')
    expect(cells[2]).toBe('Confirm prices')
    expect(cells[3]).toBe('Unchanged →  to Verified')
    expect(ticked('c-haiku')).toBe(true)
    const chip = rowEl('r-read').querySelector('[data-flag="notFetched"]') as HTMLElement
    expect(chip.textContent).toBe('Page not read')
    expect(ticked('r-read')).toBe(false)
    await click(tick('c-haiku'))
    await click(screen.getByTestId('catalog-diff-apply'))
    expect(mock.callsOf('catalog.apply')).toEqual([{ jobId: 'j1', rowIds: ['r-input'] }])
  })
})
