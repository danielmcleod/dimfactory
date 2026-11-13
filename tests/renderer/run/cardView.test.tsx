// components/cards/CardView: the plan gate (edit → Approve sends the edited plan as input; ⌘/Ctrl+↵; the "Don't stop
// after plan" checkbox patches the project config with an undo), the gate before Fix (selection → finding ids),
// insufficientContext, stall, preflight and a choice this build cannot carry out.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { CardView as CardData } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory
const FOLDER = 'C:\\work\\repo'

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: {
      'cards.resolve': () => undefined,
      'runs.get': () => snapWith(),
      'config.read': () => ({
        path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
        exists: true,
        text: '{}',
        value: { gates: { beforeFix: false } },
        issues: [],
        version: 1,
        backups: [],
      }),
      'config.patch': () => ({ path: 'p', changed: true, diff: '', backupId: 'b1' }),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
})

const PLAN = '# Plan\n1. Add a --version flag\n2. Print package.json version\n'

const planGate: CardData = {
  id: 'gate:afterPlan-1',
  kind: 'gate:afterPlan',
  title: 'Review the plan',
  body: PLAN,
  payload: { plan: PLAN },
  blocking: true,
  defaultChoice: 'approve',
  choices: [
    { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

function finding(n: number, severity: 'must' | 'should', source: 'review' | 'critic'): Finding {
  return { id: `f${n}`, n, severity, source, title: `Finding ${n}`, body: '', flags: [], round: 1 }
}

const findings = [finding(1, 'must', 'review'), finding(2, 'must', 'critic'), finding(3, 'should', 'review')]
const beforeFix: CardData = {
  id: 'gate:beforeFix-2',
  kind: 'gate:beforeFix',
  title: '3 findings before Fix: 2 must, 1 should',
  body: '',
  payload: {
    step: 'fix',
    findings,
    selected: findings.map((f) => f.id),
    notes: ['src/a.ts was reverted after Review'],
  },
  blocking: true,
  defaultChoice: 'continue',
  choices: [
    { id: 'continue', label: 'Continue with 3 findings', primary: true, input: 'findings' },
    { id: 'skip-fix', label: 'Skip Fix' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

function show(card: CardData): void {
  renderUi(<CardView runId={RUN} card={card} folder={FOLDER} />)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

describe('CardView gate:afterPlan', () => {
  it('approves an edited plan with the edited text as input, after showing the changes', async () => {
    show(planGate)
    expect(screen.getByTestId('card-gate:afterPlan').textContent).toContain('Add a --version flag')
    fireEvent.click(screen.getByTestId('plan-edit'))
    const editor = screen.getByTestId<HTMLTextAreaElement>('plan-editor')
    const edited = `${PLAN}3. Add a test\n`
    fireEvent.change(editor, { target: { value: edited } })
    fireEvent.click(screen.getByTestId('plan-view-changes'))
    expect(screen.getByTestId('plan-view-changes').textContent).toBe('Hide changes')
    expect(screen.getByTestId('plan-edit-counts').textContent).toBe('Edited · +1 −0')
    expect(screen.getByTestId('plan-gate-diff').querySelector('[data-kind="add"]')?.textContent).toContain(
      '3. Add a test',
    )
    await click(screen.getByTestId('card-choice-approve'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'gate:afterPlan-1', choiceId: 'approve', input: edited },
    ])
  })

  it('approves an unchanged plan without input, also with Ctrl+Enter', async () => {
    show(planGate)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }))
      await settle()
    })
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'gate:afterPlan-1', choiceId: 'approve' },
    ])
    expect(screen.getByTestId('card-choice-approve').getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
  })

  it('turns the plan gate off for the project and undoes it to the previous value', async () => {
    show(planGate)
    await click(screen.getByTestId('plan-gate-skip'))
    await waitFor(() => expect(mock.callsOf('config.patch')).toHaveLength(1))
    expect(mock.callsOf('config.read')).toEqual([{ scope: 'project', folder: FOLDER }])
    expect(mock.callsOf('config.patch')[0]).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/gates/afterPlan', value: false }],
    })
    const t = useStore.getState().toasts.items.find((x) => x.action?.label === 'Undo')
    expect(t?.message).toBe('Runs in this project will no longer stop after the plan.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await settle()
    })
    // The project file had no afterPlan key before, so undo removes it again.
    expect(mock.callsOf('config.patch')[1]).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'remove', path: '/gates/afterPlan' }],
    })
    expect(screen.getByTestId('plan-gate-skip').getAttribute('data-state')).toBe('unchecked')
  })

  it('cancels the run with the Cancel choice and shows core errors as a toast', async () => {
    mock.on('cards.resolve', () => {
      throw mockError('NOT_FOUND', 'This card is no longer open.')
    })
    show(planGate)
    await click(screen.getByTestId('card-choice-cancel'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'gate:afterPlan-1', choiceId: 'cancel' },
    ])
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain('This card is no longer open.')
  })
})

describe('CardView gate:beforeFix', () => {
  it('sends the ticked finding ids in order and counts what Fix receives', async () => {
    show(beforeFix)
    expect(screen.getByTestId('fix-receives').textContent).toBe('Fix will receive 2 must · 1 should')
    expect(screen.getByTestId('card-gate:beforeFix').textContent).toContain(
      'src/a.ts was reverted after Review',
    )
    const items = screen.getAllByTestId(/^finding-f/)
    expect(items.map((i) => i.getAttribute('data-severity'))).toEqual(['must', 'must', 'should'])
    // Untick F2 (a must): Fix then receives 1 must · 1 should.
    fireEvent.click(screen.getByTestId('finding-f2').querySelector('button') as HTMLElement)
    expect(screen.getByTestId('fix-receives').textContent).toBe('Fix will receive 1 must · 1 should')
    expect(screen.getByTestId('card-choice-continue').textContent).toContain('Continue with 2 findings')
    fireEvent.click(screen.getByTestId('findings-filter-should'))
    expect(screen.getAllByTestId(/^finding-f/).map((i) => i.getAttribute('data-testid'))).toEqual([
      'finding-f3',
    ])
    await click(screen.getByTestId('card-choice-continue'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'gate:beforeFix-2', choiceId: 'continue', input: ['f1', 'f3'] },
    ])
  })

  it('skips Fix without input', async () => {
    show(beforeFix)
    await click(screen.getByTestId('card-choice-skip-fix'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'gate:beforeFix-2', choiceId: 'skip-fix' },
    ])
  })
})

describe('CardView other kinds', () => {
  it('re-plans with the edited task', async () => {
    show({
      id: 'insufficientContext-1',
      kind: 'insufficientContext',
      title: 'The planner needs more context',
      body: 'Which CLI framework does this project use?',
      payload: { message: 'Which CLI framework?', task: 'add a flag' },
      blocking: true,
      choices: [
        { id: 'replan', label: 'Edit task & re-plan', primary: true, input: 'task' },
        { id: 'proceed', label: 'Proceed anyway' },
        { id: 'cancel', label: 'Cancel run', danger: true },
      ],
    })
    const box = screen.getByTestId<HTMLTextAreaElement>('card-task-input')
    expect(box.value).toBe('add a flag')
    fireEvent.change(box, { target: { value: 'add a --version flag using commander' } })
    await click(screen.getByTestId('card-choice-replan'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      {
        runId: RUN,
        cardId: 'insufficientContext-1',
        choiceId: 'replan',
        input: 'add a --version flag using commander',
      },
    ])
  })

  it('keeps waiting on a stall card through its own choice', async () => {
    show({
      id: 'stall-3',
      kind: 'stall',
      title: 'No output for 5m',
      body: 'Implement has produced no output for 5m. It may still be working.',
      payload: { step: 'implement', idleMs: 300_000 },
      blocking: false,
      choices: [
        { id: 'keep-waiting', label: 'Keep waiting', primary: true },
        { id: 'stop', label: 'Stop run', danger: true },
      ],
    })
    await click(screen.getByTestId('card-choice-keep-waiting'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'stall-3', choiceId: 'keep-waiting' },
    ])
  })

  it('lists preflight blockers with their fixes disabled and Recheck working', async () => {
    show({
      id: 'preflight-1',
      kind: 'preflight',
      title: 'Claude needs you to log in',
      body: '- Claude needs you to log in',
      payload: {
        blocking: [
          {
            id: 'vendor.claude.auth',
            scope: 'vendor',
            status: 'fail',
            blocking: true,
            title: 'Claude needs you to log in',
            detail: 'claude auth status exited 1',
            recovery: [
              {
                id: 'login',
                label: 'Copy login command',
                kind: 'shell_copy',
                command: 'claude auth login',
                shell: 'powershell',
                reason: 'Log in',
                recheck: 'vendor.claude.auth',
              },
              {
                id: 'path',
                label: 'Set the path',
                kind: 'settings_link',
                route: '#/settings/vendors/claude',
                pointer: '/vendors/claude/path',
              },
            ],
            at: 0,
            ttlMs: 0,
          },
        ],
        warnings: [],
      },
      blocking: true,
      choices: [
        { id: 'recheck', label: 'Recheck', primary: true },
        { id: 'cancel', label: 'Cancel run', danger: true },
      ],
    })
    expect(screen.getByTestId('check-vendor.claude.auth').textContent).toContain(
      'claude auth status exited 1',
    )
    expect(screen.getByTestId<HTMLButtonElement>('recovery-path').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('recovery-login').disabled).toBe(false)
    await click(screen.getByTestId('card-choice-recheck'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'preflight-1', choiceId: 'recheck' },
    ])
  })

  it('shows a choice this build cannot carry out as disabled with the reason', async () => {
    // P21 revert-then-fresh: the choice is live; a core that answers UNSUPPORTED for it is remembered, and from
    // then on the choice shows disabled with the reason.
    resetLaterChoicesForTests()
    mock.on('cards.resolve', () => {
      throw mockError('UNSUPPORTED', 'Revert partial then fresh is not available yet.')
    })
    show({
      id: 'retryPartial-1',
      kind: 'retryPartial',
      title: 'Implement left partial changes',
      body: 'Implement changed files before it failed.',
      payload: { step: 'implement' },
      blocking: true,
      defaultChoice: 'keep-changes',
      choices: [
        { id: 'revert-then-fresh', label: 'Revert partial then fresh' },
        { id: 'keep-changes', label: 'Keep changes, fresh', primary: true },
        { id: 'cancel', label: 'Cancel', danger: true },
      ],
    })
    expect(screen.getByTestId<HTMLButtonElement>('card-choice-revert-then-fresh').disabled).toBe(false)
    await click(screen.getByTestId('card-choice-revert-then-fresh'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'retryPartial-1', choiceId: 'revert-then-fresh' },
    ])
    const later = screen.getByTestId<HTMLButtonElement>('card-choice-revert-then-fresh')
    expect(later.disabled).toBe(true)
    // The focusable wrapper is named by the control and the reason (DisabledHint).
    expect(later.closest('[data-disabled-hint]')).toBe(
      screen.getByRole('group', { name: 'Revert partial then fresh Available in a later version' }),
    )
    expect(screen.getByTestId<HTMLButtonElement>('card-choice-keep-changes').disabled).toBe(false)
    act(() => resetLaterChoicesForTests())
  })
})
