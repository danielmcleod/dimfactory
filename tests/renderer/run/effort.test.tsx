// The effort a pass runs at, in the run view: a chip after the model chip on the PassCard (only when the pass names
// one; it is known from the queued card on, so it never appears on its own later), and beside the model in the
// Config tab.
import '../helpers/rtl.ts'
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { ConfigTab } from '@renderer/pages/run/ConfigTab.tsx'
import { resetStore } from '@renderer/state/store.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, snapWith } from './helpers.tsx'

let mock: MockDimFactory
const log: RunEnvelope[] = []

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  mock = installMockDimFactory({ handlers: { 'runs.events': eventsHandler(() => log) } })
})

afterEach(() => {
  mock.uninstall()
  resetTicker()
  resetBridgeForTests()
})

describe('effort in the run view', () => {
  it('a queued pass with an effort shows its chip right after the model; none without one', () => {
    const snap = snapWith({
      steps: {
        plan: {
          status: 'queued',
          attempt: 0,
          vendor: 'claude',
          model: 'opus',
          effort: 'max',
          mode: 'readonly',
        },
        implement: { status: 'queued', attempt: 0, vendor: 'codex', model: null, mode: 'autoedit' },
      },
    })
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.plan} />)
    const chip = screen.getByTestId('effort-chip-plan')
    expect(chip.textContent).toBe('max effort')
    expect(screen.getByTestId('model-chip-plan').nextElementSibling?.contains(chip) ?? false).toBe(true)
    renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps.implement} />)
    expect(screen.queryByTestId('effort-chip-implement')).toBeNull()
  })

  it('the Config tab names the effort beside the model', () => {
    const snap = snapWith({
      steps: {
        plan: {
          status: 'done',
          attempt: 1,
          vendor: 'claude',
          model: 'opus',
          effort: 'high',
          mode: 'readonly',
        },
        implement: { status: 'running', attempt: 1, vendor: 'codex', model: 'gpt-6-luna', mode: 'autoedit' },
      },
    })
    renderUi(<ConfigTab snap={snap} />)
    expect(screen.getByTestId('config-effort-plan').textContent).toBe(' · high effort')
    expect(screen.getByTestId('config-model-plan').getAttribute('title')).toBe('opus, at high effort')
    expect(screen.queryByTestId('config-effort-implement')).toBeNull()
    expect(screen.getByTestId('config-model-implement').textContent).toBe('gpt-6-luna')
  })
})
