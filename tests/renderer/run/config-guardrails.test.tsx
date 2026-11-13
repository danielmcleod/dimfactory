// The Config tab's guardrails for the run's folder: each rule in force with where it comes from (always on, the
// preset, your rules, the project), read from your settings and the folder's as set now.
import '../helpers/rtl.ts'
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Guardrails } from '@shared/guardrails.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { ConfigTab } from '@renderer/pages/run/ConfigTab.tsx'
import { resetStore } from '@renderer/state/store.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { renderUi, snapWith } from './helpers.tsx'

let mock: MockDimFactory
const user: Guardrails = { preset: 'recommended', rules: [{ kind: 'network', allow: false }] }
const project: Guardrails = {
  preset: 'strict',
  rules: [
    { kind: 'network', allow: false },
    { kind: 'privateFiles', paths: ['.env*'] },
  ],
}

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
})

afterEach(() => {
  mock.uninstall()
  resetBridgeForTests()
})

describe('guardrails in the Config tab', () => {
  it('lists each rule in force for the folder with where it comes from', async () => {
    mock = installMockDimFactory({
      handlers: {
        'config.resolve': (req) =>
          ({ config: { guardrails: req?.folder !== undefined ? project : user } }) as never,
      },
    })
    const snap = snapWith({})
    renderUi(<ConfigTab snap={{ ...snap, guardrails: { rules: 9, fired: 0, undone: 0, stopped: false } }} />)
    const box = await screen.findByTestId('config-guardrails')
    expect(mock.callsOf('config.resolve')).toEqual([{}, { folder: snap.summary.folder }])
    const rows = [...box.querySelectorAll('li')].map((li) => li.textContent)
    expect(rows[0]).toBe('Settings filesAlways on')
    expect(rows).toContain('Isolated copy onlyStrict preset, set by this project')
    expect(rows).toContain('No networkYour rules')
    expect(rows).toContain('Private files: .env*This project')
    expect(box.textContent).toContain('This run started with 9 rules in force, plus settings files.')
  })

  it('shows nothing when the folder cannot be read', async () => {
    mock = installMockDimFactory({ handlers: {} })
    renderUi(<ConfigTab snap={snapWith({})} />)
    await waitFor(() => {
      expect(mock.callsOf('config.resolve').length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('config-guardrails')).toBeNull()
  })
})
