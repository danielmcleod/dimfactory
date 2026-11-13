// The live balanced run's findings in the Run view:
//   - core's live count counts files, not lines: the Summary bar and the Log tab say "3 files", never "3 files +0 −0"
//   - a file Fix changed later in the run carries "Changed by Fix" in the Implement segment (it read "Edited after the
//     run" on every file the live Fix had touched)
//   - a Codex pass with no model names the model it ran (StepView.modelUsed), and before it starts the model core
//     expects (StepView.expectedModel), not "default model"; when the two differ, or the pass started where Codex does
//     not say (it reads "default model" then, its tooltip saying Codex did not report which model ran), the chip keeps
//     its width, so the chips after it do not move as the pass starts (UI standard: nothing moves on its own)
//   - a default Codex did not run (its refusal names its own model): the card names that model, never the default
//   - the Config tab names the expected model as the pass will run it, so a confirmed expectation changes nothing, and
//     its columns have fixed shares (table-fixed), Model and Route on one line
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffFilePatch, DiffFiles } from '@shared/ipc.ts'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearPatchCache } from '@renderer/components/diff/patches.ts'
import { resetDiffPrefs } from '@renderer/components/diff/prefs.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { SummaryBar } from '@renderer/components/run/SummaryBar.tsx'
import { resetRevertForTests } from '@renderer/components/run/revert.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { liveCountOnly } from '@renderer/lib/format.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { describeBody } from '@renderer/pages/run/LogTab.tsx'
import { ConfigTab } from '@renderer/pages/run/ConfigTab.tsx'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, runEvent } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { change, files, installFakeIO, patchFor } from '../diff/helpers.tsx'

vi.mock('@renderer/components/diff/PatchView.tsx', async () => {
  const h = await import('../diff/helpers.tsx')
  return { PatchView: h.FakePatchView }
})

let mock: MockDimFactory
let log: RunEnvelope[]
let list: DiffFiles
let current: RunSnapshot
let release: (() => void) | null = null
let restoreIO: () => void

const fixing = (): RunSnapshot =>
  snapWith({
    summary: { status: 'running', phase: 'fixing', progress: { tokens: 10, costUsd: null, filesChanged: 3 } },
    steps: {
      plan: { status: 'done', attempt: 1 },
      implement: { status: 'done', attempt: 1, vendor: 'codex' },
      review: { status: 'done', attempt: 1 },
      critic: { status: 'done', attempt: 1 },
      fix: { status: 'running', attempt: 1, vendor: 'codex' },
    },
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  clearPatchCache()
  resetDiffPrefs()
  resetRevertForTests()
  restoreIO = installFakeIO()
  window.location.hash = ''
  log = []
  current = snapWith({
    summary: {
      status: 'completed',
      phase: 'done',
      outcome: 'fixed',
      endedAt: 1_700_000_900_000,
      progress: { tokens: 10, costUsd: null, filesChanged: 3 },
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'done', attempt: 1, vendor: 'codex' },
      review: { status: 'done', attempt: 1, vendor: 'claude' },
      critic: { status: 'done', attempt: 1, vendor: 'claude' },
      fix: { status: 'done', attempt: 1, vendor: 'codex' },
    },
    lastSeq: 9,
  })
  list = files([change('src/cli.ts'), change('src/index.ts')])
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
      'diff.files': (req) => ({ ...list, seg: req.seg }),
      'diff.file': (req): DiffFilePatch => ({ patch: patchFor(req.path), truncated: false }),
      'diff.markReviewed': () => undefined,
    },
  })
})

afterEach(() => {
  release?.()
  release = null
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetTicker()
  resetBridgeForTests()
  restoreIO()
  window.location.hash = ''
})

describe('a live count is files only', () => {
  it('the Summary bar shows "3 files" for core’s live count, the lines once core counted them', async () => {
    log = [env(RUN, 4, { t: 'diff-stats', files: 3, added: 27, deleted: 4, live: false })]
    renderUi(<SummaryBar snap={fixing()} onOpenDiff={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('summary-files').textContent).toBe('3 files +27 −4'))
    await act(async () => {
      mock.push(runEvent(env(RUN, 9, { t: 'diff-stats', files: 3, added: 0, deleted: 0, live: true })))
      await settle()
    })
    expect(screen.getByTestId('summary-files').textContent).toBe('3 files')
  })

  it('the Log tab reads "3 files (live)"; a counted round keeps its lines', () => {
    expect(describeBody({ t: 'diff-stats', files: 3, added: 0, deleted: 0, live: true }).text).toBe(
      '3 files (live)',
    )
    expect(describeBody({ t: 'diff-stats', files: 3, added: 25, deleted: 2, live: false }).text).toBe(
      '3 files +25 −2',
    )
    expect(liveCountOnly({ live: true, added: 10, deleted: 1 })).toBe(false)
    expect(liveCountOnly({ live: false, added: 0, deleted: 0 })).toBe(false)
  })
})

describe('Changed by Fix', () => {
  it('a file Fix changed later carries its own chip, not "Edited after the run"', async () => {
    list = files(
      [
        change('src/cli.ts', { editedAfterRun: false, changedByFix: true }),
        change('src/index.ts', { editedAfterRun: true }),
        change('src/plain.ts', { editedAfterRun: false }),
      ],
      { seg: 'implement', available: ['implement', 'fix', 'combined'] },
    )
    release = startBridge()
    renderUi(<RunPage runId={RUN} tab="diff" />)
    await act(async () => {
      await settle(10)
    })
    await waitFor(() => expect(screen.getByTestId('diff-files')).toBeTruthy())
    const section = (path: string): HTMLElement => {
      const el = document.querySelector<HTMLElement>(`article[data-path="${path}"]`)
      if (el === null) throw new Error(`no section for ${path}`)
      return el
    }
    const chip = within(section('src/cli.ts')).getByTestId('diff-changed-by-fix')
    expect(chip.textContent).toBe('Changed by Fix')
    expect(chip.getAttribute('title')).toBe(
      "Fix changed this file later in the run. This view shows Implement's version; Fix and Combined show the rest.",
    )
    expect(within(section('src/cli.ts')).queryByTestId('diff-edited-after-run')).toBeNull()
    expect(within(section('src/index.ts')).getByTestId('diff-edited-after-run').textContent).toBe(
      'Edited after the run',
    )
    expect(within(section('src/plain.ts')).queryByTestId('diff-changed-by-fix')).toBeNull()
    const listEl = screen.getByTestId('diff-file-list')
    expect(within(listEl).getAllByText('Changed by Fix')).toHaveLength(1)
    expect(within(listEl).getAllByText('Edited after the run')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('—')
  })
})

describe('the model a pass with none ran', () => {
  const tooltipOf = async (el: HTMLElement): Promise<string | null> => {
    fireEvent.focus(el)
    await act(() => settle(400))
    const text = screen.getByRole('tooltip').textContent
    fireEvent.blur(el)
    await act(() => settle(400))
    return text
  }

  it('the card names the model that ran, and says who chose it; with nothing known, "default model"', async () => {
    const s = snapWith({
      steps: {
        implement: {
          status: 'done',
          attempt: 1,
          vendor: 'codex',
          model: null,
          modelUsed: 'gpt-6-luna',
          modelReplaced: 'gpt-5.6-sol',
          expectedModel: 'gpt-6-luna',
        },
        fix: { status: 'done', attempt: 1, vendor: 'codex', model: null, modelUsed: 'gpt-5.6-terra' },
        // Finished on the exec route: Codex did not say which model ran, and core expects nothing any more.
        review: { status: 'done', attempt: 1, vendor: 'codex', model: null, route: 'exec' },
        critic: { status: 'done', attempt: 1, vendor: 'claude', model: 'sonnet' },
      },
    })
    const { unmount } = renderUi(<PassCard runId={RUN} snap={s} view={s.steps.implement} />)
    await act(() => settle())
    const chip = screen.getByTestId('model-chip-implement')
    expect(chip.textContent).toBe('gpt-6-luna')
    expect(await tooltipOf(chip)).toBe(
      // Live re-record (Model wording item 1): modelUsed is set only once Codex said the default runs (live
      // X18a/b), so the default asked for on turn/start is the model that ran.
      "This pass names no model. Codex's settings chose gpt-5.6-sol, which this account is not offered, so Codex ran the account's default, gpt-6-luna, at Dim Factory's request.",
    )
    unmount()
    const fix = renderUi(<PassCard runId={RUN} snap={s} view={s.steps.fix} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-fix').textContent).toBe('gpt-5.6-terra')
    expect(await tooltipOf(screen.getByTestId('model-chip-fix'))).toBe(
      "This pass names no model. Codex's settings chose gpt-5.6-terra for this folder.",
    )
    fix.unmount()
    const review = renderUi(<PassCard runId={RUN} snap={s} view={s.steps.review} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-review').textContent).toBe('default model')
    expect(await tooltipOf(screen.getByTestId('model-chip-review'))).toBe(
      'This pass names no model, so Codex chose. Codex did not report which model ran.',
    )
    review.unmount()
    renderUi(<PassCard runId={RUN} snap={s} view={s.steps.critic} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-critic').textContent).toBe('sonnet')
    expect(document.body.textContent).not.toContain('—')
  })

  it('a turn Codex rerouted: the chip names the model that ran, the tooltip says Codex moved it', async () => {
    const rerouted = (implement: Partial<RunSnapshot['steps']['implement']>): RunSnapshot =>
      snapWith({
        steps: {
          implement: {
            attempt: 1,
            status: 'running',
            vendor: 'codex',
            model: null,
            modelUsed: 'gpt-5.6-terra',
            modelRerouted: 'gpt-6-luna',
            ...implement,
          },
        },
      })
    const asked = rerouted({ modelReplaced: 'gpt-5.6-sol' })
    const r = renderUi(<PassCard runId={RUN} snap={asked} view={asked.steps.implement} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-implement').textContent).toBe('gpt-5.6-terra')
    expect(await tooltipOf(screen.getByTestId('model-chip-implement'))).toBe(
      "This pass names no model. Codex's settings chose gpt-5.6-sol, which this account is not offered, so Dim Factory asked Codex for the account's default. Codex moved this turn from gpt-6-luna to gpt-5.6-terra, which ran.",
    )
    r.unmount()
    const own = rerouted({})
    renderUi(<PassCard runId={RUN} snap={own} view={own.steps.implement} />)
    await act(() => settle())
    expect(await tooltipOf(screen.getByTestId('model-chip-implement'))).toBe(
      'This pass names no model. Codex moved this turn from gpt-6-luna to gpt-5.6-terra, which ran.',
    )
    expect(document.body.textContent).not.toContain('—')
  })

  it('the default asked for and not yet confirmed: the chip keeps the expected model, the tooltip says it was asked for', async () => {
    const asked = (implement: Partial<RunSnapshot['steps']['implement']>): RunSnapshot =>
      snapWith({
        steps: {
          implement: {
            attempt: 1,
            vendor: 'codex',
            model: null,
            modelAsked: 'gpt-6-luna',
            modelReplaced: 'gpt-5.6-sol',
            ...implement,
          },
        },
      })
    const head =
      "This pass names no model. Codex's settings chose gpt-5.6-sol, which this account is not offered, so Dim Factory asked Codex to run the account's default, gpt-6-luna, instead."
    // Running: core still expects its default (Codex has not said which model runs).
    const running = asked({ status: 'running', expectedModel: 'gpt-6-luna' })
    const r = renderUi(<PassCard runId={RUN} snap={running} view={running.steps.implement} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-implement').textContent).toBe('gpt-6-luna')
    const live = await tooltipOf(screen.getByTestId('model-chip-implement'))
    expect(live).toBe(`${head} Codex has not confirmed yet which model it runs.`)
    expect(live).not.toContain('Codex ran')
    r.unmount()
    // Stopped before Codex said: nothing is claimed to have run.
    const stopped = asked({ status: 'cancelled' })
    renderUi(<PassCard runId={RUN} snap={stopped} view={stopped.steps.implement} />)
    await act(() => settle())
    expect(screen.getByTestId('model-chip-implement').textContent).toBe('default model')
    expect(await tooltipOf(screen.getByTestId('model-chip-implement'))).toBe(
      `${head} Codex did not confirm which model ran.`,
    )
    expect(document.body.textContent).not.toContain('—')
  })

  it('a default Codex did not run (its refusal names its own model): the card names what ran, never the default', async () => {
    const refused = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
    const s = snapWith({
      summary: { status: 'failed', phase: 'implementing' },
      steps: {
        implement: {
          status: 'failed',
          attempt: 1,
          vendor: 'codex',
          model: null,
          modelUsed: 'gpt-5.6-sol',
          modelOverrideIgnored: 'gpt-6-luna',
          failure: { category: 'model_unavailable', message: refused, raw: refused, classifiedBy: 'regex' },
        },
      },
    })
    renderUi(<PassCard runId={RUN} snap={s} view={s.steps.implement} />)
    await act(() => settle())
    const chip = screen.getByTestId('model-chip-implement')
    expect(chip.textContent).toBe('gpt-5.6-sol')
    const title = await tooltipOf(chip)
    expect(title).toBe(
      "This pass names no model. Codex's settings chose gpt-5.6-sol, which this account is not offered. Dim Factory asked for the account's default, gpt-6-luna, but Codex ran gpt-5.6-sol, and the account refused it.",
    )
    expect(title).not.toContain('so Dim Factory ran')
    expect(document.body.textContent).not.toContain('—')
  })

  it('a pass that starts where Codex does not say reads "default model" in the width it had (exec route)', async () => {
    const at = (implement: Partial<RunSnapshot['steps']['implement']>): RunSnapshot =>
      snapWith({
        summary: { status: 'running', phase: 'planning' },
        steps: { implement: { attempt: 0, vendor: 'codex', model: null, mode: 'autoedit', ...implement } },
      })
    const card = (s: RunSnapshot) => (
      <TooltipProvider>
        <PassCard runId={RUN} snap={s} view={s.steps.implement} />
        <Toaster />
      </TooltipProvider>
    )
    const chip = (): HTMLElement => screen.getByTestId('model-chip-implement')
    const chips = (): Element[] => [
      ...screen.getByTestId('pass-card-implement').querySelectorAll('header [data-slot="badge"]'),
    ]
    const sizers = (): (string | null)[] =>
      [...chip().querySelectorAll('[data-chip-reserve] > [aria-hidden]')].map((el) =>
        el.getAttribute('data-label'),
      )
    const queued = at({ status: 'queued', expectedModel: 'gpt-6-luna' })
    const r = renderUi(<PassCard runId={RUN} snap={queued} view={queued.steps.implement} />)
    await act(() => settle())
    expect(chip().textContent).toBe('gpt-6-luna')
    // The expected model, and "default model" which the chip reads if Codex never says.
    expect(sizers()).toEqual(['gpt-6-luna', 'default model'])
    const before = chips()

    r.rerender(card(at({ status: 'running', attempt: 1, route: 'exec' })))
    await act(() => settle())
    expect(chip().textContent).toBe('default model')
    expect(sizers()).toEqual(['gpt-6-luna', 'default model'])
    expect(chips().length).toBe(before.length)
    expect(chips().every((el, i) => el === before[i])).toBe(true)
    expect(await tooltipOf(chip())).toBe(
      'This pass names no model, so Codex chooses. Codex has not reported which model it runs.',
    )

    r.rerender(card(at({ status: 'done', attempt: 1, route: 'exec' })))
    await act(() => settle())
    expect(chip().textContent).toBe('default model')
    expect(sizers()).toEqual(['gpt-6-luna', 'default model'])
    expect(await tooltipOf(chip())).toBe(
      'This pass names no model, so Codex chose. Codex did not report which model ran.',
    )
  })

  it('a queued pass names the model core expects; the chip row does not reflow when the pass starts', async () => {
    const at = (implement: Partial<RunSnapshot['steps']['implement']>): RunSnapshot =>
      snapWith({
        summary: { status: 'running', phase: 'planning' },
        steps: { implement: { attempt: 0, vendor: 'codex', model: null, mode: 'autoedit', ...implement } },
      })
    const passCard = (s: RunSnapshot, runId = RUN) => (
      <PassCard runId={runId} snap={s} view={s.steps.implement} />
    )
    /** The same tree renderUi made, so a rerender updates the card in place (as a new snapshot does). */
    const card = (s: RunSnapshot, runId = RUN) => (
      <TooltipProvider>
        {passCard(s, runId)}
        <Toaster />
      </TooltipProvider>
    )
    const chip = (): HTMLElement => screen.getByTestId('model-chip-implement')
    /** The header's chips (vendor, model, mode, …) in order: the elements and their text. */
    const chips = (): Element[] => [
      ...screen.getByTestId('pass-card-implement').querySelectorAll('header [data-slot="badge"]'),
    ]
    /** The text whose width the model chip keeps (its invisible sizer), and the text it shows over it. */
    /** The very same elements, in the same order (nothing was inserted, removed or remounted in the row). */
    const sameElements = (a: Element[], b: Element[]): boolean =>
      a.length === b.length && a.every((el, i) => el === b[i])
    const sizer = (): Element | null => chip().querySelector('[data-chip-reserve] > [aria-hidden]')
    const shown = (): Element | null => chip().querySelector('[data-chip-reserve] > span:not([aria-hidden])')

    const queued = at({ status: 'queued', expectedModel: 'gpt-6-luna' })
    const r = renderUi(passCard(queued))
    await act(() => settle())
    expect(chip().textContent).toBe('gpt-6-luna')
    expect(await tooltipOf(chip())).toBe(
      'This pass names no model, so Codex chooses. Dim Factory expects gpt-6-luna, its default for this account, and prices the estimate at it.',
    )
    const before = chips()
    const beforeText = before.map((el) => el.textContent)
    expect(sizer()?.getAttribute('data-label')).toBe('gpt-6-luna')
    expect(
      [...chip().querySelectorAll('[data-chip-reserve] > [aria-hidden]')].map((el) =>
        el.getAttribute('data-label'),
      ),
    ).toEqual(['gpt-6-luna', 'default model'])

    // The vendor confirms the expected model as the pass starts: nothing in the row changes.
    r.rerender(
      card(at({ status: 'running', attempt: 1, expectedModel: 'gpt-6-luna', modelUsed: 'gpt-6-luna' })),
    )
    await act(() => settle())
    expect(sameElements(chips(), before)).toBe(true)
    expect(chips().map((el) => el.textContent)).toEqual(beforeText)
    expect(sizer()?.getAttribute('data-label')).toBe('gpt-6-luna')

    // The folder's settings chose another, longer model: the chip shows it within the width it had (the sizer keeps
    // the first text; the shown text is laid over it and cut), so the chips after it stay where they were.
    r.rerender(
      card(
        at({ status: 'running', attempt: 1, expectedModel: 'gpt-6-luna', modelUsed: 'gpt-5.6-terra-long' }),
      ),
    )
    await act(() => settle())
    expect(chip().textContent).toBe('gpt-5.6-terra-long')
    expect(sizer()?.getAttribute('data-label')).toBe('gpt-6-luna')
    expect(sizer()?.textContent).toBe('')
    expect(shown()?.className).toContain('absolute')
    expect(shown()?.className).toContain('truncate')
    expect(sameElements(chips(), before)).toBe(true)
    expect(chips().map((el) => el.textContent)).toEqual(
      beforeText.map((t) => (t === 'gpt-6-luna' ? 'gpt-5.6-terra-long' : t)),
    )
    expect(await tooltipOf(chip())).toBe(
      "This pass names no model. Codex's settings chose gpt-5.6-terra-long for this folder.",
    )

    // Another run's card sizes the chip anew (a card that opens on a pass that already ran is not cut).
    r.rerender(card(at({ status: 'done', attempt: 1, modelUsed: 'gpt-5.6-terra-long' }), 'run-2'))
    await act(() => settle())
    expect(sizer()?.getAttribute('data-label')).toBe('gpt-5.6-terra-long')
  })

  it('the Config tab names the expected model as the pass will run it; a confirmed expectation changes nothing', async () => {
    const at = (implement: Partial<RunSnapshot['steps']['implement']>): RunSnapshot =>
      snapWith({
        summary: { status: 'running', phase: 'planning' },
        steps: {
          plan: { status: 'running', attempt: 1, vendor: 'claude', model: 'opus', mode: 'readonly' },
          implement: { attempt: 0, vendor: 'codex', model: null, mode: 'autoedit', ...implement },
        },
      })
    const tab = (s: RunSnapshot) => (
      <TooltipProvider>
        <ConfigTab snap={s} />
        <Toaster />
      </TooltipProvider>
    )
    const r = renderUi(<ConfigTab snap={at({ status: 'queued', expectedModel: 'gpt-6-luna' })} />)
    await act(() => settle())
    const cell = (): HTMLElement => screen.getByTestId('config-model-implement')
    const first = cell()
    expect(first.textContent).toBe('gpt-6-luna (default)')
    expect(first.getAttribute('title')).toBe(
      'This pass names no model, so Codex chooses. Dim Factory expects gpt-6-luna, its default for this account, and prices the estimate at it.',
    )
    // One line, cut with its full text in the title; the table's columns have fixed shares.
    expect(first.className).toContain('truncate')
    const table = first.closest('table')
    expect(table?.className).toContain('table-fixed')
    const cols = [...(table?.querySelectorAll('colgroup > col') ?? [])]
    expect(cols).toHaveLength(6)
    expect(screen.getByTestId('config-col-model').className).toMatch(/w-\[\d+%\]/)

    // The pass starts and Codex confirms the expected model: the cell is the same element with the same text.
    r.rerender(tab(at({ status: 'running', attempt: 1, route: 'app-server', modelUsed: 'gpt-6-luna' })))
    await act(() => settle())
    expect(cell()).toBe(first)
    expect(cell().textContent).toBe('gpt-6-luna (default)')
    // Another model ran: named the same way.
    r.rerender(tab(at({ status: 'running', attempt: 1, route: 'app-server', modelUsed: 'gpt-5.6-terra' })))
    await act(() => settle())
    expect(cell().textContent).toBe('gpt-5.6-terra (default)')
    // On the exec route Codex never says: "default".
    r.rerender(tab(at({ status: 'done', attempt: 1, route: 'exec' })))
    await act(() => settle())
    expect(cell().textContent).toBe('default')
    expect(cell().getAttribute('title')).toBe(
      'This pass names no model, so Codex chose. Codex did not report which model ran.',
    )
    expect(document.body.textContent).not.toContain('—')
  })

  it('the Config tab says the model ran as the default', async () => {
    current = snapWith({
      summary: { status: 'completed', phase: 'done', outcome: 'fixed', endedAt: 1_700_000_900_000 },
      steps: {
        implement: { status: 'done', attempt: 1, vendor: 'codex', model: null, modelUsed: 'gpt-6-luna' },
        fix: { status: 'done', attempt: 1, vendor: 'codex', model: null },
      },
    })
    window.location.hash = `#/runs/${RUN}/config`
    renderUi(<RunPage runId={RUN} tab="config" />)
    await waitFor(() => expect(screen.getByTestId('config-row-implement')).toBeTruthy())
    const cells = (k: string) =>
      [...screen.getByTestId(`config-row-${k}`).querySelectorAll('td')].map((c) => c.textContent)
    expect(cells('implement')[2]).toBe('gpt-6-luna (default)')
    expect(cells('fix')[2]).toBe('default')
  })
})
