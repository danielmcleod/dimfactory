// The Grok configuration of the ACP base (`grok agent stdio` with
// GROK_DISABLE_AUTOUPDATER=1; the Grok ACP mode row: readonly = every ask rejected, autoedit unsupported until
// GR03, full = `_meta.yoloMode:true` from Auto only, plan emulated; the Grok probe checks), its flags, its
// version line, its sign-in check, its session store and its registration under "More".
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpExtraArgsProblem, acpFlagMapProblem } from '@core/adapters/acp-base/launch.ts'
import { acpCapabilities, acpSupport } from '@core/adapters/acp-base/probe.ts'
import { defaultAcpFacts } from '@core/adapters/acp-base/index.ts'
import { grokAccount, grokAuthCheck } from '@core/adapters/grok/auth.ts'
import { grokWellKnown, parseGrokVersion } from '@core/adapters/grok/cli-spec.ts'
import {
  GROK_AUTOEDIT_SUPPORTED,
  GROK_COPY,
  TESTED_UP_TO,
  VERSION_FLOOR,
  VERSION_RECOMMENDED,
  grokConfig,
} from '@core/adapters/grok/config.ts'
import { grokSessionExists } from '@core/adapters/grok/home.ts'
import { adapterRegistry } from '@core/adapters/registry.ts'
import { vendorArgsCheck } from '@core/adapters/vendor-args.ts'
import '@core/adapters/grok/index.ts'
import type { AcpHandshake } from '@core/adapters/acp-base/config.ts'
import type { ReadinessNeed } from '@shared/vendors.ts'

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const cli = { command: 'C:/Users/u/.grok/bin/grok.exe', prefixArgs: [], version: '1.0.50' }
const launch = (o: Partial<Parameters<typeof grokConfig.resolveLaunch>[0]> = {}) =>
  grokConfig.resolveLaunch({ cli, trust: false, env: { PATH: 'x' }, purpose: 'pass', ...o })
const need = (o: Partial<ReadinessNeed> = {}): ReadinessNeed => ({
  pass: 'implement',
  mode: 'readonly',
  planNative: false,
  trustFolder: false,
  ...o,
})

describe('launch: grok agent [--model m] --no-leader stdio', () => {
  it('a native binary, no shell, the prompt never in argv, extraArgs before stdio', () => {
    expect(launch()).toEqual({
      exe: cli.command,
      args: ['agent', '--no-leader', 'stdio'],
      env: { PATH: 'x', GROK_DISABLE_AUTOUPDATER: '1' },
    })
    expect(launch({ model: 'grok-4.6', extraArgs: ['--agent-profile', 'p.json'] }).args).toEqual([
      'agent',
      '--model',
      'grok-4.6',
      '--no-leader',
      '--agent-profile',
      'p.json',
      'stdio',
    ])
    // user guide 15: "Agent options ... go after `agent` but before the mode name": the transport is always last.
    expect(launch({ extraArgs: ['--sandbox', 'strict'] }).args.at(-1)).toBe('stdio')
    // A null or empty model is the CLI's own default; the trust input changes nothing (Grok needs no folder grant).
    expect(launch({ model: null, trust: true }).args).toEqual(['agent', '--no-leader', 'stdio'])
    expect(grokConfig.trustFlag).toBeUndefined()
  })

  it('GROK_DISABLE_AUTOUPDATER=1 always; the folder-trust and sandbox auto-allow switches never reach Grok', () => {
    const { env } = launch({
      env: {
        GROK_DISABLE_AUTOUPDATER: '0',
        grok_disable_autoupdater: 'false',
        GROK_FOLDER_TRUST: '0',
        Grok_Folder_Trust: '0',
        GROK_SANDBOX_AUTO_ALLOW_BASH: '1',
        XAI_API_KEY: 'k',
        GROK_HOME: '/h',
      },
    })
    expect(env).toEqual({ GROK_DISABLE_AUTOUPDATER: '1', XAI_API_KEY: 'k', GROK_HOME: '/h' })
  })

  it('flagMap renames a managed flag (the user fixes a renamed --no-leader)', () => {
    expect(launch({ flagMap: { '--no-leader': '--local-agent' } }).args).toEqual([
      'agent',
      '--local-agent',
      'stdio',
    ])
  })
})

describe('flags the user may not set', () => {
  it.each([
    [['--always-approve'], /widens/],
    [['--yolo'], /widens/],
    [['--permission-mode', 'bypassPermissions'], /widens/],
    [['--permission-mode=auto'], /widens/],
    [['--allow', 'Bash(*)'], /widens/],
    [['--trust'], /widens/],
    [['--leader'], /widens/],
    [['-w'], /widens/],
    [['--dangerously-skip-permissions'], /widens/],
    [['--model', 'x'], /manages/],
    [['-m', 'x'], /manages/],
    [['--no-leader'], /manages/],
    [['--reauth'], /manages/],
    [['-p', 'hello'], /manages/],
    [['--prompt-file', 'x.md'], /manages/],
    [['--session-id', 'x'], /manages/],
    [['--resume', 'x'], /manages/],
    [['-vw'], /combine -w/],
    [['-xm'], /combine -m/],
    [['serve'], /flags only/],
  ] as const)('%j', (extraArgs, problem) => {
    expect(acpExtraArgsProblem(grokConfig, extraArgs)).toMatch(problem)
    // The recovery guard (a heal's config_patch) applies the same rules to Grok.
    expect(vendorArgsCheck('grok', { extraArgs: [...extraArgs], flagMap: {} })).toMatch(problem)
  })

  it('narrowing or neutral flags pass', () => {
    for (const extraArgs of [
      ['--deny', 'Bash(rm *)'],
      ['--sandbox', 'strict'],
      ['--agent-profile', 'p.json'],
    ])
      expect(acpExtraArgsProblem(grokConfig, extraArgs)).toBeUndefined()
  })

  it('flagMap: only a managed flag, to a long flag Grok does not use and that widens nothing', () => {
    expect(acpFlagMapProblem(grokConfig, { '--no-leader': '--local' })).toBeUndefined()
    expect(acpFlagMapProblem(grokConfig, { '--no-leader': '--always-approve' })).toMatch(/widens/)
    expect(acpFlagMapProblem(grokConfig, { '--model': '--sandbox' })).toMatch(/already uses/)
    expect(acpFlagMapProblem(grokConfig, { '--sandbox': '--box' })).toMatch(/not a flag Dim Factory manages/)
  })
})

describe('the mode table (Grok ACP; support() is the only source of mode copy)', () => {
  const facts = defaultAcpFacts(grokConfig)

  it('readonly asks for everything and the adapter rejects every ask; the posture is session/new _meta', () => {
    expect(grokConfig.modes.readonly).toMatchObject({
      acpMode: null,
      meta: { yoloMode: false, autoMode: false },
    })
    expect(acpSupport(grokConfig, need({ pass: 'review' }), facts)).toEqual({
      status: 'supported',
      copy: GROK_COPY.readonly,
    })
  })

  it('autoedit is unsupported until GR03 (synthesized), with the honest copy', () => {
    expect(GROK_AUTOEDIT_SUPPORTED).toBe(false)
    // No reason code beside the copy (it would show in the composer as "(mode-unsupported)").
    expect(acpSupport(grokConfig, need({ mode: 'autoedit' }), facts)).toEqual({
      status: 'unsupported',
      copy: GROK_COPY.autoedit,
    })
    expect(GROK_COPY.autoedit).toMatch(/^Not supported until Dim Factory has seen it work/)
  })

  it('full is always-approve for the session (`_meta.yoloMode: true`), never the --always-approve flag', () => {
    expect(grokConfig.modes.full).toMatchObject({ acpMode: null, meta: { yoloMode: true } })
    expect(acpSupport(grokConfig, need({ mode: 'full' }), facts).status).toBe('supported')
    expect(launch().args).not.toContain('--always-approve')
  })

  it('plan is emulated: a native Plan asked for runs read-only with the template', () => {
    expect(grokConfig.planMode).toBe('emulated')
    expect(grokConfig.plan).toBeUndefined()
    expect(acpSupport(grokConfig, need({ pass: 'plan', mode: 'autoedit', planNative: true }), facts)).toEqual(
      {
        status: 'supported',
        copy: GROK_COPY.readonly,
      },
    )
    expect(acpCapabilities(grokConfig, facts, 0).planMode).toBe('emulated')
  })

  it('no mode copy has an em dash; no mode sends set_mode (Grok has no ACP mode switch)', () => {
    for (const copy of Object.values(GROK_COPY)) expect(copy).not.toContain('\u2014')
    for (const spec of Object.values(grokConfig.modes)) expect(spec.acpMode).toBeNull()
  })

  it('allow-session is never Grok\'s per-project "Always allow"; options that widen the session are refused by name', () => {
    expect(grokConfig.optionPrefs.allowSession).toEqual([])
    const name = grokConfig.optionPrefs.forbiddenName!
    for (const n of [
      'Enable always-approve mode',
      'Always approve',
      'Allow all edits this session',
      'Switch to auto mode',
      'YOLO',
      'Bypass permissions',
    ])
      expect(name.test(n), n).toBe(true)
    for (const n of ['Allow once', 'Reject once', 'Always allow `npm test` in this project'])
      expect(name.test(n), n).toBe(false)
  })
})

describe('version (no tested version: "record")', () => {
  it('no floor, no recommended version, nothing tested live yet', () => {
    expect([VERSION_FLOOR, VERSION_RECOMMENDED, TESTED_UP_TO]).toEqual(['', '', ''])
  })

  it.each([
    ['grok 1.0.50 (3f9c2ab) stable', '1.0.50'],
    ['grok 1.1.0-beta.2 (abc) beta\n', '1.1.0-beta.2'],
    ['warning: something\ngrok 1.0.9', '1.0.9'],
    ['xai-grok-pager 1.0.12 (c0ffee)', '1.0.12'],
  ])('%j → %s', (stdout, version) => {
    expect(parseGrokVersion(stdout)).toEqual({ version })
  })

  it.each(['0.0.34', 'v1.2.3', 'grok-cli 1.0.0', 'Grok CLI version 1.0.0', ''])(
    'not Grok Build: %j',
    (stdout) => {
      expect(parseGrokVersion(stdout)).toBeNull()
    },
  )

  it("well-known: the installers' ~/.grok/bin, and ~/.local/bin on POSIX", () => {
    expect(grokWellKnown({ platform: 'win32', home: 'C:\\Users\\u' })).toEqual([
      'C:\\Users\\u\\.grok\\bin\\grok.exe',
    ])
    expect(grokWellKnown({ platform: 'linux', home: '/home/u' })).toEqual([
      '/home/u/.grok/bin/grok',
      '/home/u/.local/bin/grok',
    ])
  })
})

describe('vendor.grok.auth (XAI_API_KEY, the cached sign-in by existence, or ACP authRequired on Test)', () => {
  const handshake = (o: Partial<AcpHandshake> = {}): AcpHandshake => ({
    ok: true,
    ms: 5,
    loadSession: true,
    resume: true,
    authRequired: false,
    models: [],
    stderr: [],
    ...o,
  })
  const home = temp('grok-auth-home-')
  const grokHome = join(home, 'gh')
  mkdirSync(grokHome, { recursive: true })

  it('XAI_API_KEY (or the legacy GROK_CODE_XAI_API_KEY): signed in, billed per token', () => {
    for (const key of ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) {
      const o = { env: { [key]: 'xai-not-real', GROK_HOME: grokHome }, home, handshake: undefined, at: 1 }
      const c = grokAuthCheck(o)
      expect(c).toMatchObject({ id: 'vendor.grok.auth', status: 'pass' })
      expect(JSON.stringify(c)).not.toContain('xai-not-real')
      expect(grokAccount(o)).toEqual({ method: 'api-key' })
    }
  })

  it('nothing Dim Factory can see: warns, not fails, with `grok login` to copy (never run) and Claude', () => {
    // Grok also signs in with a per-model api_key / env_key in its config.toml (user guide 02), which Dim Factory never
    // reads: the launch probe cannot tell, so Test (session/new) decides.
    const c = grokAuthCheck({ env: { GROK_HOME: grokHome }, home, handshake: undefined, at: 1 })
    expect(c).toMatchObject({ status: 'warn', blocking: false, category: 'auth_required' })
    expect(c.detail).toMatch(/Press Test/)
    // A Test whose session/new failed for another reason cannot tell either.
    expect(
      grokAuthCheck({
        env: { GROK_HOME: grokHome },
        home,
        handshake: handshake({ sessionOk: false }),
        at: 1,
      }).status,
    ).toBe('warn')
    expect(c.recovery).toMatchObject([
      { kind: 'shell_copy', command: 'grok login', recheck: 'vendor.grok.auth' },
      { kind: 'switch_vendor', to: 'claude' },
    ])
    expect(c.detail).not.toContain('\u2014')
  })

  it('the cached sign-in counts by its existence alone; Test overrides: authRequired fails, a session passes', () => {
    const signedIn = join(home, 'signed-in')
    mkdirSync(signedIn)
    writeFileSync(join(signedIn, 'auth.json'), '{}')
    const env = { GROK_HOME: signedIn }
    expect(grokAuthCheck({ env, home, handshake: undefined, at: 1 }).status).toBe('pass')
    expect(grokAccount({ env, home, handshake: undefined, at: 1 })).toBeUndefined()
    expect(
      grokAuthCheck({ env, home, handshake: handshake({ authRequired: true, sessionOk: false }), at: 1 }),
    ).toMatchObject({ status: 'fail', category: 'auth_required' })
    expect(
      grokAuthCheck({ env: { GROK_HOME: grokHome }, home, handshake: handshake({ sessionOk: true }), at: 1 })
        .status,
    ).toBe('pass')
  })
})

describe('canResume: the session store, by folder names', () => {
  it('a session folder under GROK_HOME/sessions/<group>/<id>', () => {
    const grokHome = temp('grok-sessions-')
    const id = '0199d2a4-7c1e-7a3b-9f20-3c4d5e6f7001'
    const o = { sessionId: id, env: { GROK_HOME: grokHome }, home: grokHome }
    expect(grokSessionExists(o)).toBeUndefined()
    mkdirSync(join(grokHome, 'sessions', 'slug-1a2b3c'), { recursive: true })
    expect(grokSessionExists(o)).toBe(false)
    mkdirSync(join(grokHome, 'sessions', 'slug-1a2b3c', id.toUpperCase()))
    expect(grokSessionExists(o)).toBe(true)
    expect(grokSessionExists({ ...o, sessionId: '../../etc' })).toBe(false)
  })
})

describe('registration (Grok under "More", not Experimental)', () => {
  it('grok/index.ts replaces the registry stub with the built adapter', () => {
    const entry = adapterRegistry.list().find((e) => e.id === 'grok')
    expect(entry).toMatchObject({ built: true, section: 'more', experimental: false })
    expect(entry?.adapter.transport).toBe('acp')
    expect(entry?.adapter.displayName).toBe('Grok')
    expect(adapterRegistry.primary().map((e) => e.id)).toEqual(['claude', 'codex'])
  })
})
