// An Experimental vendor (Muse; core's ProbeView.experimental) says so wherever vendors are listed: the
// composer's and Settings → Profiles' pass vendor pickers list it under "More" with the Experimental note before any
// state note (Settings → Vendors already shows its badge). Core's words only; the picker adds nothing else.
import { describe, expect, it } from 'vitest'
import { EXPERIMENTAL_NOTE, vendorChoices } from '@renderer/pages/dashboard/composer/model.ts'
import { probe } from './fixtures.tsx'

const experimental = (view: ReturnType<typeof probe>) => ({ ...view, experimental: true })

describe('the Experimental note in the vendor picker', () => {
  it('a ready Experimental vendor under "More" reads "Experimental"; its state follows when it has one', () => {
    const choices = vendorChoices(
      [
        probe('claude', 'ready'),
        probe('codex', 'ready'),
        experimental(probe('muse', 'ready')),
        { ...experimental(probe('muse', 'login-needed')), vendor: 'muse-2', displayName: 'Muse 2' },
      ],
      [],
      'claude',
    )
    expect(choices.map((c) => [c.id, c.group, c.disabled, c.note ?? null])).toEqual([
      ['claude', 'primary', false, null],
      ['codex', 'primary', false, null],
      ['muse', 'more', false, 'Experimental'],
      ['muse-2', 'more', false, 'Experimental · Login needed'],
    ])
    expect(EXPERIMENTAL_NOTE).toBe('Experimental')
  })

  it('a vendor that is not Experimental gets no note', () => {
    const choices = vendorChoices(
      [probe('claude', 'ready'), probe('codex', 'ready'), probe('gemini', 'ready')],
      [],
      'claude',
    )
    expect(choices.find((c) => c.id === 'gemini')?.note).toBeUndefined()
  })
})
