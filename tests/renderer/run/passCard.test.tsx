// components/run/PassCard: the states of one step (queued; running before output shows the launch status line; done
// collapses; failed shows Snag v1 with Retry/Close run working and later actions disabled), the plan's edited chip,
// Fix's session line and the ⋯ menu.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { RunEnvelope, RunSnapshot, StepKey } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, text } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith, stubClipboard } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  log = []
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
      'runs.retryPass': () => undefined,
      'runs.close': () => undefined,
      'runs.skipPass': () => undefined,
      'shell.open': () => undefined,
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

function card(snap: RunSnapshot, step: StepKey): ReturnType<typeof renderUi> {
  return renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps[step]} />)
}

describe('PassCard', () => {
  it('shows a queued pass without a stream or a timer', () => {
    card(snapWith(), 'implement')
    const el = screen.getByTestId('pass-card-implement')
    expect(el.getAttribute('data-status')).toBe('queued')
    expect(el.textContent).toContain('Queued')
    expect(screen.queryByTestId('stream-implement')).toBeNull()
    expect(screen.queryByTestId('pass-time-implement')).toBeNull()
  })

  it('shows the launch status line instead of a spinner before the first output', async () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'running',
          attempt: 1,
          vendor: 'claude',
          model: 'opus',
          mode: 'autoedit',
          activeMs: 1200,
        },
      },
    })
    card(snap, 'implement')
    expect(screen.getByTestId('launch-line-implement').textContent).toBe(
      'Starting Claude · waiting for first output',
    )
    log = [
      env(RUN, 1, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }, Date.now() - 2000),
      env(
        RUN,
        2,
        {
          t: 'step-status',
          step: 'implement',
          attempt: 1,
          status: 'running',
          argv: ['C:\\Tools\\claude.exe', '-p', '--output-format', 'stream-json'],
        },
        Date.now() - 3000,
      ),
    ]
    // A remount searches the log again (the hook also follows live envelopes).
    card(snap, 'implement')
    await waitFor(() =>
      expect(screen.getAllByTestId('launch-line-implement').at(-1)?.textContent).toMatch(
        /^claude\.exe spawned \d+ s ago · waiting for first output$/,
      ),
    )
    expect(screen.getAllByTestId('stream-implement').at(-1)?.getAttribute('role')).toBe('log')
    expect(screen.getAllByTestId('mode-chip-implement')[0]?.textContent).toBe('edits files')
  })

  it('renders the live stream once output arrives', () => {
    const snap = snapWith({ steps: { implement: { status: 'running', attempt: 1, vendor: 'claude' } } })
    card(snap, 'implement')
    act(() => {
      streamBuffer.apply(env(RUN, 1, text('implement', '## Step one\nEdited **src/cli.ts**\n')))
      streamBuffer.apply(
        env(RUN, 2, {
          t: 'ev',
          step: 'implement',
          attempt: 1,
          ev: { type: 'tool', id: 't1', name: 'Bash', summary: 'npm test', phase: 'start' },
        }),
      )
      streamBuffer.flush()
    })
    const pane = screen.getByTestId('stream-implement')
    expect(pane.textContent).toContain('Step one')
    expect(pane.querySelector('strong')?.textContent).toBe('src/cli.ts')
    expect(pane.querySelector('[data-kind="tool"]')?.getAttribute('data-status')).toBe('running')
    expect(screen.queryByTestId('launch-line-implement')).toBeNull()
  })

  it('collapses a finished pass and expands it on request', () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'done',
          attempt: 1,
          vendor: 'claude',
          activeMs: 65_000,
          usage: { input: 12_300, output: 4100, cacheRead: 80_000 },
          cost: { usd: 0.42, basis: 'catalog', apiEquivalent: false },
        },
      },
    })
    card(snap, 'implement')
    const el = screen.getByTestId('pass-card-implement')
    expect(el.textContent).toContain('1m 5s')
    expect(el.textContent).toContain('12.3k in · 4.1k out · 80.0k cache')
    expect(el.textContent).toContain('$0.42 est.')
    expect(screen.queryByTestId('stream-implement')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Implement' }))
    expect(screen.getByTestId('stream-implement')).toBeTruthy()
  })

  it('shows Snag v1 for a failed pass: Retry and Close run work, later actions are disabled', async () => {
    const actions: RecoveryAction[] = [
      { id: 'implement:retry', label: 'Retry', kind: 'retry', strategy: 'auto' },
      {
        id: 'auth',
        label: 'Copy login command',
        kind: 'shell_copy',
        command: 'claude auth login',
        shell: 'powershell',
        reason: 'Log in again',
        recheck: 'vendor.claude.auth',
      },
      {
        id: 'switch',
        label: 'Use Codex instead',
        kind: 'switch_vendor',
        pass: 'implement',
        to: 'codex',
        model: null,
      },
      { id: 'run:close', label: 'Close run', kind: 'close_run' },
    ]
    const failure = {
      category: 'auth_expired' as const,
      message: 'OAuth token has expired',
      raw: 'Error: OAuth token has expired (401)',
      classifiedBy: 'regex' as const,
      step: 'implement' as const,
    }
    log = [env(RUN, 1, { t: 'snag', step: 'implement', failure, actions })]
    const clip = stubClipboard()
    const snap = snapWith({
      steps: {
        implement: { status: 'failed', attempt: 1, vendor: 'claude', failure, reason: 'auth_expired' },
      },
    })
    card(snap, 'implement')
    const snag = screen.getByTestId('snag-implement')
    expect(snag.textContent).toContain('Claude login expired')
    expect(snag.textContent).toContain('OAuth token has expired')
    await waitFor(() => expect(screen.getByTestId('recovery-implement:retry')).toBeTruthy())

    const retry = screen.getByTestId<HTMLButtonElement>('recovery-implement:retry')
    const close = screen.getByTestId<HTMLButtonElement>('recovery-run:close')
    const copy = screen.getByTestId<HTMLButtonElement>('recovery-auth')
    const later = screen.getByTestId<HTMLButtonElement>('recovery-switch')
    expect(retry.disabled).toBe(false)
    expect(close.disabled).toBe(false)
    expect(copy.disabled).toBe(false)
    expect(later.disabled).toBe(true)
    // The focusable wrapper is named by the control and the reason (DisabledHint).
    expect(later.closest('[data-disabled-hint]')).toBe(
      screen.getByRole('group', { name: 'Use Codex instead Available in a later version' }),
    )

    await act(async () => {
      fireEvent.click(retry)
      await settle()
    })
    expect(mock.callsOf('runs.retryPass')).toEqual([{ runId: RUN, pass: 'implement', strategy: 'auto' }])
    await act(async () => {
      fireEvent.click(close)
      await settle()
    })
    expect(mock.callsOf('runs.close')).toEqual([{ runId: RUN }])
    await act(async () => {
      fireEvent.click(copy)
      await settle()
    })
    expect(clip.writes).toEqual(['claude auth login'])
    expect(snag.querySelector('details')?.textContent).toContain('OAuth token has expired (401)')
  })

  it('shows no snag for a user Stop', () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'cancelled',
          attempt: 1,
          failure: { category: 'user_cancelled', message: 'Stopped', raw: '', classifiedBy: 'app' },
        },
      },
    })
    card(snap, 'implement')
    expect(screen.queryByTestId('snag-implement')).toBeNull()
  })

  it("shows the plan, its mode chip and an 'edited +n −m' chip that expands the diff", async () => {
    mock.on('runs.output', (req) => {
      if (req.file === 'plan') return { text: '# Plan\n1. Add flag\n2. Test it\n', mtime: 1, version: 2 }
      if (req.file === 'plan.original') return { text: '# Plan\n1. Add flag\n', mtime: 1, version: 1 }
      throw mockError('NOT_FOUND', 'none')
    })
    const snap = snapWith({
      steps: { plan: { status: 'done', attempt: 1, vendor: 'claude', planMode: 'native', activeMs: 30_000 } },
    })
    card(snap, 'plan')
    expect(screen.getByTestId('plan-mode-chip').textContent).toBe('Native plan · Claude plan mode')
    // The chip sits in the header, so a collapsed (finished) Plan card shows it too.
    await waitFor(() => expect(screen.getByTestId('plan-edited-chip').textContent).toContain('Edited +1 −0'))
    expect(screen.queryByText('2. Test it')).toBeNull()
    fireEvent.click(screen.getByTestId('plan-edited-chip'))
    const diff = screen.getByTestId('plan-edit-diff')
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('2. Test it')
    // Expanded, the card shows the approved plan itself.
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByTestId('pass-card-plan').textContent).toContain('Test it')
  })

  it('does not read plan outputs for other passes', () => {
    card(
      snapWith({
        steps: { plan: { status: 'done', attempt: 1 }, implement: { status: 'done', attempt: 1 } },
      }),
      'implement',
    )
    expect(mock.callsOf('runs.output')).toEqual([])
  })

  it('says when the plan fell back to the template', () => {
    const snap = snapWith({
      steps: {
        plan: {
          status: 'running',
          attempt: 1,
          vendor: 'claude',
          planMode: 'emulated',
          planFallbackReason: 'Native plan mode returned an empty plan.',
        },
      },
    })
    card(snap, 'plan')
    expect(screen.getByTestId('plan-mode-chip').textContent).toBe(
      'Fell back to template: Native plan mode returned an empty plan.',
    )
  })

  it("shows Fix's session line and a skipped pass's reason", () => {
    const snap = snapWith({
      steps: {
        fix: { status: 'running', attempt: 1, vendor: 'claude', sessionNote: 'reused the Implement session' },
        critic: { status: 'skipped', attempt: 0, reason: 'no findings' },
      },
    })
    card(snap, 'fix')
    expect(screen.getByTestId('fix-session-line').textContent).toBe('Session: reused the Implement session')
    card(snap, 'critic')
    expect(screen.getByTestId('pass-reason-critic').textContent).toBe('Skipped · no findings to fix')
  })

  it('offers Retry and Continue without from the ⋯ menu only for a failed or paused pass', async () => {
    const snap = snapWith({
      steps: { review: { status: 'paused', attempt: 1, vendor: 'claude', pause: 'interrupted' } },
    })
    card(snap, 'review')
    const trigger = screen.getByTestId('pass-menu-review')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const retry = await screen.findByTestId('pass-retry')
    expect(retry.getAttribute('data-disabled')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('pass-skip'))
      await settle()
    })
    expect(mock.callsOf('runs.skipPass')).toEqual([{ runId: RUN, pass: 'review' }])
    expect(useStore.getState().toasts.items).toEqual([])
  })

  it('copies the launch command from the log', async () => {
    const clip = stubClipboard()
    log = [
      env(RUN, 1, {
        t: 'step-status',
        step: 'implement',
        attempt: 1,
        status: 'running',
        argv: ['C:\\Program Files\\claude\\claude.exe', '-p', '--model', 'opus'],
      }),
    ]
    const snap = snapWith({ steps: { implement: { status: 'done', attempt: 1, vendor: 'claude' } } })
    card(snap, 'implement')
    fireEvent.pointerDown(screen.getByTestId('pass-menu-implement'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    expect((await screen.findByTestId('pass-retry')).getAttribute('data-disabled')).toBe('')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pass-copy-launch'))
      await settle(20)
    })
    await waitFor(() =>
      expect(clip.writes).toEqual(['"C:\\Program Files\\claude\\claude.exe" -p --model opus']),
    )
  })
})
