// Settings → Self-heal (enabled, vendor, model, autoApplyConfigPatches,
// the last 10 heals; self-heal; the user-only `selfHeal` key): values from config.resolve once the section is open, each
// control writes the user file with config.patch and offers Undo (core's backup, or removing the key from a file core
// created), the vendor and model pickers, a note when the chosen vendor is not ready, and the last 10 diagnoses read
// from run state (newest first, read-only), loading the most recent runs' snapshots after the section opens.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USER_ONLY_KEYS } from '@shared/config-schema.ts'
import type { HealView } from '@shared/failure.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import type { RunSnapshot } from '@shared/run.ts'
import type { ModelOption } from '@shared/vendors.ts'
import { collectHeals, healResultText } from '@renderer/components/recovery/heal.ts'
import {
  AUTO_APPLY_LABEL,
  ENABLED_LABEL,
  HISTORY_EMPTY,
  HISTORY_RUNS,
  LOAD_DELAY_MS,
} from '@renderer/pages/settings/SelfHealSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { applySnapshot, bumpConfigEpoch, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { T0, failure, heal } from './fixtures.ts'

const EM_DASH = '\u2014'
let mock: MockDimFactory
let selfHeal: { enabled: boolean; vendor: string; model: string | null; autoApplyConfigPatches: boolean }

const write = (backupId: string | null): ConfigWriteResult => ({
  path: 'C:\\home\\dimfactory.json',
  changed: true,
  diff: '',
  backupId,
})

const models: ModelOption[] = [
  { id: 'opus', hasPricing: true, isDefault: true, source: 'cli' },
  { id: 'sonnet', hasPricing: true, source: 'cli' },
  { id: 'haiku', label: 'Haiku', hasPricing: true, source: 'catalog' },
]

beforeEach(() => {
  selfHeal = { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false }
  mock = setUp({
    handlers: {
      'config.resolve': () => {
        const base = resolvedView()
        return { ...base, config: { ...base.config, selfHeal } }
      },
      'config.patch': () => write('b-1'),
      'config.restoreBackup': () => write(null),
      'vendors.models': () => models,
      'runs.get': (req) => {
        throw mockError('NOT_FOUND', `no run ${req.runId}`)
      },
    },
  })
  act(() => upsertProbes([probeView('claude', 'ready')]))
})

afterEach(() => tearDown(mock))

async function mount(): Promise<HTMLElement> {
  render(
    <Providers>
      <SettingsPage section="self-heal" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  return screen.getByTestId('settings-self-heal')
}

async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el)
  await settle()
}

async function pick(testId: string, name: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const checked = (id: string): string | null => screen.getByTestId(id).getAttribute('aria-checked')
const lastToast = (): string | undefined => useStore.getState().toasts.items.at(-1)?.message

function runWithHeals(
  n: number,
  displayNo: number,
  heals: Partial<Record<'plan' | 'implement', HealView>>,
): RunSnapshot {
  const snap = makeSnapshot({ runId: `run-${n}`, displayNo, title: `Run ${n}` })
  for (const [step, h] of Object.entries(heals)) {
    const key = step as 'plan' | 'implement'
    snap.steps[key] = { ...snap.steps[key], status: 'failed', failure: failure({ step: key }), heal: h }
  }
  return snap
}

describe('Settings → Self-heal', () => {
  it('is live: nothing is read while passing through, then core’s values once open', async () => {
    expect(findSection('self-heal')?.live).toBe(true)
    render(
      <Providers>
        <SettingsPage section="self-heal" />
      </Providers>,
    )
    expect(screen.queryByText('Arrives in a later version')).toBeNull()
    expect(mock.callsOf('config.resolve')).toEqual([])
    expect(mock.callsOf('vendors.models')).toEqual([])
    expect(screen.getByTestId('selfheal-enabled')).toHaveProperty('disabled', true)
    // The history table is there from the first render (no layout shift when values arrive).
    expect(screen.getByTestId('selfheal-history').textContent).toContain(HISTORY_EMPTY)
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toEqual([{}])
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    expect(checked('selfheal-enabled')).toBe('true')
    expect(checked('selfheal-autoapply')).toBe('false')
    expect(screen.getByTestId('selfheal-vendor').textContent).toContain('Claude')
    expect(screen.getByTestId('selfheal-model').textContent).toContain('sonnet')
    expect(screen.getByTestId('settings-self-heal').textContent).not.toContain(EM_DASH)
  })

  it('writes enabled to the user file and undoes it from core’s backup', async () => {
    await mount()
    await click(screen.getByTestId('selfheal-enabled'))
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/selfHeal/enabled', value: false }] },
    ])
    expect(checked('selfheal-enabled')).toBe('false')
    expect(lastToast()).toBe(`${ENABLED_LABEL}: off`)
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b-1' }])
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toHaveLength(2)
  })

  it('writes autoApplyConfigPatches, and undoes a write to a new file by removing the key', async () => {
    mock.on('config.patch', (req) => write(req.ops[0]?.op === 'remove' ? 'b-2' : null))
    await mount()
    await click(screen.getByTestId('selfheal-autoapply'))
    expect(mock.callsOf('config.patch')[0]).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/selfHeal/autoApplyConfigPatches', value: true }],
    })
    expect(lastToast()).toBe(`${AUTO_APPLY_LABEL}: on`)
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.patch')[1]).toEqual({
      scope: 'user',
      ops: [{ op: 'remove', path: '/selfHeal/autoApplyConfigPatches' }],
    })
  })

  it('picks the model from vendors.models (and the CLI default as null)', async () => {
    await mount()
    await pick('selfheal-model', 'Haiku (haiku)')
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/selfHeal/model', value: 'haiku' }] },
    ])
    expect(lastToast()).toBe('Self-heal model: haiku')
    await pick('selfheal-model', "The CLI's default (opus)")
    expect(mock.callsOf('config.patch')[1]).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/selfHeal/model', value: null }],
    })
  })

  it('lists this build’s vendors only, and says when the chosen one is not ready', async () => {
    act(() =>
      upsertProbes([
        probeView('claude', 'login-needed', { healthDetail: 'Login needed' }),
        probeView('codex', 'not-built', { built: false }),
      ]),
    )
    await mount()
    expect(screen.getByTestId('selfheal-vendor-note').textContent).toBe(
      'Claude is not ready (Login needed). Dim Factory uses the first ready vendor instead.',
    )
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('selfheal-vendor'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude'])
  })

  it('puts a switch back and shows core’s message when the write fails', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'dimfactory.json has an error at 3:5.')
    })
    await mount()
    await click(screen.getByTestId('selfheal-enabled'))
    expect(checked('selfheal-enabled')).toBe('true')
    expect(lastToast()).toBe('dimfactory.json has an error at 3:5.')
  })

  it('reads the values again after a config change', async () => {
    await mount()
    selfHeal = { ...selfHeal, autoApplyConfigPatches: true }
    act(() => bumpConfigEpoch())
    await settle(LOAD_DELAY_MS)
    expect(checked('selfheal-autoapply')).toBe('true')
  })
})

describe('last 10 diagnoses', () => {
  it('loads the most recent runs once open, then lists their heals newest first (read-only)', async () => {
    const summaries = Array.from({ length: HISTORY_RUNS + 5 }, (_, i) =>
      makeSummary({ runId: `r${i}`, displayNo: 100 - i, createdAt: T0 - i * 1000 }),
    )
    act(() => upsertSummaries(summaries, { loaded: true }))
    act(() => {
      applySnapshot(
        runWithHeals(1, 7, {
          plan: heal({ at: T0 - 120_000, diagnosis: 'Old answer.' }),
          implement: heal({ at: T0 - 60_000, hidden: 2, trigger: 'auto', autoApplied: 'heal.flagmap' }),
        }),
      )
      applySnapshot(
        runWithHeals(2, 8, {
          implement: heal({ at: T0 - 30_000, status: 'failed', error: 'Timed out after 90 s', actions: [] }),
        }),
      )
    })
    await mount()
    // The recent runs' snapshots were asked for (each once).
    expect(mock.callsOf('runs.get').map((r) => r.runId)).toEqual(
      summaries.slice(0, HISTORY_RUNS).map((s) => s.runId),
    )
    const table = screen.getByTestId('selfheal-history')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'selfheal-row-run-2-implement',
      'selfheal-row-run-1-implement',
      'selfheal-row-run-1-plan',
    ])
    expect(rows[0]?.textContent).toContain('#8 · Implement')
    expect(rows[0]?.textContent).toContain('Timed out after 90 s')
    expect(rows[0]?.textContent).toContain('Failed')
    expect(rows[1]?.textContent).toContain('Something went wrong')
    expect(rows[1]?.textContent).toContain('Automatic')
    // One fix, offered to the run and saved (twins): one fix.
    expect(rows[1]?.textContent).toContain('1 fix suggested · 2 hidden')
    expect(rows[1]?.textContent).toContain('Applied on its own')
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('#/runs/run-1')
    expect(table.querySelector('button, input')).toBeNull()
    expect(table.textContent).not.toContain(EM_DASH)
  })

  it('keeps the ten newest', () => {
    const heals = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => {
        const snap = runWithHeals(i, i, { implement: heal({ at: T0 + i }) })
        return [snap.summary.runId, { snapshot: snap, lastSeq: 0, status: 'ready' as const }]
      }),
    )
    const list = collectHeals(heals)
    expect(list).toHaveLength(10)
    expect(list[0]?.runId).toBe('run-11')
    expect(list.at(-1)?.runId).toBe('run-2')
    expect(healResultText(heal({ status: 'cached', actions: [] }))).toBe('No fixes · reused')
    expect(healResultText(heal({ status: 'disabled' }))).toBe('Self-heal off')
  })

  it('selfHeal is a user-only key: every write goes to the user file', () => {
    expect(USER_ONLY_KEYS).toContain('selfHeal')
  })
})
