// The Gemini configuration on the ACP base (launch, modes, optionPrefs, exit codes; the Gemini ACP mode row; the
// Gemini column of the probe checks; Readiness `trust`), checked without a process.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAcpFacts } from '../../../../src/core/adapters/acp-base/index.ts'
import { acpExtraArgsProblem, acpFlagMapProblem } from '../../../../src/core/adapters/acp-base/launch.ts'
import {
  acpCapabilities,
  acpSupport,
  helpHasFlag,
  planCheck,
  versionCheck,
} from '../../../../src/core/adapters/acp-base/probe.ts'
import { MODEL_ID, effectiveMode, targetModeOf } from '../../../../src/core/adapters/acp-base/run.ts'
import { folderTrust, isDimFactoryOwnedCwd } from '../../../../src/core/adapters/acp-base/trust.ts'
import { geminiAuthCheck, geminiAuthSource } from '../../../../src/core/adapters/gemini/auth.ts'
import { parseGeminiVersion } from '../../../../src/core/adapters/gemini/cli-spec.ts'
import { GEMINI_COPY, geminiConfig } from '../../../../src/core/adapters/gemini/config.ts'
import { geminiDir, geminiSessionExists } from '../../../../src/core/adapters/gemini/home.ts'
import {
  GEMINI_MODE_UPDATE,
  GEMINI_PLAN_EXIT_TITLE,
  geminiExplanationDir,
  geminiMetaUsage,
  geminiShellRequest,
} from '../../../../src/core/adapters/gemini/wire.ts'
import { classifyDetailed } from '../../../../src/core/heal/classify.ts'
import { acpRpcMatch } from '../../../../src/core/heal/signals/acp-gemini.ts'
import type { ReadinessNeed } from '../../../../src/shared/vendors.ts'

const tmp = (p = 'gemini-unit-'): string => mkdtempSync(join(tmpdir(), p))
const cli = { command: '/usr/bin/node', prefixArgs: ['/npm/gemini/bundle/gemini.js'], version: '0.62.0' }
const need = (o: Partial<ReadinessNeed> = {}): ReadinessNeed => ({
  pass: 'implement',
  mode: 'autoedit',
  planNative: false,
  trustFolder: false,
  ...o,
})

describe('launch (gemini --acp [-m], --skip-trust only with a grant, node <entry>, extraArgs last)', () => {
  const launch = (o: Partial<Parameters<typeof geminiConfig.resolveLaunch>[0]> = {}) =>
    geminiConfig.resolveLaunch({ cli, trust: false, env: { PATH: '/bin' }, purpose: 'pass', ...o })

  it('runs system node with the npm entry, --acp first, never a prompt', () => {
    expect(launch()).toEqual({
      exe: '/usr/bin/node',
      args: ['/npm/gemini/bundle/gemini.js', '--acp'],
      env: { PATH: '/bin' },
    })
  })

  it('--skip-trust only when the folder may skip trust; -m with a model; extraArgs at the end', () => {
    expect(launch({ trust: true, model: 'gemini-3-pro-preview', extraArgs: ['--debug'] }).args).toEqual([
      '/npm/gemini/bundle/gemini.js',
      '--acp',
      '-m',
      'gemini-3-pro-preview',
      '--skip-trust',
      '--debug',
    ])
    expect(launch({ model: null }).args).not.toContain('-m')
  })

  it("Gemini's trust env twin never reaches the child: --skip-trust is the only way a folder is trusted", () => {
    for (const trust of [false, true]) {
      const l = launch({
        trust,
        env: { PATH: '/bin', GEMINI_CLI_TRUST_WORKSPACE: 'true', gemini_cli_trust_workspace: '1' },
      })
      expect(l.env).toEqual({ PATH: '/bin' })
      expect(l.args.includes('--skip-trust')).toBe(trust)
    }
  })

  it('flagMap renames a managed flag (heal: a renamed --acp)', () => {
    expect(launch({ trust: true, flagMap: { '--skip-trust': '--trust-workspace' } }).args).toContain(
      '--trust-workspace',
    )
    expect(acpFlagMapProblem(geminiConfig, { '--skip-trust': '--trust-workspace' })).toBeUndefined()
    expect(acpFlagMapProblem(geminiConfig, { '--acp': '--yolo' })).toMatch(/widens/)
    expect(acpFlagMapProblem(geminiConfig, { '--acp': '--model' })).toMatch(/manages/)
    expect(acpFlagMapProblem(geminiConfig, { '--acp': '--sandbox' })).toMatch(/already uses/)
    expect(acpFlagMapProblem(geminiConfig, { '--debug': '--x' })).toMatch(/not a flag Dim Factory manages/)
  })

  it('extraArgs: flags only; never a managed flag, never one that widens a pass, never a prompt', () => {
    expect(acpExtraArgsProblem(geminiConfig, ['--debug', '--proxy', 'http://p:8080'])).toBeUndefined()
    expect(acpExtraArgsProblem(geminiConfig, ['--skip-trust'])).toMatch(/manages/)
    expect(acpExtraArgsProblem(geminiConfig, ['-m', 'x'])).toMatch(/manages/)
    for (const f of [
      '--yolo',
      '-y',
      '--approval-mode=yolo',
      '--include-directories',
      '--policy',
      '--allowed-tools',
    ])
      expect(acpExtraArgsProblem(geminiConfig, [f]), f).toMatch(/widens/)
    expect(acpExtraArgsProblem(geminiConfig, ['write me a poem'])).toMatch(/flags only/)
    expect(acpExtraArgsProblem(geminiConfig, ['--debug', 'a', 'b'])).toMatch(/flags only/)
    expect(acpExtraArgsProblem(geminiConfig, ['--x\ny'])).toMatch(/newline/)
  })

  it('a combined short flag is read letter by letter (-dy is --debug --yolo)', () => {
    // yargs reads `-dy` as `-d -y`: a forbidden or managed letter anywhere in it is refused (combined short flags).
    for (const f of ['-dy', '-yd', '-dw'])
      expect(acpExtraArgsProblem(geminiConfig, [f]), f).toMatch(/combine -[yw] .*widens/)
    for (const f of ['-dm', '-dp', '-di', '-dr', '-do', '-m=x'])
      expect(acpExtraArgsProblem(geminiConfig, [f]), f).toMatch(/combine -[mpiro] .*manages/)
    // Letters Dim Factory neither manages nor forbids stay allowed, alone or combined.
    expect(acpExtraArgsProblem(geminiConfig, ['-d'])).toBeUndefined()
    expect(acpExtraArgsProblem(geminiConfig, ['-ds'])).toBeUndefined()
    expect(acpExtraArgsProblem(geminiConfig, ['--debug', '--sandbox'])).toBeUndefined()
    // A flagMap target is a long flag only, so a cluster can never be one.
    expect(acpFlagMapProblem(geminiConfig, { '--skip-trust': '-dy' })).toMatch(/not a long flag/)
  })

  it('a model that would read as a flag is never passed', () => {
    expect(MODEL_ID.test('gemini-3-pro-preview')).toBe(true)
    expect(MODEL_ID.test('models/gemini-2.5-flash')).toBe(true)
    for (const bad of ['--yolo', '-y', 'a b', '', 'x\ny']) expect(MODEL_ID.test(bad), bad).toBe(false)
  })
})

describe('modes (the Gemini ACP mode row)', () => {
  const facts = defaultAcpFacts(geminiConfig, {
    probed: true,
    loadSession: true,
    modes: ['default', 'autoEdit', 'yolo', 'plan'],
  })

  it('readonly → default, autoedit → autoEdit, full → yolo, native plan → plan; read-only steps run default', () => {
    expect(targetModeOf(geminiConfig, { step: 'review', mode: 'readonly' }, false)).toBe('default')
    expect(targetModeOf(geminiConfig, { step: 'implement', mode: 'autoedit' }, false)).toBe('autoEdit')
    expect(targetModeOf(geminiConfig, { step: 'implement', mode: 'full' }, false)).toBe('yolo')
    expect(targetModeOf(geminiConfig, { step: 'plan', mode: 'readonly' }, true)).toBe('plan')
    expect(targetModeOf(geminiConfig, { step: 'critic', mode: 'full' }, false)).toBe('default')
    expect(effectiveMode('heal', 'autoedit')).toBe('readonly')
  })

  it('support() copy: the agreed words, plain, no em dashes', () => {
    expect(acpSupport(geminiConfig, need({ mode: 'autoedit' }), facts)).toEqual({
      status: 'supported',
      copy: 'Edits auto; shell and other tools ask you.',
    })
    expect(acpSupport(geminiConfig, need({ pass: 'review', mode: 'readonly' }), facts).copy).toBe(
      GEMINI_COPY.readonly,
    )
    expect(acpSupport(geminiConfig, need({ mode: 'full' }), facts).copy).toBe(GEMINI_COPY.full)
    expect(
      acpSupport(geminiConfig, need({ pass: 'plan', mode: 'readonly', planNative: true }), facts).copy,
    ).toBe(GEMINI_COPY.plan)
    for (const c of Object.values(GEMINI_COPY)) expect(c).not.toMatch(/—/)
  })

  it('a mode the probe did not see is unsupported (flag drift), plan falls back without plan mode', () => {
    const noYolo = { ...facts, modes: ['default', 'autoEdit'], plan: false }
    expect(acpSupport(geminiConfig, need({ mode: 'full' }), noYolo)).toMatchObject({
      status: 'unsupported',
      reason: 'mode-missing',
    })
    expect(
      acpSupport(geminiConfig, need({ pass: 'plan', mode: 'readonly', planNative: true }), noYolo).copy,
    ).toBe(GEMINI_COPY.readonly)
    expect(acpCapabilities(geminiConfig, noYolo, 0).planMode).toBe('emulated')
  })

  it('capabilities: native plan, ACP relay, resume by load, vendor-assigned session id, no web', () => {
    expect(acpCapabilities(geminiConfig, facts, 2)).toMatchObject({
      planMode: 'native',
      askRelay: true,
      resume: 'load',
      preassignSessionId: false,
      modelList: 'cli',
      usageCumulative: false,
      allowSession: 'native',
      web: false,
      reasoningIncludedInOutput: false,
    })
    expect(acpCapabilities(geminiConfig, { ...facts, loadSession: false, resume: false }, 0).resume).toBe(
      'none',
    )
    // An agent that advertises session/resume continues by id (no replay to drop).
    expect(acpCapabilities(geminiConfig, { ...facts, loadSession: false, resume: true }, 0).resume).toBe('id')
  })

  it('optionPrefs: allow-session prefers the tool, then the session, then the server; never the saving one', () => {
    expect(geminiConfig.optionPrefs.allowSession).toEqual([
      'proceed_always_tool',
      'proceed_always',
      'proceed_always_server',
    ])
    expect(geminiConfig.optionPrefs.forbidden).toEqual(['proceed_always_and_save'])
  })
})

describe('probe pieces', () => {
  it('parses the bare version Gemini prints', () => {
    expect(parseGeminiVersion('0.62.0\n')).toEqual({ version: '0.62.0' })
    expect(parseGeminiVersion('Warning: something\n0.64.0-nightly.20261001\n')).toEqual({
      version: '0.64.0-nightly.20261001',
    })
    expect(parseGeminiVersion('codex-cli 0.160.1')).toBeNull()
  })

  it('version: --help must list --acp (fail, flag_drift); no --skip-trust warns; below 0.62.0 warns', () => {
    const help = (t: string) => ({ text: t })
    expect(versionCheck(geminiConfig, '0.62.0', help('  --acp  ACP\n  --skip-trust  x'), 1)).toMatchObject({
      status: 'pass',
    })
    expect(versionCheck(geminiConfig, '0.62.0', help('  --experimental-acp  old'), 1)).toMatchObject({
      status: 'fail',
      category: 'flag_drift',
    })
    expect(versionCheck(geminiConfig, '0.62.0', help('  --acp  ACP'), 1)).toMatchObject({ status: 'warn' })
    expect(versionCheck(geminiConfig, '0.61.9', help('  --acp\n  --skip-trust'), 1)).toMatchObject({
      status: 'warn',
    })
    expect(versionCheck(geminiConfig, '0.70.0', help('  --acp\n  --skip-trust'), 1)).toMatchObject({
      status: 'warn',
      title: 'Gemini 0.70.0 is newer than tested (0.64.0)',
    })
    expect(helpHasFlag('--acp-like', '--acp')).toBe(false)
    expect(helpHasFlag('      --acp   Starts', '--acp')).toBe(true)
  })

  it('plan: native when plan ∈ availableModes', () => {
    expect(
      planCheck(
        geminiConfig,
        { probed: true, loadSession: true, resume: false, modes: ['plan'], plan: true },
        1,
      ).status,
    ).toBe('pass')
    expect(
      planCheck(
        geminiConfig,
        { probed: true, loadSession: true, resume: false, modes: ['default'], plan: false },
        1,
      ).status,
    ).toBe('skip')
  })

  it('auth: GEMINI_API_KEY, Vertex env, GCA, or oauth_creds.json existing; authRequired overrides', () => {
    const home = tmp()
    const base = { home, handshake: undefined, at: 1 }
    expect(geminiAuthSource({}, home)).toBeUndefined()
    expect(geminiAuthCheck({ ...base, env: {} })).toMatchObject({ status: 'fail', category: 'auth_required' })
    expect(geminiAuthCheck({ ...base, env: { GEMINI_API_KEY: 'k' } }).status).toBe('pass')
    expect(geminiAuthSource({ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'p' }, home)).toBe(
      'Vertex AI',
    )
    expect(geminiAuthSource({ GOOGLE_GENAI_USE_VERTEXAI: 'true' }, home)).toBeUndefined()
    expect(geminiAuthSource({ GOOGLE_GENAI_USE_GCA: '1' }, home)).toBe('Google Code Assist')
    mkdirSync(join(home, '.gemini'))
    writeFileSync(join(home, '.gemini', 'oauth_creds.json'), 'SECRET')
    expect(geminiAuthCheck({ ...base, env: {} })).toMatchObject({
      status: 'pass',
      detail: 'Gemini signs in with a Google sign-in.',
    })
    const required = geminiAuthCheck({
      ...base,
      env: {},
      handshake: {
        ok: true,
        ms: 1,
        loadSession: true,
        resume: false,
        authRequired: true,
        sessionOk: false,
        models: [],
        stderr: [],
      },
    })
    expect(required).toMatchObject({ status: 'fail', category: 'auth_required' })
    expect(JSON.stringify(required)).not.toContain('SECRET')
    // GEMINI_CLI_HOME replaces the home folder.
    expect(geminiDir({ GEMINI_CLI_HOME: '/alt' }, '/home/u')).toBe(join('/alt', '.gemini'))
    expect(geminiAuthSource({ GEMINI_CLI_HOME: tmp() }, home)).toBeUndefined()
  })

  it('sessionExists: chats file names only; unknown layout → cannot tell', () => {
    const home = tmp()
    const id = '3f2b9c1e-6a4d-4e8b-9c2f-1a0b7d5e4c31'
    expect(geminiSessionExists({ sessionId: id, env: {}, home })).toBeUndefined()
    mkdirSync(join(home, '.gemini', 'tmp', 'abc'), { recursive: true })
    expect(geminiSessionExists({ sessionId: id, env: {}, home })).toBeUndefined()
    mkdirSync(join(home, '.gemini', 'tmp', 'abc', 'chats'))
    expect(geminiSessionExists({ sessionId: id, env: {}, home })).toBe(false)
    writeFileSync(
      join(home, '.gemini', 'tmp', 'abc', 'chats', 'session-2026-10-10T10-00-3f2b9c1e.json'),
      '{}',
    )
    expect(geminiSessionExists({ sessionId: id, env: {}, home })).toBe(true)
    expect(geminiSessionExists({ sessionId: '../../etc', env: {}, home })).toBe(false)
  })
})

describe('trust (--skip-trust only with the vendorFolder grant or a Dim Factory-owned cwd)', () => {
  it('Dim Factory-owned: tmp (probe, run-less heal), a run heal folder, catalog jobs; never a worktree or a run folder', () => {
    const home = tmp('dim-factory-home-')
    const dirs = {
      probe: join(home, 'tmp', 'probe-cwd'),
      healTmp: join(home, 'tmp', 'heal', 'h1'),
      runHeal: join(home, 'runs', 'r1', 'heal', 'implement-1'),
      catalog: join(home, 'catalog', 'jobs', 'j1'),
      worktree: join(home, 'worktrees', 'r1'),
      run: join(home, 'runs', 'r1'),
      user: tmp('user-folder-'),
    }
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
    expect(isDimFactoryOwnedCwd(dirs.probe, home)).toBe(true)
    expect(isDimFactoryOwnedCwd(dirs.healTmp, home)).toBe(true)
    expect(isDimFactoryOwnedCwd(dirs.runHeal, home)).toBe(true)
    expect(isDimFactoryOwnedCwd(dirs.catalog, home)).toBe(true)
    expect(isDimFactoryOwnedCwd(dirs.worktree, home)).toBe(false)
    expect(isDimFactoryOwnedCwd(dirs.run, home)).toBe(false)
    expect(isDimFactoryOwnedCwd(dirs.user, home)).toBe(false)
    expect(isDimFactoryOwnedCwd(home, home)).toBe(false)
  })

  it('a link inside tmp that points at a user folder is not Dim Factory-owned', () => {
    const home = tmp('dim-factory-home-')
    const user = tmp('user-folder-')
    mkdirSync(join(home, 'tmp'), { recursive: true })
    const link = join(home, 'tmp', 'link')
    try {
      symlinkSync(user, link, 'junction')
    } catch {
      return // no link rights here
    }
    expect(isDimFactoryOwnedCwd(link, home)).toBe(false)
  })

  it('folderTrust: the engine grant, the trust.json lookup, fail closed on a throwing lookup', async () => {
    const home = tmp('dim-factory-home-')
    const user = tmp('user-folder-')
    const base = { cwd: user, vendor: 'gemini', dimFactoryHome: home }
    expect(
      await folderTrust({ ...base, engineTrusted: false, granted: () => Promise.resolve(false) }),
    ).toEqual({ trusted: false })
    expect(
      await folderTrust({ ...base, engineTrusted: true, granted: () => Promise.resolve(false) }),
    ).toEqual({ trusted: true, why: 'engine' })
    expect(
      await folderTrust({ ...base, engineTrusted: false, granted: () => Promise.resolve(true) }),
    ).toEqual({ trusted: true, why: 'grant' })
    expect(
      await folderTrust({ ...base, engineTrusted: false, granted: () => Promise.reject(new Error('x')) }),
    ).toEqual({ trusted: false })
  })
})

describe('classifier (the failure table G rows; the real ACP shapes)', () => {
  it('exit codes 41/42/44/52/53/54/55', () => {
    const rows: [number, string][] = [
      [41, 'gemini.exit.41'],
      [42, 'gemini.exit.42'],
      [44, 'gemini.exit.44'],
      [52, 'gemini.exit.52'],
      [53, 'gemini.exit.53'],
      [54, 'gemini.exit.54'],
      [55, 'gemini.exit.55'],
    ]
    for (const [code, rule] of rows)
      expect(classifyDetailed({ vendor: 'gemini', exitCode: code, now: 1 })?.rule).toBe(rule)
    expect(geminiConfig.exitCodes).toEqual({
      41: 'auth_required',
      42: 'flag_drift',
      44: 'sandbox_unavailable',
      52: 'config_invalid',
      53: 'turn_limit',
      54: 'disk_full',
      55: 'trust_required',
    })
  })

  it('ACP resourceNotFound (-32002) on session/load or session/resume is resume_failed', () => {
    expect(
      acpRpcMatch({ code: -32002, method: 'session/load', message: 'Resource not found' })?.category,
    ).toBe('resume_failed')
    expect(acpRpcMatch({ code: -32002, method: 'session/resume' })?.category).toBe('resume_failed')
    expect(acpRpcMatch({ code: -32002, method: 'session/prompt' })).toBeUndefined()
  })

  it('a Gemini error with its words in data.details classifies by those words', () => {
    const r = classifyDetailed({
      vendor: 'gemini',
      rpcError: {
        code: -32603,
        message: 'Internal error: Invalid session identifier "x"',
        method: 'session/load',
      },
      now: 1,
    })
    expect(r?.failure.category).toBe('resume_failed')
  })
})

describe('what Gemini puts on the wire (gemini-cli v0.62.0 and main, gemini/wire.ts)', () => {
  it('a shell explanation names its folder: [in <dir>] or [current working directory <cwd>], once', () => {
    expect(geminiExplanationDir('[in src]')).toBe('src')
    expect(geminiExplanationDir('[in src] (Build the package)')).toBe('src')
    expect(geminiExplanationDir(String.raw`[current working directory C:\work\app]`)).toBe(
      String.raw`C:\work\app`,
    )
    expect(
      geminiExplanationDir('[current working directory /w/app] (Run the tests) [background]'),
    ).toBeUndefined()
    // A description with brackets of its own leaves one reading.
    expect(geminiExplanationDir('[in src] (see [docs] first)')).toBe('src')
    expect(geminiExplanationDir('[in a]b] (x)')).toBe('a]b')
    // Two readings possible (a folder that ends like a description), another shape, nothing: unknown.
    expect(geminiExplanationDir('[in /w/app] (x] (Run the tests)')).toBeUndefined()
    expect(geminiExplanationDir('[in src] [background]')).toBeUndefined()
    expect(geminiExplanationDir('Run the tests')).toBeUndefined()
    expect(geminiExplanationDir('[in ]')).toBeUndefined()
    expect(geminiExplanationDir('')).toBeUndefined()
  })

  it('a shell request: the command is the title, never the content; the folder from its one explanation', () => {
    const text = (t: string) => ({ type: 'content', content: { type: 'text', text: t } })
    expect(
      geminiShellRequest({ kind: 'execute', title: 'npm test', content: [text('[in .] (Run the tests)')] }),
    ).toEqual({ command: 'npm test', dir: '.', note: '[in .] (Run the tests)' })
    expect(geminiShellRequest({ kind: 'execute', title: 'npm test', content: [] })).toEqual({
      command: 'npm test',
      dir: undefined,
      note: undefined,
    })
    expect(
      geminiShellRequest({ kind: 'execute', title: ' ', content: [text('npm test')] }).command,
    ).toBeUndefined()
    expect(
      geminiShellRequest({ kind: 'execute', title: 'a', content: [text('[in x]'), text('[in y]')] }).dir,
    ).toBeUndefined()
    // Should a later Gemini send the tool's params, they are read instead.
    expect(
      geminiShellRequest({
        kind: 'execute',
        title: 'npm test (Run the tests)',
        rawInput: { command: 'npm test', dir_path: 'pkg' },
      }),
    ).toEqual({ command: 'npm test', dir: 'pkg', note: undefined })
  })

  it("exit_plan_mode's title names its plan file; the mode echo names the mode", () => {
    expect(
      GEMINI_PLAN_EXIT_TITLE.exec(
        'Requesting plan approval for: /h/.gemini/tmp/p/s/plans/version-flag.md',
      )?.[1],
    ).toBe('/h/.gemini/tmp/p/s/plans/version-flag.md')
    expect(GEMINI_PLAN_EXIT_TITLE.test('Requesting plan approval for: /h/plan.txt')).toBe(false)
    expect(GEMINI_MODE_UPDATE.exec('[MODE_UPDATE] autoEdit')?.[1]).toBe('autoEdit')
    expect(GEMINI_MODE_UPDATE.test('[MODE_UPDATE] yolo and more')).toBe(false)
    expect(geminiConfig.shellRequest).toBe(geminiShellRequest)
    expect(geminiConfig.planExitTitle).toBe(GEMINI_PLAN_EXIT_TITLE)
    expect(geminiConfig.modeUpdateText).toBe(GEMINI_MODE_UPDATE)
  })

  it("0.62's token totals: _meta.quota.token_count, read defensively", () => {
    const meta = { quota: { token_count: { input_tokens: 18432, output_tokens: 612 } } }
    expect(geminiMetaUsage({ stopReason: 'end_turn', _meta: meta })).toEqual({ input: 18432, output: 612 })
    expect(geminiConfig.usage.metaUsage?.({ _meta: meta })).toEqual({ input: 18432, output: 612 })
    for (const bad of [
      { stopReason: 'cancelled' },
      { _meta: { quota: { token_count: { input_tokens: '1', output_tokens: 2 } } } },
      { _meta: { quota: { token_count: { input_tokens: -1, output_tokens: 2 } } } },
      { _meta: { quota: {} } },
      null,
      'x',
    ])
      expect(geminiMetaUsage(bad), JSON.stringify(bad)).toBeUndefined()
  })
})
