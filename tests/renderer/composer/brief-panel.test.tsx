// The composer's Brief panel: collapsed by default to one line (category + counts), opened by the user into the
// category, the folder's facts (locked), one row per group starting on "Let Dim Factory decide", the approach group's
// tags, "Other" text, Suggest choices (only on click; pre-ticked answers with reasons; errors), Reset, a saved brief
// restored, keyword choices for untouched groups only, and what is sent (runs.start and the live checks get the brief
// only when it says something). Nothing moves on its own: the summary and status lines keep their fixed heights
// before and after core's detection answers.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BriefContext, BriefInput, BriefSuggestResult, Pack } from '@shared/brief.ts'
import type { Req } from '@shared/ipc.ts'
import {
  BRIEF_DETECT_DEBOUNCE_MS,
  BRIEF_SAVE_DEBOUNCE_MS,
} from '@renderer/pages/dashboard/composer/useBrief.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, GENERIC_LENSES, mountComposer, report, runEstimate } from './fixtures.tsx'

const SOFTWARE: Pack = {
  id: 'software',
  version: 1,
  label: 'Software',
  description: 'Apps, sites, services, tools and libraries: code that runs.',
  detect: { keywords: ['app'], files: ['package.json'] },
  groups: [
    {
      id: 'projectType',
      label: 'Project type',
      hint: 'What kind of software this is.',
      multi: false,
      other: true,
      options: [
        { id: 'cli', label: 'CLI or script' },
        { id: 'api', label: 'API or backend service' },
      ],
    },
    {
      id: 'language',
      label: 'Language',
      multi: true,
      other: true,
      options: [
        { id: 'typescript', label: 'TypeScript' },
        { id: 'python', label: 'Python' },
        { id: 'go', label: 'Go' },
      ],
    },
    {
      id: 'uiFramework',
      label: 'UI framework',
      multi: false,
      other: false,
      options: [
        { id: 'react', label: 'React' },
        { id: 'vue', label: 'Vue' },
      ],
    },
    {
      id: 'approach',
      label: 'Approach',
      multi: true,
      other: false,
      options: [
        {
          id: 'test-first',
          label: 'Test-first',
          hint: 'Write failing tests from the goals first, then make them pass.',
          effect: 'pipeline',
          guidance: 'Tests first.',
        },
        {
          id: 'contract-first',
          label: 'Contract first',
          hint: 'Agree the interfaces first.',
          effect: 'plan',
          guidance: 'Contracts first.',
        },
      ],
    },
  ],
}

const DOCUMENTS: Pack = {
  id: 'documents',
  version: 1,
  label: 'Documents',
  description: 'Reports, guides and other writing.',
  detect: { keywords: ['report'], files: [] },
  groups: [
    {
      id: 'tone',
      label: 'Tone',
      multi: false,
      other: false,
      options: [
        { id: 'formal', label: 'Formal' },
        { id: 'friendly', label: 'Friendly' },
      ],
    },
  ],
}

function context(over: Partial<BriefContext> = {}): BriefContext {
  return {
    packs: [
      { pack: SOFTWARE, layer: 'builtin', sha256: '0'.repeat(64) },
      { pack: DOCUMENTS, layer: 'builtin', sha256: '1'.repeat(64) },
    ],
    issues: [],
    category: { id: 'software', source: 'folder', reason: 'Found package.json in the folder' },
    facts: {
      software: [
        { group: 'language', option: 'typescript', label: 'TypeScript', evidence: 'tsconfig.json' },
        { group: 'uiFramework', option: 'react', label: 'React', evidence: 'package.json' },
        { group: 'packageManager', label: 'pnpm', evidence: 'pnpm-lock.yaml' },
      ],
    },
    keywordFields: {},
    saved: null,
    suggest: { vendor: 'claude', model: 'sonnet', tokens: 4200, usd: 0.012 },
    research: GENERIC_LENSES,
    ...over,
  }
}

let mock: MockDimFactory
let detectAnswer: (req: Req<'brief.detect'>) => BriefContext | Promise<BriefContext>
let suggestAnswer: () => BriefSuggestResult | Promise<BriefSuggestResult>

beforeEach(() => {
  detectAnswer = () => context()
  suggestAnswer = () => ({ category: 'software', suggestions: [], vendor: 'claude', model: 'sonnet' })
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'runs.start': () => ({ runId: 'r9', displayNo: 9 }),
      'brief.detect': (req) => detectAnswer(req),
      'brief.save': () => undefined,
      'brief.suggest': () => suggestAnswer(),
    },
  })
})

afterEach(() => tearDown(mock))

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
}

async function open(): Promise<void> {
  fireEvent.click(screen.getByTestId('brief-toggle'))
  await settle()
}

async function typeTask(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: text } })
  await settle()
}

const el = (id: string): HTMLElement => screen.getByTestId(id)
const summary = (): string => el('brief-summary').textContent ?? ''
const checked = (id: string): string | null => {
  const e = el(id)
  return e.getAttribute('aria-checked') ?? e.getAttribute('aria-pressed')
}

async function click(id: string): Promise<void> {
  fireEvent.click(el(id))
  await settle()
}

const saves = (): Req<'brief.save'>[] => mock.callsOf('brief.save')

describe('Brief panel: collapsed', () => {
  it('is one line, collapsed by default: the category with its detected mark and the counts', async () => {
    await ready()
    expect(el('brief-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('brief-panel')).toBeNull()
    expect(el('brief-category').textContent).toContain('Software')
    expect(el('brief-category-detected').className).not.toContain('invisible')
    // Facts that lock a group count; the package manager (no such group) does not.
    expect(summary()).toBe('0 choices · 2 from this repo')
    expect(el('brief-test-first').className).toContain('invisible')
    expect(mock.callsOf('brief.detect')[0]).toEqual({ folder: FOLDER })
  })

  it('keeps the same line, elements and heights before and after detection answers', async () => {
    let answer: (c: BriefContext) => void = () => undefined
    detectAnswer = () =>
      new Promise<BriefContext>((r) => {
        answer = r
      })
    await ready()
    const shape = (): Record<string, string> => ({
      line: el('brief-line').className,
      category: el('brief-category').className,
      tag: el('brief-test-first').className,
      summary: el('brief-summary').className,
    })
    const before = shape()
    expect(before.line).toContain('h-6')
    expect(before.category).toContain('w-44')
    expect(el('brief-category').dataset['pending']).toBe('true')
    expect(summary()).toBe('Reading this folder…')
    await act(async () => {
      answer(context())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(shape()).toEqual(before)
    expect(el('brief-category').dataset['pending']).toBeUndefined()
    expect(summary()).toBe('0 choices · 2 from this repo')
  })

  it('reserves the open panel height while detection is on its way, and keeps the status line fixed', async () => {
    window.localStorage.setItem('dimf.composer.briefOpen', '1')
    window.localStorage.setItem('dimf.composer.briefHeight', '333')
    let answer: (c: BriefContext) => void = () => undefined
    detectAnswer = () =>
      new Promise<BriefContext>((r) => {
        answer = r
      })
    await ready()
    expect(el('brief-panel').style.minHeight).toBe('333px')
    await act(async () => {
      answer(context())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(el('brief-panel').style.minHeight).toBe('')
    expect(el('brief-suggest-status').className).toContain('h-5')
    expect(el('brief-actions').className).toContain('h-7')
  })
})

describe('Brief panel: open', () => {
  it('shows the categories, the facts (locked with a lock) and every group on "Let Dim Factory decide"', async () => {
    await ready()
    await open()
    expect(el('brief-toggle').getAttribute('aria-expanded')).toBe('true')
    const cats = within(el('brief-categories')).getAllByRole('radio')
    expect(cats.map((c) => c.textContent)).toEqual(['Softwaredetected', 'Documents'])
    expect(checked('brief-category-software')).toBe('true')

    const ts = el('brief-fact-language-typescript')
    expect(ts.dataset['locked']).toBe('true')
    expect(ts.querySelector('svg')).not.toBeNull()
    expect(ts.getAttribute('aria-description')).toBe('TypeScript (from tsconfig.json)')
    const pnpm = el('brief-fact-packageManager')
    expect(pnpm.dataset['locked']).toBeUndefined()

    expect(checked('brief-decide-projectType')).toBe('true')
    expect(el('brief-decide-projectType').getAttribute('role')).toBe('radio')
    expect(checked('brief-option-projectType-cli')).toBe('false')
    // A multi-choice group's chips are toggle buttons.
    expect(el('brief-option-language-python').getAttribute('aria-pressed')).toBe('false')
    // The locked option: on, not clickable, with its lock and where it came from.
    const locked = el('brief-option-language-typescript')
    expect(locked.getAttribute('aria-pressed')).toBe('true')
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    expect(locked.querySelector('svg')).not.toBeNull()
    expect(locked.getAttribute('aria-description')).toBe('TypeScript (from tsconfig.json)')
  })

  it('locks a single-choice group a fact fixes: its other chips and "decide" are disabled', async () => {
    await ready()
    await open()
    expect(checked('brief-option-uiFramework-react')).toBe('true')
    expect(el('brief-option-uiFramework-react').getAttribute('aria-disabled')).toBe('true')
    expect(el('brief-option-uiFramework-vue').getAttribute('aria-disabled')).toBe('true')
    expect(el('brief-decide-uiFramework').getAttribute('aria-disabled')).toBe('true')
    expect(checked('brief-decide-uiFramework')).toBe('false')
    await click('brief-option-uiFramework-vue')
    expect(checked('brief-option-uiFramework-vue')).toBe('false')
  })

  it('toggles single and multi groups, updates the summary and saves once, debounced', async () => {
    await ready()
    await open()
    await click('brief-option-projectType-cli')
    expect(checked('brief-option-projectType-cli')).toBe('true')
    expect(checked('brief-decide-projectType')).toBe('false')
    await click('brief-option-projectType-api')
    // A single-choice group is a radio group.
    expect(checked('brief-option-projectType-cli')).toBe('false')
    expect(checked('brief-option-projectType-api')).toBe('true')
    await click('brief-option-language-python')
    await click('brief-option-language-go')
    expect(checked('brief-option-language-python')).toBe('true')
    expect(checked('brief-option-language-go')).toBe('true')
    expect(summary()).toBe('2 choices · 2 from this repo')
    expect(saves()).toEqual([])
    await settle(BRIEF_SAVE_DEBOUNCE_MS)
    expect(saves()).toEqual([
      {
        folder: FOLDER,
        brief: {
          category: 'software',
          fields: {
            projectType: { choices: ['api'], source: 'user' },
            language: { choices: ['python', 'go'], source: 'user' },
          },
        },
      },
    ])
    // Unticking the last one goes back to "decide".
    await click('brief-option-projectType-api')
    expect(checked('brief-decide-projectType')).toBe('true')
    expect(summary()).toBe('1 choice · 2 from this repo')
  })

  it('takes "Other" text in a slot of its own width', async () => {
    await ready()
    await open()
    const slot = el('brief-other-projectType-slot')
    expect(slot.className).toContain('w-44')
    await click('brief-other-projectType')
    const input = el('brief-other-projectType-input') as HTMLInputElement
    expect(input.maxLength).toBe(200)
    expect(slot.contains(input)).toBe(true)
    fireEvent.change(input, { target: { value: 'Kiosk app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(el('brief-other-projectType').textContent).toBe('Other: Kiosk app')
    expect(checked('brief-other-projectType')).toBe('true')
    expect(checked('brief-decide-projectType')).toBe('false')
    await settle(BRIEF_SAVE_DEBOUNCE_MS)
    expect(saves().at(-1)?.brief?.fields['projectType']).toEqual({
      choices: [],
      other: 'Kiosk app',
      source: 'user',
    })
  })

  it('tags the approach options and marks Test-first in the summary line', async () => {
    await ready()
    await open()
    expect(el('brief-option-approach-test-first').textContent).toContain('Adds a Tests step')
    expect(el('brief-option-approach-contract-first').textContent).toContain('Guides the plan')
    await click('brief-option-approach-test-first')
    expect(el('brief-test-first').className).not.toContain('invisible')
    expect(el('brief-test-first').textContent).toBe('Test-first')
  })

  it('keeps each category its own choices', async () => {
    await ready()
    await open()
    await click('brief-option-projectType-cli')
    await click('brief-category-documents')
    expect(screen.queryByTestId('brief-group-projectType')).toBeNull()
    await click('brief-option-tone-formal')
    await click('brief-category-software')
    expect(checked('brief-option-projectType-cli')).toBe('true')
    await click('brief-category-documents')
    expect(checked('brief-option-tone-formal')).toBe('true')
  })
})

describe('Brief panel: Suggest choices and Reset', () => {
  it('calls brief.suggest only on click, and pre-ticks the answers with their reasons', async () => {
    suggestAnswer = () => ({
      category: 'software',
      vendor: 'claude',
      model: 'sonnet',
      suggestions: [
        { group: 'projectType', choices: ['api'], reason: 'The task talks about endpoints.' },
        { group: 'language', choices: ['go'], reason: 'The task asks for Go.' },
        { group: 'approach', choices: ['test-first'], reason: 'A clear contract to test.' },
      ],
    })
    await ready()
    await typeTask('Add a health endpoint')
    await open()
    // The user's own choice is kept: suggestions fill only groups the user has not set.
    await click('brief-option-projectType-cli')
    expect(el('brief-suggest-hint').textContent).toBe(
      'One read-only call to Claude (sonnet), about 4k tokens (about $0.01)',
    )
    await settle(2000)
    expect(mock.callsOf('brief.suggest')).toEqual([])
    const button = el('brief-suggest')
    const classes = button.className
    await click('brief-suggest')
    expect(mock.callsOf('brief.suggest')).toHaveLength(1)
    const req = mock.callsOf('brief.suggest')[0]!
    expect(req.folder).toBe(FOLDER)
    expect(req.task).toBe('Add a health endpoint')
    expect(req.brief.category).toBe('software')
    expect(el('brief-suggest-status').textContent).toBe('Suggested 2 choices. Hover a chip to see why.')
    expect(checked('brief-option-projectType-cli')).toBe('true')
    expect(checked('brief-option-projectType-api')).toBe('false')
    const go = el('brief-option-language-go')
    expect(go.getAttribute('aria-pressed')).toBe('true')
    expect(go.dataset['source']).toBe('suggested')
    expect(go.getAttribute('aria-description')).toBe('The task asks for Go.')
    expect(el('brief-option-approach-test-first').dataset['source']).toBe('suggested')
    // The button never changed: the same classes and label.
    expect(el('brief-suggest')).toBe(button)
    expect(button.className).toBe(classes)
    expect(button.textContent).toBe('Suggest choices')
  })

  it('shows the spinner in the icon slot while suggesting, and the error message when it fails', async () => {
    let fail: (e: Error) => void = () => undefined
    suggestAnswer = () =>
      new Promise<BriefSuggestResult>((_, reject) => {
        fail = reject
      })
    await ready()
    await typeTask('Add a health endpoint')
    await open()
    await click('brief-suggest')
    const button = el('brief-suggest')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('[data-spinner]')).not.toBeNull()
    expect(button.textContent).toBe('Suggest choices')
    expect(el('brief-suggest-status').textContent).toBe('Suggesting…')
    await act(async () => {
      fail(mockError('SPAWN', 'Claude needs you to log in'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(el('brief-suggest-status').textContent).toBe('Claude needs you to log in')
    expect(el('brief-suggest-status').className).toContain('text-destructive')
  })

  it('disables Suggest with core reason when no vendor can answer', async () => {
    detectAnswer = () =>
      context({ suggest: { vendor: null, model: null, tokens: 0, usd: null, reason: 'No vendor is ready' } })
    await ready()
    await typeTask('Add a health endpoint')
    await open()
    expect((el('brief-suggest') as HTMLButtonElement).disabled).toBe(true)
    expect(el('brief-suggest-hint').textContent).toBe('No vendor is ready')
  })

  it('Reset forgets the saved brief and goes back to what detection says', async () => {
    await ready()
    await open()
    await click('brief-option-projectType-cli')
    await click('brief-reset')
    expect(saves()).toEqual([{ folder: FOLDER, brief: null }])
    expect(checked('brief-decide-projectType')).toBe('true')
    expect(summary()).toBe('0 choices · 2 from this repo')
    await settle(BRIEF_SAVE_DEBOUNCE_MS)
    // The pending save of the change before Reset is not sent.
    expect(saves()).toEqual([{ folder: FOLDER, brief: null }])
  })
})

describe('Brief panel: saved and keyword choices', () => {
  it('restores the brief saved for the folder', async () => {
    detectAnswer = () =>
      context({
        saved: { category: 'software', fields: { projectType: { choices: ['cli'], source: 'user' } } },
      })
    await ready()
    expect(summary()).toBe('1 choice · 2 from this repo')
    await open()
    expect(checked('brief-option-projectType-cli')).toBe('true')
  })

  it('applies keyword choices to untouched groups only, and an unticked one stays unticked', async () => {
    const keywords = {
      software: {
        projectType: { choices: ['cli'], source: 'keyword' as const },
        language: { choices: ['python'], source: 'keyword' as const },
      },
    }
    detectAnswer = (req) => context(req.task !== undefined ? { keywordFields: keywords } : {})
    await ready()
    await open()
    await typeTask('Write a python cli')
    await settle(BRIEF_DETECT_DEBOUNCE_MS)
    expect(mock.callsOf('brief.detect').at(-1)).toEqual({ folder: FOLDER, task: 'Write a python cli' })
    expect(checked('brief-option-projectType-cli')).toBe('true')
    expect(el('brief-option-projectType-cli').dataset['source']).toBe('keyword')
    expect(el('brief-option-projectType-cli').getAttribute('aria-description')).toBe('From your task text')
    expect(summary()).toBe('2 choices · 2 from this repo')
    // The user says "decide" for the project type: the keyword does not come back.
    await click('brief-decide-projectType')
    await typeTask('Write a python cli tool')
    await settle(BRIEF_DETECT_DEBOUNCE_MS)
    expect(checked('brief-decide-projectType')).toBe('true')
    expect(checked('brief-option-projectType-cli')).toBe('false')
    expect(checked('brief-option-language-python')).toBe('true')
  })
})

describe('Brief panel: what is sent', () => {
  async function run(): Promise<void> {
    await act(async () => {
      fireEvent.click(el('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('sends no brief when it says nothing', async () => {
    await ready()
    await typeTask('Fix the tests')
    await settle(300)
    await run()
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Fix the tests' }])
    for (const r of mock.callsOf('preflight.run')) expect(r).not.toHaveProperty('brief')
    for (const r of mock.callsOf('estimates.get')) expect(r).not.toHaveProperty('brief')
  })

  it('sends the brief to runs.start and to the live checks, without the locked facts', async () => {
    await ready()
    await typeTask('Fix the tests')
    await open()
    await click('brief-option-approach-test-first')
    await click('brief-option-language-go')
    await settle(300)
    const brief: BriefInput = {
      category: 'software',
      fields: {
        language: { choices: ['go'], source: 'user' },
        approach: { choices: ['test-first'], source: 'user' },
      },
    }
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({ folder: FOLDER, brief })
    expect(mock.callsOf('estimates.get').at(-1)).toEqual({ folder: FOLDER, brief })
    await run()
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Fix the tests', brief }])
  })

  it('sends a category the user chose even with no field set', async () => {
    await ready()
    await typeTask('Write the release notes')
    await open()
    await click('brief-category-documents')
    await settle(300)
    await run()
    expect(mock.callsOf('runs.start')[0]?.brief).toEqual({ category: 'documents', fields: {} })
  })
})
