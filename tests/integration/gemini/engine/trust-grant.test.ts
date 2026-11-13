// The flow "trust a folder for Gemini" through a real core (the `grant` executor (vendorFolder): "grant: writes
// trust.json"; trust.json `folders[folderKey].grants.vendorFolder[vendor] = {at}`; readiness `trust` "Gemini
// without a grant → fail, with a grant vendorFolder action"; failure category trust_required "grant → retry";
// the passBoundary preflight "Failure → pass fails with that category; nothing is spawned"):
//   - the composer's preflight blocks a Gemini pass in an untrusted folder; the check's grant writes trust.json and
//     the next preflight passes (Gemini's readiness hears trustFolder:true)
//   - a grant taken away before Implement: the pass-boundary guard fails it trust_required with nothing spawned; the
//     snag's grant writes trust.json and the retry runs Gemini in the trusted folder
//   - Gemini's own refusal at run time (exit 55, its trusted-directory words): the same snag, grant, retry
import { afterEach, describe, expect, it } from 'vitest'
import { CHOICE } from '../../../../src/core/supervisor/cards.ts'
import { atPlanGate } from '../../self-heal/helpers.ts'
import {
  ScriptedGemini,
  UNTRUSTED,
  World,
  failedWithSnag,
  geminiPlays,
  settled,
  snagOf,
  trustJsonOnDisk,
  value,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const IMPLEMENT_ON_GEMINI = {
  profile: 'claude-only',
  passes: { implement: { vendor: 'gemini', model: null } },
}
const PLAN = { plan: { recording: 'C06-plan-native-host' } }

/** trust.json's vendorFolder grants, folder by folder. */
function vendorGrants(home: string): { path: unknown; vendorFolder: unknown }[] {
  const file = trustJsonOnDisk(home)
  const folders = (file?.['folders'] ?? {}) as Record<
    string,
    { path?: unknown; grants?: { vendorFolder?: unknown } }
  >
  return Object.values(folders).map((f) => ({ path: f.path, vendorFolder: f.grants?.vendorFolder }))
}

describe('the composer: trust a folder for Gemini', () => {
  it('blocked until trusted; the grant writes trust.json and the next preflight passes', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{}]))
    const t = await w.boot(PLAN, gemini)
    const overrides = { ...IMPLEMENT_ON_GEMINI, gates: { afterPlan: false } }
    const before = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides }))
    expect(before.ok).toBe(false)
    const check = before.blocking.find((c) => c.id === 'pass.implement.readiness.trust')
    expect(check).toMatchObject({ category: 'trust_required', status: 'fail' })
    expect(gemini.readinessCalls.at(-1)?.need.trustFolder).toBe(false)
    const grant = check?.recovery.find((a) => a.kind === 'grant')
    expect(grant).toMatchObject({ grant: 'vendorFolder', vendor: 'gemini' })
    expect(trustJsonOnDisk(t.home)).toBeNull()

    const r = value(await t.core.invoke('recovery.execute', { actionId: grant?.id ?? '', folder: t.folder }))
    expect(r).toEqual({ kind: 'grant', message: 'This folder is trusted for Gemini. Checking again.' })
    const grants = vendorGrants(t.home)
    expect(grants).toHaveLength(1)
    expect(grants[0]?.vendorFolder).toEqual({ gemini: { at: expect.any(Number) as number } })
    expect(value(await t.core.invoke('trust.get', { folder: t.folder })).grants.vendorFolder).toEqual({
      gemini: { at: expect.any(Number) as number },
    })

    const after = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides }))
    expect(after.blocking.map((c) => c.id)).not.toContain('pass.implement.readiness.trust')
    expect(gemini.readinessCalls.at(-1)?.need.trustFolder).toBe(true)
    // Nothing ran Gemini: the grant only writes trust.json.
    expect(gemini.starts).toEqual([])
  }, 120_000)

  it('one grant clears every Gemini pass (no cached check keeps a pass blocked)', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{}]))
    const t = await w.boot(PLAN, gemini)
    const overrides = {
      profile: 'claude-only',
      gates: { afterPlan: false },
      passes: { plan: { vendor: 'gemini', model: null }, review: { vendor: 'gemini', model: null } },
    }
    const trustIds = (ids: string[]): string[] => ids.filter((id) => id.endsWith('.readiness.trust')).sort()
    const before = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides }))
    expect(trustIds(before.blocking.map((c) => c.id))).toEqual([
      'pass.plan.readiness.trust',
      'pass.review.readiness.trust',
    ])
    const grant = before.blocking
      .find((c) => c.id === 'pass.review.readiness.trust')
      ?.recovery.find((a) => a.kind === 'grant')
    value(await t.core.invoke('recovery.execute', { actionId: grant?.id ?? '', folder: t.folder }))
    const after = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides }))
    expect(trustIds(after.blocking.map((c) => c.id))).toEqual([])
    expect(after.ok, JSON.stringify(after.blocking.map((c) => c.id))).toBe(true)
    expect(vendorGrants(t.home)).toHaveLength(1)
  }, 120_000)
})

describe('a run: trust_required → grant → retry', () => {
  it('the grant taken away at the plan gate: Implement fails at the pass boundary; grant, retry, done', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{ file: 'src/version.ts', text: 'Added --version.' }]))
    const t = await w.boot(PLAN, gemini, { trust: true })
    const { runId, c } = await w.start(t, IMPLEMENT_ON_GEMINI)
    const gate = await c.waitFor(atPlanGate, 90_000)
    value(
      await t.core.invoke('trust.set', {
        folder: t.folder,
        grant: { kind: 'vendorFolder', vendor: 'gemini' },
        trusted: false,
      }),
    )
    const card = gate.cards.find((x) => x.view.kind === 'gate:afterPlan')
    value(
      await t.core.invoke('cards.resolve', { runId, cardId: card?.view.id ?? '', choiceId: CHOICE.approve }),
    )

    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.failure).toMatchObject({ category: 'trust_required' })
    // passBoundary: nothing was spawned.
    expect(gemini.starts).toEqual([])
    const actions = snagOf(t.events, 'implement')?.actions ?? []
    expect(actions[0]).toMatchObject({ kind: 'grant', grant: 'vendorFolder', vendor: 'gemini' })
    expect(actions[0]?.disabledReason).toBeUndefined()
    expect(actions[1]).toMatchObject({ kind: 'retry' })

    const r = value(await t.core.invoke('recovery.execute', { actionId: actions[0]?.id ?? '', runId }))
    expect(r.message).toBe('This folder is trusted for Gemini. Retrying Implement.')
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    expect(gemini.starts.map((s) => [s.step, s.trustFolder])).toEqual([['implement', true]])
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'gemini', autoRetryUsed: false })
    expect(vendorGrants(t.home)[0]?.vendorFolder).toEqual({ gemini: { at: expect.any(Number) as number } })
  }, 180_000)

  it('Gemini refusing the folder itself (exit 55): the snag grants and retries; the retry runs trusted', async () => {
    const gemini = new ScriptedGemini(
      geminiPlays([{ fail: UNTRUSTED }, { file: 'src/version.ts', text: 'Added --version.' }]),
      { checkTrust: false },
    )
    const t = await w.boot(PLAN, gemini)
    const { runId, c } = await w.start(t, { ...IMPLEMENT_ON_GEMINI, gates: { afterPlan: false } })
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.failure).toMatchObject({ category: 'trust_required' })
    expect(gemini.starts.map((s) => s.trustFolder)).toEqual([false])
    const grant = snagOf(t.events, 'implement')?.actions[0]
    expect(grant).toMatchObject({
      id: 'implement:grant-vendorFolder',
      grant: 'vendorFolder',
      vendor: 'gemini',
    })

    value(await t.core.invoke('recovery.execute', { actionId: grant?.id ?? '', runId }))
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    expect(gemini.starts.map((s) => s.trustFolder)).toEqual([false, true])
    expect(done.steps.implement).toMatchObject({ status: 'done', attempt: 2 })
  }, 180_000)
})
