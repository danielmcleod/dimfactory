// The Scoreboard on the Plops page, the new-model card on the Dashboard, and a rematch's line in the queue: what the
// matches say per kind of task and builder ("not enough to tell" under five), a suggestion as words with its matches,
// the list of matches, and the offer to try a new model on a few past tasks through the queue.
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueueRematch, QueueTask } from '@shared/factory.ts'
import type { NewModelOffer } from '@shared/match.ts'
import type { Scoreboard as Board, ScoreMatchLine, ScoreRow } from '@shared/scoreboard.ts'
import {
  NEW_MODEL_NOTE,
  NewModelCard,
  newModelLine,
  newModelTitle,
} from '@renderer/pages/dashboard/rail/NewModelCard.tsx'
import {
  NOT_ENOUGH,
  NO_SUGGESTION,
  SCOREBOARD_EMPTY,
  SCOREBOARD_LOADING,
  Scoreboard,
  builderName,
  checksText,
  kindName,
  matchLineText,
  pickedText,
  suggestionText,
} from '@renderer/pages/plops/Scoreboard.tsx'
import { taskFacts } from '@renderer/pages/queue/text.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const CLAUDE = { vendor: 'claude', model: 'opus' }
const CODEX = { vendor: 'codex', model: 'gpt-x' }

const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({
  category: 'software',
  builder: CLAUDE,
  matches: 6,
  judged: 5,
  picked: 1,
  checksPassed: 11,
  checksTotal: 12,
  typicalCostUsd: 0.62,
  typicalMs: 95_000,
  enough: true,
  ...over,
})

const BOARD: Board = {
  rows: [
    row(),
    row({
      builder: CODEX,
      picked: 4,
      typicalCostUsd: null,
      typicalMs: null,
      checksTotal: 0,
      checksPassed: 0,
    }),
    row({ category: 'documents', matches: 2, judged: 2, picked: 2, enough: false }),
  ],
  suggestions: [
    {
      category: 'software',
      better: CODEX,
      than: CLAUDE,
      picked: 4,
      of: 5,
      matchIds: ['m5', 'm4', 'm3', 'm2', 'm1'],
    },
  ],
  matches: [
    {
      matchId: 'm5',
      kind: 'rematch',
      category: 'software',
      at: 5,
      task: 'Add a --version flag',
      sides: [CLAUDE, CODEX],
      pick: 'b',
      ended: true,
    },
    {
      matchId: 'm4',
      kind: 'headToHead',
      category: 'software',
      at: 4,
      task: 'Fix the login bug',
      sides: [CLAUDE, CODEX],
      pick: 'none',
      ended: true,
    },
    {
      matchId: 'm3',
      kind: 'headToHead',
      category: 'software',
      at: 3,
      task: 'Still going',
      sides: [CLAUDE, CLAUDE],
      ended: false,
    },
  ],
}

const OFFER: NewModelOffer = {
  vendor: 'codex',
  model: 'gpt-new',
  at: 1,
  plan: {
    challenger: { vendor: 'codex', model: 'gpt-new' },
    items: [
      {
        runId: 'r1',
        displayNo: 1,
        title: 'Task 1',
        folder: 'C:\\work\\repo',
        category: 'software',
        costUsd: 1.2,
      },
      {
        runId: 'r2',
        displayNo: 2,
        title: 'Task 2',
        folder: 'C:\\work\\repo',
        category: 'documents',
        costUsd: 2,
      },
    ],
    totalUsd: 3.2,
    newVendorLeftOut: 0,
  },
}

let mock: MockDimFactory
let board: Board
let offers: NewModelOffer[]

beforeEach(() => {
  board = BOARD
  offers = [OFFER]
  mock = setUp({
    handlers: {
      'matches.scoreboard': () => board,
      'matches.offers': () => offers,
      'matches.batchAdd': () => ({ added: 2, skipped: 0 }),
      'matches.dismissOffer': () => {
        offers = []
        return undefined
      },
    },
  })
})

afterEach(() => tearDown(mock))

async function mountBoard(): Promise<void> {
  render(
    <Providers>
      <Scoreboard />
    </Providers>,
  )
  await settle()
  await settle()
}
async function mountCard(): Promise<void> {
  render(
    <Providers>
      <NewModelCard />
    </Providers>,
  )
  await settle()
  await settle()
}
const click = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByTestId(id))
  await settle()
  await settle()
}

describe('the Scoreboard', () => {
  it('keeps its room while it reads, then shows a row per kind of task and builder', async () => {
    render(
      <Providers>
        <Scoreboard />
      </Providers>,
    )
    const section = screen.getByTestId('plops-scoreboard')
    expect(section.className).toContain('min-h-48')
    expect(section.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('scoreboard-loading').textContent).toBe(SCOREBOARD_LOADING)
    await settle()
    await settle()
    expect(mock.callsOf('matches.scoreboard')).toHaveLength(1)
    const rows = screen
      .getAllByTestId('scoreboard-row')
      .map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))
    expect(rows).toEqual([
      ['Software', 'Claude (opus)', '6', '1 of 5', '11 of 12', '$0.62', '1m 35s'],
      ['Software', 'Codex (gpt-x)', '6', '4 of 5', 'No checks ran', 'No price', 'Not timed'],
      // Too few matches: it says so instead of showing a share.
      ['Documents', 'Claude (opus)', '2', `${NOT_ENOUGH} (2 of 5 matches)`, '11 of 12', '$0.62', '1m 35s'],
    ])
    expect(screen.getAllByTestId('scoreboard-row')[2]?.getAttribute('data-enough')).toBe('false')
  })

  it('a suggestion is words with the matches behind it; it points at Settings and changes nothing', async () => {
    await mountBoard()
    const s = screen.getByTestId('scoreboard-suggestion')
    expect(s.textContent).toContain(
      'Software: you picked Codex (gpt-x) over Claude (opus) in 4 of 5 matches.',
    )
    expect(s.textContent).toContain('nothing is changed for you')
    const links = [...s.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toEqual([
      '#/matches/m5',
      '#/matches/m4',
      '#/matches/m3',
      '#/matches/m2',
      '#/matches/m1',
      '#/settings/profiles',
    ])
    // Nothing on the board is a button: it cannot change a setting.
    expect(screen.getByTestId('plops-scoreboard').querySelectorAll('button')).toHaveLength(0)
  })

  it('lists every match, newest first, each a link to its page', async () => {
    await mountBoard()
    const list = screen.getByTestId('scoreboard-matches')
    expect(list.querySelector('h3')?.textContent).toBe('Matches (3)')
    const items = [...list.querySelectorAll('li a')]
    expect(items.map((a) => a.getAttribute('href'))).toEqual(['#/matches/m5', '#/matches/m4', '#/matches/m3'])
    expect(items[0]?.textContent).toContain('Add a --version flag')
    expect(items[0]?.textContent).toContain(
      'Rematch · Claude (opus) against Codex (gpt-x) · picked Codex (gpt-x)',
    )
    expect(items[1]?.textContent).toContain(
      'Head to head · Claude (opus) against Codex (gpt-x) · picked neither',
    )
    expect(items[2]?.textContent).toContain('still going')
  })

  it('no matches yet says how to play one; no suggestion yet says what one needs', async () => {
    board = { rows: [], suggestions: [], matches: [] }
    await mountBoard()
    expect(screen.getByTestId('scoreboard-empty').textContent).toBe(SCOREBOARD_EMPTY)
    expect(screen.queryByTestId('scoreboard-table')).toBeNull()
    tearDown(mock)
    board = { ...BOARD, suggestions: [] }
    mock = setUp({ handlers: { 'matches.scoreboard': () => board } })
    await mountBoard()
    expect(screen.getAllByTestId('scoreboard-suggestions').at(-1)?.textContent).toContain(NO_SUGGESTION)
  })

  it('a board that cannot be read says why', async () => {
    mock.on('matches.scoreboard', () => {
      throw mockError('STORAGE', 'The matches could not be read.')
    })
    await mountBoard()
    expect(screen.getByTestId('scoreboard-error').textContent).toBe('The matches could not be read.')
  })

  it('the words (pure)', () => {
    expect(builderName({ vendor: 'claude' })).toBe('Claude')
    expect(kindName('data-report')).toBe('Data report')
    expect(pickedText(row({ judged: 0, picked: 0 }))).toBe('No picks yet')
    expect(pickedText(row({ enough: false, matches: 1 }))).toBe(`${NOT_ENOUGH} (1 of 5 matches)`)
    expect(checksText(row({ checksPassed: 3, checksTotal: 4 }))).toBe('3 of 4')
    expect(suggestionText(BOARD.suggestions[0] as never)).toContain(
      'may be worth setting as the builder in your profile',
    )
    expect(matchLineText({ ...(BOARD.matches[2] as ScoreMatchLine), ended: true })).toContain('no pick yet')
  })
})

describe('the new-model card', () => {
  it('offers a model the catalog got on a few past tasks, with about what they cost', async () => {
    await mountCard()
    expect(mock.callsOf('matches.offers')).toHaveLength(1)
    const card = screen.getByTestId('new-model-card')
    expect(card.textContent).toContain('New model: Codex (gpt-new)')
    expect(screen.getByTestId('new-model-line').textContent).toBe(
      'Try it on 2 of your past tasks, about $3.20.',
    )
    expect(card.textContent).toContain(NEW_MODEL_NOTE)
  })

  it('Add to the queue queues the rematches, sets the offer aside and opens the Queue', async () => {
    await mountCard()
    await click('new-model-add')
    expect(mock.callsOf('matches.batchAdd')).toEqual([
      { challenger: { vendor: 'codex', model: 'gpt-new' }, runIds: ['r1', 'r2'] },
    ])
    expect(mock.callsOf('matches.dismissOffer')).toEqual([{ vendor: 'codex', model: 'gpt-new' }])
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain('2 rematches are in the queue.')
    expect(window.location.hash).toBe('#/queue')
  })

  it('Not now sets the model aside, and the card goes', async () => {
    await mountCard()
    await click('new-model-later')
    expect(mock.callsOf('matches.dismissOffer')).toEqual([{ vendor: 'codex', model: 'gpt-new' }])
    expect(mock.callsOf('matches.batchAdd')).toEqual([])
    expect(screen.queryByTestId('new-model-card')).toBeNull()
  })

  it('with no offer there is no card; a queue that refuses says why and the card stays', async () => {
    offers = []
    await mountCard()
    expect(screen.queryByTestId('new-model-card')).toBeNull()
    tearDown(mock)
    offers = [OFFER]
    mock = setUp({
      handlers: {
        'matches.offers': () => offers,
        'matches.batchAdd': () => {
          throw mockError('VALIDATION', 'A queue holds at most 50 tasks.')
        },
      },
    })
    await mountCard()
    await click('new-model-add')
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'A queue holds at most 50 tasks.',
    )
    expect(screen.getByTestId('new-model-card')).toBeTruthy()
    expect(window.location.hash).toBe('')
  })

  it('the words (pure)', () => {
    expect(newModelTitle({ vendor: 'claude', model: 'haiku-9' })).toBe('New model: Claude (haiku-9)')
    const one = { plan: { ...OFFER.plan, items: OFFER.plan.items.slice(0, 1), totalUsd: null } }
    expect(newModelLine(one)).toBe('Try it on 1 of your past task.')
  })
})

describe('a rematch in the queue', () => {
  it('its row says which run is replayed and against whom', () => {
    const t = {
      id: 't1',
      task: 'Add a flag',
      title: 'Add a flag',
      source: { kind: 'manual' },
      addedAt: 1,
      status: 'done',
      costUsd: 0.5,
      rematch: { runId: 'r7', displayNo: 7, challenger: { vendor: 'codex', model: 'gpt-x' }, blind: true },
    } as QueueTask
    expect(taskFacts(t)).toBe('Rematch of run #7 against Codex (gpt-x) · $0.50')
    expect(
      taskFacts({ ...t, rematch: { ...(t.rematch as QueueRematch), challenger: { vendor: 'claude' } } }),
    ).toContain('against Claude')
  })
})
