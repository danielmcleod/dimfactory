// Integration ("text cut with an ellipsis says itself in full"; Muse is Experimental): the pass
// vendor picker's trigger is narrower than a long choice such as "Muse · Experimental · Muse's event shapes are not
// pinned yet", so the trigger carries the whole choice as its title (ui-layout.spec.ts's ellipsis guard found it cut).
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProbeView } from '@shared/vendors.ts'
import { vendorChoiceText } from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'

const PINNED = "Muse's event shapes are not pinned yet"

const muse = (): ProbeView => ({
  ...probe('muse', 'warning'),
  displayName: 'Muse',
  experimental: true,
  healthDetail: PINNED,
})

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready'), probe('codex', 'ready'), muse()])
})

afterEach(() => tearDown(mock))

describe('the pass vendor picker says its whole choice', () => {
  it('a choice is its label, then its note', () => {
    expect(vendorChoiceText({ label: 'Claude' })).toBe('Claude')
    expect(vendorChoiceText({ label: 'Muse', note: `Experimental · ${PINNED}` })).toBe(
      `Muse · Experimental · ${PINNED}`,
    )
  })

  it("the trigger's title is the chosen vendor with its note (Muse, Experimental, cut on screen)", async () => {
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('composer-passes-toggle'))
    await settle()
    fireEvent.click(screen.getByTestId('pass-row-toggle-implement'))
    await settle()
    const trigger = screen.getByTestId('pass-vendor-implement')
    expect(trigger.getAttribute('title')).toBe('Claude')
    act(() => {
      fireEvent.keyDown(trigger, { key: 'Enter' })
    })
    await settle()
    const option = screen.getByRole('option', { name: `Muse · Experimental · ${PINNED}` })
    act(() => {
      fireEvent.keyDown(option, { key: 'Enter' })
    })
    await settle(300)
    expect(screen.getByTestId('pass-vendor-implement').getAttribute('title')).toBe(
      `Muse · Experimental · ${PINNED}`,
    )
  })
})
