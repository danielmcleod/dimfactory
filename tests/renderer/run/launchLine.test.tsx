// PassCard's launch line before the step reports its vendor (the first moments of a launch, seen in E2E): plain words
// ("Starting the vendor CLI"), not the sentence-start "The vendor" used in failure titles. While Plan's launch
// waits for the run-start snapshot (R2; minutes for a cold shadow on a large folder), the line says so
// (StepView.launchWait), and the spawn's own line replaces it once the step has spawned.
import '../helpers/rtl.ts'
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { resetStore } from '@renderer/state/store.ts'
import { env } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, snapWith } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  log = []
  mock = installMockDimFactory({ handlers: { 'runs.events': eventsHandler(() => log) } })
})

afterEach(() => {
  mock.uninstall()
  resetTicker()
  resetBridgeForTests()
})

describe('PassCard launch line', () => {
  it('names the CLI in plain words while the vendor is not known yet', () => {
    const snap = snapWith({ steps: { implement: { status: 'running', attempt: 1, activeMs: 0 } } })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.implement} />)
    expect(screen.getByTestId('launch-line-implement').textContent).toBe(
      'Starting the vendor CLI · waiting for first output',
    )
  })

  it('says Plan is waiting for the run-start snapshot while core says its launch waits for it', () => {
    const snap = snapWith({
      steps: { plan: { status: 'running', attempt: 1, activeMs: 0, launchWait: 'run-start' } },
    })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.plan} />)
    const line = screen.getByTestId('launch-line-plan').textContent
    expect(line).toBe('Taking the run-start snapshot · the vendor CLI starts after it')
    expect(line).not.toContain('—')
  })

  it('names the vendor once it is known', () => {
    const snap = snapWith({
      steps: { plan: { status: 'running', attempt: 1, vendor: 'claude', launchWait: 'run-start' } },
    })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.plan} />)
    expect(screen.getByTestId('launch-line-plan').textContent).toBe(
      'Taking the run-start snapshot · Claude starts after it',
    )
  })

  it('the spawn’s line wins once the step has spawned, even before the next snapshot arrives', async () => {
    log = [
      env(
        RUN,
        1,
        {
          t: 'step-status',
          step: 'plan',
          attempt: 1,
          status: 'running',
          argv: ['C:\\Tools\\claude.exe', '-p'],
        },
        Date.now() - 1000,
      ),
    ]
    const snap = snapWith({
      steps: { plan: { status: 'running', attempt: 1, vendor: 'claude', launchWait: 'run-start' } },
    })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.plan} />)
    await waitFor(() =>
      expect(screen.getByTestId('launch-line-plan').textContent).toMatch(
        /^claude\.exe spawned \d+ s ago · waiting for first output$/,
      ),
    )
  })
})
