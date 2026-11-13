// The context meter on a pass card (a fixed-width slot at the end of the never-wrapping metrics line, there from the
// step's start: "Context n/a", "Context 42% · 2 summaries", amber, "Summarising…"), the end panel's Context and Context
// health sections, and the copy (text.ts), Easy mode's plain words included.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContextHealthItem, ContextHealthReport, ContextView } from '@shared/context.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { ContextHealthSection } from '@renderer/components/run/ContextHealthSection.tsx'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import {
  contextMeterText,
  contextMeterTitle,
  easyHealthNotes,
  easyHealthText,
  healthItemText,
} from '@renderer/components/run/text.ts'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, snapWith } from './helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => []),
      'runs.get': () => snapWith(),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'no output')
      },
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetTicker()
  resetBridgeForTests()
})

const running = (context?: ContextView): RunSnapshot =>
  snapWith({
    steps: {
      implement: {
        status: 'running',
        attempt: 1,
        vendor: 'claude',
        model: 'sonnet',
        mode: 'autoedit',
        activeMs: 1_200,
        ...(context !== undefined ? { context } : {}),
      },
    },
  })

function meterOf(snap: RunSnapshot): HTMLElement {
  renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.implement} />)
  return screen.getByTestId('pass-context-implement')
}

describe('the context meter', () => {
  it('is there from the step start, reading n/a, in a fixed-width slot of the never-wrapping metrics line', () => {
    const meter = meterOf(running())
    expect(meter.textContent).toBe('Context n/a')
    expect(meter.className).toContain('w-[24ch]')
    expect(meter.className).toContain('shrink-0')
    const line = screen.getByTestId('pass-metrics-implement')
    expect(line.className).toContain('h-4')
    expect(line.className).toContain('whitespace-nowrap')
  })

  it('keeps its size and place as it fills, warns and summarises (the metrics line keeps its size)', () => {
    const states: ContextView[] = [
      { compactions: 0, used: 54_000, window: 128_000, percent: 42 },
      { compactions: 2, used: 54_000, window: 128_000, percent: 42, warn: true },
      { compactions: 2, used: 54_000, window: 128_000, percent: 42, compacting: true, warn: true },
    ]
    const r = renderUi(<PassCard runId={RUN} snap={running()} view={running().steps.implement} />)
    const first = screen.getByTestId('pass-context-implement')
    const classes = (el: HTMLElement): string[] =>
      el.className.split(/\s+/).filter((c) => c !== 'text-warning')
    const lineClass = screen.getByTestId('pass-metrics-implement').className
    const texts: string[] = []
    for (const c of states) {
      const snap = running(c)
      r.rerender(
        <TooltipProvider>
          <PassCard runId={RUN} snap={snap} view={snap.steps.implement} />
        </TooltipProvider>,
      )
      const el = screen.getByTestId('pass-context-implement')
      expect(classes(el)).toEqual(classes(first))
      expect(screen.getByTestId('pass-metrics-implement').className).toBe(lineClass)
      // Last in the line: nothing after it moves when it changes.
      expect(el.nextElementSibling).toBeNull()
      texts.push(`${el.textContent ?? ''}|${el.getAttribute('data-warn') ?? ''}`)
    }
    expect(texts).toEqual(['Context 42%|', 'Context 42% · 2 summaries|true', 'Summarising…|true'])
    expect(screen.getByTestId('pass-context-implement').className).toContain('text-warning')
  })

  it('a queued step has no meter', () => {
    const snap = snapWith()
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.implement} />)
    expect(screen.queryByTestId('pass-context-implement')).toBeNull()
  })

  it('the words: tooltip names tokens, the window and where it came from, the peak and the baseline', () => {
    expect(contextMeterText(undefined)).toBe('Context n/a')
    expect(contextMeterText({ compactions: 1, percent: 7 })).toBe('Context 7% · 1 summary')
    expect(
      contextMeterTitle({
        compactions: 1,
        used: 54_000,
        window: 128_000,
        windowFrom: 'vendor',
        percent: 42,
        peakPercent: 61,
        baseline: 14_200,
      }),
    ).toBe(
      '54,000 of 128,000 tokens in the context window · window reported by the vendor · peak 61% · 14k tokens before the task (baseline) · summarised once.',
    )
    expect(contextMeterTitle(undefined)).toBe('The vendor has not reported how full its context is yet.')
  })
})

const item = (o: Partial<ContextHealthItem> & Pick<ContextHealthItem, 'id'>): ContextHealthItem => ({
  step: 'implement',
  strong: false,
  suggestion: 'none',
  ...o,
})

const REPORT: ContextHealthReport = {
  version: 1,
  passes: [
    {
      step: 'review',
      vendor: 'claude',
      peakPercent: 18,
      compactions: 0,
      baseline: 14_000,
      window: 200_000,
      extensions: 'none',
      contributors: [],
    },
    {
      step: 'implement',
      vendor: 'claude',
      peakPercent: 86,
      compactions: 2,
      baseline: 42_000,
      window: 200_000,
      extensions: 'passthrough',
      contributors: [
        { kind: 'mcp', name: 'github', tokens: 9_000, tools: 31, from: 'vendor' },
        { kind: 'memory', name: 'CLAUDE.md', tokens: 4_100, from: 'estimate' },
        { kind: 'mcp', name: 'linear', tokens: 0, from: 'name' },
      ],
    },
  ],
  items: [
    item({ id: 'D7', strong: false, suggestion: 'split-task', count: 2 }),
    item({
      id: 'D1',
      suggestion: 'lower-extensions',
      tokens: 42_000,
      compare: { step: 'review', tokens: 14_000 },
    }),
  ],
}

describe('the end panel sections', () => {
  it('a table per pass (peak, summaries, before the task, contributors) and the items with what to try', () => {
    render(<ContextHealthSection report={REPORT} />)
    const impl = screen.getByTestId('run-end-context-implement')
    expect(impl.textContent).toContain('86%')
    expect(impl.textContent).toContain('42k')
    expect(impl.textContent).toContain('github MCP 9k, CLAUDE.md 4k, linear MCP')
    expect(impl.querySelector('[data-warn]')?.textContent).toBe('2')
    const items = screen.getByTestId('run-end-context-health-items')
    expect(items.textContent).toContain('The AI summarised its context twice in this pass.')
    expect(items.textContent).toContain(
      'This pass started with about 42k tokens before your task (Review started with 14k).',
    )
    expect(items.textContent).toContain('Lower Extensions for this pass.')
    // No button and no scroll region of its own (UI standards).
    expect(screen.queryAllByRole('button')).toEqual([])
    const section = screen.getByTestId('run-end-context')
    expect(section.className).not.toMatch(/overflow-(auto|scroll|y-auto|x-auto)/)
  })

  it('says so when nothing was found', () => {
    render(<ContextHealthSection report={{ ...REPORT, items: [] }} />)
    expect(screen.getByTestId('run-end-context-health-none').textContent).toBe(
      'Nothing made these passes heavier than they needed to be.',
    )
  })
})

describe('copy', () => {
  it('every detector has Full and Easy words, with no em dash', () => {
    const items: ContextHealthItem[] = [
      item({ id: 'D1', tokens: 42_000 }),
      item({ id: 'D2', name: 'github', tokens: 9_000, count: 31 }),
      item({ id: 'D3', name: 'CLAUDE.md', tokens: 40_000, fileKind: 'memory' }),
      item({ id: 'D3', name: 'big-skill', tokens: 9_000, fileKind: 'skill' }),
      item({ id: 'D4', name: 'Bash', count: 9, variant: 'loop' }),
      item({ id: 'D4', name: 'src/a.ts', count: 5, variant: 'reread' }),
      item({ id: 'D5', name: 'Grep', tokens: 30_000 }),
      item({ id: 'D6', count: 40 }),
      item({ id: 'D7', count: 3 }),
      item({ id: 'D8', ratio: 2.3 }),
      item({ id: 'D9', percent: 34 }),
      item({ id: 'D10', percent: 64 }),
    ]
    const full = items.map(healthItemText)
    expect(full).toEqual([
      'This pass started with about 42k tokens before your task.',
      'MCP server github adds about 9k tokens (31 tools) to every request.',
      'CLAUDE.md is about 40k tokens and loads into every request.',
      'The skill big-skill is about 9k tokens and loads into every request.',
      'The AI ran the same Bash call 9 times.',
      'The AI read src/a.ts 5 times without changing it.',
      'One Grep result was about 30k tokens.',
      '40 steps without changing a file.',
      'The AI summarised its context 3 times in this pass.',
      'Used 2.3 times the usual tokens for Implement.',
      'The prompt cache kept missing (34% hits).',
      'Subagents used 64% of this pass.',
    ])
    const easy = items.map(easyHealthText)
    expect(easy[0]).toBe('Some of your add-ons make each step heavier.')
    expect(easyHealthText(item({ id: 'D7', count: 2 }))).toBe(
      'The AI ran low on memory and summarised its notes twice; results may be less reliable.',
    )
    for (const t of [...full, ...easy]) expect(t).not.toContain('—')
  })

  it('Easy mode shows each plain sentence once, three at most', () => {
    const notes = easyHealthNotes([
      item({ id: 'D1' }),
      item({ id: 'D2' }),
      item({ id: 'D7', count: 2 }),
      item({ id: 'D4' }),
      item({ id: 'D5' }),
    ])
    expect(notes).toEqual([
      'Some of your add-ons make each step heavier.',
      'The AI ran low on memory and summarised its notes twice; results may be less reliable.',
      'The AI kept repeating the same step.',
    ])
  })
})
