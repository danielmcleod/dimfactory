// The Rematch page (choose who builds the other side of a finished run, agree to a vendor that is new to the project,
// start) and the Match page as a rematch shows it: a pick that applies nothing, the original marked as recorded, the
// open-task mark, and a side's changes saved as a patch.
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MATCH_TEXT } from '@shared/match.ts'
import type { MatchSideView, MatchView, RematchCheck } from '@shared/match.ts'
import { matchChipText } from '@renderer/components/match/MatchChip.tsx'
import { MatchPage } from '@renderer/pages/match/MatchPage.tsx'
import {
  KNOWN_VENDOR,
  REMATCH_LOADING,
  RematchPage,
  newVendorLine,
} from '@renderer/pages/match/RematchPage.tsx'
import { keepBlocked, matchStatus, matchWords } from '@renderer/pages/match/text.ts'
import { upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { resetMatchesForTests } from '@renderer/state/matches.ts'
import { useStore } from '@renderer/state/store.ts'
import { probe } from '../composer/fixtures.tsx'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { makeSummary } from '../helpers/fixtures.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const MATCH = '20261111T120000Z-ab12'
const SRC = '20261109T080000Z-cccc'
const B = '20261111T120002Z-bbbb'

const CHECK: RematchCheck = {
  displayNo: 7,
  task: 'add a --version flag',
  original: { vendor: 'claude', model: 'opus' },
  knownVendors: ['claude'],
}

const side = (s: 'a' | 'b', over: Partial<MatchSideView> = {}): MatchSideView => ({
  side: s,
  contestant: s === 'a' ? { vendor: 'claude', model: 'opus' } : { vendor: 'codex' },
  runId: s === 'a' ? SRC : B,
  displayNo: s === 'a' ? 7 : 13,
  status: 'completed',
  endedAt: 9,
  tokens: 1000,
  costUsd: 0.2,
  filesChanged: 2,
  findings: { must: 0, should: 0 },
  ...(s === 'a' ? { recorded: true as const } : { copyState: 'kept', notApplied: true }),
  ...over,
})

const rematch = (over: Partial<MatchView> = {}): MatchView => ({
  schemaVersion: 1,
  matchId: MATCH,
  kind: 'rematch',
  folder: 'C:\\work\\repo',
  folderKey: 'k',
  task: 'add a --version flag',
  createdAt: 1,
  start: { tree: 'a'.repeat(40), commit: 'b'.repeat(40) },
  sides: [side('a'), side('b')],
  source: { runId: SRC, displayNo: 7 },
  waiting: false,
  ready: true,
  ended: true,
  ...over,
})

let mock: MockDimFactory
let check: RematchCheck
let current: MatchView

beforeEach(() => {
  check = CHECK
  current = rematch()
  resetMatchesForTests()
  mock = setUp({
    handlers: {
      'matches.rematchCheck': () => check,
      'matches.rematch': () => ({
        matchId: MATCH,
        sides: [
          { side: 'a', runId: SRC, displayNo: 7 },
          { side: 'b', runId: B, displayNo: 13 },
        ],
      }),
      'matches.get': () => current,
      'matches.compare': () => ({ files: [], available: { a: true, b: true, between: true } }),
      'matches.pick': (req: { side: 'a' | 'b' | 'none' }) => {
        current = { ...current, pick: { side: req.side, at: 5 } }
        return { match: current, conflicts: [] }
      },
      'matches.undoPick': () => {
        current = rematch()
        return current
      },
      'matches.savePatch': (req: { side: string }) => ({
        path: `C:\\home\\matches\\${MATCH}\\side-${req.side}.patch`,
        bytes: 120,
      }),
    },
  })
})

afterEach(() => tearDown(mock))

async function mountRematch(): Promise<void> {
  render(
    <Providers>
      <RematchPage runId={SRC} />
    </Providers>,
  )
  await settle()
  await settle()
}
async function mountMatch(): Promise<void> {
  upsertSummaries([
    makeSummary({ runId: SRC, displayNo: 7, status: 'completed', endedAt: 9 }),
    makeSummary({
      runId: B,
      displayNo: 13,
      status: 'completed',
      endedAt: 9,
      matchOf: { matchId: MATCH, side: 'b', rematch: true },
    }),
  ])
  render(
    <Providers>
      <MatchPage matchId={MATCH} />
    </Providers>,
  )
  await settle()
  await settle()
}
const button = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)
const click = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByTestId(id))
  await settle()
  await settle()
}

describe('the Rematch page', () => {
  it('says which run and who built it, and offers another ready vendor as the challenger', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    render(
      <Providers>
        <RematchPage runId={SRC} />
      </Providers>,
    )
    expect(screen.getByTestId('rematch-loading').textContent).toBe(REMATCH_LOADING)
    await settle()
    await settle()
    expect(mock.callsOf('matches.rematchCheck')).toEqual([{ runId: SRC }])
    expect(screen.getByTestId('rematch-run').textContent).toBe('Run #7')
    expect(screen.getByTestId('rematch-run').getAttribute('href')).toBe(`#/runs/${SRC}`)
    expect(screen.getByTestId('rematch-original').textContent).toBe('Built by Claude (opus)')
    expect(screen.getByTestId('rematch-task').textContent).toBe('add a --version flag')
    expect(screen.getByTestId('rematch-blocked').textContent).toBe('')
    expect(screen.getByTestId('composer-h2h-vendor-b').textContent).toContain('Codex')
  })

  it('a vendor new to the project has to be agreed to before Start, in a row that is always there', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountRematch()
    const note = screen.getByTestId('rematch-vendor-note')
    expect(note.textContent).toBe(MATCH_TEXT.newVendor('Codex'))
    expect(button('rematch-start').disabled).toBe(true)
    await click('rematch-agree')
    expect(button('rematch-start').disabled).toBe(false)
    await click('rematch-start')
    expect(mock.callsOf('matches.rematch')).toEqual([
      { runId: SRC, challenger: { vendor: 'codex' }, confirmNewVendor: true },
    ])
    expect(window.location.hash).toBe(`#/matches/${MATCH}`)
  })

  it('a vendor that has run here before needs no agreement; the options go with the request', async () => {
    upsertProbes([probe('claude', 'ready')])
    await mountRematch()
    // Only Claude is ready: the challenger is the same builder again.
    expect(screen.getByTestId('composer-h2h-vendor-b').textContent).toContain('Claude')
    expect(screen.getByTestId('rematch-vendor-note').textContent).toBe(KNOWN_VENDOR)
    expect(button('rematch-agree').disabled).toBe(true)
    expect(button('rematch-start').disabled).toBe(false)
    await click('rematch-fresh')
    await click('rematch-blind')
    await click('rematch-start')
    expect(mock.callsOf('matches.rematch')).toEqual([
      { runId: SRC, challenger: { vendor: 'claude', model: 'opus' }, fresh: true, blind: true },
    ])
  })

  it('a run that cannot be replayed says why, and Start stays off', async () => {
    check = {
      ...CHECK,
      blocked: 'Run #7 worked in an isolated copy. A rematch replays a run that worked in the folder itself.',
    }
    upsertProbes([probe('claude', 'ready')])
    await mountRematch()
    expect(screen.getByTestId('rematch-blocked').textContent).toContain('worked in an isolated copy')
    expect(screen.getByTestId('rematch-blocked').getAttribute('role')).toBe('alert')
    expect(button('rematch-start').disabled).toBe(true)
  })

  it('a start core refuses is said, and the page stays', async () => {
    mock.on('matches.rematch', () => {
      throw mockError('PREFLIGHT_BLOCKED', 'Side B cannot start. Claude needs you to log in.')
    })
    upsertProbes([probe('claude', 'ready')])
    await mountRematch()
    await click('rematch-start')
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'Side B cannot start. Claude needs you to log in.',
    )
    expect(window.location.hash).toBe('')
  })

  it('a run that is not there says so', async () => {
    mock.on('matches.rematchCheck', () => {
      throw mockError('NOT_FOUND', 'Run not found.')
    })
    await mountRematch()
    expect(screen.getByText('This run cannot be looked at')).toBeTruthy()
  })

  it('the vendor line (pure)', () => {
    expect(newVendorLine(CHECK, 'claude')).toBeNull()
    expect(newVendorLine(CHECK, 'gemini')).toBe(MATCH_TEXT.newVendor('Gemini'))
    expect(newVendorLine(null, 'gemini')).toBeNull()
  })
})

describe('the Match page for a rematch', () => {
  it('is titled Rematch, marks the original as recorded, and says whose numbers are from when', async () => {
    current = rematch({ openTask: true })
    await mountMatch()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rematch')
    expect(screen.getByTestId('match-run-a').textContent).toBe(
      'Open run #7 (the original, as it was recorded)',
    )
    expect(screen.getByTestId('match-run-b').textContent).toBe('Open run #13')
    expect(screen.getByTestId('match-then-now').textContent).toBe(MATCH_TEXT.thenAndNow)
    expect(screen.getByTestId('match-open-task').getAttribute('title')).toBe(MATCH_TEXT.openTaskMark)
    expect(screen.getByTestId('match-status').textContent).toBe(
      'Both results are in. Pick the one you prefer, or neither.',
    )
    expect(button('match-keep-a').textContent).toBe('Pick this result')
    expect(button('match-keep-none').textContent).toBe('Pick neither')
  })

  it('a pick marks the side and applies nothing; the recorded side can be the pick', async () => {
    await mountMatch()
    expect(button('match-keep-a').disabled).toBe(false)
    await click('match-keep-a')
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'a' }])
    expect(screen.getByTestId('match-kept-a').textContent).toBe('Your pick')
    expect(screen.getByTestId('match-status').textContent).toContain('You picked Side A. Nothing was applied')
    expect(screen.getByTestId('match-page').textContent).not.toContain('In the folder')
    await click('match-undo')
    expect(screen.queryByTestId('match-kept-a')).toBeNull()
  })

  it('a side’s changes are saved as a patch, and the page says where', async () => {
    await mountMatch()
    expect(screen.getByTestId('match-patch-saved').textContent).toBe('')
    await click('match-patch-b')
    expect(mock.callsOf('matches.savePatch')).toEqual([{ matchId: MATCH, side: 'b' }])
    expect(screen.getByTestId('match-patch-saved').textContent).toBe(
      `Saved Side B's changes as a patch: C:\\home\\matches\\${MATCH}\\side-b.patch`,
    )
  })

  it('a side with no changes has nothing to save', async () => {
    current = rematch({ sides: [side('a'), side('b', { filesChanged: 0 })] })
    await mountMatch()
    expect(button('match-patch-b').disabled).toBe(true)
    expect(button('match-patch-a').disabled).toBe(false)
  })

  it('the words (pure)', () => {
    expect(matchWords('headToHead').keep).toBe('Keep this result')
    expect(matchWords('rematch')).toMatchObject({
      title: 'Rematch',
      keep: 'Pick this result',
      marked: 'Your pick',
    })
    expect(matchStatus(rematch({ ready: false, ended: false }))).toBe(
      'Building from where run #7 began. The folder is not touched.',
    )
    expect(matchStatus(rematch({ pick: { side: 'none', at: 1 } }))).toBe(
      'You picked neither. Nothing was applied.',
    )
    expect(keepBlocked(rematch(), side('a'))).toBeNull()
    expect(keepBlocked(rematch({ ready: false }), side('b'))).toBe('The new build has to finish first.')
    expect(matchChipText({ matchOf: { matchId: MATCH, side: 'b', rematch: true } })).toBe('Rematch: side b')
    expect(matchChipText({ matchOf: { matchId: MATCH, side: 'a' } })).toBe('Head to head: side a')
    expect(matchChipText({})).toBeNull()
  })
})
