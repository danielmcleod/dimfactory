import { describe, expect, it } from 'vitest'
import { sanitizeEnv, shouldRemoveEnvKey } from '../../../src/core/proc/env.ts'
import type { EnvPurpose } from '../../../src/core/proc/env.ts'

const HOST_SESSION = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  CLAUDE_CODE_SESSION_ID: 'a1b2c3d4',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  CLAUDE_CODE_ACCOUNT_UUID: 'uuid',
  CLAUDE_CODE_USER_EMAIL: 'someone@example.invalid',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_AGENT_SDK_VERSION: '0.3.286',
  CLAUDE_PID: '192484',
  CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1',
}

const COMMON = {
  HOME: '/home/u',
  NODE_OPTIONS: '--inspect',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  npm_config_prefix: '/x',
  npm_lifecycle_event: 'test',
  CODEX_SANDBOX: 'seatbelt',
  CODEX_SANDBOX_NETWORK_DISABLED: '1',
  GEMINI_CLI: '1',
  GIT_DIR: '/repo/.git',
  GIT_WORK_TREE: '/repo',
  GIT_INDEX_FILE: '/repo/.git/index',
  GIT_SSH_COMMAND: 'ssh -i key',
  GIT_SSH: 'plink',
  GIT_ASKPASS: 'askpass',
  GIT_AUTHOR_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'c@example.invalid',
  ANTHROPIC_API_KEY: 'kept',
  PATH: '/usr/bin',
}

describe('sanitizeEnv', () => {
  it('always removes runtime leakage and adds NO_COLOR/TERM/PATH', () => {
    const env = sanitizeEnv(COMMON, { purpose: 'vendor', path: '/resolved/bin:/usr/bin', platform: 'linux' })
    for (const k of [
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_NO_ATTACH_CONSOLE',
      'npm_config_prefix',
      'npm_lifecycle_event',
      'CODEX_SANDBOX',
      'CODEX_SANDBOX_NETWORK_DISABLED',
      'GEMINI_CLI',
    ]) {
      expect(env, k).not.toHaveProperty(k)
    }
    expect(env['PATH']).toBe('/resolved/bin:/usr/bin')
    expect(env['NO_COLOR']).toBe('1')
    expect(env['TERM']).toBe('dumb')
    expect(env['HOME']).toBe('/home/u')
    expect(env['ANTHROPIC_API_KEY']).toBe('kept')
  })

  const gitMatrix: [EnvPurpose, Record<string, boolean>][] = [
    [
      'vendor',
      {
        GIT_DIR: false,
        GIT_WORK_TREE: false,
        GIT_INDEX_FILE: false,
        GIT_SSH_COMMAND: true,
        GIT_SSH: true,
        GIT_ASKPASS: true,
        GIT_AUTHOR_NAME: true,
        GIT_COMMITTER_EMAIL: true,
      },
    ],
    [
      'verify',
      {
        GIT_DIR: false,
        GIT_WORK_TREE: false,
        GIT_SSH_COMMAND: true,
        GIT_AUTHOR_NAME: true,
      },
    ],
    [
      'git',
      {
        GIT_DIR: false,
        GIT_WORK_TREE: false,
        GIT_INDEX_FILE: false,
        GIT_SSH_COMMAND: false,
        GIT_ASKPASS: false,
        GIT_AUTHOR_NAME: false,
        GIT_COMMITTER_EMAIL: false,
      },
    ],
  ]
  it.each(gitMatrix)('GIT_* for purpose %s', (purpose, expected) => {
    const env = sanitizeEnv(COMMON, { purpose, platform: 'linux' })
    for (const [key, kept] of Object.entries(expected)) expect(key in env, key).toBe(kept)
    if (purpose === 'git') {
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
      expect(env['LC_ALL']).toBe('C')
    } else {
      expect(env).not.toHaveProperty('GIT_TERMINAL_PROMPT')
      expect(env).not.toHaveProperty('LC_ALL')
    }
  })

  it('outside a Claude Code session keeps user CLAUDE_CODE_* config but drops the session markers', () => {
    const base = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_PID: '1',
    }
    const env = sanitizeEnv(base, { purpose: 'vendor', platform: 'linux' })
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1')
    expect(env['CLAUDE_PID']).toBe('1')
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION')
  })

  it('launched from inside Claude Code (CLAUDECODE=1) removes every host-session variable', () => {
    const env = sanitizeEnv({ ...HOST_SESSION, KEEP: 'x' }, { purpose: 'vendor', platform: 'linux' })
    expect(Object.keys(env).sort()).toEqual(['KEEP', 'NO_COLOR', 'TERM'])
  })

  it('launchedFromClaude can be forced either way', () => {
    const forcedOn = sanitizeEnv(
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { purpose: 'vendor', launchedFromClaude: true, platform: 'linux' },
    )
    expect(forcedOn).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK')
    const forcedOff = sanitizeEnv(HOST_SESSION, {
      purpose: 'vendor',
      launchedFromClaude: false,
      platform: 'linux',
    })
    expect(forcedOff['CLAUDE_CODE_MESSAGING_TOKEN']).toBe('secret')
    expect(forcedOff).not.toHaveProperty('CLAUDECODE')
  })

  it('layers pathPrepend, vendor env and adapter extras in order', () => {
    const env = sanitizeEnv(
      { PATH: '/usr/bin', TERM: 'xterm-256color' },
      {
        purpose: 'vendor',
        platform: 'linux',
        pathPrepend: ['/opt/codex-path'],
        vendorEnv: { FAKE_CLI_SCRIPT: '/s.jsonl', TERM: 'from-vendor' },
        extra: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', TERM: 'from-adapter' },
      },
    )
    expect(env['PATH']).toBe('/opt/codex-path:/usr/bin')
    expect(env['FAKE_CLI_SCRIPT']).toBe('/s.jsonl')
    expect(env['CLAUDE_CODE_STARTUP_FAILURE_RESULTS']).toBe('1')
    expect(env['TERM']).toBe('from-adapter')
  })

  it('adapter extras survive the launched-from-Claude strip', () => {
    const env = sanitizeEnv(HOST_SESSION, {
      purpose: 'vendor',
      platform: 'linux',
      extra: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
    })
    expect(env['CLAUDE_CODE_STARTUP_FAILURE_RESULTS']).toBe('1')
  })

  describe('win32', () => {
    it('dedupes keys case-insensitively and writes PATH as Path', () => {
      const env = sanitizeEnv(
        { PATH: 'C:\\a', Path: 'C:\\b', SystemRoot: 'C:\\Windows', Node_Options: '--x', ClaudeCode: '1' },
        { purpose: 'vendor', path: 'C:\\resolved;C:\\Windows', pathPrepend: ['C:\\pre'], platform: 'win32' },
      )
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
      expect(env['Path']).toBe('C:\\pre;C:\\resolved;C:\\Windows')
      expect(env['SystemRoot']).toBe('C:\\Windows')
      expect(env).not.toHaveProperty('Node_Options')
      expect(env).not.toHaveProperty('ClaudeCode')
    })

    it('falls back to the base Path and lets vendor env override it as Path', () => {
      const env = sanitizeEnv({ Path: 'C:\\base' }, { purpose: 'vendor', platform: 'win32' })
      expect(env).toEqual({ Path: 'C:\\base', NO_COLOR: '1', TERM: 'dumb' })
      const overridden = sanitizeEnv(
        { Path: 'C:\\base' },
        { purpose: 'vendor', platform: 'win32', vendorEnv: { PATH: 'C:\\fake' } },
      )
      expect(overridden).toEqual({ Path: 'C:\\fake', NO_COLOR: '1', TERM: 'dumb' })
    })

    it('matches removal prefixes case-insensitively', () => {
      expect(shouldRemoveEnvKey('Electron_Run_As_Node', 'vendor', false, 'win32')).toBe(true)
      expect(shouldRemoveEnvKey('git_dir', 'vendor', false, 'win32')).toBe(true)
      expect(shouldRemoveEnvKey('Git_Ssh_Command', 'vendor', false, 'win32')).toBe(false)
      expect(shouldRemoveEnvKey('claude_code_foo', 'vendor', true, 'win32')).toBe(true)
    })
  })

  it('POSIX matching is case-sensitive', () => {
    expect(shouldRemoveEnvKey('node_options', 'vendor', false, 'linux')).toBe(false)
    expect(shouldRemoveEnvKey('NPM_CONFIG_PREFIX', 'vendor', false, 'linux')).toBe(false)
    expect(shouldRemoveEnvKey('npm_config_prefix', 'vendor', false, 'linux')).toBe(true)
  })

  it('drops undefined values and never mutates the input', () => {
    const base: Record<string, string | undefined> = { A: 'a', B: undefined, NODE_OPTIONS: 'x' }
    const env = sanitizeEnv(base, { purpose: 'git', platform: 'linux' })
    expect(env).not.toHaveProperty('B')
    expect(base['NODE_OPTIONS']).toBe('x')
  })
})
