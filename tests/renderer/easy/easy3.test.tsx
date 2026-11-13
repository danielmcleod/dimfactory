// Easy mode's third phase on the mock bridge:
//  - Easy's home: a fixed-size picture on every example card (drawn in the app, nothing loaded), "Work on something I
//    already have" (pick a folder, then its screen), and Make a change on a project Easy did not make going there too;
//  - the folder screen: how it works there as core decided (a copy, in place, or in place once undo is on), Start
//    waiting for what to do (and for "Turn on undo" when it is needed), then easy.work (easy.change for Easy's own);
//  - a vague idea on the confirm screen: "Did you mean a website or an app?" with plain choices, Start waiting for the
//    answer, and the model asked only when the user presses Help me choose (never on its own);
//  - a run in a copy of the folder: "Your changes are ready" with Keep these changes and Throw them away (confirmed
//    first), what became of them with Undo, and the Done screen's "Your changes" in place of Undo everything;
//  - Look it over on a website's Done screen: off with the honest reason when nobody can look; a look on the click,
//    its findings and Fix these;
//  - the overnight list: an idea added (its kind decided locally), Start now, a time, and a launch notice answered.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  EasyFolderView,
  EasyProjectView,
  EasyQueueView,
  EasyResolved,
  EasyState,
  EasyVisualState,
} from '@shared/easy.ts'
import type { CardView, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { EasyExistingPage } from '@renderer/pages/easy/EasyExisting.tsx'
import { EasyHomePage, ProjectList } from '@renderer/pages/easy/EasyHome.tsx'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { EasyOvernightPage } from '@renderer/pages/easy/EasyOvernight.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { draftNow, resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { fixLooksChange } from '@renderer/pages/easy/model.ts'
import {
  CHANGES_THROWING,
  EXISTING_MODE_TEXT,
  START_NEEDS_KIND,
  UNDO_CHECK,
  changesKeptText,
  changesReadyText,
  didYouMeanText,
  helpChooseText,
  overnightScheduleText,
  suggestedText,
} from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const ROOT = 'C:\\Users\\me\\Documents\\Dim Factory Projects'
const SITE = 'C:\\Users\\me\\code\\shop-site'

const STATE: EasyState = {
  experience: 'easy',
  askWelcome: false,
  settings: {
    projectsDir: null,
    maxCostUsd: null,
    changeMaxCostUsd: 2,
    maxMinutes: null,
    skipPlanCheck: false,
  },
  projectsDir: ROOT,
  defaultProjectsDir: ROOT,
}

const VAGUE: EasyResolved = {
  idea: 'Something for my bakery',
  kind: 'app',
  kindSource: 'default',
  ambiguous: {
    candidates: ['website', 'app'],
    helper: { vendor: 'claude', model: 'haiku', usd: 0.004 },
  },
  template: { id: 'static-site', label: 'Static site' },
  recipe: 'easy-software',
  folder: `${ROOT}\\something-bakery`,
  folderName: 'something-bakery',
  projectsDir: ROOT,
  research: true,
  estimate: null,
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: false, python: false },
}

/** The same idea once the user chose a kind (no question). */
const { ambiguous: _ambiguous, ...CLEAR } = VAGUE

const VIEW: EasyFolderView = {
  folder: SITE,
  name: 'shop-site',
  mode: 'isolated',
  made: false,
  vendors: { claude: true, codex: false, ready: true },
}

const OTHER: EasyProjectView = {
  folder: SITE,
  name: 'shop-site',
  lastRunId: 'r7',
  lastDisplayNo: 7,
  lastStatus: 'completed',
  updatedAt: 1,
  runs: 1,
}

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  window.location.hash = '#/easy'
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [OTHER],
      'easy.resolve': (req) =>
        req.kind !== undefined ? { ...CLEAR, kind: req.kind, kindSource: 'chosen' } : VAGUE,
      'easy.inspectFolder': (req) => ({ ...VIEW, folder: req.folder }),
      'easy.work': () => ({ runId: 'r9', displayNo: 9, folder: SITE }),
      'easy.change': () => ({ runId: 'r10', displayNo: 10, folder: SITE }),
      'easy.intent': () => ({ kind: 'website', reason: 'It is about pages people visit.', vendor: 'claude' }),
      'easy.permission': () => ({ folder: SITE, at: 0, uses: 0, granted: false, runUses: 0 }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'cards.resolve': () => undefined,
      'dialog.pickFolder': () => SITE,
      'worktree.undoApply': () => undefined,
      'worktree.apply': () => ({ applied: ['a.html'], conflicts: [], undoToken: 'u2' }),
      'worktree.discard': () => ({ undoToken: 'd1', deleteAt: Date.now() + 10_000 }),
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

function showRun(s: RunSnapshot): void {
  mock.on('runs.get', () => s)
  act(() => {
    applySnapshot(s)
  })
  render(
    <Providers>
      <EasyRunPage runId={s.summary.runId} />
    </Providers>,
  )
}

describe("Easy's home", () => {
  it('every example card has its own picture, one fixed size, drawn in the app', () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    for (const kind of ['app', 'website', 'document', 'data', 'research', 'checklist']) {
      const card = screen.getByTestId(`easy-example-${kind}`)
      const pic = within(card).getByTestId(`easy-thumb-${kind}`)
      expect(pic.tagName.toLowerCase()).toBe('svg')
      expect(pic.getAttribute('aria-hidden')).toBe('true')
      expect(pic.getAttribute('class')).toContain('h-12')
      expect(pic.querySelector('image, use, foreignObject')).toBeNull()
      expect(card.className).toContain('h-36')
    }
  })

  it('Work on something I already have: pick a folder, then its screen', async () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    fireEvent.click(screen.getByTestId('easy-work-existing'))
    await settle()
    expect(mock.callsOf('dialog.pickFolder')).toEqual([{}])
    expect(window.location.hash).toBe(`#/easy/existing?folder=${encodeURIComponent(SITE)}`)
  })

  it('Make a change on a project Easy did not make goes to the folder screen', async () => {
    render(
      <Providers>
        <ProjectList />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('easy-project-change'))
    expect(window.location.hash).toBe(`#/easy/existing?folder=${encodeURIComponent(SITE)}`)
  })
})

describe('a folder you already have', () => {
  function show(folder: string | null = SITE): void {
    render(
      <Providers>
        <EasyExistingPage folder={folder} />
      </Providers>,
    )
  }

  it('a copy when it has commits; Start waits for what to do, then easy.work; never easy.create', async () => {
    show()
    await settle()
    expect(screen.getByTestId('easy-existing-mode').textContent).toBe(EXISTING_MODE_TEXT.isolated)
    expect(screen.getByTestId('easy-existing-limit')).toHaveProperty('value', '2')
    expect(screen.getByTestId('easy-existing-start').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('easy-existing-change'), { target: { value: 'Add a contact page' } })
    fireEvent.click(screen.getByTestId('easy-existing-start'))
    await settle()
    expect(mock.callsOf('easy.work')).toEqual([
      { folder: SITE, change: 'Add a contact page', limits: { maxCostUsd: 2, maxMinutes: null } },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r9')
  })

  it('no repository: Start waits for "Turn on undo for this folder", and sends it', async () => {
    mock.on('easy.inspectFolder', (req) => ({ ...VIEW, folder: req.folder, mode: 'needsUndo' }))
    show()
    await settle()
    expect(screen.getByTestId('easy-existing-mode').textContent).toBe(EXISTING_MODE_TEXT.needsUndo)
    expect(screen.getByTestId('easy-existing-how').textContent).toContain(UNDO_CHECK)
    fireEvent.change(screen.getByTestId('easy-existing-change'), { target: { value: 'Tidy it up' } })
    expect(screen.getByTestId('easy-existing-start').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('easy-existing-undo'))
    fireEvent.click(screen.getByTestId('easy-existing-start'))
    await settle()
    expect(mock.callsOf('easy.work')).toEqual([
      { folder: SITE, change: 'Tidy it up', turnOnUndo: true, limits: { maxCostUsd: 2, maxMinutes: null } },
    ])
  })

  it('a folder it may not use says why, and offers nothing to start', async () => {
    mock.on('easy.inspectFolder', (req) => ({
      name: VIEW.name,
      made: false,
      vendors: VIEW.vendors,
      folder: req.folder,
      problem: 'This is a whole drive. Pick a project folder inside it.',
    }))
    show('C:\\')
    await settle()
    expect(screen.getByTestId('easy-existing-problem').textContent).toContain('whole drive')
    expect(screen.queryByTestId('easy-existing-change')).toBeNull()
    expect(screen.getByTestId('easy-existing-start').hasAttribute('disabled')).toBe(true)
  })

  it('a project Easy made goes through Make a change (its own run)', async () => {
    mock.on('easy.inspectFolder', (req) => ({ ...VIEW, folder: req.folder, mode: 'inPlace', made: true }))
    show()
    await settle()
    fireEvent.change(screen.getByTestId('easy-existing-change'), { target: { value: 'Bigger text' } })
    fireEvent.click(screen.getByTestId('easy-existing-start'))
    await settle()
    expect(mock.callsOf('easy.work')).toEqual([])
    expect(mock.callsOf('easy.change')).toEqual([
      { folder: SITE, change: 'Bigger text', limits: { maxCostUsd: 2, maxMinutes: null } },
    ])
  })
})

describe('a vague idea', () => {
  it('asks "Did you mean a website or an app?"; Start waits; picking one is the answer; no model call', async () => {
    setDraft({ idea: VAGUE.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    const q = screen.getByTestId('easy-did-you-mean')
    expect(within(q).getByRole('heading').textContent).toBe(didYouMeanText(['website', 'app']))
    expect(didYouMeanText(['website', 'app'])).toBe('Did you mean a website or an app?')
    expect(screen.getByTestId('easy-help-choose-cost').textContent).toBe(helpChooseText('claude', 0.004))
    expect(screen.getByTestId('easy-start').hasAttribute('disabled')).toBe(true)
    expect(document.body.innerHTML).toContain(START_NEEDS_KIND)
    fireEvent.click(within(q).getByTestId('easy-meant-website'))
    await settle()
    expect(draftNow().kind).toBe('website')
    expect(screen.queryByTestId('easy-did-you-mean')).toBeNull()
    expect(mock.callsOf('easy.intent')).toEqual([])
  })

  it('Help me choose asks the model once, on the click, and the user still picks', async () => {
    setDraft({ idea: VAGUE.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    expect(mock.callsOf('easy.intent')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-help-choose'))
    await settle()
    expect(mock.callsOf('easy.intent')).toEqual([{ idea: VAGUE.idea, candidates: ['website', 'app'] }])
    expect(screen.getByTestId('easy-help-choose-note').textContent).toBe(
      suggestedText('website', 'It is about pages people visit.'),
    )
    // A suggestion, not a choice: the question stays until the user picks.
    expect(draftNow().kind).toBeUndefined()
    expect(screen.getByTestId('easy-did-you-mean')).toBeTruthy()
  })

  it('nobody can help choose: the honest reason, and no button that would call a model', async () => {
    mock.on('easy.resolve', () => ({
      ...VAGUE,
      ambiguous: {
        candidates: ['website', 'app'],
        helper: null,
        helperReason: 'Help me choose needs Claude or Codex signed in.',
      },
    }))
    setDraft({ idea: VAGUE.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('easy-help-choose')).toBeNull()
    expect(screen.getByTestId('easy-help-choose-off').textContent).toContain('needs Claude or Codex')
  })
})

describe('a run in a copy of the folder', () => {
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
    payload: { step: 'finalize', folder: SITE, conflicts: [], files: 2 },
    createdAt: Date.now(),
  } as CardView

  function isolated(over: Parameters<typeof makeSnapshot>[0], edit?: (s: RunSnapshot) => void): RunSnapshot {
    const s = makeSnapshot({ folder: SITE, isolation: 'worktree', createdAt: Date.now(), ...over })
    edit?.(s)
    return s
  }

  it('"Your changes are ready": Keep these changes applies; Throw them away asks first', async () => {
    showRun(
      isolated({ runId: 'r1', status: 'waiting', phase: 'ready-to-apply' }, (s) => {
        s.cards = [FINALIZE]
        s.steps.finalize = {
          ...s.steps.finalize,
          status: 'waiting',
          finalize: { state: 'pending', files: 2 },
        }
      }),
    )
    await settle()
    const card = screen.getByTestId('easy-card-finalize')
    expect(within(card).getByTestId('easy-finalize-body').textContent).toBe(changesReadyText(2))
    expect(card.textContent).not.toContain('Keep for later')
    fireEvent.click(within(card).getByTestId('easy-throw-away'))
    await settle()
    expect(mock.callsOf('cards.resolve')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-throw-no'))
    await settle()
    expect(mock.callsOf('cards.resolve')).toEqual([])
    fireEvent.click(within(card).getByTestId('easy-keep-changes'))
    await settle()
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: 'r1', cardId: 'f1', choiceId: 'apply' }])
  })

  it('Throw them away, confirmed: core discards; the line says it can still be undone', async () => {
    showRun(
      isolated({ runId: 'r1', status: 'waiting', phase: 'ready-to-apply' }, (s) => {
        s.cards = [FINALIZE]
        s.steps.finalize = {
          ...s.steps.finalize,
          status: 'waiting',
          finalize: { state: 'pending', files: 2 },
        }
      }),
    )
    await settle()
    fireEvent.click(screen.getByTestId('easy-throw-away'))
    await settle()
    fireEvent.click(screen.getByTestId('easy-throw-yes'))
    await settle()
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: 'r1', cardId: 'f1', choiceId: 'discard' }])
  })

  it('kept: the Done screen says so with Undo (the apply’s own), in place of Undo everything', async () => {
    showRun(
      isolated({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }, (s) => {
        s.steps.finalize = {
          ...s.steps.finalize,
          status: 'done',
          finalize: { state: 'applied', files: 2, applied: 2, undoToken: 'u1' },
        }
      }),
    )
    await settle()
    expect(screen.queryByTestId('easy-done-undo')).toBeNull()
    const changes = screen.getByTestId('easy-done-changes')
    expect(within(changes).getByTestId('easy-changes-state').textContent).toBe(changesKeptText(2))
    fireEvent.click(within(changes).getByTestId('easy-changes-undo-apply'))
    await settle()
    expect(mock.callsOf('worktree.undoApply')).toEqual([{ runId: 'r1', undoToken: 'u1' }])
  })

  it('thrown away, still undoable: Undo is there while the copy waits to be deleted', async () => {
    showRun(
      isolated({ runId: 'r1', status: 'waiting', phase: 'ready-to-apply' }, (s) => {
        s.steps.finalize = {
          ...s.steps.finalize,
          status: 'running',
          finalize: { state: 'discarding', files: 2, discardToken: 'd1', deleteAt: Date.now() + 10_000 },
        }
      }),
    )
    await settle()
    expect(screen.getByTestId('easy-changes-state').textContent).toBe(CHANGES_THROWING)
    expect(screen.getByTestId('easy-changes-undo-discard')).toBeTruthy()
  })

  it('left waiting in the copy after the run: Keep these changes again (worktree.apply)', async () => {
    showRun(
      isolated(
        {
          runId: 'r1',
          status: 'completed',
          phase: 'done',
          outcome: 'clean',
          worktree: { state: 'kept', notApplied: true },
        },
        (s) => {
          s.steps.finalize = {
            ...s.steps.finalize,
            status: 'skipped',
            reason: 'kept',
            finalize: { state: 'kept', files: 2 },
          }
        },
      ),
    )
    await settle()
    const changes = screen.getByTestId('easy-done-changes')
    fireEvent.click(within(changes).getByTestId('easy-keep-changes'))
    await settle()
    expect(mock.callsOf('worktree.apply')).toEqual([{ runId: 'r1' }])
  })
})

describe('Look it over', () => {
  const WEBSITE: EasyProjectView = {
    ...OTHER,
    folder: SITE,
    kind: 'website',
    title: 'Bakery site',
    idea: 'x',
  }
  const OFF: EasyVisualState = {
    vendor: null,
    reason:
      'Looking at a picture of the page needs Claude, or Codex on its newer connection, signed in. Neither is ready here, so this is off.',
    usd: null,
    picture: false,
    findings: [],
  }

  function done(): void {
    mock.on('easy.projects', () => [WEBSITE])
    showRun(
      makeSnapshot({
        runId: 'r1',
        folder: SITE,
        status: 'completed',
        phase: 'done',
        outcome: 'clean',
        createdAt: Date.now(),
      }),
    )
  }

  it('off, honestly, when nobody can look at pictures; nothing is called', async () => {
    mock.on('easy.visual', () => OFF)
    done()
    await settle()
    expect(screen.getByTestId('easy-look-who').textContent).toBe(OFF.reason)
    expect(screen.getByTestId('easy-look').hasAttribute('disabled')).toBe(true)
    expect(mock.callsOf('easy.visualReview')).toEqual([])
  })

  it('a look only on the click; its findings, and Fix these as a change', async () => {
    const findings = [
      { id: 'v1', title: 'The grey text is hard to read.', detail: 'At the top: make it darker.' },
    ]
    mock.on('easy.visual', () => ({ vendor: 'claude', usd: 0.02, picture: true, findings: [] }))
    mock.on('easy.visualReview', () => ({ vendor: 'claude', findings }))
    done()
    await settle()
    expect(screen.getByTestId('easy-look-who').textContent).toContain(
      'This sends a picture of the page to Claude.',
    )
    expect(mock.callsOf('easy.visualReview')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-look'))
    await settle()
    expect(mock.callsOf('easy.visualReview')).toEqual([{ runId: 'r1' }])
    expect(screen.getByTestId('easy-look-findings').textContent).toContain('The grey text is hard to read.')
    fireEvent.click(screen.getByTestId('easy-look-fix'))
    await settle()
    expect(mock.callsOf('easy.change')).toEqual([
      { folder: SITE, change: fixLooksChange(findings), limits: { maxCostUsd: 2, maxMinutes: null } },
    ])
  })
})

describe('the overnight list', () => {
  const EMPTY: EasyQueueView = { items: [], state: 'idle', schedule: { enabled: false, start: '22:00' } }
  const ONE: EasyQueueView = {
    ...EMPTY,
    items: [
      { folder: `${ROOT}\\bakery`, title: 'Landing page for my bakery', kind: 'website', status: 'pending' },
    ],
  }

  it('an idea is added (its kind decided locally), then Start now; a time sets the schedule', async () => {
    let view = EMPTY
    mock.on('easy.queue', () => view)
    mock.on('easy.resolve', () => ({ ...CLEAR, kind: 'website' }))
    mock.on('easy.queueAdd', () => (view = ONE))
    mock.on('easy.queueStart', (req) =>
      req.at !== undefined
        ? { ...ONE, schedule: { enabled: true, start: req.at } }
        : { ...ONE, state: 'running' },
    )
    render(
      <Providers>
        <EasyOvernightPage />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-overnight-empty')).toBeTruthy()
    expect(screen.getByTestId('easy-overnight-run').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('easy-overnight-idea'), {
      target: { value: 'A landing page for my bakery' },
    })
    fireEvent.click(screen.getByTestId('easy-overnight-consent'))
    fireEvent.click(screen.getByTestId('easy-overnight-add'))
    await settle()
    expect(mock.callsOf('easy.queueAdd')).toEqual([
      {
        // "Decide from my words": the kind was guessed, so a vague idea can be warned about on the list.
        ideas: [{ idea: 'A landing page for my bakery', kind: 'website', consent: true, guessed: true }],
        limits: { maxCostUsd: null, maxMinutes: null },
      },
    ])
    expect(screen.getAllByTestId('easy-overnight-item')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('easy-overnight-run'))
    await settle()
    expect(mock.callsOf('easy.queueStart')).toEqual([{}])
    fireEvent.change(screen.getByTestId('easy-overnight-time'), { target: { value: '23:15' } })
    fireEvent.click(screen.getByTestId('easy-overnight-set-time'))
    await settle()
    expect(mock.callsOf('easy.queueStart')).toEqual([{}, { at: '23:15' }])
    expect(screen.getByTestId('easy-overnight-when').textContent).toBe(overnightScheduleText('23:15'))
  })

  it('a launch notice waits for the user: Carry on answers it', async () => {
    mock.on('easy.queue', () => ({
      ...ONE,
      notice: { id: 'n1', text: 'The schedule was due while it was closed.' },
    }))
    mock.on('easy.queueStart', () => ({ ...ONE, state: 'running' }))
    render(
      <Providers>
        <EasyOvernightPage />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-overnight-notice').textContent).toContain('was due')
    expect(mock.callsOf('easy.queueStart')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-overnight-carry-on'))
    await settle()
    expect(mock.callsOf('easy.queueStart')).toEqual([{ noticeId: 'n1' }])
  })
})
