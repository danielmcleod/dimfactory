// probe(), readiness(), canResume() and listModels() of the Gemini adapter against a fake gemini (the Gemini
// probe checks: bin = shim → system node ≥ 20; version warns below 0.62.0 and fails when --help lacks --acp;
// auth = GEMINI_API_KEY / Vertex env or ~/.gemini/oauth_creds.json existence; protocol = ACP initialize +
// session/new in tmp/probe-cwd with --skip-trust; plan = 'plan' ∈ availableModes. Readiness `trust`).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Frame } from './helpers.ts'
import {
  HELP_TEXT,
  MODELS,
  MODES,
  SESSION,
  acpScenario,
  eof,
  exitFrame,
  expectNoMismatch,
  fakeGemini,
  fakeSetup,
  inReq,
  opening,
  outErr,
  outRes,
  recording,
  scenario,
  tempDir,
} from './helpers.ts'

const status = (checks: { id: string; status: string }[]): [string, string][] =>
  checks.map((c) => [c.id, c.status])

const handshake = (frames: Frame[] = opening()): string =>
  recording({ scenario: 'probe' }, [...frames, eof(), exitFrame(0)])

describe('Gemini probe', () => {
  it('a signed-in Gemini: every check passes; modes, models and session/load come from the handshake', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake()), {
      vendorEnv: { GEMINI_API_KEY: 'test-key-not-real' },
    })
    const probe = await fake.adapter.probe()
    expectNoMismatch(fake.logEntries())
    expect(status(probe.checks)).toEqual([
      ['vendor.gemini.bin', 'pass'],
      ['vendor.gemini.version', 'pass'],
      ['vendor.gemini.auth', 'pass'],
      ['vendor.gemini.protocol', 'pass'],
      ['vendor.gemini.plan', 'pass'],
    ])
    expect(probe.ok).toBe(true)
    expect(probe.transport).toBe('acp')
    expect(probe.binary?.kind).toBe('node-entry')
    expect(probe.capabilities).toMatchObject({
      planMode: 'native',
      askRelay: true,
      resume: 'load',
      preassignSessionId: false,
      modelList: 'cli',
      allowSession: 'native',
      usageCumulative: false,
    })
    expect(probe.models).toEqual([
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)', isDefault: true, source: 'cli' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', source: 'cli' },
    ])
    expect(await fake.adapter.listModels()).toEqual(probe.models)
    // The key's value never reaches a check.
    expect(JSON.stringify(probe)).not.toContain('test-key-not-real')
    // The probe ran in Dim Factory's own folder, so it passed --skip-trust; it never prompted or authenticated.
    const argv = fake.starts().find((a) => a.includes('--acp'))!
    expect(argv).toEqual(['--acp', '--skip-trust'])
    const methods = fake.stdinLines().map((m) => (m as { method?: string }).method)
    expect(methods).toEqual(['initialize', 'session/new'])
  })

  it('not signed in: session/new answers authRequired; auth fails with the sign-in command, plan is not known', async () => {
    const setup = await fakeSetup()
    const frames = [
      ...opening({ sessionNew: false }),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      outErr(2, { code: -32000, message: 'Authentication required' }),
    ]
    const fake = fakeGemini(setup, acpScenario(handshake(frames)))
    const probe = await fake.adapter.probe()
    expectNoMismatch(fake.logEntries())
    const auth = probe.checks.find((c) => c.id === 'vendor.gemini.auth')!
    expect(auth).toMatchObject({ status: 'fail', blocking: true, category: 'auth_required' })
    expect(auth.recovery[0]).toMatchObject({ kind: 'shell_copy', command: 'gemini' })
    expect(probe.checks.find((c) => c.id === 'vendor.gemini.protocol')?.status).toBe('pass')
    expect(probe.checks.find((c) => c.id === 'vendor.gemini.plan')?.status).toBe('skip')
    expect(probe.capabilities.planMode).toBe('emulated')
    expect(probe.ok).toBe(false)
    // No model list from Gemini: the -m aliases.
    expect(probe.models.map((m) => m.id)).toEqual(['auto', 'pro', 'flash', 'flash-lite'])
    expect(probe.capabilities.modelList).toBe('static')
  })

  it('an OAuth sign-in is seen by the file existing (its content is never read or shown)', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake()))
    mkdirSync(join(fake.home, '.gemini'), { recursive: true })
    writeFileSync(join(fake.home, '.gemini', 'oauth_creds.json'), '{"access_token":"SECRET-TOKEN-VALUE"}')
    const probe = await fake.adapter.probe()
    const auth = probe.checks.find((c) => c.id === 'vendor.gemini.auth')!
    expect(auth).toMatchObject({ status: 'pass', detail: 'Gemini signs in with a Google sign-in.' })
    expect(JSON.stringify(probe)).not.toContain('SECRET-TOKEN-VALUE')
  })

  it('a Gemini whose --help lacks --acp fails vendor.gemini.version (flag_drift)', async () => {
    const setup = await fakeSetup()
    const help = HELP_TEXT.filter((l) => !l.includes('--acp'))
    const fake = fakeGemini(
      setup,
      scenario([{ match: { argvIncludes: ['--acp'] }, script: handshake(), repeat: true }], { help }),
    )
    const probe = await fake.adapter.probe()
    expect(probe.checks.find((c) => c.id === 'vendor.gemini.version')).toMatchObject({
      status: 'fail',
      category: 'flag_drift',
    })
    expect(probe.ok).toBe(false)
  })

  it('a Gemini older than 0.62.0 works with a warning', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake(), [], { version: '0.60.1' }))
    const probe = await fake.adapter.probe()
    expect(probe.checks.find((c) => c.id === 'vendor.gemini.version')).toMatchObject({
      status: 'warn',
      title: 'Gemini 0.60.1 works; 0.62.0 is recommended',
    })
  })

  it('a probe folder outside DIM_FACTORY_HOME is not Dim Factory-owned: no --skip-trust there', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake()), {
      adapter: { probeCwd: tempDir('gemini-user-probe-') },
      vendorEnv: { GEMINI_API_KEY: 'k' },
    })
    await fake.adapter.probe()
    expect(fake.starts().find((a) => a.includes('--acp'))).toEqual(['--acp'])
  })

  it("a pass's session answer is cached: modes and models named after the probe ran without a sign-in", async () => {
    const setup = await fakeSetup()
    const unsigned = handshake([
      ...opening({ sessionNew: false }),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      outErr(2, { code: -32000, message: 'Authentication required' }),
    ])
    const pass = recording({ scenario: 'pass' }, [
      ...opening(),
      inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'autoEdit' }),
      outRes(3, {}),
      inReq(4, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'Go.' }] }),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(
      setup,
      scenario([
        { match: { argvIncludes: ['--acp'] }, script: unsigned },
        { match: { argvIncludes: ['--acp'] }, script: pass },
      ]),
      // The scenario's entries are taken in order across processes.
      { vendorEnv: { FAKE_CLI_STATE: join(tempDir('gemini-state-'), 'state') } },
    )
    const probe = await fake.adapter.probe()
    expect(probe.capabilities.planMode).toBe('emulated')
    expect(fake.adapter.facts()).toMatchObject({ plan: false })
    expect(fake.adapter.facts().modes).toBeUndefined()
    const h = fake.adapter.start({
      runId: 'run-cache',
      step: 'implement',
      cwd: tempDir('gemini-cwd-'),
      prompt: 'Go.',
      mode: 'autoedit',
      planNative: false,
      allowRules: [],
      askTimeoutMs: 600_000,
      trustFolder: true,
    })
    await h.exited
    expectNoMismatch(fake.logEntries())
    expect(fake.adapter.facts()).toMatchObject({ modes: MODES.availableModes.map((m) => m.id), plan: true })
    expect(
      fake.adapter.support({ pass: 'plan', mode: 'readonly', planNative: true, trustFolder: false }).copy,
    ).toMatch(/own plan mode/)
    // listModels reads the cache (the probe is not run again).
    expect((await fake.adapter.listModels()).map((m) => [m.id, m.source])).toEqual([
      ['gemini-3-pro-preview', 'cli'],
      ['gemini-3-flash-preview', 'cli'],
    ])
    expect(fake.starts().filter((a) => a.includes('--acp'))).toHaveLength(2)
  })

  it('no Gemini installed: vendor.gemini.bin fails with the install command', async () => {
    const fake = fakeGemini(await fakeSetup(), tempDir(), {
      adapter: { configuredPath: join(tempDir(), 'gemini.cmd'), search: 'configured' },
    })
    const probe = await fake.adapter.probe()
    expect(probe.checks).toHaveLength(1)
    expect(probe.checks[0]).toMatchObject({
      id: 'vendor.gemini.bin',
      status: 'fail',
      category: 'cli_missing',
    })
    expect(probe.checks[0]!.recovery[0]).toMatchObject({
      kind: 'shell_copy',
      command: 'npm install -g @google/gemini-cli@latest',
    })
  })
})

describe('Gemini readiness, canResume and support', () => {
  it('readiness `trust`: a user folder without the grant fails with a grant vendorFolder action', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake()))
    const folder = tempDir('gemini-folder-')
    const need = {
      pass: 'implement' as const,
      mode: 'autoedit' as const,
      planNative: false,
      trustFolder: false,
    }
    const checks = await fake.adapter.readiness(folder, need)
    const trust = checks.find((c) => c.id === 'pass.implement.readiness.trust')!
    expect(trust).toMatchObject({ status: 'fail', blocking: true, category: 'trust_required' })
    expect(trust.recovery).toEqual([
      expect.objectContaining({ kind: 'grant', grant: 'vendorFolder', vendor: 'gemini' }),
    ])
    const granted = await fake.adapter.readiness(folder, { ...need, trustFolder: true })
    expect(granted.find((c) => c.id === 'pass.implement.readiness.trust')?.status).toBe('pass')
    const owned = join(fake.dimFactoryHome, 'tmp', 'heal', 'x')
    mkdirSync(owned, { recursive: true })
    const own = await fake.adapter.readiness(owned, { ...need, pass: 'review', mode: 'readonly' })
    expect(own.find((c) => c.id === 'pass.review.readiness.trust')?.status).toBe('pass')
    expect(checks.find((c) => c.id === 'pass.implement.readiness.mode')).toMatchObject({
      status: 'pass',
      detail: 'Edits auto; shell and other tools ask you.',
    })
  })

  it('canResume: needs session/load or resume from the probe, and a chats file when Gemini keeps them', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(handshake()), {
      adapter: { initialFacts: { loadSession: false } },
    })
    const cwd = tempDir('gemini-cwd-')
    expect(await fake.adapter.canResume(SESSION, cwd)).toEqual({ ok: false, reason: 'cannot-resume' })
    await fake.adapter.probe()
    // No chats folder at all: Dim Factory cannot tell, session/load decides.
    expect(await fake.adapter.canResume(SESSION, cwd)).toEqual({ ok: true })
    const chats = join(fake.home, '.gemini', 'tmp', 'project-1', 'chats')
    mkdirSync(chats, { recursive: true })
    writeFileSync(join(chats, `session-2026-10-10T11-00-${SESSION.slice(0, 8)}.json`), '{}')
    expect(await fake.adapter.canResume(SESSION, cwd)).toEqual({ ok: true })
    expect(await fake.adapter.canResume('0a0b0c0d-0000-4000-8000-000000000000', cwd)).toEqual({
      ok: false,
      reason: 'cannot-resume',
    })
    const ready = await fake.adapter.readiness(cwd, {
      pass: 'fix',
      mode: 'autoedit',
      planNative: false,
      trustFolder: true,
      resumeSessionId: SESSION,
    })
    expect(ready.find((c) => c.id === 'pass.fix.readiness.resume')?.status).toBe('pass')
  })

  it('support(): the mode table copy, and a mode the agent does not offer is unsupported', async () => {
    const setup = await fakeSetup()
    const frames = [
      ...opening({ sessionNew: false }),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      {
        t: 0,
        dir: 'out',
        line: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            sessionId: SESSION,
            modes: {
              ...MODES,
              availableModes: MODES.availableModes.filter((m) => m.id !== 'yolo' && m.id !== 'plan'),
            },
            models: MODELS,
          },
        }),
      },
    ]
    const fake = fakeGemini(setup, acpScenario(handshake(frames)))
    await fake.adapter.probe()
    const need = (mode: 'readonly' | 'autoedit' | 'full') => ({
      pass: 'implement' as const,
      mode,
      planNative: false,
      trustFolder: false,
    })
    expect(fake.adapter.support(need('autoedit'))).toEqual({
      status: 'supported',
      copy: 'Edits auto; shell and other tools ask you.',
    })
    expect(fake.adapter.support(need('full'))).toMatchObject({
      status: 'unsupported',
      reason: 'mode-missing',
    })
    // No plan mode: the Plan pass runs emulated (the readonly copy).
    expect(
      fake.adapter.support({ pass: 'plan', mode: 'readonly', planNative: true, trustFolder: false }).copy,
    ).toMatch(/^Reads and searches only/)
    expect(fake.adapter.facts().plan).toBe(false)
  })
})
