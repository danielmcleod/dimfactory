// Review (session rules 4 and 7, state-machine row R10; the pass.fix.resume check) through a real core and the fake
// Claude:
//   - the controller's `session-check` carries the Fix vendor's capabilities from resolved.json `vendors`: with
//     resumeModelSwitch false and a Fix model override, Fix starts fresh ("the model differs") and never tries
//     --resume; with resume 'none' it starts fresh ("the session cannot be resumed", core's detail
//     vendor-cannot-resume) although canResume found the transcript
//   - pass.fix.resume and config.resolve agree once the Codex stub has been probed (balanced, codex-only)
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { homePaths, runPaths } from '../../../src/core/home.ts'
import type { SessionCheck } from '../../../src/core/supervisor/sessions.ts'
import { REVIEW_WITH_FINDINGS, passArgvs } from '../run/scenario.ts'
import { World, fixWrite, settled, value, versionWrite } from './helpers.ts'
import type { Started } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

/** Every ask on any step: allowed, as a user would (C03's PowerShell ask). */
function allowAsks(t: Started): void {
  t.c.subscribe((s) => {
    for (const st of Object.values(s.steps)) {
      for (const a of st.asks) {
        void t.core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    }
  })
}

/** The session-check the controller put into Fix's launch (the last one seen). */
function watchSessionCheck(t: Started): () => SessionCheck | undefined {
  let seen: SessionCheck | undefined
  t.c.subscribe((s) => {
    const c = s.steps.fix.launch?.sessionCheck
    if (c !== undefined) seen = structuredClone(c)
  })
  return () => seen
}

/**
 * Change the Fix vendor's capabilities as the run recorded them at start (resolved.json `vendors.claude`), before
 * Fix's session is decided — what a vendor with other capabilities would have stored.
 */
function patchCapabilities(t: Started, caps: Record<string, unknown>): void {
  const file = runPaths(homePaths(t.home).runsDir, t.runId).resolvedJson
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    vendors: Record<string, { capabilities: Record<string, unknown> }>
  }
  const claude = doc.vendors['claude']
  if (claude === undefined) throw new Error('resolved.json has no vendors.claude')
  expect(claude.capabilities).toMatchObject({ resume: 'id', resumeModelSwitch: true })
  claude.capabilities = { ...claude.capabilities, ...caps }
  writeFileSync(file, JSON.stringify(doc, null, 2))
}

const BASE = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  fix: [{ recording: 'C03-accept-edits', write: fixWrite }],
}

describe('the controller’s session-check carries the vendor’s capabilities (rules 4 and 7)', () => {
  it('resumeModelSwitch false + a Fix model override → fresh "the model differs", no --resume', async () => {
    const t = await w.start(BASE, {
      overrides: { gates: { afterPlan: false }, passes: { fix: { model: 'opus' } } },
    })
    patchCapabilities(t, { resumeModelSwitch: false })
    const sessionCheck = watchSessionCheck(t)
    allowAsks(t)
    const done = await t.c.waitFor(settled, 90_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')
    const impl = done.steps.implement.sessionId ?? ''
    expect(impl).not.toBe('')

    // canResume found the transcript; the capabilities came from resolved.json as patched.
    expect(sessionCheck()).toEqual({
      sessionId: impl,
      ok: true,
      cwd: t.folder,
      capabilities: { resume: 'id', resumeModelSwitch: false, resumeModeSwitch: true },
    })
    const argvs = passArgvs(t.sc.entries())
    expect(argvs.some((a) => a.some((x) => x.startsWith('--resume=')))).toBe(false)
    const edits = argvs.filter((a) => a.includes('acceptEdits'))
    expect(edits).toHaveLength(2) // Implement, then the fresh Fix
    expect(edits[1]?.join(' ')).toContain('--model opus')
    expect(edits[1]?.some((x) => x.startsWith('--session-id='))).toBe(true)
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      model: 'opus',
      sessionNote: 'fresh session: the model differs',
    })
    expect(done.steps.fix.freshDetail).toBeUndefined()
  }, 150_000)

  it('resume none → fresh "the session cannot be resumed" with core’s vendor-cannot-resume, though canResume said yes', async () => {
    const t = await w.start(BASE)
    patchCapabilities(t, { resume: 'none' })
    const sessionCheck = watchSessionCheck(t)
    allowAsks(t)
    const done = await t.c.waitFor(settled, 90_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')
    const impl = done.steps.implement.sessionId ?? ''

    expect(sessionCheck()).toMatchObject({
      sessionId: impl,
      ok: true,
      capabilities: { resume: 'none', resumeModelSwitch: true },
    })
    expect(passArgvs(t.sc.entries()).some((a) => a.some((x) => x.startsWith('--resume=')))).toBe(false)
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      sessionNote: 'fresh session: the session cannot be resumed',
      freshDetail: 'vendor-cannot-resume',
    })
    // What the renderer reads: the Fix StepView carries core's detail.
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.steps.fix).toMatchObject({
      sessionNote: 'fresh session: the session cannot be resumed',
      freshDetail: 'vendor-cannot-resume',
    })
  }, 150_000)
})

describe('pass.fix.resume and config.resolve with the Codex stub probed', () => {
  it('balanced and codex-only: both say Reuse (the stub’s resume none is not a ready vendor’s)', async () => {
    const b = await w.boot({})
    value(await b.core.invoke('vendors.probe', { vendor: 'claude' }))
    value(await b.core.invoke('vendors.probe', { vendor: 'codex' }))
    for (const profile of ['balanced', 'codex-only'] as const) {
      const overrides = { profile }
      const live = value(await b.core.invoke('preflight.run', { folder: b.folder, overrides }))
      const check = [...live.blocking, ...live.warnings, ...live.info].find((c) => c.id === 'pass.fix.resume')
      expect(check, profile).toMatchObject({ status: 'pass', title: "Fix will continue Implement's session" })
      const resolved = value(await b.core.invoke('config.resolve', { folder: b.folder, overrides }))
      expect(resolved.suggestions?.fixSession, profile).toEqual({ choice: 'reuse' })
    }
  }, 150_000)
})
