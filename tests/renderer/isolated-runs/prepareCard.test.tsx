// PrepareCard and the isolated run's timeline (Prepare steps 1 to 5, "streamed to the PrepareCard"; the Run view,
// UI standards: nothing moves on its own; state-machine row R2). Core's prepare rows show from
// the run's start (StepView.prepare, planned): a step finishing changes its row's
// words in place and nothing is inserted mid-run; the dependency install's output streams through runs.output
// `prepare` into an inner region with its full height from the start, following only while the user is at its bottom.
// The timeline shows Prepare and Finalize of an isolated run (and its baseline check when core lists it) from the
// start; an in-place run has neither.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { PREPARE_STEP_LABEL, prepareOutputFile } from '@renderer/components/run/isolation.ts'
import { INSTALL_NO_OUTPUT, PrepareCard } from '@renderer/components/run/PrepareCard.tsx'
import { shownSteps, timelineColumns } from '@renderer/components/run/steps.ts'
import { READ_EVERY_MS } from '@renderer/components/run/VerifyOutput.tsx'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import { env, runEvent } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { eventsHandler, RUN, snapWith } from '../run/helpers.tsx'
import { isolatedSnap, prepareRows, prepareView } from './fixtures.ts'

const EM_DASH = '—'

let mock: MockDimFactory
let log: RunEnvelope[]
let output: string

beforeEach(() => {
  resetRecoveryForTests()
  log = []
  output = ''
  mock = setUp({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.output': () => ({ text: output, mtime: 0, version: log.length }),
    },
  })
})

afterEach(() => tearDown(mock))

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle()
}

function mountCard(snap: RunSnapshot, finishedAtOpen?: boolean) {
  return render(
    <Providers>
      <PrepareCard
        runId={RUN}
        snap={snap}
        view={snap.steps.prepare}
        {...(finishedAtOpen !== undefined ? { finishedAtOpen } : {})}
      />
    </Providers>,
  )
}

const rows = (): string[] =>
  within(screen.getByTestId('prepare-steps'))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-testid') ?? '')

describe('PrepareCard', () => {
  it('shows core’s five rows from the start, and a step finishing changes words in place (nothing inserted)', async () => {
    const start = isolatedSnap()
    const view = mountCard(start)
    await flush()
    const card = screen.getByTestId('pass-card-prepare')
    expect(card.getAttribute('data-kind')).toBe('prepare')
    expect(rows()).toEqual([
      'prepare-step-worktree',
      'prepare-step-copy',
      'prepare-step-deps',
      'prepare-step-baseline',
      'prepare-step-ready',
    ])
    for (const id of ['worktree', 'copy', 'deps', 'baseline', 'ready'] as const) {
      const row = screen.getByTestId(`prepare-step-${id}`)
      expect(row.textContent).toContain(PREPARE_STEP_LABEL[id])
      expect(screen.getByTestId(`prepare-step-${id}-status`).textContent).toBe('Queued')
      // One detail line kept for every row from the start.
      expect(screen.getByTestId(`prepare-step-${id}-detail`).className).toContain('h-4')
    }
    // Core's words for the step that ran: the same rows, new words.
    const later = isolatedSnap({
      prepare: {
        status: 'running',
        attempt: 1,
        prepare: prepareView({
          steps: prepareRows({
            worktree: { status: 'done', detail: 'dim/20261009-fix-login from main' },
            copy: { status: 'done', detail: 'Copied 2 files (.env, .env.local)' },
            deps: { status: 'running', detail: 'pnpm install --frozen-lockfile' },
          }),
        }),
      },
    })
    view.rerender(
      <Providers>
        <PrepareCard runId={RUN} snap={later} view={later.steps.prepare} />
      </Providers>,
    )
    await flush()
    expect(rows()).toHaveLength(5)
    expect(screen.getByTestId('prepare-step-worktree-status').textContent).toBe('Done')
    expect(screen.getByTestId('prepare-step-deps-status').textContent).toBe('Running')
    expect(screen.getByTestId('prepare-step-copy-detail').textContent).toBe(
      'Copied 2 files (.env, .env.local)',
    )
    expect(screen.getByTestId('prepare-step-copy-detail').getAttribute('title')).toBe(
      'Copied 2 files (.env, .env.local)',
    )
    // Status words keep one width (every status word reserved).
    expect(screen.getByTestId('prepare-step-deps-status').querySelector('[data-stable-label]')).not.toBeNull()
    expect(card.textContent?.includes(EM_DASH)).toBe(false)
  })

  it('streams the install output from runs.output `prepare` into a pinned-follow inner region with its height from the start', async () => {
    expect(prepareOutputFile()).toBe('prepare')
    log = [env(RUN, 1, { t: 'output', file: 'prepare', version: 1 })]
    output = 'Lockfile is up to date, resolution step is skipped\n'
    mountCard(isolatedSnap())
    await flush()
    const pane = screen.getByTestId('prepare-output')
    expect(pane.getAttribute('data-scroll-region')).toBe('prepare-output')
    expect(pane.getAttribute('role')).toBe('log')
    expect(pane.className).toContain('h-[min(20rem,var(--run-region-max,50vh))]')
    expect(pane.className).toContain('max-h-[min(20rem,var(--run-region-max,50vh))]')
    expect(pane.className.split(' ')).toEqual(expect.arrayContaining(['overflow-y-auto', 'scroll-region']))
    // The pane comes after the rows: core's rows never move when output arrives.
    expect(
      screen.getByTestId('prepare-steps').compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(pane.textContent).toContain('Lockfile is up to date')

    output += 'Progress: resolved 412, reused 412, downloaded 0, added 412, done\n'
    log.push(env(RUN, 2, { t: 'output', file: 'prepare', version: 2 }))
    act(() => mock.push(runEvent(log[1] as RunEnvelope)))
    await settle(READ_EVERY_MS)
    await flush()
    expect(pane.textContent).toContain('added 412')
    expect(mock.callsOf('runs.output').every((r) => r.file === 'prepare')).toBe(true)

    // Scrolled up by the user: it stops following and offers Jump to latest; the click goes back to the bottom.
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 100 })
    pane.scrollTop = 200
    fireEvent.scroll(pane)
    await settle()
    output += 'more\n'
    log.push(env(RUN, 3, { t: 'output', file: 'prepare', version: 3 }))
    act(() => mock.push(runEvent(log[2] as RunEnvelope)))
    await settle(READ_EVERY_MS)
    await flush()
    expect(pane.scrollTop).toBe(200)
    fireEvent.click(screen.getByTestId('prepare-output-jump'))
    await settle()
    expect(pane.scrollTop).toBe(1000)
  })

  it('has no install pane when core says no install runs, and never grows one later', async () => {
    const skipped = isolatedSnap({
      prepare: {
        status: 'running',
        attempt: 1,
        prepare: prepareView({
          steps: prepareRows({ deps: { status: 'skipped', detail: 'Install dependencies is off' } }),
        }),
      },
    })
    const view = mountCard(skipped)
    await flush()
    expect(screen.queryByTestId('prepare-output')).toBeNull()
    const again = isolatedSnap({
      prepare: {
        status: 'running',
        attempt: 1,
        prepare: prepareView({ steps: prepareRows({ deps: { status: 'running' } }) }),
      },
    })
    view.rerender(
      <Providers>
        <PrepareCard runId={RUN} snap={again} view={again.steps.prepare} />
      </Providers>,
    )
    await flush()
    expect(screen.queryByTestId('prepare-output')).toBeNull()
  })

  it('a prepare already over when the card mounts starts collapsed; opened, its output is a disclosure read on demand', async () => {
    const done = isolatedSnap({
      prepare: {
        status: 'done',
        attempt: 1,
        activeMs: 42_000,
        prepare: prepareView({ steps: prepareRows().map((r) => ({ ...r, status: 'done' })) }),
      },
    })
    mountCard(done)
    await flush()
    expect(screen.queryByTestId('prepare-steps')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
    await flush()
    expect(rows()).toHaveLength(5)
    const details = screen.getByTestId('prepare-output-details')
    expect(mock.callsOf('runs.output')).toHaveLength(0)
    expect(details.textContent).toContain('Install output')
    ;(details as HTMLDetailsElement).open = true
    fireEvent(details, new Event('toggle'))
    await flush()
    expect(screen.getByTestId('prepare-output').textContent).toContain(INSTALL_NO_OUTPUT)
  })
})

describe('the isolated run in the timeline and the flow', () => {
  it('shows Prepare and Finalize from the start (and the baseline check when core lists it); an in-place run has neither', () => {
    const queued = isolatedSnap({
      prepare: { status: 'queued', attempt: 0, prepare: prepareView() },
    })
    const keys = shownSteps(queued).map((v) => v.key)
    expect(keys).toEqual(expect.arrayContaining(['prepare', 'verify:0', 'finalize']))
    const cols = timelineColumns(queued)
      .filter((c) => c.kind === 'step')
      .map((c) => (c.kind === 'step' ? c.steps.map((s) => s.key).join('+') : ''))
    expect(cols[0]).toBe('preflight')
    expect(cols[1]).toBe('prepare+verify:0')
    expect(cols.at(-1)).toBe('finalize')

    // No baseline: core lists the row as skipped.
    const noBaseline = isolatedSnap({
      prepare: {
        status: 'queued',
        attempt: 0,
        prepare: prepareView({ steps: prepareRows({ baseline: { status: 'skipped' } }) }),
      },
    })
    expect(shownSteps(noBaseline).map((v) => v.key)).not.toContain('verify:0')

    // In place: core skips both as not used.
    const inPlace = snapWith({
      steps: {
        prepare: { status: 'skipped', reason: 'in place' },
        finalize: { status: 'skipped', reason: 'in place' },
      },
    })
    const inPlaceKeys = shownSteps(inPlace).map((v) => v.key)
    expect(inPlaceKeys).not.toContain('prepare')
    expect(inPlaceKeys).not.toContain('finalize')
  })

  it('the flow shows the PrepareCard for an isolated run first, and a FinalizeCard once finalize began', async () => {
    const snap = isolatedSnap({
      steps: {
        plan: { status: 'running', attempt: 1, vendor: 'claude' },
      },
      finalize: { status: 'queued', attempt: 0 },
    })
    render(
      <Providers>
        <FlowTab snap={snap} />
      </Providers>,
    )
    await flush()
    const cards = screen.getAllByRole('article').map((a) => a.getAttribute('data-testid'))
    expect(cards.slice(0, 3)).toEqual(['pass-card-preflight', 'pass-card-prepare', 'pass-card-plan'])
    expect(screen.getByTestId('pass-card-prepare').getAttribute('data-kind')).toBe('prepare')
    // Finalize has not begun: only a timeline node, no card yet.
    expect(screen.queryByTestId('pass-card-finalize')).toBeNull()
  })
})
