// The Run view's preflight card on the shared recovery buttons (state-machine row R2b):
// a fix runs recovery.execute with the run; after a copied command, "I ran it → Re-check" re-probes the
// vendor and then takes the card's own Recheck; a settings link opens core's route.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryResult } from '@shared/ipc.ts'
import type { CardView as CardData } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory
const RUN = 'run-7'

beforeEach(() => {
  mock = setUp({
    handlers: {
      'cards.resolve': () => undefined,
      'runs.get': () => makeSnapshot({ runId: RUN }),
      'vendors.probe': () => [probeView('claude', 'ready')],
    },
  })
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

const card: CardData = {
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
            id: 'claude.login',
            label: 'Copy the login command',
            kind: 'shell_copy',
            command: 'claude auth login',
            shell: 'powershell',
            reason: 'Log in',
            recheck: 'vendor.claude.auth',
          },
          {
            id: 'claude.set-path',
            label: 'Set the path',
            kind: 'settings_link',
            route: 'settings/vendors',
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
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('preflight card fixes', () => {
  it('copies, then "I ran it → Re-check" re-probes Claude and takes the card\'s Recheck', async () => {
    mock.on('recovery.execute', (req): RecoveryResult => {
      if (req.actionId === 'claude.set-path')
        return { kind: 'settings_link', route: '#/settings/vendors?field=%2Fvendors%2Fclaude%2Fpath' }
      return { kind: 'shell_copy', copied: 'claude auth login' }
    })
    render(
      <Providers>
        <CardView runId={RUN} card={card} folder="C:\\work\\repo" />
      </Providers>,
    )
    await settle()
    await click(screen.getByTestId('recovery-claude.login'))
    expect(mock.callsOf('recovery.execute')).toContainEqual({ actionId: 'claude.login', runId: RUN })
    await click(screen.getByTestId('recheck-claude.login'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'preflight-1', choiceId: 'recheck' },
    ])

    await click(screen.getByTestId('recovery-claude.set-path'))
    expect(window.location.hash).toBe('#/settings/vendors?field=%2Fvendors%2Fclaude%2Fpath')
  })
})
