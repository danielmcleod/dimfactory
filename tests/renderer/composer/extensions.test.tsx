// The Extensions control of a pass row: None, Allowed list and Pass through, with core's provenance and the vendor's
// honest copy under it. A choice is a run override. On a read-only pass, Pass through needs the user's yes to its
// warning first (Cancel changes nothing), and a run override of it is never saved to the project file.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASSTHROUGH_READONLY_WARNING, extensionsCopy } from '@shared/extensions.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { ExtensionsSelect } from '@renderer/pages/dashboard/composer/ExtensionsSelect.tsx'
import { PASSTHROUGH_NOT_SAVED } from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready'), probe('gemini', 'ready')])
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

describe('Extensions in a pass row', () => {
  it("shows the pass's level and what it means for its vendor, with core's provenance", async () => {
    await openRow('review')
    const trigger = screen.getByTestId('pass-extensions-review')
    expect(trigger.textContent).toBe('None')
    expect(trigger.getAttribute('aria-label')).toBe('Review extensions')
    expect(trigger.className).toContain('w-36')
    expect(screen.getByTestId('pass-extensions-copy-review').textContent).toBe(
      extensionsCopy('claude', 'none'),
    )
    // No provenance in this answer for the level (a default): no badge, as for any other field.
    expect(screen.queryByTestId('pass-provenance-review-extensions')).toBeNull()
    // The default level is not repeated on the collapsed row.
    expect(screen.getByTestId('pass-summary-review').textContent).not.toMatch(/None|Allowed|Pass through/)
  })

  it('Allowed list is a run override, said on the collapsed row too', async () => {
    await openRow('review')
    await pick('pass-extensions-review', 'Allowed list')
    expect(lastResolve()).toMatchObject({ overrides: { passes: { review: { extensions: 'allowed' } } } })
    expect(screen.getByTestId('pass-extensions-review').textContent).toBe('Allowed list')
    expect(screen.getByTestId('pass-extensions-review').className).toContain('w-36')
    expect(screen.getByTestId('pass-provenance-review-extensions').getAttribute('data-source')).toBe('run')
    expect(screen.getByTestId('pass-summary-review').textContent).toContain('Allowed list')
    expect(screen.getByTestId('pass-extensions-copy-review').textContent).toBe(
      extensionsCopy('claude', 'allowed'),
    )
  })

  it('Pass through on a read-only pass waits for the yes to its warning; Cancel changes nothing', async () => {
    await openRow('review')
    const before = mock.callsOf('config.resolve').length
    await pick('pass-extensions-review', 'Pass through')
    const confirm = screen.getByTestId('pass-extensions-confirm-review')
    expect(confirm.textContent).toContain(PASSTHROUGH_READONLY_WARNING)
    expect(mock.callsOf('config.resolve').length).toBe(before)
    fireEvent.click(screen.getByTestId('pass-extensions-confirm-no-review'))
    await settle(300)
    expect(screen.queryByTestId('pass-extensions-confirm-review')).toBeNull()
    expect(mock.callsOf('config.resolve').length).toBe(before)

    await pick('pass-extensions-review', 'Pass through')
    fireEvent.click(screen.getByTestId('pass-extensions-confirm-yes-review'))
    await settle(300)
    expect(lastResolve()).toMatchObject({ overrides: { passes: { review: { extensions: 'passthrough' } } } })
    // The copy carries the warning while it is set.
    const copy = screen.getByTestId('pass-extensions-copy-review')
    expect(copy.getAttribute('data-warning')).toBe('true')
    expect(copy.textContent).toContain(PASSTHROUGH_READONLY_WARNING)
    // Not saved to the project file: the button says why instead.
    const save = screen.getByTestId('pass-save-review')
    expect(save.hasAttribute('disabled')).toBe(true)
    expect(document.body.textContent).toContain(PASSTHROUGH_NOT_SAVED.slice(0, 40))
  })

  it('Implement takes Pass through (its default) and None at once, no confirm', async () => {
    await openRow('implement')
    expect(screen.getByTestId('pass-extensions-implement').textContent).toBe('Pass through')
    await pick('pass-extensions-implement', 'None')
    expect(screen.queryByTestId('pass-extensions-confirm-implement')).toBeNull()
    expect(lastResolve()).toMatchObject({ overrides: { passes: { implement: { extensions: 'none' } } } })
  })

  it("a vendor that cannot limit extensions says so (Grok's copy on a Grok pass)", async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.review.vendor = 'grok') }))
    await openRow('review')
    expect(screen.getByTestId('pass-extensions-copy-review').textContent).toMatch(/cannot limit/)
  })
})

describe('ExtensionsSelect', () => {
  it('the confirm keeps fixed labels and only the yes changes the level', async () => {
    const onChange = vi.fn()
    render(
      <Providers>
        <ExtensionsSelect id="x" pass="plan" label="Plan extensions" value="none" onChange={onChange} />
      </Providers>,
    )
    await pick('pass-extensions-x', 'Pass through')
    expect(screen.getByTestId('pass-extensions-confirm-yes-x').textContent).toBe('Use Pass through')
    expect(screen.getByTestId('pass-extensions-confirm-no-x').textContent).toBe('Cancel')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('pass-extensions-confirm-yes-x'))
    expect(onChange).toHaveBeenCalledWith('passthrough')
    // Allowed list never asks.
    await pick('pass-extensions-x', 'Allowed list')
    expect(onChange).toHaveBeenLastCalledWith('allowed')
  })
})
