// Research before Plan in the renderer:
//   - the research card: its sections (summary, features with priorities, standards, recommendations, risks, open
//     questions, sources), the must-haves and recommendations ticked to start, "Use selected" sends the ticked ids and
//     `q<n>=<answer>` entries, "Plan without research" sends core's skip id; the choices keep their labels and the card
//     its rows while ticking and typing; sources are text, never links; the dropped count and the untrusted line;
//   - the Research step: its node before Plan only when core plans it, its facts (lenses, waiting, kept, Auto, note);
//   - the composer: "Research first" (a run override of passes.plan.research), the Lenses menu (passes.plan.researchLenses),
//     the new-work suggestion and the cost note; the pack default; Settings rows.
import '../helpers/rtl.ts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BriefContext, Pack } from '@shared/brief.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { ResearchResult, ResearchView } from '@shared/research.ts'
import type { CardView as CardData, RunSnapshot } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { RESEARCH_CHOICE, researchOf } from '@renderer/components/cards/payload.ts'
import {
  droppedLine,
  NO_WEB_LINE,
  researchInput,
  UNTRUSTED_LINE,
} from '@renderer/components/cards/ResearchBody.tsx'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { keptLines, ResearchFacts, researchLine } from '@renderer/components/run/ResearchFacts.tsx'
import { cardStep, timelineColumns } from '@renderer/components/run/steps.ts'
import { SKIPPABLE } from '@renderer/components/run/text.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { RUN_PHASE_LABEL, stepLabel } from '@renderer/lib/format.ts'
import {
  looksLikeNewWork,
  researchCostText,
  researchLensesOf,
  researchNote,
  researchOnOf,
  toggleLens,
} from '@renderer/pages/dashboard/composer/model.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import coreCards from '../../../src/core/supervisor/cards.ts?raw'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle as settleUi, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  fakeResolve,
  FOLDER,
  GENERIC_LENSES,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

const RESULT: ResearchResult = {
  summary: ['Version flags are table stakes.'],
  features: [
    { id: 'f1', feature: 'Print the version', priority: 'must', sources: ['https://clig.dev/#help'] },
    { id: 'f2', feature: 'Short -v alias', priority: 'could', sources: ['https://clig.dev/#flags'] },
  ],
  standards: [
    { id: 's1', standard: 'GNU --version', why: 'Users expect it', sources: ['https://www.gnu.org/prep/'] },
  ],
  options: [
    {
      id: 'o1',
      topic: 'Version source',
      options: ['package.json', 'a constant'],
      recommendation: 'package.json',
      rationale: 'One source of truth',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ id: 'r1', risk: 'A stale inlined version', sources: ['https://example.org/stale'] }],
  questions: [
    { id: 'q1', question: 'Print the commit too?' },
    { id: 'q2', question: 'Exit code after printing?' },
  ],
  sources: [{ url: 'https://clig.dev/#help', title: 'CLI Guidelines' }],
  dropped: 2,
}

function researchCard(web = true): CardData {
  return {
    id: 'research-1',
    kind: 'research',
    title: 'Review the research',
    body: 'Research found 4 items with sources and 2 open questions.',
    payload: { step: 'research', result: RESULT, suggested: ['f1', 'o1'], web },
    blocking: true,
    defaultChoice: 'use',
    choices: [
      { id: 'use', label: 'Use selected', primary: true, input: 'research' },
      { id: 'skip', label: 'Plan without research' },
    ],
  }
}

// ---- the card ----------------------------------------------------------------------------------------------------------

describe('the research card', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    resetBridgeForTests()
    resetStore()
    clearToasts()
    resetLaterChoicesForTests()
    mock = installMockDimFactory({
      handlers: { 'cards.resolve': () => undefined, 'runs.get': () => snapWith() },
    })
  })
  afterEach(() => {
    mock.uninstall()
    cancelRefetches()
    clearToasts()
    resetBridgeForTests()
  })

  const mount = (web = true): HTMLElement => {
    renderUi(<CardView runId={RUN} card={researchCard(web)} folder={FOLDER} />)
    return screen.getByTestId('card-research')
  }
  const ticked = (id: string): boolean =>
    screen.getByTestId(`research-tick-${id}`).getAttribute('aria-checked') === 'true'

  it('shows every section, the must-haves and recommendations ticked to start, and sources as text', () => {
    const card = mount()
    expect(within(card).getByRole('heading', { name: 'Review the research' })).toBeTruthy()
    for (const s of ['summary', 'features', 'standards', 'options', 'risks', 'questions', 'sources'])
      expect(screen.getByTestId(`research-${s}`)).toBeTruthy()
    expect(ticked('f1')).toBe(true)
    expect(ticked('o1')).toBe(true)
    expect(ticked('f2')).toBe(false)
    expect(ticked('s1')).toBe(false)
    expect(screen.getByTestId('research-priority-f1').textContent).toBe('Must')
    expect(screen.getByTestId('research-priority-f2').textContent).toBe('Could')
    expect(screen.getByTestId('research-item-o1').textContent).toContain('Weighed: package.json, a constant')
    // Untrusted web content: no links anywhere in the card.
    expect(card.querySelectorAll('a')).toHaveLength(0)
    expect(card.textContent).toContain('https://clig.dev/#help')
    expect(screen.getByTestId('research-trust').textContent).toContain(UNTRUSTED_LINE)
    expect(screen.getByTestId('research-dropped').textContent).toBe(
      ' 2 claims were left out because they cited no source.',
    )
    expect(card.textContent).not.toContain(EM_DASH)
  })

  it('says when the run had no web search', () => {
    mount(false)
    expect(screen.getByTestId('research-trust').textContent).toContain(NO_WEB_LINE)
  })

  it('Use selected sends the ticked ids in card order, then one entry per answered question', async () => {
    mount()
    fireEvent.click(screen.getByTestId('research-tick-f1'))
    fireEvent.click(screen.getByTestId('research-tick-s1'))
    fireEvent.click(screen.getByTestId('research-tick-f2'))
    fireEvent.change(screen.getByTestId('research-answer-q2'), { target: { value: '  Zero  ' } })
    const use = screen.getByTestId('card-choice-use')
    expect(use.textContent).toBe('Use selected')
    await act(async () => {
      fireEvent.click(use)
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      {
        runId: RUN,
        cardId: 'research-1',
        choiceId: RESEARCH_CHOICE.use,
        input: ['f2', 's1', 'o1', 'q2=Zero'],
      },
    ])
    expect(screen.getByTestId('card-choice-use').textContent).toBe('Use selected')
    expect(screen.getByTestId('card-choice-skip').textContent).toBe('Plan without research')
  })

  it('ticking and typing add nothing to the card (every row and answer box is there from the start)', () => {
    const card = mount()
    const count = (): number => card.querySelectorAll('li, input, button').length
    const before = count()
    fireEvent.click(screen.getByTestId('research-tick-s1'))
    fireEvent.change(screen.getByTestId('research-answer-q1'), { target: { value: 'Yes' } })
    expect(count()).toBe(before)
  })

  it('Plan without research sends core’s skip id with no input', async () => {
    mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-choice-skip'))
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'research-1', choiceId: RESEARCH_CHOICE.skip },
    ])
  })

  it('reads the payload defensively and builds the input the way core takes it', () => {
    expect(researchOf({ ...researchCard(), payload: null })).toBeNull()
    const bad = researchOf({
      ...researchCard(),
      payload: { result: { features: [{ id: 'f1', feature: 'x', priority: 'urgent' }, { feature: '' }] } },
    })
    expect(bad?.result.features).toEqual([{ id: 'f1', feature: 'x', priority: 'should', sources: [] }])
    expect(bad?.suggested).toEqual([])
    expect(researchInput(RESULT, new Set(['o1', 'f1', 'zz']), { q1: ' ', q2: 'x'.repeat(600) })).toEqual([
      'f1',
      'o1',
      `q2=${'x'.repeat(500)}`,
    ])
    expect(droppedLine(0)).toBe('')
    expect(droppedLine(1)).toBe('One claim was left out because it cited no source.')
  })

  it('its choice ids match core’s', () => {
    const start = coreCards.indexOf('const RESEARCH_CHOICE')
    expect(start).toBeGreaterThan(-1)
    const block = coreCards.slice(start, coreCards.indexOf('}', start))
    expect(block).toContain("use: 'use'")
    expect(block).toContain("skip: 'skip'")
  })
})

// ---- the step ----------------------------------------------------------------------------------------------------------

const keysOf = (snap: RunSnapshot): string[] =>
  timelineColumns(snap).map((c) => (c.kind === 'gate' ? `<${c.gate}>` : c.steps.map((s) => s.key).join('+')))

describe('the Research step', () => {
  it('sits after Clarify and before Plan in the timeline only when core plans it', () => {
    const planned = snapWith({
      summary: { auto: true },
      steps: { clarify: { planned: true }, research: { planned: true } },
    })
    expect(keysOf(planned)).toEqual([
      'preflight',
      'clarify',
      'research',
      'plan',
      'implement',
      'review+critic',
      'fix',
    ])
    expect(keysOf(snapWith({ summary: { auto: true } }))).not.toContain('research')
  })

  it('has its labels, belongs with its card and may be skipped', () => {
    expect(stepLabel('research')).toBe('Research')
    expect(RUN_PHASE_LABEL.researching).toBe('Researching')
    expect(RUN_PHASE_LABEL['research-review']).toBe('Research ready for review')
    expect(cardStep(researchCard())).toBe('research')
    expect(SKIPPABLE.has('research')).toBe(true)
  })

  const view = (o: Partial<ResearchView>): ResearchView => ({
    status: 'pending',
    web: true,
    lenses: [
      { id: 'comparable', label: 'Comparable products', web: true },
      { id: 'repository', label: 'This repository', web: false },
    ],
    ...o,
  })

  it('shows its lenses from the start, then what was kept', () => {
    const { unmount } = render(<ResearchFacts view={view({})} />)
    expect(screen.getByTestId('research-lenses').textContent).toBe('Comparable productsThis repository')
    expect(screen.getByTestId('research-line').textContent).toBe('2 lenses, with web search')
    unmount()
    const chosen = view({ status: 'chosen', result: RESULT, chosen: ['f1', 's1'], answers: { q1: 'No' } })
    render(<ResearchFacts view={chosen} />)
    expect(screen.getByTestId('research-line').textContent).toBe('You kept 3 items for Plan')
    expect(keptLines(chosen)).toEqual([
      'Print the version (must)',
      'GNU --version',
      'Print the commit too? No',
    ])
  })

  it('says when it waits for the review, Auto chose, it was skipped, or core’s note', () => {
    expect(researchLine(view({ web: false, lenses: [view({}).lenses[1]!] }))).toBe(
      '1 lens, this repository only (no web)',
    )
    expect(researchLine(view({ status: 'reviewing', result: RESULT }))).toBe(
      'Findings waiting for your review below',
    )
    expect(researchLine(view({ status: 'chosen', result: RESULT, chosen: ['f1', 'o1'], auto: true }))).toBe(
      'Auto kept 2 items: the must-haves and recommendations',
    )
    expect(researchLine(view({ status: 'skipped' }))).toBe('Plan goes on without the research')
    expect(researchLine(view({ status: 'none', note: 'Nothing cited.' }))).toBe('Nothing cited.')
    for (const s of ['pending', 'reviewing', 'chosen', 'skipped', 'none'] as const)
      expect(researchLine(view({ status: s, result: RESULT }))).not.toContain(EM_DASH)
  })
})

// ---- the composer: model ------------------------------------------------------------------------------------------------

const PACK: Pack = {
  id: 'software',
  version: 1,
  label: 'Software',
  description: 'Code.',
  detect: { keywords: [], files: [] },
  groups: [{ id: 'x', label: 'X', multi: false, other: false, options: [{ id: 'a', label: 'A' }] }],
  research: {
    lenses: [{ id: 'seo', label: 'SEO', ask: 'What do search engines need?', web: true }],
    defaults: ['comparable', 'seo'],
  },
}

describe('the composer model', () => {
  it('suggests Research for new work, never for a bug fix or a short line', () => {
    expect(looksLikeNewWork('Build a habit tracker web app with streaks')).toBe(true)
    expect(looksLikeNewWork('Add a new feature: export the report as PDF')).toBe(true)
    expect(looksLikeNewWork('Fix the crash when saving an empty form')).toBe(false)
    expect(looksLikeNewWork('Refactor the login module')).toBe(false)
    expect(looksLikeNewWork('new app')).toBe(false)
    expect(looksLikeNewWork('Update the copyright year in the footer')).toBe(false)
  })

  it('is on from the pending choice, the config, or the brief pack’s default', () => {
    expect(researchOnOf(null, {})).toBe(false)
    expect(researchOnOf(null, {}, true)).toBe(true)
    expect(researchOnOf(null, { passes: { plan: { research: false } } }, true)).toBe(false)
  })

  it('picks the lenses: pending list, then config, else the pack’s defaults; the last lens stays', () => {
    expect(researchLensesOf(null, {}, GENERIC_LENSES, undefined)).toEqual([
      'comparable',
      'standards',
      'repository',
    ])
    expect(researchLensesOf(null, {}, GENERIC_LENSES, PACK)).toEqual(['comparable', 'seo'])
    expect(
      researchLensesOf(
        null,
        { passes: { plan: { researchLenses: ['pitfalls', 'nope'] } } },
        GENERIC_LENSES,
        PACK,
      ),
    ).toEqual(['pitfalls'])
    expect(researchLensesOf(null, {}, undefined, PACK)).toEqual([])
    const order = ['comparable', 'standards', 'pitfalls', 'repository']
    expect(toggleLens(['repository'], 'comparable', true, order)).toEqual(['comparable', 'repository'])
    expect(toggleLens(['repository'], 'repository', false, order)).toEqual(['repository'])
  })

  it('notes the cost from the estimate, the suggestion and no web; never an em dash', () => {
    const est = runEstimate(
      {},
      { research: { ...runEstimate().steps.plan!, costUsd: { p50: 0.9, p80: 1.6 } } },
    )
    expect(researchCostText(est)).toBe('$0.90 to $1.60')
    expect(researchCostText(runEstimate())).toBeNull()
    const on = researchNote({ on: true, cost: '$0.90 to $1.60', suggest: true, web: true })
    expect(on).toBe(
      'Studies the problem space with cited sources; you pick what Plan uses. Research: about $0.90 to $1.60, web research is token-heavy.',
    )
    const off = researchNote({ on: false, cost: null, suggest: true, web: false })
    expect(off).toContain('Suggested: this looks like a new product or feature.')
    expect(off).toContain("Plan's vendor has no web search, so Research reads this repository only.")
    expect(on + off).not.toContain(EM_DASH)
  })
})

// ---- the composer ------------------------------------------------------------------------------------------------------

function briefContext(): BriefContext {
  return {
    packs: [{ pack: PACK, layer: 'builtin', sha256: '0'.repeat(64) }],
    issues: [],
    category: { id: 'software', source: 'folder', reason: 'Found package.json' },
    facts: { software: [] },
    keywordFields: {},
    saved: null,
    suggest: { vendor: null, model: null, tokens: 0, usd: null, reason: 'none' },
    research: GENERIC_LENSES,
  }
}

describe('the composer: Research first', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'preflight.run': () => report(),
        'estimates.get': () => runEstimate(),
        'brief.detect': () => briefContext(),
      },
    })
    upsertProbes([probe('claude', 'ready')])
  })
  afterEach(() => tearDown(mock))

  it('is off by default; turning it on is a run override of passes.plan.research and the row keeps its size', async () => {
    await mountComposer()
    await settleUi(300)
    const sw = screen.getByTestId('composer-research')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    const lenses = screen.getByTestId('composer-research-lenses')
    expect(lenses.textContent).toBe('Lenses')
    expect(lenses.hasAttribute('disabled')).toBe(true)
    fireEvent.click(sw)
    await settleUi(300)
    const last = mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }
    expect(last.overrides).toEqual({ passes: { plan: { research: true } } })
    expect(screen.getByTestId('composer-research').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('composer-research-lenses').textContent).toBe('Lenses')
    expect(screen.getByTestId('composer-research-lenses').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('composer-research-note').textContent).toMatch(/web research is token-heavy/i)
    expect(screen.getByTestId('composer-research-row').textContent).not.toContain(EM_DASH)
  })

  it('suggests it in the note when the task looks like a new product', async () => {
    await mountComposer()
    await settleUi(300)
    fireEvent.change(screen.getByTestId('composer-task'), {
      target: { value: 'Build a recipe sharing web app with photos' },
    })
    await settleUi(300)
    expect(screen.getByTestId('composer-research-note').textContent).toContain(
      'Suggested: this looks like a new product or feature.',
    )
    // A suggestion, never a choice made for the user.
    expect(screen.getByTestId('composer-research').getAttribute('aria-checked')).toBe('false')
  })

  it('reads on from the resolved config (the thorough profile or a project setting)', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.plan.research = true) }))
    await mountComposer()
    await settleUi(300)
    expect(screen.getByTestId('composer-research').getAttribute('aria-checked')).toBe('true')
  })
})

// ---- Settings ------------------------------------------------------------------------------------------------------------

describe('Settings: Research before Plan', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'verify.detect': () => [],
        'folders.recent': () => [],
        'brief.detect': () => briefContext(),
        'config.patch': () => ({
          path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
          changed: true,
          diff: '',
          backupId: 'b1',
        }),
        'config.restoreBackup': () => ({ path: '', changed: true, diff: '', backupId: null }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  it('writes passes.plan.research and the lens list (Use defaults writes an empty one)', async () => {
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settleUi(SECTION_LOAD_DELAY_MS)
    await settleUi()
    const on = screen.getByTestId('setting-/passes/plan/research')
    expect(on.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(on)
    await settleUi()
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/plan/research', value: true }],
    })
    // With Research on (here the resolved config), the lens picker reads the generic lenses.
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.plan.research = true) }))
    cleanup()
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settleUi(SECTION_LOAD_DELAY_MS)
    await settleUi()
    await settleUi(SECTION_LOAD_DELAY_MS)
    await settleUi()
    expect(mock.callsOf('brief.detect')).toEqual([{}])
    // None chosen: the generic defaults show ticked; ticking one more writes the whole list.
    expect(screen.getByTestId('setting-research-lens-comparable').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('setting-research-lens-pitfalls').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('setting-research-lens-defaults').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('setting-research-lens-pitfalls'))
    await settleUi()
    expect((mock.callsOf('config.patch').at(-1) as { ops: unknown }).ops).toEqual([
      {
        op: 'replace',
        path: '/passes/plan/researchLenses',
        value: ['comparable', 'standards', 'pitfalls', 'repository'],
      },
    ])
    expect(document.body.textContent).not.toContain(EM_DASH)
  })
})
