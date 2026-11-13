// Settings > Extensions > Context: the context health options (user settings, one config.patch each with Undo) and
// the chosen project's Context report (core's context.report): one line kept from the start, the table and the
// suggestions behind a click, the five-run gate in plain words, no em dashes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContextReport } from '@shared/context.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { CONTEXT_HEALTH_DEFAULTS } from '@shared/config-schema.ts'
import {
  REMINDER_OPTIONS,
  liftText,
  recommendationText,
  reportSummaryText,
  tokensText,
} from '@renderer/pages/settings/extensions/contextReport.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { fakeResolve } from '../composer/fixtures.tsx'

const EM_DASH = '\u2014'
const FOLDER = 'C:\\work\\app'

const REPORT: ContextReport = {
  folder: FOLDER,
  runs: 12,
  minRuns: 5,
  failureRate: 0.25,
  groundingRate: 0.17,
  rows: [
    {
      key: 'aaaaaaaaaaaa',
      kind: 'memory',
      name: 'CLAUDE.md',
      tokens: 40_000,
      runs: 12,
      steps: ['implement', 'review'],
      failureRate: 0.25,
      failureLift: 1,
      groundingRate: 0.17,
      groundingLift: 1,
    },
    {
      key: 'bbbbbbbbbbbb',
      kind: 'mcp',
      name: 'tracker',
      tokens: 9_000,
      tools: 31,
      runs: 6,
      steps: ['implement'],
      calls: 0,
      failureRate: 0.5,
      failureLift: 2,
      groundingRate: 0,
      groundingLift: 0,
    },
  ],
  recommendations: [
    { kind: 'big-memory', key: 'aaaaaaaaaaaa', name: 'CLAUDE.md', tokens: 40_000 },
    { kind: 'unused-mcp', key: 'bbbbbbbbbbbb', name: 'tracker', tools: 31, runs: 10 },
    { kind: 'heavy-skill', key: 'cccccccccccc', name: 'deploy', tokens: 12_000, step: 'implement' },
    { kind: 'lift', key: 'bbbbbbbbbbbb', name: 'tracker', what: 'failures', lift: 2 },
  ],
}

const write = (): ConfigWriteResult => ({
  path: 'C:\\home\\dimfactory.json',
  changed: true,
  diff: '',
  backupId: 'b1',
})

let mock: MockDimFactory
let report: ContextReport = REPORT

beforeEach(() => {
  report = REPORT
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'extensions.discover': () => ({ vendors: [] }),
      'config.patch': () => write(),
      'context.report': () => report,
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(folder: string | null): Promise<void> {
  const q = folder !== null ? `?folder=${encodeURIComponent(folder)}` : ''
  window.location.hash = `#/settings/extensions${q}`
  render(
    <Providers>
      <SettingsPage section="extensions" />
    </Providers>,
  )
  await settle(400)
}

describe('Settings > Extensions > Context', () => {
  it('shows the options with their defaults and asks for a project before any report', async () => {
    await mount(null)
    expect(screen.getByTestId('context-grounding').getAttribute('data-state')).toBe('checked')
    expect(screen.getByTestId('context-registry').getAttribute('data-state')).toBe('unchecked')
    expect(screen.getByTestId('context-judge').getAttribute('data-state')).toBe('unchecked')
    // The reminder's default (Auto runs only, or Off until it was recorded live), in the option's words.
    expect(screen.getByTestId('context-reminder').textContent).toBe(
      REMINDER_OPTIONS.find((o) => o.value === CONTEXT_HEALTH_DEFAULTS.compactionReminder)?.label,
    )
    expect(screen.getByTestId('context-report-summary').textContent).toBe(
      'Choose a project above to see what loads into its passes.',
    )
    expect(mock.callsOf('context.report')).toEqual([])
    const group = screen.getByTestId('extensions-context')
    expect(group.textContent).toContain('npm, PyPI, crates.io')
    expect(group.textContent).toContain('labelled AI-judged')
    expect(group.textContent).not.toContain(EM_DASH)
  })

  it('writes an option to the user settings with one config.patch', async () => {
    await mount(FOLDER)
    act(() => {
      fireEvent.click(screen.getByTestId('context-registry'))
    })
    await settle(100)
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'add', path: '/contextHealth/registryCheck', value: true }] },
    ])
    expect(screen.getByTestId('context-registry').getAttribute('data-state')).toBe('checked')
  })

  it("reads the chosen project's report: a summary line, then the table and suggestions on a click", async () => {
    await mount(FOLDER)
    expect(mock.callsOf('context.report')).toEqual([{ folder: FOLDER }])
    expect(screen.getByTestId('context-report-summary').textContent).toBe(
      'From 12 recent runs: 25% failed or completed with failures, 17% had AI claims that did not match the run. 4 suggestions.',
    )
    const details = screen.getByTestId<HTMLDetailsElement>('context-report-details')
    expect(details.open).toBe(false)
    act(() => {
      fireEvent.click(details.querySelector('summary')!)
    })
    const table = screen.getByTestId('context-report-table')
    expect(table.textContent).toContain('CLAUDE.md')
    expect(table.textContent).toContain('~40k tokens')
    expect(screen.getByTestId('context-row-bbbbbbbbbbbb').textContent).toContain('2 times as often')
    const tips = screen.getByTestId('context-report-suggestions').textContent ?? ''
    expect(tips).toContain('CLAUDE.md is ~40k tokens and loads into every pass.')
    expect(tips).toContain('MCP server tracker: 31 tools, unused in the last 10 runs.')
    expect(tips).toContain('Skill deploy adds ~12k tokens to every Implement pass.')
    expect(tips).toContain("Runs with tracker failed 2 times as often as this project's average.")
    expect(screen.getByTestId('extensions-context').textContent).not.toContain(EM_DASH)
  })

  it('below five runs says how many more it needs, and keeps the line while it reads', async () => {
    report = { folder: FOLDER, runs: 2, minRuns: 5, rows: [], recommendations: [] }
    await mount(FOLDER)
    expect(screen.getByTestId('context-report-summary').textContent).toBe(
      'From 2 recent runs. The comparison with failures starts at 5 runs (3 more).',
    )
    expect(screen.queryByTestId('context-report-details')).toBeNull()
    expect(screen.getByTestId('context-report').className).toContain('min-h-20')
  })
})

describe('the words', () => {
  it('sizes, lifts and the summary', () => {
    expect(tokensText(0)).toBe('Size not known')
    expect(tokensText(800)).toBe('~800 tokens')
    expect(tokensText(12_400)).toBe('~12k tokens')
    expect(liftText(undefined, undefined)).toBe('Not enough runs')
    expect(liftText(2.5, 0.75)).toBe('2.5 times as often')
    expect(liftText(1.1, 0.3)).toBe('About as often')
    expect(liftText(0.5, 0.1)).toBe('Less often')
    expect(liftText(0, 0)).toBe('Never')
    expect(reportSummaryText(null, true, null)).toBe('Reading the recent runs…')
    expect(reportSummaryText(null, false, 'boom')).toBe('The report could not be read: boom')
    expect(recommendationText({ kind: 'lift', key: 'k', name: 'x', what: 'grounding', lift: 1.5 })).toBe(
      "Runs with x had AI claims that did not match the run 1.5 times as often as this project's average.",
    )
  })
})
