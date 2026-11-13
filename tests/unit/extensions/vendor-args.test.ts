// What each vendor's launch carries at each Extensions level. Pass through equals today's Implement launch, byte for
// byte (Claude and Codex); Allowed list adds only what limits the pass to the allowed servers. None is the read-only
// launch with everything of the user's off: for Claude also its skills (and its hooks in its own plan mode), for Codex
// also its apps, plugins and hooks. Gemini's None is the one deliberate change: session/new's empty mcpServers never stopped the
// servers of its own settings (gemini-cli merges them), so a name filter now does.
import { describe, expect, it } from 'vitest'
import { CLAUDEAI_MCP_ENV, PLAN_ALLOWED_SETTINGS } from '@core/adapters/claude/capabilities.ts'
import type { ArgvInput } from '@core/adapters/claude/launch.ts'
import { buildArgv, claudeEnv, routeExtensions } from '@core/adapters/claude/launch.ts'
import { initializeRequest } from '@core/adapters/claude/protocol.ts'
import { CODEX_APPS, execArgv, featuresOffKeys, mcpOffKeys } from '@core/adapters/codex/launch.ts'
import { threadResumeParams, threadStartParams } from '@core/adapters/codex/params.ts'
import { codexSupport, MCP_ALLOWED_NOTE, MCP_NOTE, MCP_OFF_NOTE } from '@core/adapters/codex/capabilities.ts'
import { defaultFacts } from '@core/adapters/codex/capabilities.ts'
import { GEMINI_NO_MCP, geminiConfig, geminiMcpArgs, MANAGED_FLAGS } from '@core/adapters/gemini/config.ts'
import { grokConfig } from '@core/adapters/grok/config.ts'
import { acpExtraArgsProblem } from '@core/adapters/acp-base/launch.ts'

const BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
]

const claude = (i: Partial<ArgvInput> & Pick<ArgvInput, 'route'>): string[] =>
  buildArgv({ mode: i.route === 'edit' ? 'autoedit' : 'readonly', step: 'review', ...i })

// Today's launches, written out (tests/unit/adapters/claude.launch.test.ts pins the same ones).
const TODAY_REVIEW = [
  ...BASE,
  'dontAsk',
  '--strict-mcp-config',
  '--permission-prompts',
  'none',
  '--no-session-persistence',
  '--settings',
  '{"disableAllHooks":true}',
  '--disallowedTools',
  'Edit,Write,NotebookEdit,AskUserQuestion,Monitor',
]
const TODAY_PLAN = [
  ...BASE,
  'plan',
  '--strict-mcp-config',
  '--permission-prompt-tool',
  'stdio',
  '--settings',
  '{"useAutoModeDuringPlan":false}',
  '--no-session-persistence',
  '--disallowedTools',
  'AskUserQuestion',
]
/** None: the read-only launch with skills off too. */
const NONE_REVIEW = [...TODAY_REVIEW, '--disable-slash-commands']
/** None in Claude's own plan mode: hooks off as on the read-only route, and skills off. */
const NONE_PLAN = [
  ...TODAY_PLAN.map((a) => (a === '{"useAutoModeDuringPlan":false}' ? PLAN_ALLOWED_SETTINGS : a)),
  '--disable-slash-commands',
]
const TODAY_IMPLEMENT = [
  ...BASE,
  'acceptEdits',
  '--permission-prompt-tool',
  'stdio',
  '--disallowedTools',
  'AskUserQuestion',
  '--session-id=s1',
]

describe('Claude argv per level', () => {
  it('the routes default to today: none for plan and read-only, passthrough for edit', () => {
    expect(routeExtensions('plan')).toBe('none')
    expect(routeExtensions('readonly')).toBe('none')
    expect(routeExtensions('edit')).toBe('passthrough')
  })

  it('None on a read-only pass is the read-only argv with skills off, and hooks off in plan mode too', () => {
    expect(claude({ route: 'readonly', extensions: 'none' })).toEqual(NONE_REVIEW)
    expect(claude({ route: 'readonly' })).toEqual(NONE_REVIEW)
    expect(claude({ route: 'plan', step: 'plan', extensions: 'none' })).toEqual(NONE_PLAN)
    expect(claude({ route: 'plan', step: 'plan' })).toEqual(NONE_PLAN)
    // A stray config path never reaches a None launch.
    expect(claude({ route: 'readonly', extensions: 'none', mcpConfigPath: '/x.json' })).toEqual(NONE_REVIEW)
    // Pass through on Claude's own plan mode keeps the user's hooks and skills.
    expect(claude({ route: 'plan', step: 'plan', extensions: 'passthrough' })).not.toContain(
      '--disable-slash-commands',
    )
  })

  it("Pass through on Implement and Fix is today's edit argv, byte for byte", () => {
    expect(claude({ route: 'edit', step: 'implement', sessionId: 's1', extensions: 'passthrough' })).toEqual(
      TODAY_IMPLEMENT,
    )
    expect(claude({ route: 'edit', step: 'implement', sessionId: 's1' })).toEqual(TODAY_IMPLEMENT)
    const fix = claude({ route: 'edit', step: 'fix', resumeId: 'old', extensions: 'passthrough' })
    expect(fix).toEqual(claude({ route: 'edit', step: 'fix', resumeId: 'old' }))
  })

  it("Allowed list: no MCP server but the allowed ones' file, and no hooks (also in Claude's own plan mode)", () => {
    const review = claude({
      route: 'readonly',
      extensions: 'allowed',
      mcpConfigPath: 'C:\\run\\tmp\\mcp-1.json',
    })
    expect(review).toEqual([
      ...BASE,
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      'C:\\run\\tmp\\mcp-1.json',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true}',
      '--disallowedTools',
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor',
    ])
    // No allowed server defined any more: strict, with no server at all.
    const empty = claude({ route: 'readonly', extensions: 'allowed' })
    expect(empty).toEqual(TODAY_REVIEW)
    const plan = claude({ route: 'plan', step: 'plan', extensions: 'allowed', mcpConfigPath: '/m.json' })
    expect(plan.slice(plan.indexOf('--strict-mcp-config'), plan.indexOf('--strict-mcp-config') + 3)).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '/m.json',
    ])
    expect(plan[plan.indexOf('--settings') + 1]).toBe(PLAN_ALLOWED_SETTINGS)
    expect(JSON.parse(PLAN_ALLOWED_SETTINGS)).toEqual({ useAutoModeDuringPlan: false, disableAllHooks: true })
    const impl = claude({
      route: 'edit',
      step: 'implement',
      sessionId: 's1',
      extensions: 'allowed',
      mcpConfigPath: '/m.json',
    })
    expect(impl).toEqual([
      ...BASE,
      'acceptEdits',
      '--permission-prompt-tool',
      'stdio',
      '--disallowedTools',
      'AskUserQuestion',
      '--strict-mcp-config',
      '--mcp-config',
      '/m.json',
      '--settings',
      '{"disableAllHooks":true}',
      '--session-id=s1',
    ])
  })

  it('None on Implement: no MCP server and no hooks', () => {
    const impl = claude({ route: 'edit', step: 'implement', sessionId: 's1', extensions: 'none' })
    expect(impl).toEqual([
      ...BASE,
      'acceptEdits',
      '--permission-prompt-tool',
      'stdio',
      '--disallowedTools',
      'AskUserQuestion',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--session-id=s1',
      '--disable-slash-commands',
    ])
    expect(impl).not.toContain('--mcp-config')
  })

  it("Pass through on a read-only pass: the user's servers and hooks load; the read-only tool cut stays", () => {
    const a = claude({ route: 'readonly', extensions: 'passthrough', mcpConfigPath: '/never.json' })
    expect(a).not.toContain('--strict-mcp-config')
    expect(a).not.toContain('--mcp-config')
    expect(a).not.toContain('--settings')
    expect(a).toContain('dontAsk')
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit,AskUserQuestion,Monitor')
    const p = claude({ route: 'plan', step: 'plan', extensions: 'passthrough' })
    expect(p).not.toContain('--strict-mcp-config')
    expect(p[p.indexOf('--settings') + 1]).toBe('{"useAutoModeDuringPlan":false}')
  })

  it('the claude.ai connectors stay off at Pass through, as on an edit pass; a read-only None leaves the env as today', () => {
    const base = { PATH: '/bin' }
    const off = Object.entries(CLAUDEAI_MCP_ENV)
    const pass = claudeEnv(base, {
      route: 'readonly',
      extensions: 'passthrough',
      platform: 'linux',
      launchedFromClaude: false,
    })
    for (const [k, v] of off) expect(pass[k]).toBe(v)
    const none = claudeEnv(base, {
      route: 'readonly',
      extensions: 'none',
      platform: 'linux',
      launchedFromClaude: false,
    })
    const legacy = claudeEnv(base, { route: 'readonly', platform: 'linux', launchedFromClaude: false })
    expect(none).toEqual(legacy)
    for (const [k] of off) expect(none[k]).toBeUndefined()
    const edit = claudeEnv(base, {
      route: 'edit',
      extensions: 'passthrough',
      platform: 'linux',
      launchedFromClaude: false,
    })
    expect(edit).toEqual(claudeEnv(base, { route: 'edit', platform: 'linux', launchedFromClaude: false }))
  })

  it('initialize carries the skill allowlist only when one is given', () => {
    expect(initializeRequest('r1').request).toEqual({ subtype: 'initialize' })
    expect(initializeRequest('r1', { skills: ['pdf', 'tools:lint'] }).request).toEqual({
      subtype: 'initialize',
      skills: ['pdf', 'tools:lint'],
    })
    expect(initializeRequest('r1', { skills: [] }).request['skills']).toEqual([])
  })
})

describe('Codex per level', () => {
  const names = ['alpha', 'beta-2']
  const keys = ['mcp_servers.alpha.enabled', 'mcp_servers.beta-2.enabled']

  it("no level: today's rule (read-only steps switch them off, Implement and Fix keep them)", () => {
    expect(mcpOffKeys('review', names)).toEqual(keys)
    expect(mcpOffKeys('implement', names)).toEqual([])
  })

  it('a level decides for any step: passthrough switches nothing off, none and allowed switch off what is given', () => {
    for (const step of ['plan', 'implement', 'review', 'critic', 'fix'] as const) {
      expect(mcpOffKeys(step, names, 'passthrough')).toEqual([])
      expect(mcpOffKeys(step, names, 'none')).toEqual(keys)
      expect(mcpOffKeys(step, ['beta-2'], 'allowed')).toEqual(['mcp_servers.beta-2.enabled'])
    }
  })

  it("None on Review is today's frame and argv; Pass through on Implement is today's", () => {
    const review = { step: 'review' as const, mode: 'readonly' as const, cwd: '/w', mcpOff: names }
    expect(threadStartParams({ ...review, extensions: 'none' })).toEqual(threadStartParams(review))
    expect(execArgv({ ...review, outFile: '/o', extensions: 'none' })).toEqual(
      execArgv({ ...review, outFile: '/o' }),
    )
    const impl = { step: 'implement' as const, mode: 'autoedit' as const, cwd: '/w', mcpOff: [] }
    expect(threadStartParams({ ...impl, extensions: 'passthrough' })).toEqual(threadStartParams(impl))
    expect(threadResumeParams('t', { ...impl, extensions: 'passthrough' })).toEqual(
      threadResumeParams('t', impl),
    )
    expect(execArgv({ ...impl, outFile: '/o', extensions: 'passthrough' })).toEqual(
      execArgv({ ...impl, outFile: '/o' }),
    )
  })

  it('None on Implement switches every server off; Pass through on Review switches none off', () => {
    const impl = threadStartParams({
      step: 'implement',
      mode: 'autoedit',
      cwd: '/w',
      mcpOff: names,
      extensions: 'none',
    })
    expect(impl.config).toEqual({
      'mcp_servers.alpha.enabled': false,
      'mcp_servers.beta-2.enabled': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
    const argv = execArgv({
      step: 'implement',
      mode: 'autoedit',
      cwd: '/w',
      outFile: '/o',
      mcpOff: names,
      extensions: 'none',
    })
    expect(argv).toContain('mcp_servers.alpha.enabled=false')
    const review = threadStartParams({
      step: 'review',
      mode: 'readonly',
      cwd: '/w',
      mcpOff: names,
      extensions: 'passthrough',
    })
    expect(JSON.stringify(review)).not.toContain('mcp_servers')
  })

  it('below Pass through apps, plugins and hooks are off, on thread/start and the exec route alike', () => {
    expect(featuresOffKeys('none')).toEqual(['features.apps', 'features.plugins', 'features.hooks'])
    expect(featuresOffKeys('allowed', ['alpha'])).toEqual([
      'features.apps',
      'features.plugins',
      'features.hooks',
    ])
    // The user allowed the apps linked to the account: only they stay on.
    expect(featuresOffKeys('allowed', [CODEX_APPS])).toEqual(['features.plugins', 'features.hooks'])
    expect(featuresOffKeys('none', [CODEX_APPS])).toEqual([
      'features.apps',
      'features.plugins',
      'features.hooks',
    ])
    expect(featuresOffKeys('passthrough', [CODEX_APPS])).toEqual([])
    const featuresOff = featuresOffKeys('none')
    const review = { step: 'review' as const, mode: 'readonly' as const, cwd: '/w', mcpOff: ['alpha'] }
    expect(threadStartParams({ ...review, extensions: 'none', featuresOff }).config).toEqual({
      'mcp_servers.alpha.enabled': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
    expect(threadResumeParams('t', { ...review, extensions: 'none', featuresOff }).config).toMatchObject({
      'features.hooks': false,
    })
    const argv = execArgv({ ...review, outFile: '/o', extensions: 'none', featuresOff })
    for (const k of featuresOff) expect(argv).toContain(`${k}=false`)
    expect(argv.indexOf('features.apps=false')).toBeLessThan(argv.indexOf('-o'))
  })

  it('the read-only copy follows the level: off, only the allowed ones, or the servers still load', () => {
    const facts = defaultFacts()
    const need = { pass: 'review' as const, mode: 'readonly' as const, planNative: false, trustFolder: false }
    expect(codexSupport(need, facts, false).copy.endsWith(MCP_NOTE)).toBe(true)
    expect(codexSupport(need, facts, true).copy.endsWith(MCP_OFF_NOTE)).toBe(true)
    expect(codexSupport(need, facts, 'allowed').copy.endsWith(MCP_ALLOWED_NOTE)).toBe(true)
    expect(MCP_ALLOWED_NOTE).not.toMatch(/\u2014/)
  })
})

describe('Gemini and Grok per level', () => {
  const cli = { command: 'node', prefixArgs: ['gemini.js'], version: '0.62.0' }
  const launch = (mcpAllow?: readonly string[]) =>
    geminiConfig.resolveLaunch({
      cli,
      trust: false,
      env: {},
      purpose: 'pass',
      ...(mcpAllow !== undefined ? { mcpAllow } : {}),
    })

  it("Pass through (no list) is today's launch", () => {
    expect(launch().args).toEqual(['gemini.js', '--acp'])
    expect(geminiMcpArgs(undefined)).toEqual([])
  })

  it('None names a server no settings define, so no MCP server loads (an empty list means no limit to Gemini)', () => {
    expect(launch([]).args).toEqual(['gemini.js', '--acp', '--allowed-mcp-server-names', GEMINI_NO_MCP])
  })

  it('Allowed list names the allowed servers (deduplicated, unsafe names left out)', () => {
    expect(launch(['alpha', 'beta-2', 'alpha', 'bad name', '--x']).args).toEqual([
      'gemini.js',
      '--acp',
      '--allowed-mcp-server-names',
      'alpha,beta-2',
    ])
    // Nothing safe left: no server at all, never "no limit".
    expect(launch(['bad name']).args.at(-1)).toBe(GEMINI_NO_MCP)
  })

  it("the flag is Dim Factory's: extraArgs may not set it", () => {
    expect(MANAGED_FLAGS).toContain('--allowed-mcp-server-names')
    expect(acpExtraArgsProblem(geminiConfig, ['--allowed-mcp-server-names', 'x'])).toMatch(
      /Dim Factory manages it/,
    )
  })

  it('Grok cannot limit its servers: its launch ignores the list', () => {
    const cliG = { command: 'grok', prefixArgs: [], version: '1.0.0' }
    const a = grokConfig.resolveLaunch({ cli: cliG, trust: false, env: {}, purpose: 'pass' })
    const b = grokConfig.resolveLaunch({
      cli: cliG,
      trust: false,
      env: {},
      purpose: 'pass',
      mcpAllow: ['alpha'],
    })
    expect(b.args).toEqual(a.args)
  })
})
