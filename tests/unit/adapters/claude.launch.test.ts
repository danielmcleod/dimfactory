// Claude argv per pass, flagMap / extraArgs rules, and the child env.
import { describe, expect, it } from 'vitest'
import {
  applyFlagMap,
  buildArgv,
  claudeConfigDir,
  claudeEnv,
  extraArgsProblem,
  flagMapProblem,
  isHostSessionLeftover,
  permissionModeFor,
  probeArgv,
  routeFor,
} from '@core/adapters/claude/launch.ts'
import type { ArgvInput } from '@core/adapters/claude/launch.ts'

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

const argv = (i: Partial<ArgvInput> & Pick<ArgvInput, 'route'>): string[] =>
  buildArgv({ mode: 'autoedit', step: 'implement', ...i })

describe('routeFor', () => {
  it.each([
    [{ step: 'plan', mode: 'readonly', planNative: true }, 'plan'],
    [{ step: 'plan', mode: 'readonly', planNative: false }, 'readonly'],
    [{ step: 'review', mode: 'autoedit', planNative: false }, 'readonly'],
    [{ step: 'critic', mode: 'readonly', planNative: false }, 'readonly'],
    [{ step: 'heal', mode: 'readonly', planNative: false }, 'readonly'],
    [{ step: 'catalog', mode: 'readonly', planNative: false }, 'readonly'],
    [{ step: 'implement', mode: 'autoedit', planNative: false }, 'edit'],
    [{ step: 'fix', mode: 'full', planNative: false }, 'edit'],
    [{ step: 'implement', mode: 'readonly', planNative: false }, 'readonly'],
  ] as const)('%o → %s', (o, route) => {
    expect(routeFor(o)).toBe(route)
  })

  it('maps the permission mode', () => {
    expect(permissionModeFor('plan', 'readonly')).toBe('plan')
    expect(permissionModeFor('readonly', 'full')).toBe('dontAsk')
    expect(permissionModeFor('edit', 'autoedit')).toBe('acceptEdits')
    expect(permissionModeFor('edit', 'full')).toBe('bypassPermissions')
  })
})

describe('buildArgv (the Claude launch table)', () => {
  it('native plan: host, plan settings, no persistence, AskUserQuestion off (C06), hooks and skills off at None', () => {
    expect(argv({ route: 'plan', step: 'plan', model: 'opus' })).toEqual([
      ...BASE,
      'plan',
      '--model',
      'opus',
      '--strict-mcp-config',
      '--permission-prompt-tool',
      'stdio',
      '--settings',
      '{"useAutoModeDuringPlan":false,"disableAllHooks":true}',
      '--no-session-persistence',
      '--disallowedTools',
      'AskUserQuestion',
      '--disable-slash-commands',
    ])
  })

  it('read-only: dontAsk, no host, prompts none, hooks off, edit tools off (C02), skills off at None', () => {
    expect(argv({ route: 'readonly', step: 'review', mode: 'readonly', model: 'sonnet' })).toEqual([
      ...BASE,
      'dontAsk',
      '--model',
      'sonnet',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true}',
      '--disallowedTools',
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor',
      '--disable-slash-commands',
    ])
  })

  it('read-only and plan routes below Pass through cut the subagent tool when custom subagents exist', () => {
    const cut = (a: string[]): string => a[a.indexOf('--disallowedTools') + 1] ?? ''
    expect(cut(argv({ route: 'readonly', step: 'review', customAgents: true }))).toBe(
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Agent',
    )
    expect(cut(argv({ route: 'plan', step: 'plan', customAgents: true }))).toBe('AskUserQuestion,Agent')
    expect(
      cut(argv({ route: 'readonly', step: 'review', customAgents: true, extensions: 'allowed' })),
    ).toContain('Agent')
    // None exist: the built-in subagents stay; Pass through keeps the user's own.
    expect(cut(argv({ route: 'readonly', step: 'review' }))).not.toContain('Agent')
    expect(
      cut(argv({ route: 'readonly', step: 'review', customAgents: true, extensions: 'passthrough' })),
    ).not.toContain('Agent')
    // An edit pass may change files anyway; its subagents are the user's choice.
    expect(argv({ route: 'edit', customAgents: true, extensions: 'none' }).join(' ')).not.toContain('Agent,')
  })

  it('Run without asking: mcp__<name>__* in --allowedTools at Allowed list only, on every route but the confined ones', () => {
    const allowedOf = (a: string[]): string | undefined =>
      a.includes('--allowedTools') ? a[a.indexOf('--allowedTools') + 1] : undefined
    const noAsk = {
      extensions: 'allowed' as const,
      mcpConfigPath: '/x.json',
      mcpWithoutAsking: ['github', 'db_2'],
    }
    // Read-only (C21b): after the tool cut.
    const r = argv({ route: 'readonly', step: 'review', ...noAsk })
    expect(r.slice(-2)).toEqual(['--allowedTools', 'mcp__github__*,mcp__db_2__*'])
    // Claude's own plan mode: its host would deny the ask as a read-only pass.
    expect(allowedOf(argv({ route: 'plan', step: 'plan', ...noAsk }))).toBe('mcp__github__*,mcp__db_2__*')
    // An edit pass: one --allowedTools with the run's own rules.
    const e = argv({ route: 'edit', nativeRules: ['Bash(npm test)'], ...noAsk })
    expect(e.filter((x) => x === '--allowedTools')).toHaveLength(1)
    expect(allowedOf(e)).toBe('Bash(npm test),mcp__github__*,mcp__db_2__*')
    // Not below or above Allowed list, never on the catalog refresh or Research, never a name that is not allowable.
    for (const extensions of ['none', 'passthrough'] as const)
      expect(argv({ route: 'readonly', step: 'review', ...noAsk, extensions })).not.toContain(
        '--allowedTools',
      )
    expect(allowedOf(argv({ route: 'readonly', step: 'catalog', ...noAsk }))).toBe('WebSearch')
    expect(argv({ route: 'readonly', step: 'research', ...noAsk })).not.toContain('--allowedTools')
    expect(
      argv({ route: 'readonly', step: 'review', ...noAsk, mcpWithoutAsking: ['a,b', '-x', 'ok'] }).slice(-1),
    ).toEqual(['mcp__ok__*'])
    // Nothing opted in: argv as before.
    expect(
      argv({ route: 'readonly', step: 'review', extensions: 'allowed', mcpConfigPath: '/x.json' }),
    ).not.toContain('--allowedTools')
  })

  it('the connector listing is the probe handshake with strict MCP off (C22a)', () => {
    expect(probeArgv({ connectors: true })).toEqual(probeArgv().filter((a) => a !== '--strict-mcp-config'))
    expect(probeArgv()).toContain('--strict-mcp-config')
  })

  it('read-only passes disallow shell when readiness found risky allow-rules', () => {
    const a = argv({ route: 'readonly', step: 'critic', disallowShell: true })
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe(
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Bash,PowerShell',
    )
    const p = argv({ route: 'plan', step: 'plan', disallowShell: true })
    expect(p[p.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion,Bash,PowerShell')
  })

  it('heal also cuts shell and web; catalog allows web', () => {
    const h = argv({ route: 'readonly', step: 'heal' })
    expect(h[h.indexOf('--disallowedTools') + 1]).toBe(
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Bash,PowerShell,WebFetch,WebSearch',
    )
    // The catalog refresh also cuts shell and subagents, and fetches pages only on the
    // hosts it is given (none given: web search alone).
    const c = argv({ route: 'readonly', step: 'catalog' })
    expect(c[c.indexOf('--disallowedTools') + 1]).toBe(
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Bash,PowerShell,Agent',
    )
    expect(c.slice(-2)).toEqual(['--allowedTools', 'WebSearch'])
    const d = argv({ route: 'readonly', step: 'catalog', webDomains: ['platform.claude.com'] })
    expect(d.slice(-2)).toEqual(['--allowedTools', 'WebSearch,WebFetch(domain:platform.claude.com)'])
  })

  it('implement / fresh fix: host, --session-id=, allowedTools from nativeRules (C08a)', () => {
    expect(
      argv({
        route: 'edit',
        sessionId: 'fa4e849c-3bb9-4cdb-8305-645bafbe57ea',
        nativeRules: ['Bash(npm --version)', 'Bash(a,b)', 'Bash(npm --version)', 'Edit(src/**)'],
      }),
    ).toEqual([
      ...BASE,
      'acceptEdits',
      '--permission-prompt-tool',
      'stdio',
      '--disallowedTools',
      'AskUserQuestion',
      '--allowedTools',
      'Bash(npm --version),Edit(src/**)',
      '--session-id=fa4e849c-3bb9-4cdb-8305-645bafbe57ea',
    ])
  })

  it('Auto mode uses bypassPermissions with the host still attached', () => {
    const a = argv({ route: 'edit', mode: 'full', sessionId: 's' })
    expect(a).toContain('bypassPermissions')
    expect(a).toContain('--permission-prompt-tool')
  })

  it('fix reuse: --resume= and never --session-id (C08b/C08e)', () => {
    const a = argv({ route: 'edit', step: 'fix', sessionId: 'new', resumeId: 'old' })
    expect(a).toContain('--resume=old')
    expect(a.some((x) => x.startsWith('--session-id'))).toBe(false)
  })

  it('never carries the prompt and puts extraArgs last', () => {
    const a = argv({ route: 'edit', sessionId: 's', extraArgs: ['--max-turns', '40'] })
    expect(a.slice(-2)).toEqual(['--max-turns', '40'])
  })

  it('applies flagMap to managed flags, including the = form', () => {
    const a = argv({
      route: 'edit',
      resumeId: 'x',
      flagMap: { '--permission-prompt-tool': '--permission-tool', '--resume': '--resume-session' },
    })
    expect(a).toContain('--permission-tool')
    expect(a).not.toContain('--permission-prompt-tool')
    expect(a).toContain('--resume-session=x')
    expect(applyFlagMap(['--model', 'opus'], { '--nope': '--x' })).toEqual(['--model', 'opus'])
  })
})

describe('extraArgs / flagMap validation', () => {
  it('rejects managed flags in extraArgs', () => {
    expect(extraArgsProblem(['--max-turns', '3'])).toBeUndefined()
    expect(extraArgsProblem(['--model', 'x'])).toMatch(/--model/)
    expect(extraArgsProblem(['--session-id=abc'])).toMatch(/--session-id/)
    expect(extraArgsProblem(['-p'])).toMatch(/-p/)
    expect(extraArgsProblem(['a\nb'])).toMatch(/newline/)
  })

  it('flagMap may only rename managed flags to flag names', () => {
    expect(flagMapProblem({ '--permission-prompts': '--permission-prompt-mode' })).toBeUndefined()
    expect(flagMapProblem({ '--max-turns': '--turns' })).toMatch(/not a flag Dim Factory manages/)
    expect(flagMapProblem({ '--model': 'rm -rf' })).toMatch(/not a long flag name/)
    expect(flagMapProblem({ '--resume': '-r' })).toMatch(/not a long flag name/)
  })

  it('flagMap may not turn one managed flag into another or into an escalation (the read-only tool cut)', () => {
    // The review's repro: the read-only tool cut would become an allow list for Edit/Write.
    expect(flagMapProblem({ '--disallowedTools': '--allowedTools' })).toMatch(/manages --allowedTools/)
    expect(flagMapProblem({ '--disallowedTools': '--allowed_tools' })).toMatch(/manages/)
    expect(flagMapProblem({ '--permission-mode': '--dangerously-skip-permissions' })).toMatch(/widens/)
    expect(flagMapProblem({ '--settings': '--allow-dangerously-skip-permissions' })).toMatch(/widens/)
    expect(flagMapProblem({ '--settings': '--add-dir' })).toMatch(/widens/)
    expect(flagMapProblem({ '--strict-mcp-config': '--mcp-config' })).toMatch(/widens/)
    expect(flagMapProblem({ '--model': '--permission-mode' })).toMatch(/manages/)
    expect(
      flagMapProblem({
        '--permission-prompt-tool': '--prompt-tool',
        '--permission-prompts': '--prompt-tool',
      }),
    ).toMatch(/two flags/)
    // Spelling variants of the same flag and plain renames stay allowed.
    expect(flagMapProblem({ '--disallowedTools': '--disallowed-tools' })).toBeUndefined()
    expect(flagMapProblem({ '--disallowedTools': '--deny-tools' })).toBeUndefined()
  })

  it('extraArgs may not widen permissions or name a managed flag in another spelling', () => {
    expect(extraArgsProblem(['--dangerously-skip-permissions'])).toMatch(/widens/)
    expect(extraArgsProblem(['--add-dir', '/'])).toMatch(/widens/)
    expect(extraArgsProblem(['--mcp-config=x.json'])).toMatch(/widens/)
    expect(extraArgsProblem(['--allowed-tools', 'Bash'])).toMatch(/manages/)
    expect(extraArgsProblem(['--PERMISSION_MODE', 'plan'])).toMatch(/manages/)
    expect(extraArgsProblem(['-r', 'abc'])).toMatch(/manages/)
    expect(extraArgsProblem(['--max-turns', '-1'])).toBeUndefined()
  })
})

describe('probeArgv (C16)', () => {
  it('carries the stream and host flags a pass needs, user extraArgs, and the flagMap', () => {
    const a = probeArgv()
    expect(a.slice(0, 11)).toEqual([...BASE, 'default', '--permission-prompt-tool', 'stdio'])
    expect(a).toContain('--no-session-persistence')
    const mapped = probeArgv({
      extraArgs: ['--max-turns', '3'],
      flagMap: { '--permission-prompt-tool': '--permission-tool', '--include-partial-messages': '--partial' },
    })
    expect(mapped).toContain('--permission-tool')
    expect(mapped).toContain('--partial')
    expect(mapped).not.toContain('--permission-prompt-tool')
    expect(mapped.slice(-2)).toEqual(['--max-turns', '3'])
  })
})

describe('claudeEnv', () => {
  const hostEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'host',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_USER_EMAIL: 'me@example.com',
    CLAUDE_AGENT_SDK_VERSION: '0.3',
    CLAUDE_PID: '1',
    CLAUDE_PREVIEW_X: '1',
    CLAUDE_EFFORT: 'xhigh',
    CLAUDE_CONFIG_DIR: '/home/u/.cfg',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com/',
    ANTHROPIC_API_KEY: 'sk-ant-user-key-0000000000000',
    NODE_OPTIONS: '--inspect',
    GIT_DIR: '/x',
    GIT_SSH_COMMAND: 'ssh',
  }

  it('scrubs a host Claude Code session but keeps user settings', () => {
    const env = claudeEnv(hostEnv, { route: 'readonly', platform: 'linux' })
    for (const k of Object.keys(env)) {
      if (k !== 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS')
        expect(k).not.toMatch(/^CLAUDECODE$|^CLAUDE_(CODE|AGENT|PID|PREVIEW|EFFORT)/)
    }
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/u/.cfg')
    expect(env['ANTHROPIC_API_KEY']).toBe(hostEnv.ANTHROPIC_API_KEY)
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined()
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['GIT_DIR']).toBeUndefined()
    expect(env['GIT_SSH_COMMAND']).toBe('ssh')
    expect(env['CLAUDE_CODE_STARTUP_FAILURE_RESULTS']).toBe('1')
    expect(env['NO_COLOR']).toBe('1')
    expect(env['ENABLE_CLAUDEAI_MCP_SERVERS']).toBeUndefined()
  })

  it('keeps a custom ANTHROPIC_BASE_URL and nothing is scrubbed outside a host session', () => {
    const env = claudeEnv(
      { PATH: '/bin', CLAUDE_EFFORT: 'low', ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
      { route: 'edit', platform: 'linux' },
    )
    expect(env['CLAUDE_EFFORT']).toBe('low')
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://gateway.example.com')
    expect(env['ENABLE_CLAUDEAI_MCP_SERVERS']).toBe('false')
  })

  it('layers vendor env last (user overrides) and the resolved PATH', () => {
    const env = claudeEnv(
      { PATH: '/bin' },
      {
        route: 'edit',
        platform: 'linux',
        path: '/resolved',
        pathPrepend: ['/pre'],
        vendorEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true', FAKE_CLI_SCRIPT: 's' },
      },
    )
    expect(env['PATH']).toBe('/pre:/resolved')
    expect(env['ENABLE_CLAUDEAI_MCP_SERVERS']).toBe('true')
    expect(env['FAKE_CLI_SCRIPT']).toBe('s')
  })

  it('identifies host-session leftovers', () => {
    expect(isHostSessionLeftover('CLAUDE_EFFORT', 'x')).toBe(true)
    expect(isHostSessionLeftover('claude_code_entrypoint', 'x')).toBe(true)
    expect(isHostSessionLeftover('CLAUDE_CONFIG_DIR', 'x')).toBe(false)
    expect(isHostSessionLeftover('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')).toBe(true)
    expect(isHostSessionLeftover('ANTHROPIC_BASE_URL', 'https://proxy.local')).toBe(false)
  })

  it('finds the config dir', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toBe('/c')
    expect(claudeConfigDir({}, '/h').replace(/\\/g, '/')).toBe('/h/.claude')
  })
})
