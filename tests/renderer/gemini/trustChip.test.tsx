// Gemini trust chip in the composer's preflight strip (readiness `trust`, the grant executor, the
// preflight strip; gemini-trust.spec.ts "Gemini trust chip clears the block"; flow "trust a folder for Gemini").
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { RecoveryResult } from '@shared/ipc.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { trustPhase } from '@renderer/components/recovery/FolderTrustChip.tsx'
import {
  resetFolderTrustForTests,
  trustAbove,
  trustMeans,
  trustedMeans,
  trustStatusText,
} from '@renderer/components/recovery/folderTrust.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { bumpTrustEpoch, composerFolderNow, resetTrustStateForTests } from '@renderer/state/trust.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import {
  FOLDER,
  gemini,
  SWITCH_TO_CLAUDE,
  TRUST_ACTION_ID,
  TRUST_CHECK_DETAIL,
  TRUST_CHECK_TITLE,
  trustAction,
  trustCheck,
} from './fixtures.ts'

let mock: MockDimFactory
let live: PreflightReport

/** Implement (and Fix, inheriting it) on Gemini. */
const geminiImplement = (c: ResolvedConfig): void => {
  c.passes.implement.vendor = 'gemini'
  c.passes.fix.vendor = 'gemini'
}

const blocked = (...checks: ReturnType<typeof trustCheck>[]): PreflightReport =>
  report({ blocking: checks.length > 0 ? checks : [trustCheck()] })

beforeEach(() => {
  resetRecoveryForTests()
  resetFolderTrustForTests()
  resetTrustStateForTests()
  setLiveSupportForTests()
  live = blocked()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve({ config: geminiImplement }),
      'preflight.run': () => live,
      'estimates.get': () => runEstimate(),
      'vendors.list': (): ProbeView[] => [],
    },
  })
  upsertProbes([probe('claude', 'ready'), gemini()])
})

afterEach(() => {
  resetFolderTrustForTests()
  resetTrustStateForTests()
  tearDown(mock)
})

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
  await settle()
}

async function openDetails(): Promise<void> {
  fireEvent.click(screen.getByTestId('preflight-details'))
  await settle()
}

const ID = 'preflight-trust-pass.implement.readiness.trust'
const button = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(ID)
const status = (): string => screen.getByTestId(`${ID}-status`).textContent ?? ''
const phase = (): string | null => screen.getByTestId(`${ID}-chip`).getAttribute('data-phase')
const toasts = () => useStore.getState().toasts.items

describe('Gemini: the trust chip in the preflight strip clears the block', () => {
  it('names the block, says plainly what trusting means, and runs nothing on its own', async () => {
    await ready()
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe(
      `1 issue blocks the run: ${TRUST_CHECK_TITLE}`,
    )
    expect(screen.getByTestId<HTMLButtonElement>('composer-run').disabled).toBe(true)
    await openDetails()
    const block = screen.getByTestId('preflight-chip-pass.implement.readiness.trust')
    expect(within(block).getByTestId(ID)).toBe(button())
    expect(phase()).toBe('needed')
    expect(button().textContent).toBe('Trust this folder for Gemini')
    expect(button().disabled).toBe(false)
    expect(status()).toBe('Gemini is not trusted in this folder yet')
    expect(screen.getByTestId(`${ID}-means`).textContent).toBe(
      'If you trust it, Gemini may read and act in this folder without its own trust prompt. You can revoke it later in Settings → Vendors.',
    )
    expect(screen.getByTestId(`${ID}-chip`).getAttribute('data-vendor')).toBe('gemini')
    // The composer told the setup card which folder its checks are about.
    expect(composerFolderNow()).toBe(FOLDER)
    // Nothing runs on its own.
    await settle(60_000)
    expect(mock.callsOf('recovery.execute')).toEqual([])
    expect(mock.callsOf('trust.set')).toEqual([])
  })

  it('runs core’s grant on the click, re-checks, and the block clears', async () => {
    const answer = deferred<RecoveryResult>()
    mock.on('recovery.execute', () => answer.promise)
    await ready()
    await openDetails()
    const before = mock.callsOf('preflight.run').length
    const node = button()
    await act(async () => {
      fireEvent.click(node)
      await vi.advanceTimersByTimeAsync(0)
    })
    // The request names core's action and the composer's folder.
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: TRUST_ACTION_ID, folder: FOLDER }])
    expect(phase()).toBe('running')
    expect(status()).toBe('Trusting this folder for Gemini…')
    // The same button, its label kept; the spinner takes its icon slot.
    expect(button()).toBe(node)
    expect(node.textContent).toBe('Trust this folder for Gemini')
    expect(node.getAttribute('aria-busy')).toBe('true')
    // A second click while it runs sends nothing more.
    fireEvent.click(node)
    await settle()
    expect(mock.callsOf('recovery.execute')).toHaveLength(1)

    live = report()
    await act(async () => {
      answer.resolve({ kind: 'grant', message: 'This folder is trusted for Gemini. Checking again.' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    // Core's words, with Undo.
    const t = toasts().find((x) => x.message === 'This folder is trusted for Gemini. Checking again.')
    expect(t?.action?.label).toBe('Undo')
    // The live checks ran again and the block is gone (the summary says nothing blocks), so Run can start.
    expect(mock.callsOf('preflight.run').length).toBeGreaterThan(before)
    expect(screen.queryByTestId('preflight-chip-pass.implement.readiness.trust')).toBeNull()
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe('')
    expect(screen.getByTestId<HTMLButtonElement>('composer-run').disabled).toBe(false)
  })

  it('Undo in the toast revokes the grant through trust.set and checks again', async () => {
    mock.on('recovery.execute', () => ({ kind: 'grant', message: 'This folder is trusted for Gemini.' }))
    mock.on('trust.set', (req) => ({
      folder: req.folder,
      folderKey: 'repo-key',
      scopeRoot: req.folder,
      grants: {},
    }))
    await ready()
    await openDetails()
    await act(async () => {
      fireEvent.click(button())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    const before = mock.callsOf('preflight.run').length
    const undo = toasts().find((x) => x.message === 'This folder is trusted for Gemini.')?.action
    expect(undo?.label).toBe('Undo')
    await act(async () => {
      await (undo as { onClick: () => Promise<unknown> }).onClick()
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('trust.set')).toEqual([
      { folder: FOLDER, grant: { kind: 'vendorFolder', vendor: 'gemini' }, trusted: false },
    ])
    expect(toasts().some((x) => x.message === `Gemini no longer trusted in ${FOLDER}`)).toBe(true)
    expect(mock.callsOf('preflight.run').length).toBeGreaterThan(before)
    // The block is back, and its chip asks again from the start.
    expect(phase()).toBe('needed')
  })

  it('a refused grant says why and keeps the button for another try', async () => {
    mock.on('recovery.execute', () => {
      throw mockError('VALIDATION', 'This fix needs a folder; choose one first.')
    })
    await ready()
    await openDetails()
    await act(async () => {
      fireEvent.click(button())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(phase()).toBe('failed')
    expect(status()).toBe('Could not trust this folder: This fix needs a folder; choose one first')
    expect(button().disabled).toBe(false)
    expect(toasts().some((x) => x.level === 'error')).toBe(true)
  })

  it('core’s one grant for two passes is one chip: "and 1 more with the same fix"', async () => {
    live = blocked(trustCheck('implement'), trustCheck('fix'))
    await ready()
    await openDetails()
    const chip = screen.getByTestId('preflight-chip-pass.implement.readiness.trust')
    expect(chip.textContent).toContain('and 1 more with the same fix')
    expect(screen.queryByTestId('preflight-chip-pass.fix.readiness.trust')).toBeNull()
    expect(screen.getAllByText('Trust this folder for Gemini')).toHaveLength(1)
  })

  it('shows the grant once per strip: a later check with its own grant for Gemini points at the first', async () => {
    live = blocked(
      trustCheck('implement'),
      trustCheck('fix', { recovery: [trustAction({ id: 'pass.fix.readiness.trust.grant' })] }),
    )
    await ready()
    await openDetails()
    expect(screen.getAllByText('Trust this folder for Gemini')).toHaveLength(1)
    const fix = screen.getByTestId('preflight-chip-pass.fix.readiness.trust')
    expect(within(fix).queryByTestId('preflight-trust-pass.fix.readiness.trust')).toBeNull()
    expect(within(fix).getByTestId('preflight-trust-elsewhere-pass.fix.readiness.trust').textContent).toBe(
      trustAbove('Gemini'),
    )
  })

  it('a folder trusted or revoked elsewhere (the setup card, Settings) makes the composer check again', async () => {
    await ready()
    const before = mock.callsOf('preflight.run').length
    live = report()
    act(() => bumpTrustEpoch())
    await settle(300)
    expect(mock.callsOf('preflight.run').length).toBe(before + 1)
    expect(screen.getByTestId<HTMLButtonElement>('composer-run').disabled).toBe(false)
  })

  it('an open chip lists the trust control first, then the other fixes, with core’s words for what trust means', async () => {
    live = blocked(trustCheck('implement', { recovery: [trustAction(), SWITCH_TO_CLAUDE] }))
    await ready()
    await openDetails()
    const chip = screen.getByTestId('preflight-chip-pass.implement.readiness.trust')
    fireEvent.click(within(chip).getByRole('button', { name: /Show details and fixes/ }))
    await settle()
    const fixes = within(chip).getByRole('group', { name: /Ways to fix/ })
    const order = within(fixes)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(order).toEqual(['Trust this folder for Gemini', 'Use Claude for Implement'])
    expect(chip.textContent).toContain(TRUST_CHECK_DETAIL)
    // Core's detail says what trusting means here, so the chip does not say it a second time.
    expect(within(chip).queryByTestId(`${ID}-means`)).toBeNull()
    expect(within(chip).getByTestId(`${ID}-status`).textContent).toBe(
      'Gemini is not trusted in this folder yet',
    )
  })
})

describe('words and phases', () => {
  it('reads each phase in plain words, without em dashes', () => {
    const texts = [
      trustStatusText('no-folder', 'Gemini', 'this folder'),
      trustStatusText('checking', 'Gemini', FOLDER),
      trustStatusText('needed', 'Gemini', 'this folder'),
      trustStatusText('running', 'Gemini', 'this folder'),
      trustStatusText('trusted', 'Gemini', FOLDER),
      trustStatusText('failed', 'Gemini', 'this folder', 'Disk full.'),
      trustStatusText('failed', 'Gemini', 'this folder'),
      trustMeans('Gemini'),
      trustedMeans('Gemini'),
      trustAbove('Gemini'),
    ]
    expect(texts).toEqual([
      'Choose a folder in the composer to trust it for Gemini',
      `Checking Gemini's trust for ${FOLDER}…`,
      'Gemini is not trusted in this folder yet',
      'Trusting this folder for Gemini…',
      `Gemini trusted in ${FOLDER}`,
      'Could not trust this folder: Disk full',
      'Could not trust this folder',
      'If you trust it, Gemini may read and act in this folder without its own trust prompt. You can revoke it later in Settings → Vendors.',
      'Gemini may read and act in this folder without its own trust prompt. Revoke it in Settings → Vendors.',
      'Trust this folder for Gemini from the first check that offers it, above.',
    ])
    for (const t of texts) expect(t).not.toContain('—')
  })

  it('a grant made before a newer failing check does not read as trusted', () => {
    const check = { at: 2000 }
    expect(trustPhase(FOLDER, { state: 'trusted', at: 3000 }, check, null)).toBe('trusted')
    expect(trustPhase(FOLDER, { state: 'trusted', at: 1000 }, check, null)).toBe('needed')
    expect(trustPhase(null, undefined, check, null)).toBe('no-folder')
    expect(trustPhase(FOLDER, { state: 'running', startedAt: 1 }, undefined, false)).toBe('running')
    // A folder's chip (no check): core's trust.get answer decides.
    expect(trustPhase(FOLDER, undefined, undefined, null)).toBe('checking')
    expect(trustPhase(FOLDER, undefined, undefined, true)).toBe('trusted')
    expect(trustPhase(FOLDER, undefined, undefined, false)).toBe('needed')
    expect(trustPhase(FOLDER, { state: 'failed', at: 1, message: 'x' }, undefined, false)).toBe('failed')
  })
})
