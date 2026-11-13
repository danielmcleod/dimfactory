// VerifyCard (the Verify step's results, the Run view and UI standards): a verify
// round in the flow with a row per command (core's status in words, time, exit code, reason), a failing command's
// excerpt, Auto's untrusted skip with a way to Settings, and the round's output streamed through runs.output in an
// inner region that follows only while the user is at its bottom. A round the view watched keeps its live layout
// (output first, excerpts open on a click); a round over when the card mounts shows its rows first with the excerpts
// open and its output in a disclosure, read only once opened.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot, StepView } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { VerifyCard, TRUST_IN_SETTINGS, VERIFY_ABORTED } from '@renderer/components/run/VerifyCard.tsx'
import { READ_EVERY_MS, tailText, VERIFY_OUTPUT_TAIL } from '@renderer/components/run/VerifyOutput.tsx'
import { verifyCommandsOf, verifyFactsText, verifySummaryText } from '@renderer/components/run/VerifyModel.ts'
import { parseHash } from '@renderer/lib/router.ts'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import { env, runEvent } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { eventsHandler, RUN, snapWith } from '../run/helpers.tsx'
import { TEST_FAIL, TYPECHECK, verifyStep } from './fixtures.ts'

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

function snapOf(v: Partial<StepView>, key: 'verify:1' | 'verify:2' = 'verify:1'): RunSnapshot {
  return snapWith({ steps: { implement: { status: 'done', attempt: 1 }, [key]: v } })
}

function mountCard(snap: RunSnapshot, key: 'verify:1' | 'verify:2' = 'verify:1', finishedAtOpen?: boolean) {
  const view = snap.steps[key]
  return render(
    <Providers>
      <VerifyCard
        runId={RUN}
        snap={snap}
        view={view}
        {...(finishedAtOpen !== undefined ? { finishedAtOpen } : {})}
      />
    </Providers>,
  )
}

/** Let the log search, the output read and the renders after them finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle()
}

const row = (i: number, key = 'verify:1'): HTMLElement => screen.getByTestId(`verify-command-${key}-${i}`)

describe('a round that runs while the view watches', () => {
  it('shows each command as core states it, the round output streamed as core writes it, and follows it', async () => {
    log = [env(RUN, 1, { t: 'output', file: 'verify:1', version: 1 })]
    output = '> pnpm run typecheck\nok\n'
    const running = snapOf(
      verifyStep({
        status: 'running',
        activeMs: 13_000,
        commands: [TYPECHECK, { name: 'test', argv: ['pnpm', 'run', 'test'], status: 'running' }],
      }),
    )
    const view = mountCard(running)
    await flush()
    const card = screen.getByTestId('pass-card-verify:1')
    expect(card.getAttribute('data-kind')).toBe('verify')
    expect(card.id).toBe('pass-card-verify:1')
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe('1 running · 1 passed')
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-status').textContent).toBe('Passed')
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-facts').textContent).toBe('12s')
    expect(row(0).textContent).toContain('pnpm run typecheck')
    expect(within(row(1)).getByTestId('verify-command-verify:1-1-status').textContent).toBe('Running')

    // The output pane: an allowed inner region with its live height from the start, before the rows.
    const pane = screen.getByTestId('verify-output-verify:1')
    expect(pane.getAttribute('data-scroll-region')).toBe('verify-output')
    expect(pane.getAttribute('role')).toBe('log')
    expect(pane.className).toContain('h-[min(20rem,var(--run-region-max,50vh))]')
    expect(pane.className).toContain('max-h-[min(20rem,var(--run-region-max,50vh))]')
    expect(pane.className.split(' ')).toEqual(expect.arrayContaining(['overflow-y-auto', 'scroll-region']))
    expect(pane.compareDocumentPosition(row(0)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pane.textContent).toContain('ok')

    // Core writes more and says so: the pane reads the new version (at most every READ_EVERY_MS).
    output += '> pnpm run test\nRUN v3\n'
    log.push(env(RUN, 2, { t: 'output', file: 'verify:1', version: 2 }))
    act(() => mock.push(runEvent(log[1] as RunEnvelope)))
    await settle(READ_EVERY_MS)
    await flush()
    expect(pane.textContent).toContain('RUN v3')
    expect(mock.callsOf('runs.output').every((r) => r.file === 'verify:1')).toBe(true)

    // Scrolled up by the user: it stops following and offers Jump to latest (an overlay); the click goes back.
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 100 })
    pane.scrollTop = 200
    fireEvent.scroll(pane)
    await settle()
    const jump = screen.getByTestId('verify-output-jump-verify:1')
    fireEvent.click(jump)
    await settle()
    expect(pane.scrollTop).toBe(1000)
    expect(screen.queryByTestId('verify-output-jump-verify:1')).toBeNull()

    // The round ends with a failure: the row changes words in place; its excerpt opens on a click.
    const done = snapOf(verifyStep({ commands: [TYPECHECK, TEST_FAIL] }))
    view.rerender(
      <Providers>
        <VerifyCard runId={RUN} snap={done} view={done.steps['verify:1']} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('verify-output-verify:1')).toBe(pane)
    expect(within(row(1)).getByTestId('verify-command-verify:1-1-status').textContent).toBe('Failed')
    expect(within(row(1)).getByTestId('verify-command-verify:1-1-facts').textContent).toBe('exit 1 · 41s')
    expect(screen.queryByTestId('verify-command-verify:1-1-excerpt')).toBeNull()
    fireEvent.click(screen.getByTestId('verify-command-verify:1-1-excerpt-toggle'))
    expect(screen.getByTestId('verify-command-verify:1-1-excerpt').textContent).toContain('expected "1.2.0"')
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe('1 failed · 1 passed')
  })

  it('says it waits for the card below while a trust card holds the round', async () => {
    mountCard(snapOf(verifyStep({ status: 'waiting', commands: [{ ...TYPECHECK, status: 'queued' }] })))
    await settle()
    expect(screen.getByTestId('verify-output-verify:1').textContent).toBe('Waiting for your choice below')
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-status').textContent).toBe('Waiting')
  })
})

describe('a round already over when the card mounts', () => {
  it('passes: its rows, and its output only once the disclosure is opened', async () => {
    log = [env(RUN, 1, { t: 'output', file: 'verify:1', version: 3 })]
    output = 'all good\n'
    mountCard(
      snapOf(verifyStep({ commands: [TYPECHECK, { ...TYPECHECK, name: 'lint', durationMs: 3_000 }] })),
      'verify:1',
      false,
    )
    await settle()
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe('2 passed')
    expect(screen.getByTestId('verify-commands-verify:1').getAttribute('aria-label')).toBe('Verify commands')
    expect(mock.callsOf('runs.output')).toEqual([])
    const details = screen.getByTestId<HTMLDetailsElement>('verify-output-details-verify:1')
    act(() => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    await flush()
    expect(screen.getByTestId('verify-output-verify:1').textContent).toContain('all good')
    expect(mock.callsOf('runs.output')).toEqual([{ runId: RUN, file: 'verify:1' }])
  })

  it('fails: the failing command with its exit code, time and excerpt open in an inner region', async () => {
    mountCard(snapOf(verifyStep({ commands: [TYPECHECK, TEST_FAIL] }), 'verify:2'), 'verify:2', false)
    await settle()
    const summary = screen.getByTestId('verify-summary-verify:2')
    expect(summary.textContent).toBe('1 failed · 1 passed')
    expect(summary.className).toContain('text-st-failed')
    const fail = row(1, 'verify:2')
    expect(fail.getAttribute('data-status')).toBe('fail')
    expect(within(fail).getByTestId('verify-command-verify:2-1-facts').textContent).toBe('exit 1 · 41s')
    const excerpt = screen.getByTestId('verify-command-verify:2-1-excerpt')
    expect(excerpt.textContent).toContain('Tests: 1 failed, 12 passed')
    expect(excerpt.getAttribute('data-scroll-region')).toBe('verify-output')
    expect(excerpt.className).toContain('max-h-[min(20rem,var(--run-region-max,50vh))]')
    expect(screen.getByRole('heading', { name: 'Final verify' })).toBeTruthy()
  })

  it('env: could not run, with core’s reason and the excerpt; never a finding', async () => {
    mountCard(
      snapOf(
        verifyStep({
          commands: [
            {
              name: 'lint',
              argv: ['eslint', '.'],
              status: 'env',
              exitCode: 9009,
              durationMs: 400,
              reason: 'eslint was not found on this computer.',
              excerpt: "'eslint' is not recognized as an internal or external command",
            },
          ],
        }),
      ),
      'verify:1',
      false,
    )
    await settle()
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-status').textContent).toBe('Could not run')
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-facts').textContent).toBe('exit 9009 · 0s')
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-note').textContent).toContain(
      'eslint was not found on this computer.',
    )
    expect(screen.getByTestId('verify-command-verify:1-0-excerpt').textContent).toContain('not recognized')
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe('1 could not run')
  })

  it('skipped untrusted (Auto): says so and links to Settings for the run’s folder', async () => {
    mountCard(
      snapOf(
        verifyStep({
          commands: [
            {
              name: 'test',
              argv: ['pnpm', 'run', 'test'],
              status: 'skipped-untrusted',
              reason: 'Not trusted for this project. Auto never trusts a command on its own.',
            },
          ],
        }),
      ),
      'verify:1',
      false,
    )
    await settle()
    expect(within(row(0)).getByTestId('verify-command-verify:1-0-status').textContent).toBe('Not trusted')
    const link = screen.getByTestId('verify-command-verify:1-0-trust')
    expect(link.textContent).toBe(TRUST_IN_SETTINGS)
    expect(parseHash(link.getAttribute('href') ?? '')).toEqual({
      name: 'settings',
      section: 'isolation',
      subpath: [],
      query: { field: '/verify/commands', folder: 'C:\\work\\repo' },
    })
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe('1 not trusted')
  })

  it('a round failFast stopped says so; a finished round seen at open starts collapsed', async () => {
    const snap = snapOf({
      ...verifyStep({ commands: [TEST_FAIL, { name: 'lint', argv: ['pnpm', 'lint'], status: 'skipped' }] }),
      verify: {
        commands: [
          TEST_FAIL,
          { name: 'lint', argv: ['pnpm', 'lint'], status: 'skipped', reason: 'Not run.' },
        ],
        aborted: true,
      },
    })
    mountCard(snap, 'verify:1', true)
    await settle()
    expect(screen.queryByTestId('verify-commands-verify:1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(screen.getByTestId('verify-aborted-verify:1').textContent).toBe(VERIFY_ABORTED)
  })

  it('a skipped round says why, in core’s words', async () => {
    mountCard(snapOf({ status: 'skipped', attempt: 0, activeMs: 0, reason: 'user' }))
    await settle()
    expect(screen.getByTestId('pass-reason-verify:1').textContent).toBe('Skipped · you skipped it')
  })
})

describe('the flow', () => {
  it('gives a verify round its VerifyCard and keeps PassCards for the passes', async () => {
    const snap = snapWith({
      steps: {
        implement: { status: 'done', attempt: 1 },
        'verify:1': verifyStep({ commands: [TYPECHECK] }),
      },
    })
    render(
      <Providers>
        <FlowTab snap={snap} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('pass-card-verify:1').getAttribute('data-kind')).toBe('verify')
    expect(screen.getByTestId('pass-card-implement').getAttribute('data-kind')).toBeNull()
  })
})

describe('verify words', () => {
  it('reads core’s view defensively and words it without an em dash', () => {
    const view = { key: 'verify:1', status: 'done', attempt: 1, activeMs: 0 } as StepView
    expect(verifyCommandsOf(view)).toEqual([])
    expect(verifySummaryText([])).toBeNull()
    const odd = {
      ...view,
      verify: { commands: [{ name: 'x', status: 'nope' }, TYPECHECK, null] },
    } as unknown as StepView
    expect(verifyCommandsOf(odd)).toEqual([TYPECHECK])
    expect(verifyFactsText({ ...TEST_FAIL, exitCode: null })).toBe('41s')
    expect(verifySummaryText([TEST_FAIL, TYPECHECK, TYPECHECK])).toBe('1 failed · 2 passed')
    for (const s of [VERIFY_ABORTED, TRUST_IN_SETTINGS]) expect(s).not.toContain('\u2014')
  })

  it('keeps the newest part of a long output, from a line start', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
    const t = tailText(lines)
    expect(t.cut).toBe(true)
    expect(t.text.length).toBeLessThanOrEqual(VERIFY_OUTPUT_TAIL)
    expect(t.text.startsWith('line ')).toBe(true)
    expect(t.text.endsWith('line 19999')).toBe(true)
    expect(tailText('short')).toEqual({ text: 'short', cut: false })
  })
})
