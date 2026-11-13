// PassCard header: the mode chip names the mode in a word or two and core's support().copy sentence
// wraps on its own line under the header, so a long sentence never stretches the card (a one-line chip with the
// whole sentence used to push the Flow tab into horizontal scrolling).
import '../helpers/rtl.ts'
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot, StepKey } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, snapWith } from '../run/helpers.tsx'

const COPY =
  'Edits and basic file operations (mkdir, mv, rm, cp) in the folder run automatically; other commands, network and outside-folder access ask you. On Windows, PowerShell file commands (New-Item, Move-Item) may still ask.'

let mock: MockDimFactory
const log: RunEnvelope[] = []

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
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

function card(snap: RunSnapshot, step: StepKey): void {
  renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps[step]} />)
}

describe('PassCard mode copy', () => {
  it('keeps the chip short and wraps the support copy under the header', () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'queued',
          vendor: 'claude',
          mode: 'autoedit',
          modeCopy: { status: 'supported', copy: COPY },
        },
      },
    })
    card(snap, 'implement')
    const chip = screen.getByTestId('mode-chip-implement')
    expect(chip.textContent).toBe('edits files')
    expect(chip.querySelector('.truncate')).not.toBeNull()
    const line = screen.getByTestId('mode-copy-implement')
    expect(line.textContent).toBe(COPY)
    expect(line.className).toContain('break-words')
  })

  it('shows a degraded mode with its reason, in the warning colour', () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'queued',
          vendor: 'codex',
          mode: 'autoedit',
          modeCopy: {
            status: 'degraded',
            copy: 'Escalations are auto-denied.',
            reason: 'No relay on this route.',
          },
        },
      },
    })
    card(snap, 'implement')
    const line = screen.getByTestId('mode-copy-implement')
    expect(line.textContent).toBe('Escalations are auto-denied. No relay on this route.')
    expect(line.className).toContain('text-warning')
  })

  it('drops the sentence once the pass has finished', () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'done',
          attempt: 1,
          vendor: 'claude',
          mode: 'autoedit',
          modeCopy: { status: 'supported', copy: COPY },
        },
      },
    })
    card(snap, 'implement')
    expect(screen.getByTestId('mode-chip-implement').textContent).toBe('edits files')
    expect(screen.queryByTestId('mode-copy-implement')).toBeNull()
  })
})
