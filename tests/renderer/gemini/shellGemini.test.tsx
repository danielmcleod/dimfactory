// Gemini in the app shell (the Settings nav item's dot when a vendor isn't ready, the footer health dots):
// Gemini is built now, and a "More" vendor that is not installed is an option, not a vendor to set up.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { vendorNotReady } from '@renderer/components/shell/VendorHealth.tsx'
import { setAppInfo, upsertProbes } from '@renderer/state/actions.ts'
import { defaultAppInfo } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, setUp, tearDown } from '../dashboard/setup.tsx'
import { gemini } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp()
  act(() => setAppInfo(defaultAppInfo()))
})

afterEach(() => tearDown(mock))

function mount(): void {
  render(
    <Providers>
      <Shell>
        <p>page</p>
      </Shell>
    </Providers>,
  )
}

describe('Gemini in the shell', () => {
  it('a Gemini that is not installed lights no Settings dot; its footer dot says so', () => {
    upsertProbes([
      probeView('claude', 'ready'),
      probeView('codex', 'ready'),
      gemini({ state: 'not-installed' }),
    ])
    mount()
    expect(screen.queryByTestId('settings-attention-dot')).toBeNull()
    expect(screen.getByTestId('vendor-dot-gemini').getAttribute('aria-label')).toBe('Gemini · Not installed')
  })

  it('an installed Gemini that needs signing in or an update lights the dot like any vendor', () => {
    upsertProbes([
      probeView('claude', 'ready'),
      probeView('codex', 'ready'),
      gemini({ state: 'login-needed' }),
    ])
    mount()
    expect(screen.getByTestId('settings-attention-dot').getAttribute('aria-label')).toBe(
      'A vendor needs setup',
    )
    act(() => upsertProbes([gemini({ state: 'no-acp', version: '0.55.0' })]))
    expect(screen.getByTestId('settings-attention-dot').getAttribute('aria-label')).toBe(
      'A vendor needs setup',
    )
    act(() => upsertProbes([gemini()]))
    expect(screen.queryByTestId('settings-attention-dot')).toBeNull()
    expect(screen.getByTestId('vendor-dot-gemini').getAttribute('aria-label')).toMatch(
      /^Gemini 0\.62\.1 · Ready/,
    )
  })

  it('Claude or Codex not installed still lights it', () => {
    expect(vendorNotReady(probeView('codex', 'not-installed'))).toBe(true)
    expect(vendorNotReady(probeView('claude', 'not-installed'))).toBe(true)
    expect(vendorNotReady(gemini({ state: 'not-installed' }))).toBe(false)
    expect(vendorNotReady(gemini({ state: 'login-needed' }))).toBe(true)
    expect(vendorNotReady(gemini())).toBe(false)
  })
})
