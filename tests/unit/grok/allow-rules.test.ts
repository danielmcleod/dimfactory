// Grok's read-only allow-rules scan and its secret-free TOML reading (the Grok ACP readonly mode,
// Readiness checks, as for Claude's read-only tool cut; review findings "Grok read-only passes run what the user's allow rules
// allow" and "the recorder reads a config.toml that can hold api_key"). Grok applies allow rules from its own config and
// from the user's Claude settings before it asks (user guide 22), so the scan reads both; secret lines never survive
// the read.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowRulesList,
  readonlyAllowRulesCopy,
  settingsFileLabel,
} from '@core/adapters/acp-base/allow-rules.ts'
import {
  grokSettingsFiles,
  grokTomlAllows,
  isRiskyAllowRule,
  projectFolders,
  scanGrokAllowRules,
} from '@core/adapters/grok/allow-rules.ts'
import { readGrokToml, tomlEntries, tomlKeyOf, withoutSecretLines } from '@core/adapters/grok/config-toml.ts'

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const claudeSettings = (allow: string[]): string => JSON.stringify({ permissions: { allow } })

describe('isRiskyAllowRule: what could change files or run a command that can', () => {
  it('shell rules as the read-only tool cut judges them; edits, MCP tools and unknown rules count; reads do not', () => {
    for (const rule of [
      'Bash',
      'Bash(npm *)',
      'Bash(npm run test:*)',
      'Bash(git *)',
      'Bash(git diff:*)',
      'bash(rm -rf build)',
      'PowerShell(Remove-Item *)',
      'Edit',
      'Edit(src/**)',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'mcp__github__create_issue',
      'Task',
      'what is this',
      '',
    ])
      expect(isRiskyAllowRule(rule), rule).toBe(true)
    for (const rule of [
      'Read',
      'Read(./docs/**)',
      'Glob',
      'Grep',
      'LS',
      'WebSearch',
      'WebFetch(domain:example.com)',
      'Bash(git status)',
      'Bash(git diff)',
      'Bash(ls *)',
      'PowerShell(Get-ChildItem *)',
    ])
      expect(isRiskyAllowRule(rule), rule).toBe(false)
  })
})

describe("Grok's TOML: allow rules and the sandbox's bash auto-allow", () => {
  it('[permission] allow (one line or several), dotted keys, inline and table rules, auto_allow_bash', () => {
    const text = [
      'model = "grok-4.6"',
      '[permission]',
      'allow = ["Bash(git status)", "Read"]',
      'deny = ["Bash(rm *)"]',
      'rules = [',
      '  { action = "allow", tool = "Bash", pattern = "npm *" },',
      '  { action = "deny", tool = "Edit" },',
      ']',
      '[[permission.rules]]',
      'action = "allow"',
      'tool = "Edit"',
      'pattern = "src/**"',
      '[[permission.rules]]',
      'action = "ask"',
      'tool = "Bash"',
      '[sandbox]',
      'auto_allow_bash = true',
    ].join('\n')
    expect(grokTomlAllows(text)).toEqual([
      'Bash(git status)',
      'Read',
      'Bash(npm *)',
      'sandbox.auto_allow_bash',
      'Edit(src/**)',
    ])
    expect(
      grokTomlAllows('permission.allow = [\n  "Write",\n  "Read",\n]\nsandbox.auto_allow_bash = false\n'),
    ).toEqual(['Write', 'Read'])
    // A rules value Dim Factory cannot read counts as one rule it cannot read (fail closed); an empty one is nothing.
    expect(grokTomlAllows('[permission]\nrules = "weird"\n')).toEqual([
      'permission.rules (could not be read)',
    ])
    expect(grokTomlAllows('[permission]\nrules = []\n')).toEqual([])
  })

  it('secret lines are dropped as the file is read (api_key, env_key, tokens, secrets)', () => {
    const text = [
      '[model.grok-4]',
      'api_key = "xai-REAL-SECRET-1"',
      "env_key = ['XAI_KEY_A',",
      "  'XAI_KEY_B']",
      'base_url = "https://api.x.ai/v1"',
      '[grok_com_config.oidc]',
      'client_secret = """',
      'multi-line-secret',
      '"""',
      'issuer = "https://sso.example.com"',
      '"refresh_token" = "rt-SECRET"',
      'max_tokens = 4096',
      '[permission]',
      'allow = ["Edit"]',
    ].join('\n')
    const kept = withoutSecretLines(text)
    for (const secret of ['xai-REAL-SECRET-1', 'XAI_KEY_A', 'XAI_KEY_B', 'multi-line-secret', 'rt-SECRET'])
      expect(kept).not.toContain(secret)
    expect(kept).toContain('base_url = "https://api.x.ai/v1"')
    expect(kept).toContain('issuer = "https://sso.example.com"')
    expect(kept).toContain('max_tokens = 4096')
    expect(grokTomlAllows(kept)).toEqual(['Edit'])
    expect(tomlKeyOf('  "a.b".api_key = 1')).toBe('api_key')
    expect(tomlKeyOf('[section]')).toBeUndefined()
    expect(tomlEntries(kept).some((e) => e.key.includes('api_key'))).toBe(false)
    // readGrokToml reads through the same filter.
    const file = join(temp('grok-toml-'), 'config.toml')
    writeFileSync(file, text)
    expect(readGrokToml(file)).toBe(kept)
    expect(readGrokToml(join(temp('grok-toml-'), 'missing.toml'))).toBeUndefined()
  })
})

describe('scanGrokAllowRules: the files Grok reads permission rules from', () => {
  it('user and local Claude settings, CLAUDE_CONFIG_DIR, the project up to its root, GROK_HOME and the project .grok', () => {
    const home = temp('grok-scan-home-')
    const grokHome = join(home, 'gh')
    const repo = join(temp('grok-scan-repo-'), 'repo')
    const cwd = join(repo, 'packages', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const configDir = temp('grok-scan-claude-')
    write(join(home, '.claude', 'settings.json'), claudeSettings(['Bash(npm *)', 'Read', 'Bash(git status)']))
    write(join(home, '.claude', 'settings.local.json'), claudeSettings(['Edit']))
    write(join(configDir, 'settings.json'), claudeSettings(['Write']))
    write(join(repo, '.claude', 'settings.local.json'), claudeSettings(['mcp__db__query']))
    write(join(cwd, '.claude', 'settings.json'), claudeSettings(['Grep']))
    write(
      join(grokHome, 'config.toml'),
      '[model.x]\napi_key = "xai-NOPE"\n[permission]\nallow = ["Bash(make *)"]\n',
    )
    write(join(repo, '.grok', 'config.toml'), '[sandbox]\nauto_allow_bash = true\n')
    const env = { GROK_HOME: grokHome, CLAUDE_CONFIG_DIR: configDir }

    const files = grokSettingsFiles({ cwd, env, home, platform: 'win32' })
    expect(files.claude).toEqual([
      join(home, '.claude', 'settings.json'),
      join(home, '.claude', 'settings.local.json'),
      join(configDir, 'settings.json'),
      join(configDir, 'settings.local.json'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
      join(repo, 'packages', '.claude', 'settings.json'),
      join(repo, 'packages', '.claude', 'settings.local.json'),
      join(repo, '.claude', 'settings.json'),
      join(repo, '.claude', 'settings.local.json'),
    ])
    expect(files.grok).toEqual([
      join(grokHome, 'config.toml'),
      join(grokHome, 'managed_config.toml'),
      join(repo, '.grok', 'config.toml'),
      join(repo, 'packages', '.grok', 'config.toml'),
      join(cwd, '.grok', 'config.toml'),
    ])
    expect(grokSettingsFiles({ cwd, env, home, platform: 'linux' }).grok).toContain(
      '/etc/grok/managed_config.toml',
    )

    const rules = scanGrokAllowRules({ cwd, env, home })
    expect(rules).toEqual([
      { file: join(home, '.claude', 'settings.json'), rule: 'Bash(npm *)' },
      { file: join(home, '.claude', 'settings.local.json'), rule: 'Edit' },
      { file: join(configDir, 'settings.json'), rule: 'Write' },
      { file: join(repo, '.claude', 'settings.local.json'), rule: 'mcp__db__query' },
      { file: join(grokHome, 'config.toml'), rule: 'Bash(make *)' },
      { file: join(repo, '.grok', 'config.toml'), rule: 'sandbox.auto_allow_bash' },
    ])
    expect(JSON.stringify(rules)).not.toContain('xai-NOPE')
  })

  it('nothing risky: an empty list (read-only rules and folders without settings)', () => {
    const home = temp('grok-scan-clean-')
    const cwd = temp('grok-scan-cwd-')
    write(join(home, '.claude', 'settings.json'), claudeSettings(['Read', 'Bash(git diff)', 'WebSearch']))
    expect(scanGrokAllowRules({ cwd, env: { GROK_HOME: join(home, 'gh') }, home })).toEqual([])
    // Without a repository the folder alone is the project.
    expect(projectFolders(cwd)).toEqual([cwd])
  })
})

describe('the copy (no em dashes; files named as the user knows them)', () => {
  it('names each rule and its file, at most four, then how many more', () => {
    const home = 'C:\\Users\\me'
    const cwd = 'C:\\work\\app'
    const rules = [
      { file: 'C:\\Users\\me\\.claude\\settings.json', rule: 'Bash(npm *)' },
      { file: 'C:\\work\\app\\.claude\\settings.local.json', rule: 'Edit' },
      { file: 'D:\\etc\\grok.toml', rule: 'Write' },
      { file: 'C:\\Users\\me\\.grok\\config.toml', rule: 'sandbox.auto_allow_bash' },
      { file: 'C:\\Users\\me\\.grok\\config.toml', rule: 'Bash(make *)' },
    ]
    if (process.platform === 'win32') {
      expect(settingsFileLabel(rules[0]!.file, { cwd, home })).toBe('~/.claude/settings.json')
      expect(settingsFileLabel(rules[1]!.file, { cwd, home })).toBe('.claude/settings.local.json')
      expect(settingsFileLabel(rules[2]!.file, { cwd, home })).toBe('D:\\etc\\grok.toml')
      expect(allowRulesList(rules, { cwd, home })).toBe(
        'Bash(npm *) in ~/.claude/settings.json, Edit in .claude/settings.local.json, Write in D:\\etc\\grok.toml, sandbox.auto_allow_bash in ~/.grok/config.toml and 1 more',
      )
    }
    const copy = readonlyAllowRulesCopy('Grok', 'review', rules.slice(0, 1), { cwd, home })
    expect(copy.title).toBe('Your allow rules would let Grok change files in Review')
    expect(copy.detail).toMatch(/^Grok applies your own allow rules before Dim Factory sees a request/)
    expect(copy.detail).toContain('Bash(npm *) in ')
    expect(copy.detail).toMatch(/so it does not run Review \(read-only\) on Grok in this folder/)
    expect(`${copy.title} ${copy.detail}`).not.toContain('\u2014')
  })
})
