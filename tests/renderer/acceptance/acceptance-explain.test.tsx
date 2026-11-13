// Acceptance criteria and Explain it to me in the renderer:
//   - the checklist (on the acceptance review's card and in "After the run"): one row per criterion with its status
//     icon and word, the criterion, the evidence, the finding and the mapped tests; the line above it says how the
//     review stands; no em dashes, and the status column has a fixed width (nothing resizes)
//   - "Explain it to me" in "After the run": explain.md read through runs.output and shown with the light markdown
//     component; absent until the step is done, and after an empty answer
//   - the timeline places the two nodes (acceptance before the reviewers, explain after deploy)
//   - the composer's switches (run overrides of passes.review.acceptance / passes.plan.explain) and the Settings rows
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AcceptanceView } from '@shared/acceptance.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { AcceptanceChecklist, checklistLine } from '@renderer/components/run/AcceptanceChecklist.tsx'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { RunEndPanel } from '@renderer/components/run/RunEndPanel.tsx'
import { timelineColumns } from '@renderer/components/run/steps.ts'
import { SKIPPABLE, skipReasonText } from '@renderer/components/run/text.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { RUN_PHASE_LABEL, stepLabel } from '@renderer/lib/format.ts'
import { ACCEPTANCE_NOTE, EXPLAIN_NOTE } from '@renderer/pages/dashboard/composer/model.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle as settleUi, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import { renderUi, settle, snapWith } from '../run/helpers.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

const VIEW: AcceptanceView = {
  review: 'done',
  findings: true,
  counts: { met: 2, notMet: 1, unknown: 1, notChecked: 0 },
  items: [
    {
      id: 'AC1',
      text: 'Adding an item shows it',
      status: 'met',
      evidence: 'src/todo.ts addItem',
      tests: ['tests/todo.test.ts: adds'],
    },
    {
      id: 'AC2',
      text: 'Clearing removes completed items',
      status: 'met',
      evidence: 'Re-check: resolved in round 1.',
      finding: 1,
    },
    { id: 'AC3', text: 'Items persist', status: 'not-met', evidence: 'no storage', finding: 2 },
    { id: 'AC4', text: 'Looks right on a phone', status: 'unknown', evidence: 'needs a person' },
  ],
}

const SUMMARY = '## What was built\nA todo list.\n\n## How to run it\n1. Run `npm start`.'

function ended(o: { explain?: 'done' | 'empty' | 'none'; acceptance?: AcceptanceView } = {}): RunSnapshot {
  const explain = o.explain ?? 'done'
  const snap = snapWith({
    summary: {
      status: 'completed',
      phase: 'done',
      outcome: 'clean',
      endedAt: 1_700_000_900_000,
      progress: { tokens: 1, costUsd: null, filesChanged: 2 },
    },
    steps:
      explain === 'none'
        ? {}
        : {
            explain: {
              status: 'done',
              attempt: 1,
              ...(explain === 'empty' ? { reason: 'empty answer' } : {}),
            },
          },
  })
  return o.acceptance !== undefined ? { ...snap, acceptance: o.acceptance } : snap
}

describe('the acceptance checklist', () => {
  it('a row per criterion: status icon and word, the criterion, evidence, finding and tests', () => {
    renderUi(<AcceptanceChecklist view={VIEW} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(screen.getByTestId('acceptance-status-AC1').textContent).toBe('Met')
    expect(screen.getByTestId('acceptance-status-AC3').textContent).toBe('Not met')
    expect(screen.getByTestId('acceptance-status-AC4').textContent).toBe('Unknown')
    expect(screen.getByTestId('acceptance-row-AC2').getAttribute('data-status')).toBe('met')
    expect(screen.getByTestId('acceptance-evidence-AC2').textContent).toBe(
      'Re-check: resolved in round 1. (F1)',
    )
    expect(screen.getByTestId('acceptance-tests-AC1').textContent).toBe('Tests: tests/todo.test.ts: adds')
    expect(within(rows[0] as HTMLElement).getByText('Adding an item shows it')).toBeTruthy()
    // The status column has a fixed width: a status word changing never moves the criterion.
    const col = screen.getByTestId('acceptance-status-AC1').parentElement
    expect(col?.className).toContain('w-28')
    expect(col?.className).toContain('shrink-0')
    expect(screen.getByTestId('acceptance-checklist-line').textContent).toBe(
      'Acceptance: 2 of 4 criteria met, 1 not met, 1 unknown. Unmet criteria went to Fix as [must] findings.',
    )
    expect(document.body.textContent).not.toContain(EM_DASH)
  })

  it('says how the review stands before it runs, when it is off, and why it was skipped', () => {
    const base = {
      ...VIEW,
      findings: false,
      items: VIEW.items.map((i) => ({ ...i, status: 'not-checked' as const })),
    }
    expect(checklistLine({ ...base, review: 'off' })).toBe(
      'The acceptance review is off, so these criteria are not checked.',
    )
    expect(checklistLine({ ...base, review: 'pending' })).toBe(
      'The acceptance review checks these after Implement.',
    )
    expect(checklistLine({ ...base, review: 'checking' })).toBe(
      'The acceptance review is checking these criteria.',
    )
    expect(
      checklistLine({
        ...base,
        review: 'skipped',
        note: 'The acceptance review did not run: the run made no changes.',
      }),
    ).toBe('The acceptance review did not run: the run made no changes.')
    renderUi(<AcceptanceChecklist view={{ ...base, review: 'off' }} />)
    expect(screen.getByTestId('acceptance-status-AC1').textContent).toBe('Not checked')
  })
})

describe('After the run: the checklist and Explain it to me', () => {
  let mock: MockDimFactory
  let reads: string[]
  beforeEach(() => {
    resetBridgeForTests()
    resetStore()
    clearToasts()
    clearOutputCache()
    reads = []
    mock = installMockDimFactory({
      handlers: {
        'runs.get': () => ended(),
        'runs.output': (req: { file: string }) => {
          reads.push(req.file)
          return { text: SUMMARY, mtime: 0, version: 1 }
        },
      },
    })
  })
  afterEach(() => {
    mock.uninstall()
    cancelRefetches()
    clearToasts()
    resetBridgeForTests()
  })

  it('shows the checklist and explain.md, inline (no scroll box of its own), last in the panel', async () => {
    renderUi(<RunEndPanel snap={ended({ acceptance: VIEW })} />)
    expect(screen.getByTestId('run-end-acceptance')).toBeTruthy()
    await act(async () => {
      await settle()
    })
    expect(reads).toContain('explain')
    const section = screen.getByTestId('run-end-explain')
    expect(within(section).getByRole('heading', { name: 'Explain it to me' })).toBeTruthy()
    expect(screen.getByTestId('run-end-explain-text').textContent).toContain('A todo list.')
    expect(screen.getByTestId('run-end-explain-text').textContent).toContain('Run npm start.')
    expect(section.className).not.toMatch(/overflow|max-h/)
    // Last in the panel: the text arriving moves nothing below it.
    expect(screen.getByTestId('run-end').lastElementChild).toBe(section)
    expect(document.body.textContent).not.toContain(EM_DASH)
  })

  it('has no Explain section while the step is not done, or after an empty answer; no checklist without criteria', async () => {
    const { unmount } = renderUi(<RunEndPanel snap={ended({ explain: 'none' })} />)
    await act(async () => {
      await settle()
    })
    expect(screen.queryByTestId('run-end-explain')).toBeNull()
    expect(screen.queryByTestId('run-end-acceptance')).toBeNull()
    unmount()
    renderUi(<RunEndPanel snap={ended({ explain: 'empty' })} />)
    await act(async () => {
      await settle()
    })
    expect(screen.queryByTestId('run-end-explain')).toBeNull()
    expect(reads).not.toContain('explain')
  })
})

describe('the timeline and labels', () => {
  it('places acceptance before the reviewers and explain after deploy, when core plans them', () => {
    const snap = snapWith({
      steps: {
        acceptance: { status: 'queued', planned: true },
        explain: { status: 'queued', planned: true },
        deploy: { status: 'queued', planned: true },
      },
    })
    const keys = timelineColumns(snap).flatMap((c) =>
      c.kind === 'step' ? c.steps.map((s) => s.key) : [c.gate],
    )
    expect(keys.indexOf('acceptance')).toBeGreaterThan(keys.indexOf('implement'))
    expect(keys.indexOf('acceptance')).toBeLessThan(keys.indexOf('review'))
    expect(keys.indexOf('explain')).toBe(keys.indexOf('deploy') + 1)
    // Not planned (a run without them): no node.
    const none = timelineColumns(snapWith()).flatMap((c) =>
      c.kind === 'step' ? c.steps.map((s) => s.key) : [],
    )
    expect(none).not.toContain('acceptance')
    expect(none).not.toContain('explain')
  })

  it('names the steps and phases, and lets Continue without skip them', () => {
    expect(stepLabel('acceptance')).toBe('Acceptance review')
    expect(stepLabel('explain')).toBe('Explain it to me')
    expect(RUN_PHASE_LABEL.accepting).toBe('Checking acceptance')
    expect(RUN_PHASE_LABEL.explaining).toBe('Writing the summary')
    expect(SKIPPABLE.has('acceptance')).toBe(true)
    expect(SKIPPABLE.has('explain')).toBe(true)
    expect(skipReasonText('no criteria')).toBe('the plan lists no acceptance criteria')
    for (const t of [RUN_PHASE_LABEL.accepting, RUN_PHASE_LABEL.explaining, ACCEPTANCE_NOTE, EXPLAIN_NOTE])
      expect(t).not.toContain(EM_DASH)
  })
})

describe('the composer: Acceptance review and Explain it to me', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'preflight.run': () => report(),
        'estimates.get': () => runEstimate(),
      },
    })
    upsertProbes([probe('claude', 'ready')])
  })
  afterEach(() => tearDown(mock))

  it('are off by default with constant notes; turning them on is a run override, with its source badge', async () => {
    await mountComposer()
    await settleUi(300)
    const acc = screen.getByTestId('composer-acceptance')
    const exp = screen.getByTestId('composer-explain')
    expect(acc.getAttribute('aria-checked')).toBe('false')
    expect(exp.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('composer-acceptance-note').textContent).toBe(ACCEPTANCE_NOTE)
    expect(screen.getByTestId('composer-explain-note').textContent).toBe(EXPLAIN_NOTE)
    fireEvent.click(acc)
    await settleUi(300)
    fireEvent.click(screen.getByTestId('composer-explain'))
    await settleUi(300)
    const last = mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }
    expect(last.overrides).toEqual({ passes: { review: { acceptance: true }, plan: { explain: true } } })
    expect(screen.getByTestId('composer-acceptance').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('composer-acceptance-provenance').getAttribute('data-source')).toBe('run')
    expect(screen.getByTestId('composer-explain-provenance').getAttribute('data-source')).toBe('run')
    expect(screen.getByTestId('composer-acceptance-note').textContent).toBe(ACCEPTANCE_NOTE)
  })

  it('reads on from the resolved config (the thorough profile turns the acceptance review on)', async () => {
    mock.on(
      'config.resolve',
      fakeResolve({
        config: (c) => {
          ;(c.passes.review as { acceptance?: boolean }).acceptance = true
        },
      }),
    )
    await mountComposer()
    await settleUi(300)
    expect(screen.getByTestId('composer-acceptance').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('composer-explain').getAttribute('aria-checked')).toBe('false')
  })
})

describe('Settings: the acceptance review and Explain it to me', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'verify.detect': () => [],
        'folders.recent': () => [],
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

  it('writes passes.review.acceptance and passes.plan.explain to the chosen project', async () => {
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settleUi(SECTION_LOAD_DELAY_MS)
    await settleUi()
    const acc = screen.getByTestId('setting-/passes/review/acceptance')
    expect(acc.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(acc)
    await settleUi()
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/review/acceptance', value: true }],
    })
    fireEvent.click(screen.getByTestId('setting-/passes/plan/explain'))
    await settleUi()
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/plan/explain', value: true }],
    })
    expect(document.body.textContent).not.toContain(EM_DASH)
  })
})
