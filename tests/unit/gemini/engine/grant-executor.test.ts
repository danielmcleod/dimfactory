// vendorFolder grant executor (executors "grant: writes trust.json"; trust.json
// `folders[folderKey].grants.vendorFolder[vendor] = {at}`; trust_required
// "grant → retry"; Readiness `trust`):
//   - a snag's grant writes the grant for the run's folder, marks the pass's readiness for a re-check, then retries
//   - a composer (folder) fix writes it and marks the check that offered it; a preflight card checks again
//   - it names the vendor it trusts; a vendor that never asks for folder trust, or none, is refused, nothing written
//   - with real trust.json: the file holds exactly the canonical grant, for the folder's scope key
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { StepKey } from '@shared/run.ts'
import { DimFactoryError } from '@core/errors.ts'
import { executeAction } from '@core/recovery/dispatcher.ts'
import type {
  ExecuteDeps,
  FoundAction,
  RecoveryConfigDeps,
  RunCommandDeps,
} from '@core/recovery/dispatcher.ts'
import { CHOICE } from '@core/supervisor/cards.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { getTrust, grantTrust, isVendorFolderGranted } from '@core/config/trust.ts'
import { makeConfig } from '../../supervisor/helpers.ts'

const RUN = '20261010T120000Z-grant1'
const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

function state(o: { failed?: StepKey[]; cards?: RunState['cards'] } = {}): RunState {
  const steps: Record<string, unknown> = {}
  for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'fix'] as const) {
    const failed = o.failed?.includes(k) === true
    steps[k] = { snagOpen: failed, status: failed ? 'failed' : 'queued' }
  }
  return {
    runId: RUN,
    folder: FOLDER,
    steps,
    cards: o.cards ?? [],
    config: makeConfig(),
  } as unknown as RunState
}

function mocks(o: { config?: boolean } = {}) {
  const retryPass = vi.fn<RunCommandDeps['retryPass']>(() => Promise.resolve())
  const resolveCard = vi.fn<NonNullable<RunCommandDeps['resolveCard']>>(() => Promise.resolve())
  const grant = vi.fn<RecoveryConfigDeps['grant']>(() => Promise.resolve())
  const awaitRecheck = vi.fn<(checkId: string) => void>()
  const deps: ExecuteDeps = {
    run: {
      retryPass,
      resolveCard,
      skipPass: () => Promise.resolve(),
      closeRun: () => Promise.resolve(),
      resumeRun: () => Promise.resolve(),
    },
    awaitRecheck,
    ...(o.config === false
      ? {}
      : {
          config: {
            managedFlags: () => ({}),
            persist: () => Promise.resolve([]),
            grant,
          },
        }),
    vendors: {
      vendors: () => [
        { id: 'claude', displayName: 'Claude', built: true },
        { id: 'codex', displayName: 'Codex', built: true },
        { id: 'gemini', displayName: 'Gemini', built: true },
      ],
      readyFor: () => ({ ok: true }),
    },
  }
  return { deps, retryPass, resolveCard, grant, awaitRecheck }
}

const trust = (o: Partial<Extract<RecoveryAction, { kind: 'grant' }>> = {}): RecoveryAction => ({
  id: 'implement:grant-vendorFolder',
  label: 'Trust this folder for Gemini',
  kind: 'grant',
  grant: 'vendorFolder',
  vendor: 'gemini',
  detail: `Gemini works in ${FOLDER} from now on.`,
  ...o,
})

const snag = (action: RecoveryAction, step: StepKey = 'implement'): FoundAction => ({
  action,
  source: { kind: 'snag', runId: RUN, step },
  state: state({ failed: [step] }),
})

async function err(p: Promise<unknown>): Promise<DimFactoryError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  if (!(e instanceof DimFactoryError)) throw new Error(`expected a DimFactoryError, got ${String(e)}`)
  return e
}

describe('vendorFolder grant', () => {
  it('a snag: writes the grant for the run folder, re-checks readiness, then retries the pass (grant → retry)', async () => {
    const m = mocks()
    const r = await executeAction(snag(trust()), m.deps)
    expect(r).toEqual({ kind: 'grant', message: 'This folder is trusted for Gemini. Retrying Implement.' })
    expect(m.grant).toHaveBeenCalledTimes(1)
    expect(m.grant).toHaveBeenCalledWith(FOLDER, { kind: 'vendorFolder', vendor: 'gemini' })
    expect(m.awaitRecheck).toHaveBeenCalledWith('pass.implement.readiness')
    expect(m.retryPass).toHaveBeenCalledWith(RUN, 'implement', 'auto')
    // The grant is written before the retry reads it.
    expect(m.grant.mock.invocationCallOrder[0]).toBeLessThan(m.retryPass.mock.invocationCallOrder[0] ?? 0)
  })

  it('a composer fix: writes the grant and marks the check that offered it for a re-check (nothing retried)', async () => {
    const m = mocks()
    const found: FoundAction = {
      action: trust({ id: 'pass.review.readiness.trust.grant' }),
      source: { kind: 'folder', folder: FOLDER, checkId: 'pass.review.readiness.trust' },
    }
    expect(await executeAction(found, m.deps)).toEqual({
      kind: 'grant',
      message: 'This folder is trusted for Gemini. Checking again.',
    })
    expect(m.grant).toHaveBeenCalledWith(FOLDER, { kind: 'vendorFolder', vendor: 'gemini' })
    expect(m.awaitRecheck).toHaveBeenCalledWith('pass.review.readiness.trust')
    expect(m.retryPass).not.toHaveBeenCalled()
  })

  it("a preflight card's grant checks again (the card's Recheck)", async () => {
    const m = mocks()
    const action = trust({ id: 'pass.implement.readiness.trust.grant' })
    const card = {
      view: {
        id: 'card-preflight-1',
        kind: 'preflight',
        title: 'Preflight',
        body: '',
        payload: { blocking: [{ recovery: [action] }] },
        blocking: true,
        choices: [],
      },
    } as unknown as RunState['cards'][number]
    const found: FoundAction = {
      action,
      source: { kind: 'card', runId: RUN, cardId: 'card-preflight-1' },
      state: state({ cards: [card] }),
    }
    expect(await executeAction(found, m.deps)).toEqual({
      kind: 'grant',
      message: 'This folder is trusted for Gemini. Checking again.',
    })
    expect(m.resolveCard).toHaveBeenCalledWith(RUN, 'card-preflight-1', CHOICE.recheck)
  })

  it('refuses a grant without a vendor, or for a vendor that never asks for folder trust; nothing is written', async () => {
    const m = mocks()
    const { vendor: _v, ...noVendor } = trust() as Extract<RecoveryAction, { kind: 'grant' }>
    for (const a of [noVendor as RecoveryAction, trust({ vendor: '' }), trust({ vendor: 'claude' })]) {
      const e = await err(executeAction(snag(a), m.deps))
      expect(e.code).toBe('VALIDATION')
      expect(e.message).not.toMatch(/—/)
    }
    expect(m.grant).not.toHaveBeenCalled()
    expect(m.retryPass).not.toHaveBeenCalled()
  })

  it('needs a folder (an app or vendor check has none) and the trust store (UNSUPPORTED without it)', async () => {
    const m = mocks()
    const vendor = await err(
      executeAction(
        { action: trust(), source: { kind: 'vendor', vendor: 'gemini', checkId: 'vendor.gemini.auth' } },
        m.deps,
      ),
    )
    expect(vendor.code).toBe('VALIDATION')
    const none = mocks({ config: false })
    expect((await err(executeAction(snag(trust()), none.deps))).code).toBe('UNSUPPORTED')
    expect(m.grant).not.toHaveBeenCalled()
  })

  it('is no longer "Available in a later version" (the placeholder is gone)', async () => {
    const m = mocks()
    const r = await executeAction(snag(trust()), m.deps)
    expect(r.message).not.toMatch(/later version/i)
  })
})

describe('trust.json vendorFolder (canonical shape)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('folders[folderKey].grants.vendorFolder.gemini = {at}; read back as granted for Gemini only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trust-'))
    dirs.push(root)
    const home = join(root, 'home')
    const folder = join(root, 'proj')
    mkdirSync(home, { recursive: true })
    mkdirSync(folder, { recursive: true })
    const folderScope = { scopeRoot: folder, folderKey: '0123456789abcdef' }
    await grantTrust(
      folder,
      { kind: 'vendorFolder', vendor: 'gemini' },
      { home, folderScope, now: () => 4242 },
    )
    const file = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as Record<string, unknown>
    expect(file).toEqual({
      schemaVersion: 1,
      folders: {
        '0123456789abcdef': { path: folder, grants: { vendorFolder: { gemini: { at: 4242 } } } },
      },
    })
    const t = await getTrust(folder, { home, folderScope })
    expect(isVendorFolderGranted(t.grants, 'gemini')).toBe(true)
    expect(isVendorFolderGranted(t.grants, 'claude')).toBe(false)
  })
})
