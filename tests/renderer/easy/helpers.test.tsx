// Easy's beginner helpers on the mock bridge:
//  - Help me think it through on the home screen: off until there is an idea, says what it sends and costs before the
//    click, asks nothing on its own; then rounds of directions (picked, or in the person's own words), a brief that goes
//    into the idea box (with its kind) only on a click, and Stop forgetting it all;
//  - Ask about it on a Done screen: says who reads the files and the cost, asks only on the click, shows the answer and
//    changes nothing;
//  - Before I share it on a website's and a document's Done screen: nothing runs until the click; each check's line;
//    Fix these hands what a change can fix to Make a change, and never the personal details.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyProjectView, EasyState, EasyThinkRequest } from '@shared/easy.ts'
import { EASY_THINK_ROUNDS } from '@shared/easy.ts'
import type { PreviewInfo } from '@shared/preview.ts'
import type { RunSnapshot } from '@shared/run.ts'
import type { ShareFilesReport, SharePageReport } from '@shared/share-check.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { EasyHomePage } from '@renderer/pages/easy/EasyHome.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { draftNow, resetDraftForTests } from '@renderer/pages/easy/draft.ts'
import { THINK_USED, askCostText, thinkCostText } from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const ROOT = 'C:\\Users\\me\\Documents\\Dim Factory Projects'
const SITE = `${ROOT}\\bakery`

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

const WEBSITE: EasyProjectView = {
  folder: SITE,
  name: 'bakery',
  lastRunId: 'r1',
  lastDisplayNo: 1,
  lastStatus: 'completed',
  updatedAt: 1,
  runs: 1,
  kind: 'website',
  title: 'Bakery site',
  idea: 'x',
}

const Q1 = {
  step: 'ask' as const,
  question: 'How should people find out what you bake?',
  options: [
    "One page with today's bread: quick, no ordering",
    'An order form: more work, people order ahead',
  ],
  vendor: 'claude',
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
      'easy.projects': () => [WEBSITE],
      'easy.helperCost': (req) => ({
        helper: { vendor: 'claude', model: req.helper === 'ask' ? 'haiku' : null, usd: 0.02 },
      }),
      'easy.permission': () => ({ folder: SITE, at: 0, uses: 0, granted: false, runUses: 0 }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

function home(): void {
  render(
    <Providers>
      <EasyHomePage />
    </Providers>,
  )
}

const idea = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>('easy-idea')

describe('Help me think it through', () => {
  it('is off until there is an idea, says what it sends and costs, and asks nothing on its own', async () => {
    home()
    await settle()
    expect(screen.getByTestId('easy-think').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('easy-think-cost').textContent).toBe(
      thinkCostText('claude', 0.02, EASY_THINK_ROUNDS),
    )
    expect(screen.queryByTestId('easy-think-panel')).toBeNull()
    fireEvent.change(idea(), { target: { value: 'Something for my bakery' } })
    await settle()
    expect(screen.getByTestId('easy-think').hasAttribute('disabled')).toBe(false)
    expect(mock.callsOf('easy.think')).toEqual([])
  })

  it('is the suggested next step for an idea that leaves out who it is for and what they can do', async () => {
    home()
    await settle()
    const button = (): HTMLElement => screen.getByTestId('easy-think')
    // Off (no idea yet): never suggested.
    expect(button().hasAttribute('data-suggested')).toBe(false)
    fireEvent.change(idea(), { target: { value: 'A recipe app' } })
    await settle()
    expect(button().hasAttribute('data-suggested')).toBe(true)
    const wide = button().className
    fireEvent.change(idea(), { target: { value: 'A recipe app where my friends save and share recipes' } })
    await settle()
    expect(button().hasAttribute('data-suggested')).toBe(false)
    // Only the fill changes: the same size classes, the same label, and nothing is asked.
    const sizes = (c: string): string[] =>
      c
        .split(/s+/)
        .filter((x) => /^(h-|px-|text-|gap-)/.test(x))
        .sort()
    expect(sizes(button().className)).toEqual(sizes(wide))
    expect(mock.callsOf('easy.think')).toEqual([])
  })

  it('rounds of directions, then a brief that goes into the idea box with its kind on a click', async () => {
    const asked: EasyThinkRequest[] = []
    mock.on('easy.think', (req) => {
      asked.push(req)
      return req.turns.length === 0
        ? Q1
        : {
            step: 'brief',
            brief: 'A website for my bakery that shows the bread of the day.',
            kind: 'website',
            vendor: 'claude',
          }
    })
    home()
    await settle()
    fireEvent.change(idea(), { target: { value: 'Something for my bakery' } })
    fireEvent.click(screen.getByTestId('easy-think'))
    await settle()
    expect(asked).toEqual([{ idea: 'Something for my bakery', turns: [] }])
    expect(screen.getByTestId('easy-think-question').textContent).toContain(Q1.question)
    fireEvent.click(screen.getByTestId('easy-think-option-0'))
    await settle()
    expect(asked[1]).toEqual({
      idea: 'Something for my bakery',
      turns: [{ question: Q1.question, options: Q1.options, answer: Q1.options[0] }],
    })
    expect(screen.getByTestId('easy-think-brief-text').textContent).toBe(
      'A website for my bakery that shows the bread of the day.',
    )
    // Nothing goes into the box until the person says so.
    expect(idea().value).toBe('Something for my bakery')
    fireEvent.click(screen.getByTestId('easy-think-use'))
    await settle()
    expect(idea().value).toBe('A website for my bakery that shows the bread of the day.')
    expect(draftNow()).toEqual({
      idea: 'A website for my bakery that shows the bread of the day.',
      kind: 'website',
    })
    expect(screen.getByTestId('easy-think-note').textContent).toBe(THINK_USED)
  })

  it('their own words, Write the brief now, and Stop forgetting it all', async () => {
    const asked: EasyThinkRequest[] = []
    mock.on('easy.think', (req) => {
      asked.push(req)
      return req.finish === true ? { step: 'brief', brief: 'A simple page.', vendor: 'claude' } : Q1
    })
    home()
    await settle()
    fireEvent.change(idea(), { target: { value: 'Something for my bakery' } })
    fireEvent.click(screen.getByTestId('easy-think'))
    await settle()
    expect(screen.getByTestId('easy-think-send').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('easy-think-own'), { target: { value: 'The first, with photos' } })
    fireEvent.click(screen.getByTestId('easy-think-send'))
    await settle()
    expect(asked[1]?.turns.map((t) => t.answer)).toEqual(['The first, with photos'])
    fireEvent.click(screen.getByTestId('easy-think-finish'))
    await settle()
    expect(asked[2]).toEqual({ ...asked[1], finish: true })
    expect(screen.getByTestId('easy-think-brief-text').textContent).toBe('A simple page.')
    fireEvent.click(screen.getByTestId('easy-think-stop'))
    await settle()
    expect(screen.queryByTestId('easy-think-panel')).toBeNull()
    expect(idea().value).toBe('Something for my bakery')
  })

  it('a refusal (nobody signed in) is said plainly, and the button is off with the reason', async () => {
    mock.on('easy.helperCost', () => ({
      helper: null,
      reason: 'Help me think it through needs Claude or Codex signed in.',
    }))
    home()
    await settle()
    fireEvent.change(idea(), { target: { value: 'Something' } })
    await settle()
    expect(screen.getByTestId('easy-think').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('easy-think-cost').textContent).toBe(
      'Help me think it through needs Claude or Codex signed in.',
    )
  })
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

describe('Ask about it', () => {
  const done = (): void =>
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

  it('says who reads the files and the cost; asks only on the click; shows the answer; changes nothing', async () => {
    mock.on('easy.ask', () => ({
      answer: 'Open **styles.css**: the colours are at the top.',
      vendor: 'claude',
      model: 'haiku',
    }))
    done()
    await settle()
    expect(mock.callsOf('easy.helperCost')).toContainEqual({ helper: 'ask', runId: 'r1' })
    expect(screen.getByTestId('easy-ask-cost').textContent).toBe(askCostText('claude', 0.02))
    expect(screen.getByTestId('easy-ask').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('easy-ask-question'), {
      target: { value: '  How do I change the colours? ' },
    })
    await settle()
    expect(mock.callsOf('easy.ask')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-ask'))
    await settle()
    expect(mock.callsOf('easy.ask')).toEqual([{ runId: 'r1', question: 'How do I change the colours?' }])
    expect(screen.getByTestId('easy-ask-answer').textContent).toContain('the colours are at the top')
    expect(mock.callsOf('easy.change')).toEqual([])
  })

  it('an error is said plainly under the button', async () => {
    mock.on('easy.ask', () => {
      throw new Error('Ask about it took longer than 180 s, so Dim Factory stopped it.')
    })
    done()
    await settle()
    fireEvent.change(screen.getByTestId('easy-ask-question'), { target: { value: 'What is this?' } })
    fireEvent.click(screen.getByTestId('easy-ask'))
    await settle()
    expect(screen.getByTestId('easy-ask-note').textContent).toContain('took longer than 180 s')
    expect(screen.queryByTestId('easy-ask-answer')).toBeNull()
  })
})

describe('Before I share it', () => {
  const INFO = (): PreviewInfo => ({
    folder: SITE,
    scopeRoot: SITE,
    trustFolder: SITE,
    runId: 'r1',
    commands: [
      {
        id: 'static:.',
        label: 'Serve index.html',
        kind: 'static',
        source: 'static',
        argv: [],
        cwdRel: '.',
        staticRoot: '.',
        trust: 'none',
      },
    ],
    checks: [],
    runMd: null,
    sessions: [],
    smoke: null,
    openIn: 'app',
  })
  const PAGE: SharePageReport = {
    url: 'http://127.0.0.1:5000/',
    loaded: true,
    title: 'Vite + React',
    viewport: true,
    phone: { width: 390, wide: true, part: 'a table' },
    links: { checked: 2, broken: ['menu.html'], otherSites: 0, more: false },
    failedFiles: [],
  }
  const FILES: ShareFilesReport = {
    read: 3,
    truncated: false,
    secrets: [],
    publicKeys: [],
    envFiles: [],
    personal: [{ file: 'index.html', line: 4, kind: 'email', masked: 'j***@gmail.com' }],
    brokenFileLinks: [],
  }

  const done = (kind: 'website' | 'document'): void => {
    mock.on('easy.projects', () => [{ ...WEBSITE, kind }])
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

  it("a website: nothing until the click; then each check's line, and Fix these without the personal details", async () => {
    mock.on('preview.detect', INFO)
    mock.on('preview.start', (req) => ({
      id: 'pv1',
      folder: SITE,
      runId: 'r1',
      commandId: req.commandId,
      label: 'Serve index.html',
      kind: 'static',
      status: 'running',
      url: 'http://127.0.0.1:5000/',
      startedAt: 1,
      tail: [],
      lines: 0,
    }))
    mock.on('preview.shareCheck', () => PAGE)
    mock.on('easy.shareFiles', () => FILES)
    done('website')
    await settle()
    expect(screen.getByTestId('easy-done-share-check').textContent).toContain('What it cannot know')
    expect(mock.callsOf('preview.shareCheck')).toEqual([])
    expect(mock.callsOf('easy.shareFiles')).toEqual([])
    fireEvent.click(screen.getByTestId('easy-share-check'))
    await settle()
    expect(mock.callsOf('preview.shareCheck')).toEqual([{ sessionId: 'pv1' }])
    expect(mock.callsOf('easy.shareFiles')).toEqual([{ runId: 'r1' }])
    const lines = screen.getByTestId('easy-share-check-lines')
    const status = (id: string): string | null =>
      lines.querySelector(`[data-check="${id}"]`)?.getAttribute('data-status') ?? null
    expect(status('title')).toBe('problem')
    expect(status('image')).toBe('problem')
    expect(status('phone')).toBe('problem')
    expect(status('links')).toBe('problem')
    expect(status('secrets')).toBe('ok')
    expect(status('personal')).toBe('unknown')
    expect(lines.textContent).toContain('j***@gmail.com')
    fireEvent.click(screen.getByTestId('easy-share-check-fix'))
    await settle()
    const box = screen.getByTestId<HTMLTextAreaElement>('easy-change-text')
    expect(box.value).toContain('A check before sharing found these problems')
    expect(box.value).toContain('menu.html')
    expect(box.value).not.toContain('gmail')
    expect(mock.callsOf('easy.change')).toEqual([])
  })

  it('a document: its files only, no page is opened', async () => {
    mock.on('easy.shareFiles', () => ({
      ...FILES,
      personal: [],
      brokenFileLinks: ['guide.md links to setup.md'],
    }))
    done('document')
    await settle()
    fireEvent.click(screen.getByTestId('easy-share-check'))
    await settle()
    expect(mock.callsOf('preview.shareCheck')).toEqual([])
    expect(mock.callsOf('preview.start')).toEqual([])
    const lines = screen.getByTestId('easy-share-check-lines')
    expect([...lines.querySelectorAll('[data-check]')].map((l) => l.getAttribute('data-check'))).toEqual([
      'links',
      'secrets',
      'personal',
    ])
    expect(screen.getByTestId('easy-share-check-note').textContent).toBe('1 thing to fix.')
  })
})
