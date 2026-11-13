// Easy mode's screens on the mock bridge: the welcome card's two equal choices; the home (Next disabled with its reason
// until there is an idea, examples fill the box, the project list); the confirm screen (core's decision, the limit and
// its warning with Raise it, Start with its reason when nobody can run it, Start sending the idea, kind, folder,
// limit and permission); the run's five milestones (always five, fixed height) and the plain cards; the Done screen
// (ready, stopped at a limit with Continue with more); the sidebar switch. UI standards: buttons whose label could
// change reserve every label, and the milestone state reserves every state.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyResolved, EasyState } from '@shared/easy.ts'
import type { AskView, CardView, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { ExperienceSwitch } from '@renderer/components/shell/ExperienceSwitch.tsx'
import { EasyHomePage } from '@renderer/pages/easy/EasyHome.tsx'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { WelcomeCard } from '@renderer/pages/easy/WelcomeCard.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { milestoneViews, plainAsk } from '@renderer/pages/easy/model.ts'
import {
  ALLOW,
  ASK_LABELS,
  DONT_ALLOW,
  MILESTONE_STATE,
  NEXT_DISABLED,
  PLAN_TOGGLE_LABELS,
  START_NEEDS_VENDOR,
  SWITCH_LABELS,
  WELCOME_EASY,
  WELCOME_FULL,
  costStopTitle,
  continueMoreLabel,
  readyTitle,
} from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

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
  idea: 'A landing page for my bakery',
  kind: 'website',
  kindSource: 'words',
  template: { id: 'landing-page', label: 'Landing page prototype' },
  recipe: 'easy-design',
  folder: 'C:\\Users\\me\\Documents\\Dim Factory Projects\\landing-page-bakery',
  folderName: 'landing-page-bakery',
  projectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
  research: true,
  estimate: { durationMs: { p50: 600_000, p80: 1_500_000 }, costUsd: { p50: 1, p80: 3.4 } },
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: false, python: false },
}

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [],
      'easy.resolve': () => RESOLVED,
      'easy.create': () => ({ runId: 'r9', displayNo: 9, folder: RESOLVED.folder }),
      'easy.setExperience': (req) => ({ ...STATE, experience: req.experience }),
      'easy.change': () => ({ runId: 'r10', displayNo: 10, folder: RESOLVED.folder }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'cards.resolve': () => undefined,
      'asks.answer': () => undefined,
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

/** The labels a button reserves (StableLabel / Button `labels`). */
const reserved = (el: HTMLElement): (string | null)[] =>
  [...el.querySelectorAll('[data-label]')].map((x) => x.getAttribute('data-label'))

function snap(over: Parameters<typeof makeSnapshot>[0], edit?: (s: RunSnapshot) => void): RunSnapshot {
  const s = makeSnapshot({ folder: RESOLVED.folder, createdAt: Date.now(), ...over })
  edit?.(s)
  return s
}

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

describe('the welcome card', () => {
  it('asks with two equal choices of one width; Make something chooses Easy and opens its home', async () => {
    render(
      <Providers>
        <WelcomeCard />
      </Providers>,
    )
    const easy = screen.getByTestId('welcome-easy')
    const full = screen.getByTestId('welcome-full')
    expect(reserved(easy)).toEqual([WELCOME_EASY, WELCOME_FULL])
    expect(reserved(full)).toEqual([WELCOME_EASY, WELCOME_FULL])
    fireEvent.click(easy)
    await settle()
    expect(mock.callsOf('easy.setExperience')).toEqual([{ experience: 'easy' }])
    expect(window.location.hash).toBe('#/easy')
  })
})

describe('home', () => {
  it('Next waits for an idea and says why; an example fills the box; Next opens the confirm screen', async () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    await settle()
    const next = screen.getByTestId('easy-next')
    expect((next as HTMLButtonElement).disabled).toBe(true)
    expect(next.closest('[data-disabled-hint]')?.textContent).toContain(NEXT_DISABLED)
    fireEvent.click(screen.getByTestId('easy-example-website'))
    await settle()
    const box = screen.getByTestId<HTMLTextAreaElement>('easy-idea')
    expect(box.value).toMatch(/^A landing page for my bakery/)
    // The examples keep one height whatever their text.
    for (const b of screen.getAllByTestId(/^easy-example-/)) expect(b.className).toContain('h-36')
    fireEvent.click(screen.getByTestId('easy-next'))
    await settle()
    expect(window.location.hash).toBe('#/easy/new')
    expect(screen.queryByTestId('easy-projects-empty')).not.toBeNull()
  })
})

describe('confirm', () => {
  it("shows core's decision, warns when the estimate may pass a limit, and starts with what the user chose", async () => {
    setDraft({ idea: RESOLVED.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-folder').textContent).toBe(RESOLVED.folder)
    expect(screen.getByTestId('easy-estimate').textContent).toBe(
      'Usually 10 to 25 minutes and $1.00 to $3.40.',
    )
    // No limit by default.
    expect(screen.getByTestId('easy-limit-line').textContent).toContain('No spending limit')
    fireEvent.change(screen.getByTestId('easy-limit'), { target: { value: '2' } })
    await settle()
    expect(screen.getByTestId('easy-limit-line').textContent).toContain(
      'This may cost more than your $2 limit. Raise it to $4',
    )
    fireEvent.click(screen.getByTestId('easy-limit-raise'))
    await settle()
    expect(screen.getByTestId<HTMLInputElement>('easy-limit').value).toBe('4')
    fireEvent.click(screen.getByTestId('easy-consent'))
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')).toEqual([
      {
        idea: RESOLVED.idea,
        kind: 'website',
        folder: RESOLVED.folder,
        limits: { maxCostUsd: 4, maxMinutes: null },
        consent: true,
      },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r9')
  })

  it('Start says why it cannot start while nobody is signed in', async () => {
    mock.on('easy.resolve', () => ({ ...RESOLVED, vendors: { claude: false, codex: false, ready: false } }))
    setDraft({ idea: RESOLVED.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    const start = screen.getByTestId('easy-start')
    expect((start as HTMLButtonElement).disabled).toBe(true)
    expect(start.closest('[data-disabled-hint]')?.textContent).toContain(START_NEEDS_VENDOR)
  })
})

describe('the run', () => {
  it('always shows five fixed-height milestones, each reserving every state', async () => {
    showRun(
      snap({ runId: 'r1', status: 'running', phase: 'preflight' }, (s) => {
        s.steps.preflight = { ...s.steps.preflight, status: 'running', attempt: 1 }
      }),
    )
    await settle()
    const rows = within(screen.getByTestId('easy-milestones')).getAllByRole('listitem')
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(r.className).toContain('h-16')
      expect(reserved(r)).toEqual(Object.values(MILESTONE_STATE))
    }
    expect(rows[0]?.getAttribute('data-state')).toBe('working')
  })

  it('asks the questions plainly; You decide sends an empty answer', async () => {
    const card: CardView = {
      id: 'clarify-1',
      kind: 'clarify',
      title: '2 questions before Plan',
      body: '',
      payload: {
        step: 'clarify',
        questions: [
          { question: 'Who will use it?', options: ['Just me', 'Anyone'] },
          { question: 'What tone?', options: ['Friendly', 'Formal'] },
        ],
      },
      blocking: true,
      choices: [
        { id: 'answer', label: 'Use these answers', primary: true, input: 'answers' },
        { id: 'skip', label: 'Skip questions' },
      ],
    }
    showRun(
      snap({ runId: 'r1', status: 'waiting', phase: 'clarifying' }, (s) => {
        s.steps.clarify = { ...s.steps.clarify, status: 'waiting', attempt: 1 }
        s.cards = [card]
      }),
    )
    await settle()
    expect(screen.getByTestId('easy-milestone-understand').getAttribute('data-state')).toBe('needsYou')
    expect(screen.getByTestId('easy-milestone-understand').textContent).toContain('Waiting for your answers')
    fireEvent.click(screen.getByTestId('easy-q-0-opt-1'))
    fireEvent.click(screen.getByTestId('easy-continue'))
    await settle()
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: 'r1', cardId: 'clarify-1', choiceId: 'answer', input: ['Anyone', ''] },
    ])
  })

  it('shows the plan as what it will do; Change something sends the change in the plan', async () => {
    const plan =
      '## Goal\nA page.\n\n## Acceptance criteria\n- A visitor sees the opening hours\n- A visitor can sign up\n'
    const card: CardView = {
      id: 'gate:afterPlan-1',
      kind: 'gate:afterPlan',
      title: 'Review the plan',
      body: plan,
      payload: { plan },
      blocking: true,
      choices: [
        { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
        { id: 'cancel', label: 'Cancel run', danger: true },
      ],
    }
    showRun(
      snap({ runId: 'r1', status: 'waiting', phase: 'plan-review' }, (s) => {
        s.steps.plan = { ...s.steps.plan, status: 'done', attempt: 1 }
        s.cards = [card]
      }),
    )
    await settle()
    expect(screen.getByTestId('easy-plan-will-do').textContent).toContain('A visitor can sign up')
    expect(reserved(screen.getByTestId('easy-plan-toggle'))).toEqual([...PLAN_TOGGLE_LABELS])
    fireEvent.click(screen.getByTestId('easy-change-something'))
    fireEvent.change(screen.getByTestId('easy-plan-change'), {
      target: { value: 'No sign-up, just an email' },
    })
    fireEvent.click(screen.getByTestId('easy-plan-send'))
    await settle()
    const sent = mock.callsOf('cards.resolve')[0]
    expect(sent).toMatchObject({ runId: 'r1', cardId: 'gate:afterPlan-1', choiceId: 'approve' })
    expect(String(sent?.input)).toMatch(
      /## Changes the user asked for before building\n\nNo sign-up, just an email\n$/,
    )
  })

  it("asks in plain words with Allow and Don't allow of one width", async () => {
    const ask: AskView = {
      runId: 'r1',
      step: 'implement',
      attempt: 1,
      requestId: 'q1',
      vendor: 'claude',
      kind: 'shell',
      detail: 'npm install',
      expiresAt: Date.now() + 600_000,
      allowSession: true,
      queue: { index: 1, total: 1 },
    }
    showRun(
      snap({ runId: 'r1', status: 'waiting', phase: 'implementing' }, (s) => {
        s.steps.implement = { ...s.steps.implement, status: 'waiting', attempt: 1 }
        s.asks = [ask]
      }),
    )
    await settle()
    const card = screen.getByTestId('easy-ask')
    expect(card.textContent).toContain('It wants to install building blocks it needs (npm install).')
    expect(reserved(screen.getByTestId('easy-ask-allow'))).toEqual([...ASK_LABELS])
    expect(reserved(screen.getByTestId('easy-ask-deny'))).toEqual([...ASK_LABELS])
    expect(screen.getByTestId('easy-ask-allow').textContent).toBe(ALLOW)
    expect(screen.getByTestId('easy-ask-deny').textContent).toBe(DONT_ALLOW)
    // Armed after a moment, like the Full ask card.
    expect(screen.getByTestId<HTMLButtonElement>('easy-ask-allow').disabled).toBe(true)
    await settle(600)
    fireEvent.click(screen.getByTestId('easy-ask-allow'))
    await settle()
    expect(mock.callsOf('asks.answer')).toEqual([{ runId: 'r1', requestId: 'q1', decision: 'allow' }])
  })
})

describe('done', () => {
  it('says it is ready, by what Easy made it as, with the project name', async () => {
    mock.on('easy.projects', () => [
      {
        folder: RESOLVED.folder,
        name: 'landing-page-bakery',
        kind: 'website',
        lastRunId: 'r1',
        lastDisplayNo: 1,
        lastStatus: 'completed',
        updatedAt: 1,
        runs: 1,
      },
    ])
    showRun(snap({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }))
    await settle()
    expect(screen.getByTestId('easy-done-title').textContent).toBe(readyTitle('website'))
    expect(screen.getByTestId('easy-done-project').textContent).toBe('landing page bakery')
    expect(screen.queryByTestId('easy-open-it')).not.toBeNull()
  })

  it('a run its limit stopped offers to continue with more', async () => {
    mock.on('runs.limits', () => ({
      limits: { maxCostUsd: 5, maxMinutes: null },
      stop: { kind: 'cost', limit: 5, costUsd: 5.2, workedMs: 600_000, at: Date.now() },
    }))
    showRun(snap({ runId: 'r1', status: 'cancelled', phase: 'done' }))
    await settle()
    expect(screen.getByTestId('easy-done-title').textContent).toBe(costStopTitle(5))
    const more = screen.getByTestId('easy-continue-more')
    expect(more.textContent).toBe(continueMoreLabel(3))
    fireEvent.click(more)
    await settle()
    expect(mock.callsOf('easy.change')).toEqual([
      { folder: RESOLVED.folder, continueRunId: 'r1', limits: { maxCostUsd: 3, maxMinutes: null } },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r10')
  })
})

describe('the sidebar switch', () => {
  it('two options of one size; switching to Full on an Easy run opens the same run in the Full view', async () => {
    window.location.hash = '#/easy/runs/r1'
    render(
      <Providers>
        <ExperienceSwitch />
      </Providers>,
    )
    const easy = screen.getByTestId('experience-easy')
    const full = screen.getByTestId('experience-full')
    expect(easy.getAttribute('aria-checked')).toBe('true')
    expect(full.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('experience-switch').className).toContain('grid-cols-2')
    expect(SWITCH_LABELS).toEqual(['Easy', 'Full'])
    fireEvent.click(full)
    await settle()
    expect(mock.callsOf('easy.setExperience')).toEqual([{ experience: 'full' }])
    expect(window.location.hash).toBe('#/runs/r1')
  })
})

describe('the model', () => {
  it('words asks by where they reach, with the safe answer first', () => {
    const folder = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\bakery'
    expect(plainAsk({ kind: 'shell', detail: 'Bash: npm install' }, folder).text).toBe(
      'It wants to install building blocks it needs (npm install). This downloads code from the internet into this project folder.',
    )
    expect(plainAsk({ kind: 'shell', detail: 'npm test' }, folder)).toMatchObject({
      tier: 'inside',
      recommended: 'allow',
    })
    expect(plainAsk({ kind: 'edit', detail: `${folder}\\index.html` }, folder)).toEqual({
      tier: 'inside',
      text: 'It wants to change a file in this project: index.html',
      recommended: 'allow',
    })
    expect(plainAsk({ kind: 'edit', detail: 'C:\\Windows\\hosts' }, folder)).toEqual({
      tier: 'outside',
      text: 'It wants to change a file outside this project: C:\\Windows\\hosts',
      recommended: 'deny',
    })
    expect(plainAsk({ kind: 'network', detail: 'https://api.example.com/v1' }, folder)).toEqual({
      tier: 'outside',
      text: 'It wants to reach a website: api.example.com',
      recommended: 'deny',
    })
    expect(plainAsk({ kind: 'shell', detail: 'del C:\\Users\\me\\notes.txt' }, folder).tier).toBe('outside')
  })

  it('milestones: a finished run with nothing to fix shows fixing as not needed', () => {
    const s = snap({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }, (x) => {
      for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'explain'] as const)
        x.steps[k] = { ...x.steps[k], status: 'done', attempt: 1 }
    })
    expect(milestoneViews(s).map((m) => [m.id, m.state])).toEqual([
      ['understand', 'done'],
      ['build', 'done'],
      ['check', 'done'],
      ['fix', 'notNeeded'],
      ['wrap', 'done'],
    ])
  })

  it('milestones: a run stopped while building', () => {
    const s = snap({ runId: 'r1', status: 'cancelled', phase: 'done' }, (x) => {
      x.steps.plan = { ...x.steps.plan, status: 'done', attempt: 1 }
      x.steps.implement = { ...x.steps.implement, status: 'cancelled', attempt: 1 }
    })
    expect(milestoneViews(s).map((m) => m.state)).toEqual([
      'done',
      'stopped',
      'waiting',
      'waiting',
      'waiting',
    ])
  })
})
