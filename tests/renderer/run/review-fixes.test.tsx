// Review fixes in the Run view: the plan line says "approved" only from core's gate card,
// Review and Critic list their own findings from core's findings.json, Snag's "Continue without" works, and the Log
// tab re-renders at most once per frame however many live batches arrive.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindingsFile } from '@shared/findings.ts'
import type { RunEnvelope, RunEventBody } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { clearPlanGateCache } from '@renderer/components/run/plan.ts'
import { RecoveryActions } from '@renderer/components/run/RecoveryActions.tsx'
import { findFirstEnvelope, useLogTail } from '@renderer/components/run/runLog.ts'
import { SummaryBar } from '@renderer/components/run/SummaryBar.tsx'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { formatLogTime } from '@renderer/pages/run/LogTab.tsx'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, runEvent, text } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]
let outputs: Record<string, string>

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  clearPlanGateCache()
  log = []
  outputs = {}
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
      'runs.skipPass': () => undefined,
      'runs.output': (req) => {
        const t = outputs[req.file]
        if (t === undefined) throw mockError('NOT_FOUND', 'none')
        return { text: t, mtime: 1, version: 1 }
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

const gateCard = {
  id: 'gate-1',
  kind: 'gate:afterPlan' as const,
  title: 'Review the plan',
  body: '',
  payload: {},
  blocking: true,
  choices: [],
}
const planStatus = (status: 'running' | 'done'): RunEventBody => ({
  t: 'step-status',
  step: 'plan',
  attempt: 1,
  status,
})
const implementRunning: RunEventBody = { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }
const planDone = snapWith({ steps: { plan: { status: 'done', attempt: 1 } } })

describe('SummaryBar plan line (core gate card)', () => {
  it('says approved when the gate card closed with Approve', async () => {
    log = [
      env(RUN, 1, planStatus('running')),
      env(RUN, 2, text('plan', 'the plan')),
      env(RUN, 3, planStatus('done')),
      env(RUN, 4, { t: 'card', card: gateCard, state: 'open' }),
      env(RUN, 5, { t: 'card', card: gateCard, state: 'resolved', choiceId: 'approve' }),
      env(RUN, 6, implementRunning),
    ]
    renderUi(<SummaryBar snap={planDone} onOpenDiff={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('summary-plan').textContent).toBe('Plan ✓ approved'))
  })

  it('says done when no gate ran (Auto, or gates.afterPlan off): nobody approved anything', async () => {
    log = [env(RUN, 1, planStatus('running')), env(RUN, 2, planStatus('done')), env(RUN, 3, implementRunning)]
    renderUi(<SummaryBar snap={planDone} onOpenDiff={() => undefined} />)
    await act(async () => {
      await settle(10)
    })
    expect(screen.getByTestId('summary-plan').textContent).toBe('Plan done')
  })

  it('reads the log forwards and stops at the first later step', async () => {
    log = [
      env(RUN, 1, planStatus('done')),
      env(RUN, 2, implementRunning),
      ...Array.from({ length: 3000 }, (_, i) => env(RUN, i + 3, text('implement', 'x'))),
    ]
    const found = await findFirstEnvelope(RUN, (b) => b.t === 'card', {
      until: (b) => b.t === 'step-status' && b.step === 'implement',
    })
    expect(found).toBeNull()
    // One window from seq 0 was enough; the 3,000 Implement deltas were never paged through.
    expect(mock.callsOf('runs.events').map((r) => r.sinceSeq)).toEqual([0])
  })
})

describe('Review and Critic list their own findings', () => {
  const findings: FindingsFile = {
    schemaVersion: 1,
    runId: RUN,
    round: 1,
    sources: {
      review: { status: 'ok', count: 2, rawFile: 'review.md' },
      critic: { status: 'none', count: 0, rawFile: 'critic.md' },
    },
    findings: [
      {
        id: 'a',
        n: 1,
        severity: 'must',
        source: 'review',
        title: 'No --version output',
        body: '',
        flags: [],
        round: 1,
      },
      {
        id: 'b',
        n: 2,
        severity: 'should',
        source: 'review',
        title: 'Unused import',
        body: '',
        flags: [],
        round: 1,
      },
    ],
    selected: { a: true, b: true },
  }
  const reviewed = snapWith({
    summary: { findings: { must: 1, should: 1 } },
    steps: { review: { status: 'done', attempt: 1 }, critic: { status: 'done', attempt: 1 } },
  })
  const expand = (step: string): void => {
    fireEvent.click(screen.getByRole('button', { name: step }))
  }

  it('Review lists its findings; Critic says it found none; no run-wide totals on either card', async () => {
    outputs['findings'] = JSON.stringify(findings)
    renderUi(
      <>
        <PassCard runId={RUN} snap={reviewed} view={reviewed.steps.review} />
        <PassCard runId={RUN} snap={reviewed} view={reviewed.steps.critic} />
      </>,
    )
    expand('Review')
    expand('Critic')
    await waitFor(() => expect(screen.getByTestId('findings-review')).toBeTruthy())
    const items = screen.getByTestId('findings-review').querySelectorAll('li')
    expect([...items].map((li) => li.textContent)).toEqual([
      'mustF1No --version output',
      'shouldF2Unused import',
    ])
    expect(screen.getByTestId('no-findings-critic').textContent).toBe('No findings from Critic.')
    expect(screen.queryByText(/Findings so far/)).toBeNull()
  })

  it('a card open since its step finished lists the findings once core writes them (its output body)', async () => {
    const release = startBridge()
    try {
      // Review finished; findings.json is not written yet.
      renderUi(<PassCard runId={RUN} snap={reviewed} view={reviewed.steps.review} />)
      expand('Review')
      await act(async () => {
        await settle()
      })
      expect(screen.queryByTestId('findings-review')).toBeNull()
      // Core writes it and says so: the open card reads it again.
      outputs['findings'] = JSON.stringify(findings)
      log.push(env(RUN, 1, { t: 'output', file: 'findings', version: 1 }))
      await act(async () => {
        mock.push(runEvent(log[0] as RunEnvelope))
        await settle()
      })
      await waitFor(() =>
        expect(screen.getByTestId('findings-review').querySelectorAll('li')).toHaveLength(2),
      )
    } finally {
      release()
    }
  })

  it("shows the reviewer's report when core could not structure its findings", async () => {
    outputs['findings'] = JSON.stringify({
      ...findings,
      sources: { ...findings.sources, critic: { status: 'unstructured', count: 0, rawFile: 'critic.md' } },
    })
    outputs['critic'] = 'The critic wrote prose without tags.'
    renderUi(<PassCard runId={RUN} snap={reviewed} view={reviewed.steps.critic} />)
    expand('Critic')
    await waitFor(() =>
      expect(screen.getByTestId('pass-card-critic').textContent).toContain(
        'The critic wrote prose without tags.',
      ),
    )
    expect(screen.queryByTestId('no-findings-critic')).toBeNull()
  })
})

describe('Snag recovery: Continue without', () => {
  it('runs runs.skipPass for the pass (it was shown disabled before)', async () => {
    renderUi(
      <RecoveryActions
        runId={RUN}
        step="review"
        actions={[{ id: 'skip', label: 'Continue without Review', kind: 'skip_pass', pass: 'review' }]}
      />,
    )
    const btn = screen.getByTestId<HTMLButtonElement>('recovery-skip')
    expect(btn.disabled).toBe(false)
    expect(btn.closest('[data-disabled-hint]')).toBeNull()
    await act(async () => {
      fireEvent.click(btn)
      await settle()
    })
    expect(mock.callsOf('runs.skipPass')).toEqual([{ runId: RUN, pass: 'review' }])
  })
})

describe('Log tab', () => {
  it('re-renders once per frame however many live batches (separate IPC messages) arrive in it', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const runFrames = (): void => {
      for (const cb of frames.splice(0)) cb(performance.now())
    }
    try {
      log = Array.from({ length: 3 }, (_, i) =>
        env(
          RUN,
          i + 1,
          text(
            'implement',
            `line ${i + 1}
`,
          ),
        ),
      )
      let renders = 0
      function Probe(): React.JSX.Element {
        const t = useLogTail(RUN)
        renders++
        return <span data-testid="total">{t.total}</span>
      }
      render(<Probe />)
      await act(async () => {
        await settle(10)
        runFrames()
      })
      expect(screen.getByTestId('total').textContent).toBe('3')
      const before = renders
      for (let s = 4; s <= 8; s++) {
        await act(async () => {
          const e = env(
            RUN,
            s,
            text(
              'implement',
              `line ${s}
`,
            ),
          )
          log.push(e)
          mock.push(runEvent(e))
          await new Promise((r) => setTimeout(r, 0))
        })
      }
      // Five batches, each its own task: nothing rendered yet, one frame queued.
      expect(renders).toBe(before)
      expect(frames).toHaveLength(1)
      await act(async () => {
        runFrames()
        await Promise.resolve()
      })
      expect(screen.getByTestId('total').textContent).toBe('8')
      expect(renders - before).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('formats times with one shared formatter, as the locale writes a 24-hour time', () => {
    const ts = new Date(2026, 9, 6, 9, 5, 7).getTime()
    const want = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(ts)
    expect(formatLogTime(ts)).toBe(want)
  })
})
