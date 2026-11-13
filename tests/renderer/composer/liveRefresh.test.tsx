// The composer's live check follows the runs (folder.lock "queues behind #N", estimates from history, Run states):
// a run starting, changing status or ending changes core's folder.lock
// answer and the estimate's history, so preflight.run and estimates.get run again (debounced) on every run status
// change, and not on progress-only summary updates. The vendor picker greys a vendor that is not in this build with
// the install command its stub probe offers.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProbeView } from '@shared/vendors.ts'
import { installCommandOf, vendorChoices } from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { check, fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

let mock: MockDimFactory
let busy = false

beforeEach(() => {
  busy = false
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () =>
        report({
          info: [
            check('folder.lock', {
              title: busy ? 'Queues behind run #1 (running 1 min)' : 'Folder availability',
              detail: busy ? 'Run #1 is using this folder; this run starts when it finishes.' : '',
            }),
          ],
        }),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const runButton = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('composer-run')
/** What Run reads: its constant label, then the state shown beside it (UI standard: the button never changes size). */
const runReads = (): string => {
  const status = screen.getByTestId('composer-run-status').textContent ?? ''
  const label = runButton().textContent ?? ''
  return status === '' ? label : `${label} · ${status}`
}

describe('live checks follow the runs', () => {
  it('checks again when a run starts, changes status or ends, not on progress updates', async () => {
    await mountComposer()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --help flag' } })
    await settle(300)
    expect(mock.callsOf('preflight.run')).toHaveLength(1)
    expect(runReads()).toBe('Run')

    // Run #1 starts in this folder: core now answers "queues behind #1".
    busy = true
    act(() => upsertSummaries([makeSummary({ runId: 'r1', status: 'running', folder: FOLDER })]))
    await settle(300)
    expect(mock.callsOf('preflight.run')).toHaveLength(2)
    expect(mock.callsOf('estimates.get')).toHaveLength(2)
    expect(runReads()).toBe('Queue · Folder busy')

    // Progress only (same status): no new check.
    act(() =>
      upsertSummaries([
        makeSummary({
          runId: 'r1',
          status: 'running',
          folder: FOLDER,
          progress: { tokens: 1200, costUsd: null, filesChanged: 1 },
        }),
      ]),
    )
    await settle(300)
    expect(mock.callsOf('preflight.run')).toHaveLength(2)

    // Run #1 ends: the folder is free again, and the estimate is asked again (one more run of history).
    busy = false
    act(() => upsertSummaries([makeSummary({ runId: 'r1', status: 'completed', folder: FOLDER })]))
    await settle(300)
    expect(mock.callsOf('preflight.run')).toHaveLength(3)
    expect(mock.callsOf('estimates.get')).toHaveLength(3)
    expect(runReads()).toBe('Run')
  })
})

describe('a vendor not in this build', () => {
  const stub: ProbeView = {
    ...probe('codex', 'ready', { built: false }),
    probe: {
      vendor: 'codex',
      at: 0,
      ok: false,
      checks: [
        check('vendor.codex.protocol', {
          status: 'fail',
          blocking: true,
          category: 'capability_missing',
          title: 'Codex: not available in this build',
          recovery: [
            {
              id: 'codex.switch-vendor',
              label: 'Use Claude instead',
              kind: 'switch_vendor',
              pass: 'all',
              to: 'claude',
              model: null,
            },
            {
              id: 'codex.install',
              label: 'Copy the install command',
              kind: 'shell_copy',
              command: 'npm install -g @openai/codex@latest',
              shell: 'sh',
              reason: 'Install it now to use it once Dim Factory supports Codex',
              recheck: 'vendor.codex.bin',
            },
          ],
        }),
      ],
      capabilities: probe('claude', 'ready').probe!.capabilities,
      models: [],
    },
  }

  it("offers the stub's install command as the greyed choice's tooltip", () => {
    expect(installCommandOf(stub)).toBe('npm install -g @openai/codex@latest')
    expect(vendorChoices([probe('claude', 'ready'), stub], [], 'claude')).toEqual([
      { id: 'claude', label: 'Claude', group: 'primary', disabled: false },
      {
        id: 'codex',
        label: 'Codex',
        group: 'primary',
        disabled: true,
        note: 'Not available in this build',
        title: 'npm install -g @openai/codex@latest',
      },
    ])
  })

  it('has no tooltip without an install command', () => {
    const bare: ProbeView = { ...stub, probe: null }
    expect(installCommandOf(bare)).toBeNull()
    expect(vendorChoices([bare], [], 'claude').find((c) => c.id === 'codex')).toEqual({
      id: 'codex',
      label: 'Codex',
      group: 'primary',
      disabled: true,
      note: 'Not available in this build',
    })
  })
})
