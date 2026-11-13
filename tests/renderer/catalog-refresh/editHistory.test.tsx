// Settings → Catalog's price editing and update history ("Manual edits set confidence:'user'",
// "Apply … a combined backup in catalog/history/ (20 kept)"; the editable models and pricing tables and
// their history). Edit opens a row's prices in place, refuses what core would refuse with why, saves
// through catalog.savePrice with an Undo (catalog.undo), and marks a price you set "Edited by you"; Add a price does the
// same for a new model. The history lists the last 20 changes newest first; only the change catalog.undo would put
// back (core's undoId) has Undo, the older ones are read-only.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState, PriceEdit } from '@shared/catalog.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { HISTORY_EMPTY, UNDO_LAST_LABEL } from '@renderer/pages/settings/catalog/HistoryTable.tsx'
import {
  PRICE_ABOVE_ZERO,
  parseModelId,
  parsePriceInput,
  undoableId,
} from '@renderer/pages/settings/catalog/model.ts'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { resetCatalogForTests } from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { catalogState, history, price } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState

function saved(entry: PriceEdit): CatalogState {
  const rest = state.pricing.entries.filter((e) => !(e.vendor === entry.vendor && e.model === entry.model))
  return {
    ...state,
    pricing: {
      ...state.pricing,
      entries: [
        ...rest,
        price({
          ...entry,
          aliases: entry.aliases ?? [],
          confidence: 'user',
          sourceUrl: '',
          fetchedAt: Date.now(),
        }),
      ],
    },
    history: [{ id: 'h-edit', at: Date.now(), source: 'manual', entries: 1 }, ...state.history],
    undoId: 'h-edit',
  }
}

beforeEach(() => {
  resetCatalogForTests()
  state = catalogState()
  mock = setUp({
    handlers: {
      'catalog.get': () => state,
      'catalog.savePrice': (req) => {
        state = saved(req.entry)
        return state
      },
      'catalog.undo': () => {
        state = catalogState({
          history: [{ id: 'h-u', at: Date.now(), source: 'undo', entries: 1 }],
          undoId: null,
        })
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

const OPUS = 'claude-claude-opus-5-5'
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const box = (field: string): HTMLInputElement =>
  screen.getByTestId<HTMLInputElement>(`catalog-edit-${OPUS}-${field}`)

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

function type(el: HTMLInputElement, value: string): void {
  act(() => {
    fireEvent.change(el, { target: { value } })
  })
}

describe('editing a price', () => {
  it('opens the row’s prices as boxes in place; Escape puts it back without asking core', async () => {
    await mount()
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    expect(box('inputPerMTok').value).toBe('4')
    expect(box('outputPerMTok').value).toBe('20')
    expect(box('cacheReadPerMTok').value).toBe('0.2')
    expect(box('cacheWritePerMTok').value).toBe('8')
    type(box('inputPerMTok'), '9')
    act(() => {
      fireEvent.keyDown(box('inputPerMTok'), { key: 'Escape' })
    })
    expect(screen.queryByTestId(`catalog-edit-${OPUS}-inputPerMTok`)).toBeNull()
    expect(mock.callsOf('catalog.savePrice')).toEqual([])
    expect(screen.getByTestId(`catalog-price-${OPUS}`).textContent).toContain('$4.00')
  })

  it('refuses what core would refuse, in place and with why, sending nothing', async () => {
    await mount()
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    type(box('inputPerMTok'), 'abc')
    type(box('outputPerMTok'), '')
    type(box('cacheWritePerMTok'), '1001')
    await click(screen.getByTestId(`catalog-save-${OPUS}`))
    expect(mock.callsOf('catalog.savePrice')).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(
      'Input: Use a number such as 3 or 0.30. Output: Enter a price. Cache write: At most $1,000 per million tokens.',
    )
    expect(box('inputPerMTok').getAttribute('aria-invalid')).toBe('true')
    expect(box('cacheReadPerMTok').getAttribute('aria-invalid')).toBeNull()
    expect(box('inputPerMTok').getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  it('saves through catalog.savePrice, marks it "Edited by you", and Undo puts the old price back', async () => {
    await mount()
    const epoch = useStore.getState().catalog.epoch
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    type(box('inputPerMTok'), '$5')
    type(box('cacheReadPerMTok'), '')
    act(() => {
      fireEvent.keyDown(box('inputPerMTok'), { key: 'Enter' })
    })
    await settle()
    expect(mock.callsOf('catalog.savePrice')).toEqual([
      {
        entry: {
          vendor: 'claude',
          model: 'claude-opus-5-5',
          inputPerMTok: 5,
          outputPerMTok: 20,
          cacheReadPerMTok: null,
          cacheWritePerMTok: 8,
          aliases: ['opus'],
        },
      },
    ])
    const rowEl = screen.getByTestId(`catalog-price-${OPUS}`)
    expect([...rowEl.querySelectorAll('td')].slice(0, 4).map((c) => c.textContent)).toEqual([
      '$5.00',
      '$20.00',
      'No price',
      '$8.00',
    ])
    expect(screen.getByTestId(`catalog-edited-${OPUS}`).textContent).toBe('Edited by you')
    expect(toasts()).toContain('Price saved for claude-opus-5-5')
    // Estimates and model lists ask core again at once.
    expect(useStore.getState().catalog.epoch).toBe(epoch + 1)
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('catalog.undo')).toHaveLength(1)
    expect(screen.queryByTestId(`catalog-edited-${OPUS}`)).toBeNull()
    expect(toasts()).toContain('The last price change was undone')
  })

  it('an unchanged price closes without asking core', async () => {
    await mount()
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    await click(screen.getByTestId(`catalog-save-${OPUS}`))
    expect(mock.callsOf('catalog.savePrice')).toEqual([])
    expect(screen.queryByTestId(`catalog-save-${OPUS}`)).toBeNull()
  })

  it('a refusal from core stays in the row with core’s words', async () => {
    mock.on('catalog.savePrice', () => {
      throw new Error('The catalog is being updated. Try again in a moment.')
    })
    await mount()
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    type(box('inputPerMTok'), '6')
    await click(screen.getByTestId(`catalog-save-${OPUS}`))
    expect(toasts()).toContain('The catalog is being updated. Try again in a moment.')
    expect(box('inputPerMTok').value).toBe('6')
  })

  it('adds a price for a new model, checking its id and prices first', async () => {
    await mount()
    await click(screen.getByTestId('catalog-add-price'))
    const form = screen.getByTestId('catalog-add-form')
    type(screen.getByTestId<HTMLInputElement>('catalog-add-model'), 'bad id!')
    await click(screen.getByTestId('catalog-add-save'))
    expect(screen.getByTestId('catalog-add-error').textContent).toBe(
      'Model: Use letters, digits and . : @ / [ ] - _ only. Input: Enter a price. Output: Enter a price.',
    )
    expect(mock.callsOf('catalog.savePrice')).toEqual([])
    type(screen.getByTestId<HTMLInputElement>('catalog-add-model'), 'claude-new')
    type(screen.getByTestId<HTMLInputElement>('catalog-add-inputPerMTok'), '2')
    type(screen.getByTestId<HTMLInputElement>('catalog-add-outputPerMTok'), '10.5')
    await click(within(form).getByTestId('catalog-add-save'))
    expect(mock.callsOf('catalog.savePrice')).toEqual([
      {
        entry: {
          vendor: 'claude',
          model: 'claude-new',
          inputPerMTok: 2,
          outputPerMTok: 10.5,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
    ])
    expect(screen.queryByTestId('catalog-add-form')).toBeNull()
    expect(screen.getByTestId('catalog-edited-claude-claude-new')).toBeTruthy()
  })

  it('reads prices the way the validator bounds them', () => {
    expect(parsePriceInput('3', true)).toEqual({ ok: true, value: 3 })
    expect(parsePriceInput(' $0.30 ', true)).toEqual({ ok: true, value: 0.3 })
    expect(parsePriceInput('.5', true)).toEqual({ ok: true, value: 0.5 })
    expect(parsePriceInput('1000', true)).toEqual({ ok: true, value: 1000 })
    expect(parsePriceInput('', false)).toEqual({ ok: true, value: null })
    expect(parsePriceInput('', true).ok).toBe(false)
    expect(parsePriceInput('-1', true).ok).toBe(false)
    expect(parsePriceInput('1e3', true).ok).toBe(false)
    expect(parsePriceInput('1000.01', true)).toEqual({
      ok: false,
      message: 'At most $1,000 per million tokens.',
    })
    expect(parsePriceInput('0.0000001', true)).toEqual({ ok: false, message: 'Use at most 6 decimals.' })
    expect(parseModelId('claude-opus-5-5')).toEqual({ ok: true, model: 'claude-opus-5-5' })
    expect(parseModelId('').ok).toBe(false)
  })
})

describe('update history', () => {
  it('lists the last 20 changes newest first; only the newest core can undo has Undo', async () => {
    state = catalogState({ history: history(25), undoId: 'h0' })
    await mount()
    const table = screen.getByRole('table', { name: 'Update history' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(20)
    expect(rows[0]?.getAttribute('data-testid')).toBe('catalog-history-h0')
    expect(rows[0]?.textContent).toContain('AI update')
    expect(rows[0]?.textContent).toContain('1 price')
    expect(rows[1]?.textContent).toContain('Price edited by you')
    expect(rows[1]?.textContent).toContain('2 prices')
    expect(within(table).getAllByRole('button')).toHaveLength(1)
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: UNDO_LAST_LABEL })).toBeTruthy()
    await click(screen.getByTestId('catalog-history-undo'))
    expect(mock.callsOf('catalog.undo')).toHaveLength(1)
    expect(toasts()).toContain('The last price change was undone')
    // Core's answer: an undo entry, nothing more to undo.
    expect(
      within(screen.getByRole('table', { name: 'Update history' })).queryAllByRole('button'),
    ).toHaveLength(0)
  })

  it('offers no Undo when core says there is nothing to undo, and says which changes were undone', async () => {
    state = catalogState({
      history: [
        { id: 'a', at: Date.now(), source: 'undo', entries: 3 },
        { id: 'b', at: Date.now() - 1000, source: 'refresh', entries: 3, undone: true },
      ],
      undoId: null,
    })
    await mount()
    const table = screen.getByRole('table', { name: 'Update history' })
    expect(within(table).queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByTestId('catalog-history-b').textContent).toContain('AI update (undone)')
  })

  it('says when there is no history yet', async () => {
    await mount()
    expect(screen.getByRole('table', { name: 'Update history' }).textContent).toContain(HISTORY_EMPTY)
  })

  it('from a core without undoId, the newest change not undone is the one to undo', () => {
    expect(undoableId({ history: history(3), undoId: 'h1' })).toBe('h1')
    expect(undoableId({ history: history(3), undoId: null })).toBeNull()
    expect(undoableId({ history: [{ ...history(1)[0]!, undone: true }, ...history(3).slice(1)] })).toBe('h1')
    expect(undoableId({ history: [] })).toBeNull()
  })
})

describe('$0 is refused in the row, as core would', () => {
  it('reads $0 as out of bounds, for a required and a cache price', () => {
    expect(parsePriceInput('0', true)).toEqual({ ok: false, message: PRICE_ABOVE_ZERO })
    expect(parsePriceInput('0.0', false)).toEqual({ ok: false, message: PRICE_ABOVE_ZERO })
    expect(parsePriceInput('$0', true).ok).toBe(false)
    expect(parsePriceInput('0.000001', true)).toEqual({ ok: true, value: 0.000001 })
  })

  it('says so beside the price and sends nothing', async () => {
    await mount()
    await click(screen.getByRole('button', { name: 'Edit claude-opus-5-5 prices' }))
    type(box('inputPerMTok'), '0')
    type(box('cacheReadPerMTok'), '0')
    await click(screen.getByTestId(`catalog-save-${OPUS}`))
    expect(mock.callsOf('catalog.savePrice')).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(
      `Input: ${PRICE_ABOVE_ZERO} Cache read: ${PRICE_ABOVE_ZERO}`,
    )
    expect(toasts()).toEqual([])
  })
})
