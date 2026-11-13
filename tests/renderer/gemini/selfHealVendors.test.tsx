// Settings → Self-heal keeps its vendor choice honest with a third vendor (self-heal execution:
// the selfHeal vendor, falling back to the first ready of claude/codex, with a Claude row and a Codex row only;
// shared HEAL_VENDORS): a built, ready Gemini is not offered as the self-heal vendor, and a user file that already
// names Gemini says what runs instead (Claude or Codex), in plain words with no em dash.
import '../helpers/rtl.ts'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAL_VENDORS } from '@shared/vendors.ts'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/SelfHealSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

let mock: MockDimFactory
let selfHeal: { enabled: boolean; vendor: string; model: string | null; autoApplyConfigPatches: boolean }

beforeEach(() => {
  selfHeal = { enabled: true, vendor: 'claude', model: null, autoApplyConfigPatches: false }
  mock = setUp({
    handlers: {
      'config.resolve': () => {
        const base = resolvedView()
        return { ...base, config: { ...base.config, selfHeal } }
      },
      'vendors.models': () => [],
      'runs.get': (req) => {
        throw mockError('NOT_FOUND', `no run ${req.runId}`)
      },
    },
  })
  act(() =>
    upsertProbes([
      probeView('claude', 'ready'),
      probeView('codex', 'ready'),
      probeView('gemini', 'ready', { displayName: 'Gemini' }),
    ]),
  )
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <SettingsPage section="self-heal" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
}

async function options(): Promise<string[]> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId('selfheal-vendor'), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  return screen.getAllByRole('option').map((o) => o.textContent ?? '')
}

describe('Settings → Self-heal with Gemini built', () => {
  it('offers Claude and Codex only: a ready Gemini cannot run the healer', async () => {
    expect(HEAL_VENDORS).toEqual(['claude', 'codex'])
    await mount()
    // The note's line is reserved (nothing moves); it is empty for a vendor that heals.
    expect(screen.getByTestId('selfheal-vendor-note').textContent).toBe('')
    expect(await options()).toEqual(['Claude', 'Codex'])
  })

  it('a user file naming Gemini: shown by its name, with the vendor that diagnoses instead', async () => {
    selfHeal = { ...selfHeal, vendor: 'gemini' }
    await mount()
    const note = screen.getByTestId('selfheal-vendor-note').textContent ?? ''
    expect(note).toBe(
      'Gemini cannot diagnose failures. Dim Factory uses the first ready of Claude and Codex instead.',
    )
    expect(note).not.toContain('—')
    expect(screen.getByTestId('selfheal-vendor').textContent).toContain('Gemini')
    expect(await options()).toEqual(['Gemini', 'Claude', 'Codex'])
  })
})
