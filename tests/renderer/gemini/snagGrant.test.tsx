// The vendorFolder grant in any RecoveryActions list (the executor "grant: writes trust.json", failure category
// trust_required "grant → retry"; a Gemini exit-55 snag, a run's preflight card): it runs, and says what it trusts.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryResult } from '@shared/ipc.ts'
import { laterReason } from '@renderer/components/recovery/execute.ts'
import { trustMeans } from '@renderer/components/recovery/folderTrust.ts'
import { RecoveryActions, resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetTrustStateForTests, trustEpochNow } from '@renderer/state/trust.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { FOLDER, TRUST_ACTION_ID, trustAction } from './fixtures.ts'

const RUN = 'run-1'
let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.get': () => Promise.reject(new Error('not needed')) } })
  resetRecoveryForTests()
  resetTrustStateForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  resetTrustStateForTests()
  tearDown(mock)
})

/** Core's snag action for a Gemini pass that exited 55 (snag-actions.ts materialize). */
const snagGrant = trustAction({
  id: 'implement:grant-vendorFolder',
  detail: `Gemini works in ${FOLDER} from now on.`,
})

describe('the vendorFolder grant', () => {
  it('is no longer a later version', () => {
    expect(laterReason(snagGrant, undefined)).toBeNull()
    expect(laterReason({ ...snagGrant, disabledReason: 'Choose a folder first' }, undefined)).toBe(
      'Choose a folder first',
    )
  })

  it('in a snag: runs through recovery.execute for the run, says what it trusts, and the trust views ask again', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'grant',
      message: 'This folder is trusted for Gemini. Retrying Implement.',
    }))
    render(
      <Providers>
        <RecoveryActions actions={[snagGrant]} runId={RUN} step="implement" />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('grant-note-implement:grant-vendorFolder').textContent).toBe(
      `Gemini works in ${FOLDER} from now on.`,
    )
    const epoch = trustEpochNow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-implement:grant-vendorFolder'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('recovery.execute')).toEqual([
      { actionId: 'implement:grant-vendorFolder', runId: RUN },
    ])
    expect(trustEpochNow()).toBe(epoch + 1)
  })

  it('a grant core gave no words for says what trusting means', async () => {
    render(
      <Providers>
        <RecoveryActions actions={[trustAction({ detail: '' })]} runId={RUN} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId(`grant-note-${TRUST_ACTION_ID}`).textContent).toBe(trustMeans('Gemini'))
  })
})
