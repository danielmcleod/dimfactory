// Recovery with a second vendor, through a real core (the `vendor_setup` executor "Calls Codex
// windowsSandbox/setupStart, waits for setupCompleted, then re-probes" and `switch_vendor`; vendor_setup "runs on
// click"; switch_vendor live once a second vendor is ready, codex-auth.spec.ts and codex-unknown-heal.spec.ts; failure categories
// sandbox_unavailable / auth_expired; self-heal "falling back to the first ready of claude/codex", "Codex: read-only,
// ephemeral"):
//   - the Codex vendor check's sandbox fix runs only on its click, then the stored probe reads the sandbox ready and
//     the composer's preflight no longer blocks Implement on Codex
//   - a Codex Implement failing on its sandbox mid-run shows the sandbox_unavailable snag; nothing runs the setup until the click,
//     which then re-probes and retries the pass (no retry budget)
//   - a logged-out Claude Implement offers [Use another vendor] → Codex once Codex is ready, and the pass retries on
//     Codex; while Codex has no sandbox the action is disabled with the reason, and core refuses it the same way
//   - Codex's expired login (codex-auth.spec.ts): copy `codex login`, re-check, retry
//   - heal on Codex: an unknown Review failure is diagnosed by Codex read-only and ephemeral
import { afterEach, describe, expect, it } from 'vitest'
import {
  HEAL_ANSWER,
  HEAL_DIAGNOSIS,
  IMPLEMENT_MATCH,
  REVIEW_MATCH,
  ScriptedCodex,
  World,
  claudeLoggedOutScript,
  claudeUnknownFailureScript,
  codexPlays,
  failedWithSnag,
  settled,
  snagOf,
  value,
} from './helpers.ts'
import { codexHangs } from '../../../unit/balanced/engine/helpers.ts'

const isWin = process.platform === 'win32'
const w = new World()
afterEach(() => w.dispose())

const BALANCED = { profile: 'balanced', gates: { afterPlan: false } }
const CLAUDE_ONLY = { profile: 'claude-only', gates: { afterPlan: false } }
const PLAN = { plan: { recording: 'C06-plan-native-host' } }

describe('vendor_setup: the Codex Windows sandbox from its check (the chip)', () => {
  it('runs only on the click; the re-probe is stored and the composer stops blocking Implement on Codex', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'notConfigured' })
    const t = await w.boot(PLAN, codex)
    const before = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides: BALANCED }))
    expect(before.ok).toBe(false)
    expect(before.blocking.map((c) => c.id)).toContain('pass.implement.mode')
    // Probing, preflight and the vendor rows never ran the setup themselves.
    expect(codex.setups).toEqual([])
    const probesBefore = codex.probes

    const r = value(await t.core.invoke('recovery.execute', { actionId: 'vendor.codex.winSandbox.setup' }))
    expect(r).toMatchObject({
      kind: 'vendor_setup',
      message: 'The Codex sandbox is set up.',
      setup: { vendor: 'codex', ok: true, ready: true, probed: true },
    })
    expect(codex.setups).toEqual([{ call: 'windowsSandbox/setupStart', params: { mode: 'unelevated' } }])
    expect(codex.probes).toBe(probesBefore + 1)
    // The vendor rows heard the new probe (AppEvent `probe`): the sandbox check passes now.
    const probed = t.appEvents.filter((e) => e.kind === 'probe' && e.vendor === 'codex').at(-1)
    const sandbox =
      probed?.kind === 'probe'
        ? probed.view.probe?.checks.find((c) => c.id === 'vendor.codex.winSandbox')
        : null
    expect(sandbox?.status).toBe('pass')

    const after = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides: BALANCED }))
    expect(after.blocking.map((c) => c.id)).not.toContain('pass.implement.mode')
  }, 120_000)

  it('a setup that does not finish says so, names the elevated command, and leaves the block in place', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'notConfigured' })
    codex.setupScript = () => Promise.resolve({ ok: false, detail: 'setup refresh had errors' })
    const t = await w.boot(PLAN, codex)
    const r = value(await t.core.invoke('recovery.execute', { actionId: 'vendor.codex.winSandbox.setup' }))
    expect(r).toMatchObject({ kind: 'vendor_setup', setup: { ok: false, ready: false, probed: true } })
    expect(r.message).toBe(
      'The Codex sandbox setup failed. setup refresh had errors. Try the elevated setup command.',
    )
    // The elevated command is only ever copied: core answers its text, nothing runs it.
    const copy = value(
      await t.core.invoke('recovery.execute', { actionId: 'vendor.codex.winSandbox.elevated' }),
    )
    expect(copy).toMatchObject({
      kind: 'shell_copy',
      copied: 'codex sandbox setup --elevated --current-user',
      message: 'Copied. Run it in an administrator terminal, then re-check.',
    })
    expect(codex.setups).toHaveLength(1)
    const after = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides: BALANCED }))
    expect(after.blocking.map((c) => c.id)).toContain('pass.implement.mode')
  }, 120_000)
})

const sandboxFailThenOk = (): ScriptedCodex =>
  new ScriptedCodex(
    codexPlays([
      {
        kind: 'fail',
        failure: {
          category: 'sandbox_unavailable',
          message: 'CreateRestrictedToken failed',
          raw: 'CreateRestrictedToken failed',
          classifiedBy: 'regex',
        },
      },
      { kind: 'ok', file: 'src/version.ts' },
    ]),
  )

// The setup Dim Factory runs (windowsSandbox/setupStart) and the elevated command exist only for Codex's Windows
// sandbox; on Linux and macOS Codex has no setup to run (snag-actions.ts, probe.ts sandboxActions).
describe('vendor_setup from a failed Codex pass', () => {
  it.runIf(isWin)(
    'the sandbox snag waits for the click; the click sets up, re-probes and retries Implement',
    async () => {
      const codex = sandboxFailThenOk()
      const t = await w.boot(PLAN, codex)
      const { runId, c } = await w.start(t, BALANCED)
      const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
      expect(failed.steps.implement.failure).toMatchObject({ category: 'sandbox_unavailable' })
      const actions = snagOf(t.events, 'implement')?.actions ?? []
      expect(actions.slice(0, 3).map((a) => a.kind)).toEqual(['vendor_setup', 'shell_copy', 'switch_vendor'])
      const setup = actions[0]
      expect(setup).toMatchObject({ vendor: 'codex', params: { mode: 'unelevated' } })
      expect(setup?.disabledReason).toBeUndefined()
      await c.settle()
      expect(codex.setups).toEqual([])

      const r = value(await t.core.invoke('recovery.execute', { actionId: setup?.id ?? '', runId }))
      expect(r.message).toBe('The Codex sandbox is set up. Retrying Implement.')
      expect(codex.setups).toHaveLength(1)
      const done = await c.waitFor(settled, 90_000)
      expect(done.status).toBe('completed')
      expect(done.steps.implement).toMatchObject({ status: 'done', attempt: 2, autoRetryUsed: false })
    },
    180_000,
  )

  it.skipIf(isWin)(
    'off Windows the snag has no setup to offer: another vendor first, then Retry, and nothing sets up',
    async () => {
      const codex = sandboxFailThenOk()
      const t = await w.boot(PLAN, codex)
      const { runId, c } = await w.start(t, BALANCED)
      const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
      expect(failed.steps.implement.failure).toMatchObject({ category: 'sandbox_unavailable' })
      const actions = snagOf(t.events, 'implement')?.actions ?? []
      expect(actions.map((a) => a.kind)).not.toContain('vendor_setup')
      expect(actions.filter((a) => a.kind === 'shell_copy')).toEqual([])
      expect(actions[0]).toMatchObject({ kind: 'switch_vendor', to: 'claude', pass: 'implement' })
      expect(actions[0]?.disabledReason).toBeUndefined()
      expect(actions.map((a) => a.kind)).toContain('retry')
      await c.settle()

      value(await t.core.invoke('runs.retryPass', { runId, pass: 'implement' }))
      const done = await c.waitFor(settled, 90_000)
      expect(done.status).toBe('completed')
      expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'codex', attempt: 2 })
      expect(codex.setups).toEqual([])
    },
    180_000,
  )
})

describe('switch_vendor with Codex as the second vendor', () => {
  it('a logged-out Claude Implement offers Codex; the click moves Implement to Codex and the run finishes', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', file: 'src/version.ts' }]))
    const t = await w.boot(PLAN, codex, {
      first: [{ name: 'implement-logged-out', match: IMPLEMENT_MATCH, ops: claudeLoggedOutScript() }],
    })
    const { runId, c } = await w.start(t, CLAUDE_ONLY)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.failure).toMatchObject({ category: 'auth_required' })
    const sw = snagOf(t.events, 'implement')?.actions.find((a) => a.kind === 'switch_vendor')
    expect(sw).toMatchObject({ kind: 'switch_vendor', to: 'codex', pass: 'implement', model: null })
    expect(sw?.disabledReason).toBeUndefined()

    value(await t.core.invoke('recovery.execute', { actionId: sw?.id ?? '', runId }))
    const done = await c.waitFor(settled, 90_000)
    expect(done.status).toBe('completed')
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'codex' })
    expect(codex.starts.map((s) => [s.step, s.mode])).toEqual([['implement', 'autoedit']])
  }, 180_000)

  it('while Codex has no Windows sandbox, the switch for Implement is disabled with why, and core refuses it', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'notConfigured' })
    const t = await w.boot(PLAN, codex, {
      first: [{ name: 'implement-logged-out', match: IMPLEMENT_MATCH, ops: claudeLoggedOutScript() }],
    })
    const { runId, c } = await w.start(t, CLAUDE_ONLY)
    await c.waitFor(failedWithSnag('implement'), 90_000)
    const sw = snagOf(t.events, 'implement')?.actions.find((a) => a.kind === 'switch_vendor')
    expect(sw).toMatchObject({ to: 'codex' })
    // The adapter's words, never its reason code.
    expect(sw?.disabledReason).toBe('Codex cannot run Implement this way. Needs the Codex Windows sandbox.')
    expect(sw?.disabledReason).not.toContain('winSandbox-')
    expect(sw?.disabledReason).not.toContain('—')
    const refused = await t.core.invoke('recovery.execute', { actionId: sw?.id ?? '', runId })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toBe(sw?.disabledReason)
    expect(codex.starts).toEqual([])
  }, 180_000)
})

describe('Codex: an expired login', () => {
  it('copy `codex login`, re-check, retry: the pass runs again on Codex', async () => {
    const codex = new ScriptedCodex(
      codexPlays([
        {
          kind: 'fail',
          failure: {
            category: 'auth_expired',
            message: '401 Unauthorized',
            raw: '',
            classifiedBy: 'structured',
          },
        },
        { kind: 'ok', file: 'src/version.ts' },
      ]),
    )
    const t = await w.boot(PLAN, codex)
    const { runId, c } = await w.start(t, BALANCED)
    await c.waitFor(failedWithSnag('implement'), 90_000)
    const actions = snagOf(t.events, 'implement')?.actions ?? []
    expect(actions[0]).toMatchObject({
      kind: 'shell_copy',
      command: 'codex login',
      recheck: 'vendor.codex.auth',
    })
    expect(actions[1]).toMatchObject({ kind: 'switch_vendor', to: 'claude' })
    const copied = value(await t.core.invoke('recovery.execute', { actionId: actions[0]?.id ?? '', runId }))
    expect(copied).toMatchObject({ kind: 'shell_copy', copied: 'codex login' })
    // "I ran it → Re-check": a forced probe, then the pass's Retry.
    value(await t.core.invoke('vendors.probe', { vendor: 'codex', force: true }))
    value(await t.core.invoke('runs.retryPass', { runId, pass: 'implement' }))
    const done = await c.waitFor(settled, 90_000)
    expect(done.status).toBe('completed')
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'codex', attempt: 2 })
  }, 180_000)
})

describe('heal on Codex', () => {
  it('an unknown Review failure is diagnosed by Codex: read-only, ephemeral, in the run’s heal folder', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', text: HEAL_ANSWER }]))
    const t = await w.boot(
      {
        ...PLAN,
        implement: [
          { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
        ],
      },
      codex,
      {
        user: { selfHeal: { enabled: true, vendor: 'codex', model: null, autoApplyConfigPatches: false } },
        first: [{ name: 'review-unknown', match: REVIEW_MATCH, ops: claudeUnknownFailureScript() }],
      },
    )
    const { runId, c } = await w.start(t, CLAUDE_ONLY)
    const healed = await c.waitFor(
      (s) =>
        failedWithSnag('review')(s) &&
        s.steps.review.heal !== undefined &&
        s.steps.review.heal.status !== 'running',
      120_000,
    )
    expect(healed.steps.review.failure).toMatchObject({ category: 'unknown' })
    const heal = codex.starts.find((s) => s.step === 'heal')
    expect(heal).toMatchObject({
      mode: 'readonly',
      ephemeral: true,
      planNative: false,
      model: null,
      allowRules: [],
    })
    expect(heal?.sessionId).toBeUndefined()
    expect(heal?.cwd.replace(/\\/g, '/')).toContain(`/runs/${runId}/heal`)
    expect(heal?.prompt).not.toContain('add a --version flag')
    const view = value(await t.core.invoke('runs.get', { runId })).steps.review.heal
    expect(view).toMatchObject({ status: 'ok', trigger: 'auto', diagnosis: HEAL_DIAGNOSIS })
  }, 180_000)
})
