// The palette's New run and Folders reach the quick composer (the Ctrl/Cmd+K palette: its
// New run action focuses the composer, and a recent folder is chosen in the composer): an ask made while the composer is
// mounted chooses the folder as its chip would and puts the focus in the task box; one made from another page waits
// for the composer's next mount, for INTENT_TTL_MS at most.
import '../helpers/rtl.ts'
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  INTENT_TTL_MS,
  requestComposer,
  resetComposerIntentForTests,
} from '@renderer/components/palette/composerIntent.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  resetComposerIntentForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => {
  resetComposerIntentForTests()
  tearDown(mock)
})

const folderInput = (): HTMLInputElement => screen.getByTestId<HTMLInputElement>('composer-folder-input')

describe('composer intent', () => {
  it('chooses the folder and focuses the task box while the composer is mounted', async () => {
    await mountComposer()
    expect(folderInput().value).toBe(FOLDER)
    act(() => requestComposer({ folder: 'C:\\work\\api' }))
    await settle(300)
    expect(folderInput().value).toBe('C:\\work\\api')
    expect(document.activeElement).toBe(screen.getByTestId('composer-task'))
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({ folder: 'C:\\work\\api' })
  })

  it('New run only focuses the task box, keeping the folder', async () => {
    await mountComposer()
    act(() => requestComposer())
    await settle()
    expect(folderInput().value).toBe(FOLDER)
    expect(document.activeElement).toBe(screen.getByTestId('composer-task'))
  })

  it('an ask made before the composer mounts is taken up when it mounts', async () => {
    requestComposer({ folder: 'C:\\work\\api' })
    await mountComposer()
    await settle(300)
    expect(folderInput().value).toBe('C:\\work\\api')
    expect(document.activeElement).toBe(screen.getByTestId('composer-task'))
  })

  it('an ask older than INTENT_TTL_MS is dropped instead of surprising a later visit', async () => {
    requestComposer({ folder: 'C:\\work\\api' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTENT_TTL_MS + 1)
    })
    await mountComposer()
    await settle(300)
    expect(folderInput().value).toBe(FOLDER)
    expect(document.activeElement).not.toBe(screen.getByTestId('composer-task'))
  })
})
