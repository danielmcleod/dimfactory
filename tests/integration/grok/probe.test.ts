// probe(), readiness() and canResume() of the Grok adapter against a fake grok (the Grok probe checks: bin resolve;
// version record; auth XAI_API_KEY, or ACP authRequired on Test; protocol ACP
// initialize and `--help` lists `agent stdio`; plan emulated. Readiness: mode only, Grok needs no folder grant). The
// launch probe stops at initialize; only Test (a forced probe) starts a session (replay.test.ts GR01, GR01b).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  eof,
  exitFrame,
  expectNoMismatch,
  fakeSetup,
  inReq,
  outRes,
  recording,
  tempDir,
} from '../acp/adapter/helpers.ts'
import { AGENT_HELP, fakeGrok, grokScenario, stdioScenario } from './helpers.ts'

const status = (checks: { id: string; status: string }[]): [string, string][] =>
  checks.map((c) => [c.id, c.status])

const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dim-factory', title: 'Dim Factory', version: '0.1.0' },
}
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  authMethods: [{ id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' }],
  _meta: { grokShell: true, defaultAuthMethodId: 'grok.com', agentVersion: '1.0.50' },
}

/** The launch probe's agent: initialize only, then stdin closes. */
const initializeOnly = (): string =>
  recording({ scenario: 'grok-launch-probe', vendor: 'grok' }, [
    inReq(1, 'initialize', INITIALIZE_PARAMS),
    outRes(1, INITIALIZE_RESULT),
    eof(),
    exitFrame(0),
  ])

describe('Grok launch probe (no session, no token)', () => {
  it('with XAI_API_KEY: bin, version, auth and protocol pass; plan is emulated; initialize only', async () => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()), {
      vendorEnv: { XAI_API_KEY: 'xai-test-key-not-real' },
    })
    const probe = await fake.adapter.probe()
    expectNoMismatch(fake.logEntries())
    expect(status(probe.checks)).toEqual([
      ['vendor.grok.bin', 'pass'],
      ['vendor.grok.version', 'pass'],
      ['vendor.grok.auth', 'pass'],
      ['vendor.grok.protocol', 'pass'],
      ['vendor.grok.plan', 'skip'],
    ])
    expect(probe.ok).toBe(true)
    expect(probe.version).toBe('1.0.50')
    expect(probe.transport).toBe('acp')
    // The probe's version check, "record": no floor, no recommended, no tested version yet.
    expect(probe.checks.find((c) => c.id === 'vendor.grok.version')?.detail).toMatch(/Version recorded/)
    expect(probe.capabilities).toMatchObject({
      planMode: 'emulated',
      askRelay: true,
      resume: 'id',
      preassignSessionId: false,
      modelList: 'static',
      usageCumulative: false,
      reasoningIncludedInOutput: true,
    })
    expect(probe.capabilities.modes.readonly.status).toBe('supported')
    expect(probe.capabilities.modes.autoedit).toMatchObject({ status: 'unsupported' })
    expect(probe.capabilities.modes.full.status).toBe('supported')
    expect(probe.models).toEqual([])
    expect(probe.account).toEqual({ method: 'api-key' })
    // The key's value never reaches a check.
    expect(JSON.stringify(probe)).not.toContain('xai-test-key-not-real')
    // `grok agent --help` read the transports; the agent ran as `agent --no-leader stdio`; only initialize was sent.
    expect(fake.starts()).toContainEqual(['agent', '--help'])
    expect(fake.starts().find((a) => a.includes('stdio'))).toEqual(['agent', '--no-leader', 'stdio'])
    expect(fake.stdinLines().map((m) => (m as { method?: string }).method)).toEqual(['initialize'])
  })

  it("Grok's cached sign-in counts (the file exists; its contents are never needed)", async () => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()))
    writeFileSync(join(fake.grokHome, 'auth.json'), '{"token":"secret-token-not-real"}')
    const probe = await fake.adapter.probe()
    const auth = probe.checks.find((c) => c.id === 'vendor.grok.auth')!
    expect(auth.status).toBe('pass')
    expect(auth.detail).toMatch(/grok login/)
    expect(JSON.stringify(probe)).not.toContain('secret-token-not-real')
    // A Grok sign-in may be a subscription: nothing is claimed about how it is billed.
    expect(probe.account).toBeUndefined()
  })

  it('no key and no cached sign-in: auth warns, with the sign-in command to copy and Claude', async () => {
    // Grok may sign in with a key in its own config.toml, which Dim Factory never reads: the launch probe (initialize
    // only) cannot tell, so it warns; Test's session/new decides (GR01b: authRequired fails).
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()))
    const probe = await fake.adapter.probe()
    const auth = probe.checks.find((c) => c.id === 'vendor.grok.auth')!
    expect(auth).toMatchObject({ status: 'warn', blocking: false, category: 'auth_required' })
    expect(auth.recovery.map((a) => [a.kind, a.id])).toEqual([
      ['shell_copy', 'grok.login'],
      ['switch_vendor', 'grok.switch-vendor'],
    ])
    expect(auth.recovery[0]).toMatchObject({ command: 'grok login', recheck: 'vendor.grok.auth' })
    expect(probe.ok).toBe(true)
    // The version answered, so Grok is listed under "More" (with the warning).
    expect(probe.version).toBe('1.0.50')
  })

  it('an agent help without --no-leader (or without stdio) fails the version check as flag_drift', async () => {
    const setup = await fakeSetup()
    for (const drop of ['--no-leader', 'stdio ']) {
      const help = AGENT_HELP.filter((l) => !l.includes(drop))
      const fake = fakeGrok(
        setup,
        grokScenario([{ match: { argvIncludes: ['stdio'] }, script: initializeOnly(), repeat: true }], {
          help,
        }),
        {
          vendorEnv: { XAI_API_KEY: 'k' },
        },
      )
      const probe = await fake.adapter.probe()
      const version = probe.checks.find((c) => c.id === 'vendor.grok.version')!
      expect(version, drop).toMatchObject({ status: 'fail', category: 'flag_drift' })
    }
  })

  it('another CLI named grok (a bare version, not "grok <version>") is not Grok', async () => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, grokScenario([], { version: ['0.0.34'] }))
    const probe = await fake.adapter.probe()
    expect(status(probe.checks)).toEqual([['vendor.grok.bin', 'fail']])
    expect(probe.checks[0]?.detail).toMatch(/not grok/)
  })

  it('refused flags in vendors.grok.extraArgs fail the protocol check without starting the agent', async () => {
    const setup = await fakeSetup()
    for (const extraArgs of [['--always-approve'], ['--yolo'], ['--leader'], ['--trust'], ['--model', 'x']]) {
      const fake = fakeGrok(setup, stdioScenario(initializeOnly()), {
        adapter: { extraArgs },
        vendorEnv: { XAI_API_KEY: 'k' },
      })
      const probe = await fake.adapter.probe()
      expect(
        probe.checks.find((c) => c.id === 'vendor.grok.protocol'),
        extraArgs.join(' '),
      ).toMatchObject({
        status: 'fail',
        category: 'config_invalid',
      })
      expect(fake.starts().some((a) => a.includes('stdio'))).toBe(false)
    }
  })
})

describe('Grok readiness and canResume', () => {
  it('readiness: the mode check alone (no folder grant); autoedit fails with the honest copy', async () => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()))
    const cwd = tempDir('grok-ready-')
    const review = await fake.adapter.readiness(cwd, {
      pass: 'review',
      mode: 'readonly',
      planNative: false,
      trustFolder: false,
    })
    // A read-only pass also gets the allow-rules scan (nothing set up here: it passes).
    expect(review.map((c) => [c.id, c.status])).toEqual([
      ['pass.review.readiness.mode', 'pass'],
      ['pass.review.readiness.grok-allow-rules', 'pass'],
    ])
    const implement = await fake.adapter.readiness(cwd, {
      pass: 'implement',
      mode: 'autoedit',
      planNative: false,
      trustFolder: false,
    })
    expect(implement).toHaveLength(1)
    expect(implement[0]).toMatchObject({
      id: 'pass.implement.readiness.mode',
      status: 'fail',
      blocking: true,
      category: 'capability_missing',
    })
    expect(implement[0]?.detail).toMatch(/^Not supported until Dim Factory has seen it work/)
    // A native Plan asked for runs emulated (read-only with the plan template): supported, never Grok's plan mode.
    const plan = fake.adapter.support({
      pass: 'plan',
      mode: 'autoedit',
      planNative: true,
      trustFolder: false,
    })
    expect(plan.status).toBe('supported')
    expect(plan.copy).toMatch(/^Reads and searches only/)
    // Full (Auto only) is Grok's always-approve for the session.
    expect(
      fake.adapter.support({ pass: 'implement', mode: 'full', planNative: false, trustFolder: false }).copy,
    ).toMatch(/always-approve, for this session only/)
  })

  it('a read-only pass whose allow rules would let Grok change files fails grok-allow-rules', async () => {
    // Grok applies allow rules from its own config and the user's Claude settings before it asks (user guide 22):
    // rejecting every ask cannot stop an edit or a command such a rule lets through.
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()))
    const cwd = tempDir('grok-ready-rules-')
    const review = { pass: 'review', mode: 'readonly', planNative: false, trustFolder: false } as const
    mkdirSync(join(fake.home, '.claude'), { recursive: true })
    writeFileSync(
      join(fake.home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read', 'Bash(npm *)'] } }),
    )
    writeFileSync(join(fake.grokHome, 'config.toml'), ['[sandbox]', 'auto_allow_bash = true', ''].join('\n'))
    const checks = await fake.adapter.readiness(cwd, review)
    const guard = checks.find((c) => c.id === 'pass.review.readiness.grok-allow-rules')
    expect(guard).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'capability_missing',
      title: 'Your allow rules would let Grok change files in Review',
    })
    expect(guard?.detail).toContain('Bash(npm *) in ~/.claude/settings.json')
    expect(guard?.detail).toContain('sandbox.auto_allow_bash in ~/.grok-test/config.toml')
    expect(guard?.detail).not.toContain('Read in')
    expect(guard?.recovery).toEqual([
      {
        id: 'grok.allow-rules.switch',
        label: 'Use Claude for Review',
        kind: 'switch_vendor',
        pass: 'review',
        to: 'claude',
        model: null,
      },
    ])
    // The emulated Plan is read-only too; Implement in full mode (Auto) is not, so it is not scanned.
    const plan = await fake.adapter.readiness(cwd, {
      ...review,
      pass: 'plan',
      mode: 'autoedit',
      planNative: true,
    })
    expect(plan.find((c) => c.id === 'pass.plan.readiness.grok-allow-rules')?.status).toBe('fail')
    const full = await fake.adapter.readiness(cwd, { ...review, pass: 'implement', mode: 'full' })
    expect(full.map((c) => c.id)).toEqual(['pass.implement.readiness.mode'])
    // Nothing was spawned to find out.
    expect(fake.starts()).toEqual([])
  })

  it('canResume looks only at folder names under GROK_HOME/sessions (no process, no file read)', async () => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(initializeOnly()), { vendorEnv: { XAI_API_KEY: 'k' } })
    await fake.adapter.probe()
    const id = '0199d2a4-7c1e-7a3b-9f20-3c4d5e6f70aa'
    const before = fake.starts().length
    // No sessions folder yet: Grok decides at session/resume.
    expect(await fake.adapter.canResume(id, 'C:/x')).toEqual({ ok: true })
    mkdirSync(join(fake.grokHome, 'sessions', 'C%3A%5Cwork%5Capp', id), { recursive: true })
    expect(await fake.adapter.canResume(id, 'C:/x')).toEqual({ ok: true })
    expect(await fake.adapter.canResume('0199d2a4-7c1e-7a3b-9f20-3c4d5e6f70bb', 'C:/x')).toEqual({
      ok: false,
      reason: 'cannot-resume',
    })
    expect(await fake.adapter.canResume('not-a-uuid', 'C:/x')).toEqual({ ok: false, reason: 'cannot-resume' })
    expect(fake.starts().length).toBe(before)
  })
})
