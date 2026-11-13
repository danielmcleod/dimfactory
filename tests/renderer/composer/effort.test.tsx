// The effort picker beside the model: a pass row on Claude or Codex offers "Default effort" plus the levels the
// pass's model lists (else every level the vendor's models list); a choice is a run override with its provenance; a
// model that does not list the chosen level puts it back to the default; a vendor change clears it; a vendor without
// an effort setting (Gemini) shows no effort picker. The shared helpers the picker formats with are tested too.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { effortChoices } from '@renderer/pages/dashboard/composer/EffortSelect.tsx'
import { effortAfterModel, effortText } from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

const MODELS: ModelInfo[] = [
  { id: 'default', isDefault: true, efforts: ['low', 'medium', 'high'], source: 'cli' },
  { id: 'opus', efforts: ['low', 'medium', 'high', 'max'], source: 'cli' },
  { id: 'sonnet', efforts: ['low', 'medium', 'high'], source: 'cli' },
]
const OPTIONS = MODELS.map((m) => ({ ...m, hasPricing: true }))

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'vendors.models': () => OPTIONS,
    },
  })
  upsertProbes([probe('claude', 'ready', { models: MODELS }), probe('gemini', 'ready')])
})

afterEach(() => tearDown(mock))

async function openRow(pass: string): Promise<void> {
  await mountComposer()
  await settle(300)
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
  fireEvent.click(screen.getByTestId(`pass-row-toggle-${pass}`))
  await settle()
}

async function optionNames(testId: string): Promise<string[]> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle(300)
  const names = screen.getAllByRole('option').map((o) => o.textContent ?? '')
  act(() => {
    fireEvent.keyDown(screen.getAllByRole('option')[0] as HTMLElement, { key: 'Escape' })
  })
  await settle()
  return names
}

async function pick(testId: string, option: string): Promise<void> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle(300)
  act(() => {
    fireEvent.keyDown(screen.getByRole('option', { name: option }), { key: 'Enter' })
  })
  await settle(300)
}

const lastResolve = () => mock.callsOf('config.resolve').at(-1)

describe('effort picker in a pass row', () => {
  it("offers Default effort and the model's levels; a choice is a run override", async () => {
    await openRow('plan')
    const trigger = screen.getByTestId('pass-effort-plan')
    expect(trigger.textContent).toBe('Default effort')
    expect(trigger.getAttribute('aria-label')).toBe('Plan effort')
    // Plan runs opus in the claude-only profile: opus lists max.
    expect(await optionNames('pass-effort-plan')).toEqual(['Default effort', 'low', 'medium', 'high', 'max'])
    await pick('pass-effort-plan', 'max')
    expect(lastResolve()).toMatchObject({ overrides: { passes: { plan: { effort: 'max' } } } })
    expect(screen.getByTestId('pass-effort-plan').textContent).toBe('max')
    expect(screen.getByTestId('pass-provenance-plan-effort').getAttribute('data-source')).toBe('run')
    expect(screen.getByTestId('pass-summary-plan').textContent).toBe(
      'Plan · Claude · opus · max effort · Native plan',
    )
  })

  it('the trigger keeps one width whatever it shows', async () => {
    await openRow('plan')
    const before = screen.getByTestId('pass-effort-plan').className
    expect(before).toContain('w-36')
    await pick('pass-effort-plan', 'medium')
    expect(screen.getByTestId('pass-effort-plan').className).toBe(before)
  })

  it('a model that does not list the level puts it back to the default; one that does keeps it', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.plan.effort = 'max') }))
    await openRow('plan')
    await optionNames('pass-effort-plan') // loads the vendor's list
    const box = screen.getByTestId<HTMLInputElement>('pass-model-plan')
    fireEvent.change(box, { target: { value: 'sonnet' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle(300)
    expect(lastResolve()).toMatchObject({
      overrides: { passes: { plan: { model: 'sonnet', effort: null } } },
    })
  })

  it('a vendor change clears the effort with the model', async () => {
    await openRow('review')
    await pick('pass-vendor-review', 'Gemini')
    expect(lastResolve()).toMatchObject({
      overrides: { passes: { review: { vendor: 'gemini', model: null, effort: null } } },
    })
  })

  it('a vendor without an effort setting shows no effort picker', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.review.vendor = 'gemini') }))
    await openRow('review')
    expect(screen.queryByTestId('pass-effort-review')).toBeNull()
    expect(screen.getByTestId('pass-model-review')).toBeTruthy()
  })
})

describe('effort helpers', () => {
  it("effortChoices: the model's levels, every listed level as a fallback, and a level in use", () => {
    expect(effortChoices(MODELS, 'sonnet', null)).toEqual(['low', 'medium', 'high'])
    expect(effortChoices(MODELS, 'gpt-x', null)).toEqual(['low', 'medium', 'high', 'max'])
    expect(effortChoices(MODELS, 'sonnet', 'ultra')).toEqual(['low', 'medium', 'high', 'ultra'])
    expect(effortChoices(null, null, null)).toEqual([])
  })

  it('effortAfterModel keeps a listed level, drops one the model does not list, keeps it while unknown', () => {
    expect(effortAfterModel(OPTIONS, 'opus', 'max')).toBe('max')
    expect(effortAfterModel(OPTIONS, 'sonnet', 'max')).toBeNull()
    expect(effortAfterModel(null, 'sonnet', 'max')).toBe('max')
    expect(effortAfterModel(OPTIONS, 'sonnet', null)).toBeNull()
  })

  it('effortText', () => {
    expect(effortText('high')).toBe('high effort')
    expect(effortText(null)).toBe('Default effort')
  })
})
