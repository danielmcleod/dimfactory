// Review fix (state-machine row R13 "any non-terminal, Stop / Close run → changes kept; toast [Revert all]"):
// Stop run on a reconcile card (the branch-prep block card included) is a user Stop like the header's, so once core
// says the run is cancelled the "Run stopped · changes kept" toast offers Revert all, as the stall card's Stop does.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { upsertSummaries } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { blockCard, overlapCard } from './fixtures.ts'

let mock: MockDimFactory
const STOPPED = 'Run stopped · changes kept'

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: {
      'cards.resolve': () => undefined,
      'runs.get': () => snapWith(),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  resetStopWatches()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
})

const stoppedToast = () => useStore.getState().toasts.items.find((t) => t.message === STOPPED)

async function stopThrough(card: ReturnType<typeof blockCard>): Promise<void> {
  renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('card-choice-stop'))
    await settle()
  })
  expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: card.id, choiceId: 'stop' }])
  // Not before core says the run is cancelled.
  expect(stoppedToast()).toBeUndefined()
  await act(async () => {
    // Core's run-summary event, as the bridge applies it.
    upsertSummaries([{ ...snapWith().summary, status: 'cancelled', phase: 'done' }])
    await settle()
  })
}

describe('Stop run on a reconcile card', () => {
  it('a block card’s Stop run: the stopped toast with Revert all', async () => {
    await stopThrough(blockCard())
    expect(stoppedToast()?.action?.label).toBe('Revert all')
  })

  it('a choice card’s Stop run: the same toast', async () => {
    await stopThrough(overlapCard())
    expect(stoppedToast()?.action?.label).toBe('Revert all')
  })
})
