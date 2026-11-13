// Easy's "Make two and pick" on the mock bridge: the confirm screen's choice (One, or Two then pick) with what it
// means and costs, Start sending `two` and going to the page of both versions; that page's two boxes (how each
// stands, never who built it), the one list of what either build needs with each item under its version and no "keep or
// throw away" card, Keep this one applying through the match and moving on to the kept version's Done screen, Keep
// neither, and a version's own run page pointing back to the page where one is kept.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyProjectView, EasyResolved, EasyState } from '@shared/easy.ts'
import type { MatchSideView, MatchView } from '@shared/match.ts'
import type { CardView, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { currentRoute, navigate } from '@renderer/lib/router.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { resetMatchesForTests } from '@renderer/state/matches.ts'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { EasyTwoPage } from '@renderer/pages/easy/EasyTwo.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { canKeep, keptRunId, twoSideState, twoStatus } from '@renderer/pages/easy/two-model.ts'
import {
  TWO_COST_NOTE,
  TWO_HAPPENS_NOTE,
  TWO_NEEDS_LABEL,
  TWO_OFF_LINE,
  TWO_POINTER_TITLE,
  TWO_STATUS,
  TWO_TITLE_READY,
  TWO_TITLE_WORKING,
  twoOnLine,
} from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\help-guide-customers'
const MATCH = '20261111T120000Z-ab12'
const A = '20261111T120001Z-aaaa'
const B = '20261111T120002Z-bbbb'

const STATE: EasyState = {
  experience: 'easy',
  askWelcome: false,
  settings: {
    projectsDir: null,
    maxCostUsd: null,
    changeMaxCostUsd: null,
    maxMinutes: null,
    skipPlanCheck: false,
  },
  projectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
  defaultProjectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
}

const RESOLVED: EasyResolved = {
  idea: 'A help guide for the customers of my knitting shop',
  kind: 'document',
  kindSource: 'words',
  template: { id: 'docs-simple', label: 'Simple guide or docs' },
  recipe: 'easy-documents',
  folder: FOLDER,
  folderName: 'help-guide-customers',
  projectsDir: STATE.projectsDir,
  research: false,
  estimate: null,
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: false, python: false },
}

const PROJECT: EasyProjectView = {
  folder: FOLDER,
  name: 'help-guide-customers',
  title: 'Help guide for the customers of my knitting shop',
  kind: 'document',
  idea: RESOLVED.idea,
  lastRunId: A,
  lastDisplayNo: 1,
  lastStatus: 'running',
  updatedAt: 1,
  runs: 2,
}

const side = (s: 'a' | 'b', over: Partial<MatchSideView> = {}): MatchSideView => ({
  side: s,
  contestant: { vendor: s === 'a' ? 'claude' : 'codex' },
  runId: s === 'a' ? A : B,
  displayNo: s === 'a' ? 1 : 2,
  status: 'running',
  tokens: 100,
  costUsd: s === 'a' ? 0.4 : 0.25,
  filesChanged: 0,
  findings: { must: 0, should: 0 },
  copyState: 'working',
  notApplied: false,
  ...over,
})
const built = (s: 'a' | 'b', over: Partial<MatchSideView> = {}): MatchSideView =>
  side(s, { status: 'waiting', outcome: 'clean', copyState: 'pending', notApplied: true, ...over })

const base = (over: Partial<MatchView> = {}): MatchView => ({
  schemaVersion: 1,
  matchId: MATCH,
  kind: 'headToHead',
  folder: FOLDER,
  folderKey: 'k',
  task: RESOLVED.idea,
  createdAt: 1,
  start: { tree: 'a'.repeat(40), commit: 'b'.repeat(40) },
  sides: [side('a'), side('b')],
  // Names hidden, as Easy starts it; side A is shown first.
  blind: { swap: false },
  waiting: false,
  ready: false,
  ended: false,
  ...over,
})
const ready = (over: Partial<MatchView> = {}): MatchView =>
  base({ sides: [built('a'), built('b')], ready: true, ...over })

const QUESTIONS: CardView = {
  id: 'clarify-1',
  kind: 'clarify',
  title: '1 question before Plan',
  body: '',
  payload: { step: 'clarify', questions: [{ question: 'Who will read it?', options: ['New', 'Regular'] }] },
  blocking: true,
  choices: [
    { id: 'answer', label: 'Use these answers', primary: true, input: 'answers' },
    { id: 'skip', label: 'Skip questions' },
  ],
  createdAt: 1,
} as CardView

const FINALIZE: CardView = {
  id: 'f1',
  kind: 'finalize',
  title: 'Apply the run to your folder?',
  body: 'core words',
  blocking: true,
  choices: [
    { id: 'apply', label: 'Apply to folder', primary: true },
    { id: 'keep', label: 'Keep for later' },
    { id: 'discard', label: 'Discard', danger: true },
  ],
  payload: { step: 'finalize', folder: FOLDER, conflicts: [], files: 2 },
  createdAt: 1,
} as CardView

function snapOf(runId: string, s: 'a' | 'b', cards: CardView[] = []): RunSnapshot {
  const snap = makeSnapshot({
    runId,
    folder: FOLDER,
    isolation: 'worktree',
    createdAt: Date.now(),
    matchOf: { matchId: MATCH, side: s },
    ...(cards.some((c) => c.kind === 'finalize')
      ? { status: 'waiting', worktree: { state: 'pending', notApplied: true } }
      : {}),
  })
  snap.cards = cards
  return snap
}

let mock: MockDimFactory
let current: MatchView
let conflicts: string[]

beforeEach(() => {
  current = base()
  conflicts = []
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  resetMatchesForTests()
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [PROJECT],
      'easy.resolve': () => RESOLVED,
      'easy.create': (req: { two?: boolean }) => ({
        runId: A,
        displayNo: 1,
        folder: FOLDER,
        ...(req.two === true ? { matchId: MATCH } : {}),
      }),
      'easy.permission': () => ({ folder: FOLDER, at: 1, uses: 0, granted: false, runUses: 0 }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'cards.resolve': () => undefined,
      'matches.get': () => current,
      'matches.pick': (req: { side: 'a' | 'b' | 'none' }) => {
        const sides = current.sides.map((s) =>
          s.side === req.side ? { ...s, status: 'completed', copyState: 'applied', notApplied: false } : s,
        ) as MatchView['sides']
        current = {
          ...current,
          sides,
          pick: { side: req.side, at: 5, ...(req.side !== 'none' ? { undoToken: 'tok' } : {}) },
          ...(req.side !== 'none' ? { kept: req.side } : {}),
          blind: { swap: current.blind?.swap === true, revealedAt: 5 },
        }
        return { match: current, conflicts }
      },
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

function load(a: RunSnapshot | null, b: RunSnapshot | null): void {
  const byId: Record<string, RunSnapshot> = {}
  if (a !== null) byId[A] = a
  if (b !== null) byId[B] = b
  mock.on('runs.get', (req: { runId: string }) => byId[req.runId] as RunSnapshot)
  act(() => {
    for (const s of Object.values(byId)) applySnapshot(s)
  })
}

async function showTwo(a: RunSnapshot | null = snapOf(A, 'a'), b: RunSnapshot | null = snapOf(B, 'b')) {
  load(a, b)
  render(
    <Providers>
      <EasyTwoPage matchId={MATCH} />
    </Providers>,
  )
  await settle()
}

const version = (i: 0 | 1): HTMLElement => screen.getByTestId(`easy-two-version-${i}`)

describe('how two versions stand (the model)', () => {
  it('a version: waiting, working, needing an answer, ready, stopped, not finished, kept or not', () => {
    const v = base()
    expect(twoSideState(v, { side: 'b', contestant: { vendor: 'codex' } }, 0)).toBe('waiting')
    expect(twoSideState(v, { side: 'b', contestant: { vendor: 'codex' }, notStarted: 'x' }, 0)).toBe(
      'stopped',
    )
    expect(twoSideState(v, side('a'), 0)).toBe('working')
    expect(twoSideState(v, side('a'), 1)).toBe('needsYou')
    // Still reading what its copy changed: not ready yet.
    expect(twoSideState(v, built('a', { copyState: 'preview' }), 0)).toBe('working')
    expect(twoSideState(v, built('a'), 0)).toBe('ready')
    expect(twoSideState(v, built('a', { status: 'cancelled', endedAt: 9 }), 0)).toBe('stopped')
    expect(twoSideState(v, built('a', { status: 'failed', endedAt: 9 }), 0)).toBe('failed')
    // Failed with its failure still waiting for an answer (the run has not ended): not "working".
    expect(twoSideState(v, side('a', { status: 'failed' }), 1)).toBe('failed')
    // Built nothing that is not already in the folder: nothing to keep.
    expect(twoSideState(v, built('a', { notApplied: false }), 0)).toBe('failed')
    const picked = ready({ pick: { side: 'b', at: 5 }, kept: 'b' })
    expect(twoSideState(picked, picked.sides[0], 0)).toBe('notKept')
    expect(twoSideState(picked, picked.sides[1], 3)).toBe('kept')
  })

  it('the status line and what can be kept, in the order the versions are shown', () => {
    expect(twoStatus(base({ waiting: true }), ['working', 'waiting'])).toBe('waiting')
    expect(twoStatus(base({ waiting: true }), ['needsYou', 'waiting'])).toBe('needsYou')
    expect(twoStatus(base(), ['working', 'working'])).toBe('working')
    expect(twoStatus(base(), ['failed', 'working'])).toBe('failed')
    expect(twoStatus(base({ waiting: true }), ['failed', 'stopped'])).toBe('failed')
    expect(twoStatus(ready(), ['ready', 'ready'])).toBe('ready')
    expect(twoStatus(ready(), ['ready', 'failed'])).toBe('readyOne')
    expect(twoStatus(ready(), ['stopped', 'failed'])).toBe('readyNone')
    // Shown the other way round: side B is the first version.
    const swapped = ready({ blind: { swap: true, revealedAt: 5 }, pick: { side: 'b', at: 5 }, kept: 'b' })
    expect(twoStatus(swapped, ['kept', 'notKept'])).toBe('keptFirst')
    expect(keptRunId(swapped)).toBe(B)
    expect(twoStatus(ready({ pick: { side: 'none', at: 5 } }), ['notKept', 'notKept'])).toBe('keptNone')
    expect(keptRunId(ready({ pick: { side: 'none', at: 5 } }))).toBeUndefined()
    expect(canKeep(ready(), 'ready')).toBe(true)
    expect(canKeep(ready(), 'failed')).toBe(false)
    // One built, the other still going: nothing is kept until both have settled.
    expect(canKeep(base({ sides: [built('a'), side('b')] }), 'ready')).toBe(false)
    expect(canKeep(ready({ pick: { side: 'none', at: 5 } }), 'ready')).toBe(false)
  })
})

describe('the confirm screen', () => {
  it('One by default; Two says what it means and costs; Start sends it and goes to both versions', async () => {
    setDraft({ idea: RESOLVED.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    const choice = screen.getByTestId('easy-two-choice')
    const [one, two] = within(choice).getAllByRole('radio')
    expect(one?.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('easy-two-line').textContent).toBe(TWO_OFF_LINE)
    expect(screen.queryByTestId('easy-two-cost')).toBeNull()
    expect(screen.queryByTestId('easy-two-happens')).toBeNull()
    const width = (two as HTMLElement).textContent
    fireEvent.click(two as HTMLElement)
    expect(two?.getAttribute('aria-checked')).toBe('true')
    // The choice keeps its labels whichever is chosen.
    expect((two as HTMLElement).textContent).toBe(width)
    // One vendor is ready: the same one builds both, and the line does not promise two different ones.
    expect(screen.getByTestId('easy-two-line').textContent).toBe(twoOnLine('twice'))
    expect(twoOnLine('pair')).toContain('each by a different AI')
    expect(screen.getByTestId('easy-two-cost').textContent).toBe(TWO_COST_NOTE)
    expect(screen.getByTestId('easy-two-happens').textContent).toBe(TWO_HAPPENS_NOTE)
    expect(screen.getByTestId('easy-confirm').textContent).not.toContain(EM_DASH)
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')[0]).toMatchObject({ idea: RESOLVED.idea, two: true })
    expect(currentRoute()).toMatchObject({ name: 'easyTwo', matchId: MATCH })
  })

  it('one version sends no `two` and goes to its run', async () => {
    setDraft({ idea: RESOLVED.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')[0]).not.toHaveProperty('two')
    expect(currentRoute()).toMatchObject({ name: 'easyRun', runId: A })
  })
})

describe('the page of both versions', () => {
  it('while they are made: both boxes, no builder named, buttons waiting, Stop both', async () => {
    await showTwo()
    const page = screen.getByTestId('easy-two')
    expect(page.getAttribute('data-status')).toBe('working')
    expect(screen.getByTestId('easy-two-title').textContent).toBe(TWO_TITLE_WORKING)
    expect(screen.getByTestId('easy-two-status').textContent).toBe(TWO_STATUS.working)
    expect(screen.getByTestId('easy-two-project').textContent).toBe(PROJECT.title)
    expect(within(version(0)).getByRole('heading').textContent).toBe('First version')
    expect(within(version(1)).getByRole('heading').textContent).toBe('Second version')
    for (const i of [0, 1] as const) {
      expect(version(i).getAttribute('data-state')).toBe('working')
      expect(within(version(i)).getByTestId('easy-two-open')).toHaveProperty('disabled', true)
      expect(within(version(i)).getByTestId('easy-two-keep')).toHaveProperty('disabled', true)
    }
    expect(within(version(0)).getByTestId('easy-two-spent').textContent).toBe('$0.40 spent')
    expect(screen.getByTestId('easy-two-neither')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('easy-two-go-project')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('easy-stop')).toHaveProperty('disabled', false)
    expect(screen.getByTestId('easy-stop').textContent).toBe('Stop both')
    // Who builds is never said here.
    expect(page.textContent).not.toMatch(/claude|codex/i)
    expect(page.textContent).not.toContain(EM_DASH)
  })

  it('the second version waits while the first asks; its questions are listed under its version', async () => {
    current = base({ sides: [side('a'), { side: 'b', contestant: { vendor: 'codex' } }], waiting: true })
    await showTwo(snapOf(A, 'a', [QUESTIONS]), null)
    expect(screen.getByTestId('easy-two').getAttribute('data-status')).toBe('needsYou')
    expect(version(0).getAttribute('data-state')).toBe('needsYou')
    expect(version(1).getAttribute('data-state')).toBe('waiting')
    expect(within(version(1)).getByTestId('easy-two-spent').textContent).toBe('')
    const needs = screen.getByTestId('easy-needs-you')
    expect(within(needs).getByTestId('easy-needs-version').textContent).toBe(TWO_NEEDS_LABEL[0])
    expect(needs.textContent).toContain('Who will read it?')
  })

  it('shown the other way round, the first version is side B and its label follows', async () => {
    current = base({ blind: { swap: true } })
    await showTwo(snapOf(A, 'a', [QUESTIONS]), snapOf(B, 'b'))
    expect(version(0).getAttribute('data-state')).toBe('working')
    expect(version(1).getAttribute('data-state')).toBe('needsYou')
    expect(screen.getByTestId('easy-needs-version').textContent).toBe(TWO_NEEDS_LABEL[1])
  })

  it('both ready: no keep-or-throw-away card; Keep this one applies it and goes to its Done screen', async () => {
    current = ready()
    await showTwo(snapOf(A, 'a', [FINALIZE]), snapOf(B, 'b', [FINALIZE]))
    expect(screen.getByTestId('easy-two').getAttribute('data-status')).toBe('ready')
    expect(screen.getByTestId('easy-two-title').textContent).toBe(TWO_TITLE_READY)
    // Nothing is left to stop: the choice now is to keep one or neither.
    expect(screen.getByTestId('easy-stop')).toHaveProperty('disabled', true)
    // Each run's own card is answered here, by the pick.
    expect(screen.queryByTestId('easy-card-finalize')).toBeNull()
    expect(screen.getByTestId('easy-needs-you').textContent).toBe('')
    for (const i of [0, 1] as const) {
      expect(version(i).getAttribute('data-state')).toBe('ready')
      expect(within(version(i)).getByTestId('easy-two-open')).toHaveProperty('disabled', false)
      expect(within(version(i)).getByTestId('easy-two-keep')).toHaveProperty('disabled', false)
    }
    fireEvent.click(within(version(1)).getByTestId('easy-two-keep'))
    await settle()
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'b' }])
    expect(currentRoute()).toMatchObject({ name: 'easyRun', runId: B })
  })

  it('after a pick the page says which was kept and leads to the project; nothing can be kept again', async () => {
    current = ready({
      sides: [built('a'), built('b', { status: 'completed', copyState: 'applied', notApplied: false })],
      pick: { side: 'b', at: 5, undoToken: 'tok' },
      kept: 'b',
      blind: { swap: false, revealedAt: 5 },
    })
    await showTwo()
    expect(screen.getByTestId('easy-two-status').textContent).toBe(TWO_STATUS.keptSecond)
    expect(version(0).getAttribute('data-state')).toBe('notKept')
    expect(version(1).getAttribute('data-state')).toBe('kept')
    for (const i of [0, 1] as const) {
      expect(within(version(i)).getByTestId('easy-two-keep')).toHaveProperty('disabled', true)
    }
    expect(screen.getByTestId('easy-two-neither')).toHaveProperty('disabled', true)
    // Names stay out of Easy's page after the pick too.
    expect(screen.getByTestId('easy-two').textContent).not.toMatch(/claude|codex/i)
    fireEvent.click(screen.getByTestId('easy-two-go-project'))
    expect(currentRoute()).toMatchObject({ name: 'easyRun', runId: B })
  })

  it('Keep neither adds nothing and stays; files that could not be added are said, and the page stays', async () => {
    current = ready()
    await showTwo()
    navigate({ name: 'easyTwo', matchId: MATCH })
    fireEvent.click(screen.getByTestId('easy-two-neither'))
    await settle()
    expect(mock.callsOf('matches.pick')).toEqual([{ matchId: MATCH, side: 'none' }])
    expect(screen.getByTestId('easy-two-status').textContent).toBe(TWO_STATUS.keptNone)
    expect(currentRoute()).toMatchObject({ name: 'easyTwo' })
  })

  it('a kept version with files it could not add stays on the page and says how many', async () => {
    current = ready()
    conflicts = ['index.html']
    await showTwo()
    navigate({ name: 'easyTwo', matchId: MATCH })
    fireEvent.click(within(version(0)).getByTestId('easy-two-keep'))
    await settle()
    expect(screen.getByTestId('easy-two-note-page').textContent).toBe(
      '1 file could not be added. Show details to see which.',
    )
    expect(currentRoute()).toMatchObject({ name: 'easyTwo' })
    expect(screen.getByTestId('easy-two-go-project')).toHaveProperty('disabled', false)
  })

  it('one version did not finish: the other can still be kept', async () => {
    current = ready({ sides: [built('a'), built('b', { status: 'failed', endedAt: 9 })] })
    await showTwo()
    expect(screen.getByTestId('easy-two-status').textContent).toBe(TWO_STATUS.readyOne)
    expect(within(version(0)).getByTestId('easy-two-keep')).toHaveProperty('disabled', false)
    expect(within(version(1)).getByTestId('easy-two-keep')).toHaveProperty('disabled', true)
    expect(version(1).getAttribute('data-state')).toBe('failed')
  })

  it('a version that failed while the other builds says so and leads to its own page', async () => {
    current = base({ sides: [side('a', { status: 'failed' }), side('b')] })
    await showTwo()
    expect(screen.getByTestId('easy-two-status').textContent).toBe(TWO_STATUS.failed)
    expect(version(0).getAttribute('data-state')).toBe('failed')
    expect(version(1).getAttribute('data-state')).toBe('working')
    fireEvent.click(within(version(0)).getByTestId('easy-two-see'))
    expect(currentRoute()).toMatchObject({ name: 'easyRun', runId: A })
  })

  it('See this one waits while a version has no run yet', async () => {
    current = base({ sides: [side('a'), { side: 'b', contestant: { vendor: 'codex' } }], waiting: true })
    await showTwo(snapOf(A, 'a'), null)
    expect(within(version(0)).getByTestId('easy-two-see')).toHaveProperty('disabled', false)
    expect(within(version(1)).getByTestId('easy-two-see')).toHaveProperty('disabled', true)
  })
})

describe('a version’s own run page', () => {
  it('points to the page of both versions instead of asking to keep or throw away', async () => {
    const s = snapOf(A, 'a', [FINALIZE])
    load(s, null)
    render(
      <Providers>
        <EasyRunPage runId={A} />
      </Providers>,
    )
    await settle()
    const pointer = screen.getByTestId('easy-two-pointer')
    expect(pointer.textContent).toContain(TWO_POINTER_TITLE)
    expect(screen.queryByTestId('easy-card-finalize')).toBeNull()
    expect(within(pointer).getByTestId('easy-two-pointer-go').getAttribute('href')).toBe(
      `#/easy/two/${MATCH}`,
    )
  })

  it('ended and not the one in the project: its Done screen starts with the way back to both', async () => {
    const s = snapOf(A, 'a')
    s.summary = { ...s.summary, status: 'failed', phase: 'done', endedAt: Date.now() }
    load(s, null)
    render(
      <Providers>
        <EasyRunPage runId={A} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-done')).toBeTruthy()
    expect(screen.getByTestId('easy-two-pointer-go').getAttribute('href')).toBe(`#/easy/two/${MATCH}`)
  })

  it('the version that is in the project has an ordinary Done screen', async () => {
    const s = snapOf(B, 'b')
    s.summary = {
      ...s.summary,
      status: 'completed',
      outcome: 'clean',
      phase: 'done',
      endedAt: Date.now(),
      worktree: { state: 'applied', notApplied: false },
    }
    load(null, s)
    render(
      <Providers>
        <EasyRunPage runId={B} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-done')).toBeTruthy()
    expect(screen.queryByTestId('easy-two-pointer')).toBeNull()
  })
})
