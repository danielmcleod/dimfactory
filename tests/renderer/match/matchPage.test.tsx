// The Match page: two sides of one task next to each other (the same facts in the same rows), names hidden until a
// pick when asked, keeping a result and taking the pick back, where the two results differ, and both previews in one
// window. Core is the mock bridge; the diff view is the stand-in the Diff tab's tests use.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '@shared/ipc.ts'
import type { MatchCompare, MatchSideView, MatchView } from '@shared/match.ts'
import { MatchPage, MATCH_LOADING } from '@renderer/pages/match/MatchPage.tsx'
import { BETWEEN_GONE, NO_CHANGES } from '@renderer/pages/match/MatchChanges.tsx'
import {
  HIDDEN,
  OPEN_BOTH_REASON,
  builderText,
  keepBlocked,
  matchStatus,
  sideFacts,
  sideNames,
} from '@renderer/pages/match/text.ts'
import { upsertSummaries } from '@renderer/state/actions.ts'
import { bumpMatch, resetMatchesForTests } from '@renderer/state/matches.ts'
import { upsertPreviewSessions, usePreviewsStore } from '@renderer/state/previews.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

vi.mock('@renderer/components/diff/PatchView.tsx', async () => {
  const h = await import('../diff/helpers.tsx')
  return { PatchView: h.FakePatchView }
})

const MATCH = '20261110T120000Z-ab12'
const A = '20261110T120001Z-aaaa'
const B = '20261110T120002Z-bbbb'

const side = (s: 'a' | 'b', over: Partial<MatchSideView> = {}): MatchSideView => ({
  side: s,
  contestant: s === 'a' ? { vendor: 'claude', model: 'opus' } : { vendor: 'codex', effort: 'high' },
  runId: s === 'a' ? A : B,
  displayNo: s === 'a' ? 12 : 13,
  status: 'waiting',
  tokens: s === 'a' ? 12_300 : 9_000,
  costUsd: s === 'a' ? 0.62 : null,
  filesChanged: s === 'a' ? 3 : 2,
  findings: { must: 0, should: s === 'a' ? 1 : 0 },
  copyState: 'pending',
  notApplied: true,
  detail: {
    closing: s === 'a' ? 'Added the flag and a test.' : 'Added --version.',
    lines: { added: s === 'a' ? 40 : 12, deleted: 2 },
    checks: { passed: 2, failed: s === 'a' ? 0 : 1 },
    grounding: 0,
    buildMs: 90_000,
    reviewers: ['codex'],
    ...(s === 'b' ? { selfReviewed: true } : {}),
  },
  ...over,
})

const base = (over: Partial<MatchView> = {}): MatchView => ({
  schemaVersion: 1,
  matchId: MATCH,
  kind: 'headToHead',
  folder: 'C:\\work\\repo',
  folderKey: 'k',
  task: 'add a --version flag',
  createdAt: 1,
  start: { tree: 'a'.repeat(40), commit: 'b'.repeat(40) },
  sides: [side('a'), side('b')],
  waiting: false,
  ready: true,
  ended: false,
  ...over,
})

const change = (path: string, sha: string, added = 1): FileChange => ({
  status: 'M',
  path,
  oldMode: '100644',
  newMode: '100644',
  oldSha: '0'.repeat(40),
  newSha: sha.repeat(40),
  added,
  deleted: 0,
  binary: false,
  gitlink: false,
  eolOnly: false,
})

const COMPARE: MatchCompare = {
  files: [
    { path: 'src/cli.ts', a: change('src/cli.ts', '1', 9), b: change('src/cli.ts', '2', 4), same: false },
    { path: 'src/onlyA.ts', a: change('src/onlyA.ts', '3') },
    { path: 'src/onlyB.ts', b: change('src/onlyB.ts', '4') },
    { path: 'src/same.ts', a: change('src/same.ts', '5'), b: change('src/same.ts', '5'), same: true },
  ],
  available: { a: true, b: true, between: true },
}

let mock: MockDimFactory
let current: MatchView
let compare: MatchCompare
let conflicts: string[]

beforeEach(() => {
  current = base()
  compare = COMPARE
  conflicts = []
  resetMatchesForTests()
  usePreviewsStore.setState({ byId: {}, smoke: {} })
  mock = setUp({
    handlers: {
      'matches.get': () => current,
      'matches.compare': () => compare,
      'matches.compareFile': () => ({ patch: 'BETWEEN PATCH', truncated: false }),
      'diff.file': (req: { runId: string }) => ({ patch: `OWN ${req.runId}`, truncated: false }),
      'matches.pick': (req: { side: 'a' | 'b' | 'none' }) => {
        const sides = current.sides.map((s) =>
          s.side === req.side ? { ...s, copyState: 'applied', notApplied: false } : s,
        ) as MatchView['sides']
        const { kept: _k, ...rest } = current
        void _k
        current = {
          ...rest,
          sides,
          pick: { side: req.side, at: 5, ...(req.side !== 'none' ? { undoToken: 'tok' } : {}) },
          ...(req.side !== 'none' ? { kept: req.side } : {}),
          ...(current.blind !== undefined ? { blind: { ...current.blind, revealedAt: 5 } } : {}),
        }
        return { match: current, conflicts }
      },
      'matches.undoPick': () => {
        current = base()
        return current
      },
      'matches.blind': (req: { on: boolean }) => {
        current = { ...current, blind: req.on ? { swap: true } : { swap: true, revealedAt: 9 } }
        return current
      },
      'preview.openPair': () => undefined,
    },
  })
  upsertSummaries([
    makeSummary({ runId: A, displayNo: 12, status: 'waiting', matchOf: { matchId: MATCH, side: 'a' } }),
    makeSummary({ runId: B, displayNo: 13, status: 'waiting', matchOf: { matchId: MATCH, side: 'b' } }),
  ])
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <MatchPage matchId={MATCH} />
    </Providers>,
  )
  await settle()
  await settle()
}
const fact = (s: 'a' | 'b', key: string): string => screen.getByTestId(`match-fact-${s}-${key}`).textContent
const button = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)
/** A file's diff view is loaded on demand: let that import and its draw finish. */
const drawn = async (): Promise<void> => {
  await settle()
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  await settle()
}
const click = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByTestId(id))
  await settle()
  await settle()
}

describe('the Match page', () => {
  it('says it is loading, then shows the task, where the match stands and both sides', async () => {
    render(
      <Providers>
        <MatchPage matchId={MATCH} />
      </Providers>,
    )
    expect(screen.getByTestId('match-loading').textContent).toBe(MATCH_LOADING)
    await settle()
    expect(mock.callsOf('matches.get')).toEqual([{ matchId: MATCH }])
    expect(screen.getByTestId('match-task').textContent).toBe('add a --version flag')
    expect(screen.getByTestId('match-status').textContent).toBe('Both sides are built. Keep one, or neither.')
    expect(screen.getByTestId('match-builder-a').textContent).toBe('Claude (opus)')
    expect(screen.getByTestId('match-builder-b').textContent).toBe('Codex (default model, high)')
    expect(screen.getByTestId('match-run-a').getAttribute('href')).toBe(`#/runs/${A}`)
    expect(screen.getByTestId('match-run-b').textContent).toBe('Open run #13')
  })

  it('puts the same facts in the same rows on both cards', async () => {
    await mount()
    const keys = ['checks', 'findings', 'grounding', 'changes', 'time', 'tokens', 'cost', 'reviewers']
    for (const s of ['a', 'b'] as const) for (const k of keys) expect(fact(s, k)).not.toBe('')
    expect(fact('a', 'checks')).toBe('2 passed, 0 failed')
    expect(fact('b', 'checks')).toBe('2 passed, 1 failed')
    expect(fact('a', 'findings')).toBe('0 must fix, 1 should fix')
    expect(fact('a', 'changes')).toBe('3 files, +40 -2')
    expect(fact('b', 'grounding')).toBe('No flags')
    expect(fact('b', 'cost')).toBe('No price')
    expect(fact('a', 'reviewers')).toBe('Codex')
    // A side reviewed by its own vendor says so.
    expect(fact('b', 'reviewers')).toBe('Codex (the same vendor that built it)')
    expect(screen.getByTestId('match-said-a').textContent).toContain('Added the flag and a test.')
    expect(screen.getByTestId('match-said-b').textContent).toContain('Added --version.')
  })

  it('a side that waits for the other’s questions says so in its own rows', async () => {
    current = base({
      waiting: true,
      ready: false,
      sides: [
        side('a', { copyState: 'working', notApplied: false }),
        { side: 'b', contestant: { vendor: 'codex' } },
      ],
    })
    await mount()
    expect(screen.getByTestId('match-status').textContent).toContain('Side B starts from the same answers')
    expect(screen.getByTestId('match-side-b').textContent).toContain('Not started yet')
    expect(fact('b', 'changes')).toBe('Not started')
    expect(button('match-keep-a').disabled).toBe(true)
    expect(button('match-keep-none').disabled).toBe(true)
  })

  it('hidden names: the sides are two results in their shuffled order, and nothing says who built which', async () => {
    current = base({ blind: { swap: true } })
    await mount()
    const page = screen.getByTestId('match-page')
    expect(page.getAttribute('data-blind')).toBe('true')
    const cards = [...page.querySelectorAll('[data-testid^="match-side-"]')].map((c) =>
      c.getAttribute('data-testid'),
    )
    expect(cards).toEqual(['match-side-b', 'match-side-a'])
    expect(screen.getByTestId('match-side-b').getAttribute('aria-label')).toBe('First result')
    expect(screen.getByTestId('match-side-a').getAttribute('aria-label')).toBe('Second result')
    for (const s of ['a', 'b'] as const) {
      expect(screen.getByTestId(`match-builder-${s}`).textContent).toBe(HIDDEN)
      expect(fact(s, 'tokens')).toBe(HIDDEN)
      expect(fact(s, 'cost')).toBe(HIDDEN)
      expect(fact(s, 'reviewers')).toBe(HIDDEN)
      expect(screen.queryByTestId(`match-run-${s}`)).toBeNull()
    }
    expect(page.textContent).not.toMatch(/Claude|Codex|opus|Side A|Side B/)
    // The file list names the results in the order they are shown.
    expect(screen.getByTestId('match-file-src/cli.ts').textContent).toContain(
      'First result +4 -0, Second result +9 -0',
    )
    // What was built is still compared.
    expect(fact('a', 'checks')).toBe('2 passed, 0 failed')

    // Keeping one shows the names, and the cards stay where they were.
    await click('match-keep-b')
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'b' }])
    expect(screen.getByTestId('match-builder-b').textContent).toBe('Codex (default model, high)')
    const after = [...page.querySelectorAll('[data-testid^="match-side-"]')].map((c) =>
      c.getAttribute('data-testid'),
    )
    expect(after).toEqual(['match-side-b', 'match-side-a'])
    expect(button('match-blind').disabled).toBe(true)
  })

  it('the switch hides the names and shows them again', async () => {
    await mount()
    await click('match-blind')
    expect(mock.callsOf('matches.blind')).toEqual([{ matchId: MATCH, on: true }])
    expect(screen.getByTestId('match-builder-a').textContent).toBe(HIDDEN)
    await click('match-blind')
    expect(mock.callsOf('matches.blind').at(-1)).toEqual({ matchId: MATCH, on: false })
    expect(screen.getByTestId('match-builder-a').textContent).toBe('Claude (opus)')
  })

  it('keeping a side says it is in the folder; the buttons keep their labels; Undo takes the pick back', async () => {
    await mount()
    const labels = (): string[] =>
      ['match-keep-a', 'match-keep-b', 'match-keep-none', 'match-undo'].map((id) => button(id).textContent)
    const before = labels()
    expect(button('match-undo').disabled).toBe(true)
    await click('match-keep-a')
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'a' }])
    expect(screen.getByTestId('match-status').textContent).toContain('Side A is in the folder.')
    expect(screen.getByTestId('match-status').textContent).toContain('kept for 7 days')
    expect(screen.getByTestId('match-kept-a').textContent).toBe('In the folder')
    expect(button('match-keep-a').disabled).toBe(true)
    expect(button('match-keep-b').disabled).toBe(true)
    expect(button('match-keep-none').disabled).toBe(true)
    expect(button('match-undo').disabled).toBe(false)
    expect(labels()).toEqual(before)
    expect(screen.getByTestId('match-conflicts').textContent).toBe('')

    await click('match-undo')
    expect(mock.callsOf('matches.undoPick')).toEqual([{ matchId: MATCH }])
    expect(screen.getByTestId('match-status').textContent).toBe('Both sides are built. Keep one, or neither.')
    expect(button('match-keep-b').disabled).toBe(false)
    expect(labels()).toEqual(before)
  })

  it('keeping neither is a pick too', async () => {
    await mount()
    await click('match-keep-none')
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'none' }])
    expect(screen.getByTestId('match-status').textContent).toContain('You kept neither.')
    expect(button('match-undo').disabled).toBe(false)
  })

  it('files the folder changed since the match began are said, with the run to choose in', async () => {
    conflicts = ['src/cli.ts', 'README.md']
    await mount()
    await click('match-keep-b')
    const line = screen.getByTestId('match-conflicts')
    expect(line.textContent).toContain(
      '2 files changed in the folder since the match began and were left as they are.',
    )
    expect(line.querySelector('a')?.getAttribute('href')).toBe(`#/runs/${B}`)
  })

  it('a pick core refuses is said, and nothing changes', async () => {
    mock.on('matches.pick', () => {
      throw mockError('CONFLICT', 'Side A is already in the folder. Undo that in its run first.')
    })
    await mount()
    await click('match-keep-b')
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'Side A is already in the folder. Undo that in its run first.',
    )
    expect(button('match-keep-b').disabled).toBe(false)
  })

  it('where they differ: sorted into four groups, and a file opens against the other result or on its own', async () => {
    await mount()
    expect(mock.callsOf('matches.compare')).toEqual([{ matchId: MATCH }])
    const paths = (id: string): string[] =>
      [...screen.getByTestId(id).querySelectorAll('li')].map((li) => li.getAttribute('data-testid') ?? '')
    expect(paths('match-group-both')).toEqual(['match-file-src/cli.ts'])
    expect(paths('match-group-only-a')).toEqual(['match-file-src/onlyA.ts'])
    expect(paths('match-group-only-b')).toEqual(['match-file-src/onlyB.ts'])
    expect(paths('match-group-same')).toEqual(['match-file-src/same.ts'])
    expect(screen.getByTestId('match-file-src/cli.ts').textContent).toContain('Side A +9 -0, Side B +4 -0')
    // Nothing is read until a file is opened.
    expect(mock.callsOf('matches.compareFile')).toEqual([])
    expect(mock.callsOf('diff.file')).toEqual([])

    fireEvent.click(screen.getByTestId('match-file-src/cli.ts').querySelector('button') as HTMLElement)
    await drawn()
    expect(mock.callsOf('matches.compareFile')).toEqual([{ matchId: MATCH, path: 'src/cli.ts' }])
    expect(screen.getByTestId('patch-view').textContent).toBe('BETWEEN PATCH')
    // Side A's own change against the start.
    const group = screen.getByTestId('match-against-src/cli.ts')
    fireEvent.click(
      [...group.querySelectorAll('button')].find((b) => b.textContent === 'Side A') as HTMLElement,
    )
    await drawn()
    expect(mock.callsOf('diff.file')).toEqual([{ runId: A, seg: 'combined', path: 'src/cli.ts' }])
    expect(screen.getByTestId('patch-view').textContent).toBe(`OWN ${A}`)

    // A file only one side changed opens on that side's change.
    fireEvent.click(screen.getByTestId('match-file-src/onlyB.ts').querySelector('button') as HTMLElement)
    await drawn()
    expect(mock.callsOf('diff.file').at(-1)).toEqual({ runId: B, seg: 'combined', path: 'src/onlyB.ts' })
  })

  it('when a copy is gone the results are not put against each other, and each side’s own change still opens', async () => {
    compare = { ...COMPARE, available: { a: true, b: true, between: false } }
    await mount()
    expect(screen.getByTestId('match-between-gone').textContent).toBe(BETWEEN_GONE)
    fireEvent.click(screen.getByTestId('match-file-src/cli.ts').querySelector('button') as HTMLElement)
    await drawn()
    expect(mock.callsOf('matches.compareFile')).toEqual([])
    expect(mock.callsOf('diff.file')).toEqual([{ runId: A, seg: 'combined', path: 'src/cli.ts' }])
    const options = [...screen.getByTestId('match-against-src/cli.ts').querySelectorAll('button')].map(
      (b) => b.textContent,
    )
    expect(options).toEqual(['Side A', 'Side B'])
  })

  it('no changed file yet is said in the same place', async () => {
    compare = { files: [], available: { a: true, b: true, between: false } }
    await mount()
    expect(screen.getByTestId('match-changes-none').textContent).toBe(NO_CHANGES)
  })

  it('reads the match again when core says it changed, and when a side’s run moves on', async () => {
    await mount()
    const n = mock.callsOf('matches.get').length
    await act(async () => {
      bumpMatch(MATCH)
      await settle()
    })
    expect(mock.callsOf('matches.get').length).toBe(n + 1)
    await act(async () => {
      upsertSummaries([
        makeSummary({
          runId: A,
          displayNo: 12,
          status: 'completed',
          endedAt: 9,
          matchOf: { matchId: MATCH, side: 'a' },
        }),
      ])
      await settle()
    })
    expect(mock.callsOf('matches.get').length).toBe(n + 2)
    // Tokens ticking up are shown from the summary without another read.
    await act(async () => {
      upsertSummaries([
        makeSummary({
          runId: A,
          displayNo: 12,
          status: 'completed',
          endedAt: 9,
          matchOf: { matchId: MATCH, side: 'a' },
          progress: { tokens: 50_000, costUsd: 1.5, filesChanged: 0 },
        }),
      ])
      await settle()
    })
    expect(mock.callsOf('matches.get').length).toBe(n + 2)
    expect(fact('a', 'tokens')).toBe('50.0k')
    expect(fact('a', 'cost')).toBe('$1.50')
  })

  it('both previews open in one window once each side has a page, in the order the sides are shown', async () => {
    await mount()
    expect(button('match-open-both').disabled).toBe(true)
    expect(screen.getByTestId('match-open-both').closest('[role="group"]')?.textContent).toContain(
      'Open both side by side',
    )
    const session = (id: string, runId: string, url: string | null) => ({
      id,
      folder: `C:\\home\\worktrees\\${runId}`,
      runId,
      commandId: 'pkg:dev',
      label: 'dev',
      kind: 'web',
      status: 'running',
      url,
      startedAt: 1,
    })
    await act(async () => {
      upsertPreviewSessions([session('pv_a', A, 'http://127.0.0.1:5173/'), session('pv_b', B, null)] as never)
      await settle()
    })
    // Side B's preview has no page yet.
    expect(button('match-open-both').disabled).toBe(true)
    await act(async () => {
      upsertPreviewSessions([session('pv_b', B, 'http://127.0.0.1:5174/')] as never)
      await settle()
    })
    expect(button('match-open-both').disabled).toBe(false)
    await click('match-open-both')
    expect(mock.callsOf('preview.openPair')).toEqual([
      { sessionIds: ['pv_a', 'pv_b'], labels: ['Side A', 'Side B'] },
    ])
    expect(OPEN_BOTH_REASON).toContain('Run it')
  })

  it('a match that is not there says so, with a way back', async () => {
    mock.on('matches.get', () => {
      throw mockError('NOT_FOUND', 'That match is not here any more.')
    })
    await mount()
    expect(screen.getByText('This match cannot be shown')).toBeTruthy()
    expect(screen.getByText('That match is not here any more.')).toBeTruthy()
    expect(screen.getByText('Go to the Dashboard').getAttribute('href')).toBe('#/')
  })
})

describe('the page’s words (pure)', () => {
  it('names a builder by vendor, model and effort', () => {
    expect(builderText({ vendor: 'claude' })).toBe('Claude')
    expect(builderText({ vendor: 'claude', model: 'opus', effort: 'high' })).toBe('Claude (opus, high)')
    expect(builderText({ vendor: 'codex', model: null, effort: 'low' })).toBe('Codex (default model, low)')
  })

  it('the sides are named by letter, or by place while the names are hidden', () => {
    expect(sideNames({})).toEqual({ a: 'Side A', b: 'Side B' })
    expect(sideNames({ blind: { swap: false } })).toEqual({ a: 'First result', b: 'Second result' })
    expect(sideNames({ blind: { swap: true } })).toEqual({ b: 'First result', a: 'Second result' })
    expect(sideNames({ blind: { swap: true, revealedAt: 3 } })).toEqual({ a: 'Side A', b: 'Side B' })
  })

  it('the shared questions’ cost is said on the side that asked', () => {
    const s = side('a', { detail: { sharedCostUsd: 0.04 } })
    expect(sideFacts(s).find((f) => f.key === 'cost')?.value).toBe(
      '$0.62 ($0.04 of it for the questions and research both sides share)',
    )
    // A run that ended without checks, grounding or a review says so without "yet".
    const ended = sideFacts({ side: 'b', contestant: { vendor: 'codex' }, runId: B, endedAt: 9 })
    const going = sideFacts({ side: 'b', contestant: { vendor: 'codex' }, runId: B })
    const value = (l: { key: string; value: string }[], k: string): string | undefined =>
      l.find((f) => f.key === k)?.value
    expect([value(ended, 'checks'), value(ended, 'grounding'), value(ended, 'reviewers')]).toEqual([
      'No checks ran',
      'Not checked',
      'No review ran',
    ])
    expect(value(going, 'checks')).toBe('No checks ran yet')
    // Nothing known yet reads as that, in the same rows.
    const bare = sideFacts({ side: 'b', contestant: { vendor: 'codex' } })
    expect(bare.map((f) => f.key)).toEqual(sideFacts(s).map((f) => f.key))
    expect(bare.every((f) => f.value !== '')).toBe(true)
  })

  it('where the match stands, and why a side cannot be kept', () => {
    expect(matchStatus(base({ ready: false }))).toBe(
      'Building. Both sides have to finish before one is kept.',
    )
    expect(matchStatus(base({ kept: 'b' }))).toBe('Side B is in the folder.')
    const unstarted = base({
      ready: true,
      sides: [side('a'), { side: 'b', contestant: { vendor: 'codex' }, notStarted: 'Side A stopped first.' }],
    })
    expect(matchStatus(unstarted)).toBe('Side A stopped first.')
    expect(keepBlocked(base(), side('a'))).toBeNull()
    expect(keepBlocked(base({ ready: false }), side('a'))).toBe('Both sides have to finish building first.')
    expect(keepBlocked(base(), side('a', { notApplied: false }))).toBe('This side has no changes to keep.')
    expect(keepBlocked(base({ pick: { side: 'none', at: 1 } }), side('a'))).toContain('Undo it')
    expect(keepBlocked(base({ kept: 'a' }), side('b'))).toBe('A result is already in the folder.')
  })
})
