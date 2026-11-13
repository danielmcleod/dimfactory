// Extensions discovery: names only, from each vendor's own settings files, in temp homes (never the real ~/.claude,
// ~/.codex or ~/.gemini: every reader here gets an explicit home and env). Also the definitions Claude's launch copies
// for the allowed servers, the parts of Claude's global file that are kept (none of the account or a key), the names
// redactor and the sweep of leftover allowed-servers files.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeCustomAgents,
  claudeGlobalFiles,
  claudeGlobalMcpOnly,
  claudeMcpDefinitions,
  discoverClaude,
  readClaudeMcp,
} from '@core/extensions/claude.ts'
import { handshakeNames } from '@core/adapters/claude/probe.ts'
import { codexPluginNames, discoverCodex } from '@core/extensions/codex.ts'
import { discoverExtensions, discoverVendor, withHandshakeNames } from '@core/extensions/discover.ts'
import { parseJsonc } from '@core/extensions/files.ts'
import { discoverGemini } from '@core/extensions/gemini.ts'
import { namesRedactor, REDACTED_NAME } from '@core/extensions/redact.ts'
import { MCP_SCRATCH_FILE, scratchDirOf, sweepMcpScratch } from '@core/extensions/scratch.ts'

const tmp = (p = 'ext-'): string => mkdtempSync(join(tmpdir(), p))
const write = (path: string, content: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}
const skill = (dir: string, name: string): void =>
  write(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)

/** A project folder that is its own git root (so the walk up stops there). */
function project(): string {
  const p = tmp('ext-project-')
  mkdirSync(join(p, '.git'))
  return p
}

describe('Claude', () => {
  function claudeHome(): { home: string; env: Record<string, string>; dir: string } {
    const home = tmp('ext-home-')
    const dir = join(home, 'claude-config')
    return { home, dir, env: { CLAUDE_CONFIG_DIR: dir } }
  }

  it("keeps only the MCP entries of the CLI's global file: never its account, key or anything else", () => {
    const doc = {
      primaryApiKey: 'sk-ant-api03-SECRET',
      oauthAccount: { emailAddress: 'me@example.invalid' },
      mcpServers: { github: { command: 'gh-mcp' } },
      projects: {
        'C:/work/app': { mcpServers: { db: { command: 'db' } }, allowedTools: ['x'] },
        '/other': {},
      },
      userID: 'u',
    }
    const kept = claudeGlobalMcpOnly(doc)
    expect(kept).toEqual({
      mcpServers: { github: { command: 'gh-mcp' } },
      projects: { 'C:/work/app': { db: { command: 'db' } } },
    })
    expect(JSON.stringify(kept)).not.toMatch(/SECRET|example\.invalid|userID|allowedTools/)
  })

  it('reads user, local and project servers (CLAUDE_CONFIG_DIR moves the global file), in precedence order', () => {
    const { home, env, dir } = claudeHome()
    const proj = project()
    expect(claudeGlobalFiles(env, home)).toEqual([join(dir, '.config.json'), join(dir, '.claude.json')])
    write(join(dir, '.claude.json'), {
      primaryApiKey: 'sk-ant-api03-SECRET',
      mcpServers: { github: { command: 'gh-user' }, shared: { command: 'user-shared' } },
      projects: {
        [proj.replace(/\\/g, '/')]: {
          mcpServers: { localdb: { command: 'db' }, shared: { command: 'local' } },
        },
      },
    })
    write(join(proj, '.mcp.json'), {
      mcpServers: { team: { type: 'http', url: 'https://t.example' }, shared: {} },
    })
    const r = readClaudeMcp({ env, home, cwd: proj })
    expect(r.complete).toBe(true)
    expect(r.servers.map((s) => [s.name, s.scope])).toEqual([
      ['localdb', 'local'],
      ['shared', 'local'],
      ['team', 'project'],
      ['github', 'user'],
    ])
    // Without a folder: the user scope only.
    expect(readClaudeMcp({ env, home }).servers.map((s) => s.name)).toEqual(['github', 'shared'])
    // Without CLAUDE_CONFIG_DIR the global file is in the home folder.
    expect(claudeGlobalFiles({}, home)).toEqual([
      join(home, '.claude', '.config.json'),
      join(home, '.claude.json'),
    ])
  })

  it('copies the definitions of the allowed names only (the first scope wins), never an unsafe name', () => {
    const { home, env, dir } = claudeHome()
    const proj = project()
    write(join(dir, '.claude.json'), {
      mcpServers: {
        alpha: { command: 'a', env: { TOKEN: 'stand-in-secret' } },
        beta: { command: 'b' },
        'bad name': { command: 'x' },
      },
    })
    write(join(proj, '.mcp.json'), { mcpServers: { beta: { command: 'project-b' } } })
    expect(
      claudeMcpDefinitions({ env, home, cwd: proj, names: ['alpha', 'beta', 'bad name', 'gone'] }),
    ).toEqual({
      alpha: { command: 'a', env: { TOKEN: 'stand-in-secret' } },
      beta: { command: 'project-b' },
    })
  })

  it('a file that cannot be parsed makes the answer incomplete; a missing one does not', () => {
    const { home, env, dir } = claudeHome()
    expect(readClaudeMcp({ env, home }).complete).toBe(true)
    write(join(dir, '.claude.json'), '{ not json')
    expect(readClaudeMcp({ env, home })).toEqual({ servers: [], complete: false })
  })

  it('lists project and user skills and the skills of enabled plugins (plugin:skill), with plugin ids', () => {
    const { home, env, dir } = claudeHome()
    const proj = project()
    skill(join(dir, 'skills'), 'pdf')
    skill(join(dir, 'skills'), 'odd name')
    mkdirSync(join(dir, 'skills', 'no-skill-file'), { recursive: true })
    skill(join(proj, '.claude', 'skills'), 'deploy')
    const install = join(dir, 'plugins', 'cache', 'mkt', 'tools', '1.0.0')
    skill(join(install, 'skills'), 'lint')
    write(join(dir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'tools@mkt': [{ scope: 'user', installPath: install }],
        'off@mkt': [{ installPath: install }],
      },
    })
    write(join(dir, 'settings.json'), { enabledPlugins: { 'tools@mkt': true, 'off@mkt': false } })
    const d = discoverClaude({ env, home, cwd: proj })
    expect(d.skills).toEqual([
      { name: 'deploy', scope: 'project', allowable: true },
      { name: 'odd name', scope: 'user', allowable: false },
      { name: 'pdf', scope: 'user', allowable: true },
      { name: 'tools:lint', scope: 'plugin', allowable: true },
    ])
    expect(d.plugins).toEqual(['tools@mkt'])
    expect(d.complete).toBe(true)
  })

  it("lists custom subagents: the user's, the project's (front matter name, else the file) and enabled plugins'", () => {
    const { home, env, dir } = claudeHome()
    const proj = project()
    write(
      join(dir, 'agents', 'reviewer.md'),
      ['---', 'name: code-reviewer', 'description: x', '---', 'Body.'].join('\n'),
    )
    write(join(proj, '.claude', 'agents', 'nested', 'helper.md'), 'No front matter.\n')
    write(join(proj, '.claude', 'agents', 'notes.txt'), 'not an agent')
    const install = join(dir, 'plugins', 'cache', 'mkt', 'tools', '1.0.0')
    write(
      join(install, 'agents', 'fixer.md'),
      ['---', 'name: "fixer"', 'permissionMode: bypassPermissions', '---'].join('\n'),
    )
    write(join(dir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'tools@mkt': [{ installPath: install }] },
    })
    write(join(dir, 'settings.json'), { enabledPlugins: { 'tools@mkt': true } })
    expect(claudeCustomAgents({ env, home, cwd: proj })).toEqual(['helper', 'code-reviewer', 'tools:fixer'])
    expect(discoverClaude({ env, home, cwd: proj }).agents).toEqual([
      'helper',
      'code-reviewer',
      'tools:fixer',
    ])
    // None anywhere: the read-only passes keep the built-in subagents.
    const empty = claudeHome()
    expect(claudeCustomAgents({ env: empty.env, home: empty.home, cwd: project() })).toEqual([])
  })

  it("the probe handshake's names: commands not marked built in, and subagents that are not the CLI's", () => {
    const names = handshakeNames({
      commands: [
        { name: 'review', description: 'x', builtin: true },
        { name: 'pdf', description: 'x' },
        { name: 'anthropic-skills:docx', description: 'x' },
        { name: 'pdf', description: 'again' },
      ],
      agents: [{ name: 'Explore' }, { name: 'general-purpose' }, { name: 'code-reviewer' }],
    })
    expect(names).toEqual({ skills: ['pdf', 'anthropic-skills:docx'], agents: ['code-reviewer'] })
    expect(handshakeNames(undefined)).toEqual({ skills: [], agents: [] })
  })

  it('merges what the handshake named into the Claude lists, keeping what the files found', () => {
    const found = {
      vendors: [
        {
          vendor: 'claude',
          mcp: [],
          skills: [{ name: 'pdf', scope: 'project' as const, allowable: true }],
          plugins: [],
          agents: ['helper'],
          complete: true,
          support: { mcp: true, skills: true },
        },
        {
          vendor: 'codex',
          mcp: [],
          skills: [],
          plugins: [],
          complete: true,
          support: { mcp: true, skills: false },
        },
      ],
    }
    const merged = withHandshakeNames(found, {
      skills: ['pdf', 'anthropic-skills:docx', 'odd name'],
      agents: ['helper', 'code-reviewer'],
    })
    expect(merged.vendors[0]?.skills).toEqual([
      { name: 'pdf', scope: 'project', allowable: true },
      { name: 'anthropic-skills:docx', scope: 'plugin', allowable: true },
      { name: 'odd name', scope: 'user', allowable: false },
    ])
    expect(merged.vendors[0]?.agents).toEqual(['helper', 'code-reviewer'])
    expect(merged.vendors[1]).toEqual(found.vendors[1])
    expect(withHandshakeNames(found, undefined)).toBe(found)
  })
})

describe('Codex', () => {
  it('lists config.toml servers of the user and the project folder, and the plugins it names', () => {
    const home = tmp('ext-codex-')
    const codexHome = join(home, 'codex')
    const proj = project()
    write(
      join(codexHome, 'config.toml'),
      [
        'model = "x"',
        '[mcp_servers.alpha]',
        'command = "a"',
        '[mcp_servers."bad.name"]',
        'command = "b"',
        '[plugins."github@openai-curated"]',
        'enabled = true',
      ].join('\n'),
    )
    write(join(proj, '.codex', 'config.toml'), '[mcp_servers.team]\ncommand = "t"\n')
    const d = discoverCodex({ env: { CODEX_HOME: codexHome }, home, cwd: proj })
    expect(d.mcp).toEqual([
      { name: 'team', scope: 'project', allowable: true },
      { name: 'alpha', scope: 'user', allowable: true },
      { name: 'bad.name', scope: 'user', allowable: false },
      // The apps linked to the account (Codex's built-in server, not in config.toml) can always be allowed.
      { name: 'codex_apps', scope: 'account', allowable: true },
    ])
    expect(d.plugins).toEqual(['github@openai-curated'])
    expect(d.complete).toBe(true)
    expect(codexPluginNames("[plugins.'x@y']\n[plugins.bare]\n[pluginsx.no]")).toEqual(['x@y', 'bare'])
  })

  it('a shape the reader does not follow makes it incomplete', () => {
    const home = tmp('ext-codex-')
    write(join(home, 'c', 'config.toml'), 'mcp_servers = { a = { command = "x" } }\n')
    expect(discoverCodex({ env: { CODEX_HOME: join(home, 'c') }, home }).complete).toBe(false)
  })
})

describe('Gemini', () => {
  it('lists settings (comments allowed), workspace and extension servers, and the extensions', () => {
    const home = tmp('ext-gemini-')
    const proj = project()
    write(
      join(home, '.gemini', 'settings.json'),
      '{\n  // mine\n  "mcpServers": { "alpha": { "command": "a" }, /* x */ "beta": { "url": "https://b" }, },\n}',
    )
    write(join(proj, '.gemini', 'settings.json'), { mcpServers: { team: { command: 't' } } })
    write(join(home, '.gemini', 'extensions', 'ext-dir', 'gemini-extension.json'), {
      name: 'tools',
      mcpServers: { extsrv: { command: 'e' } },
    })
    const d = discoverGemini({ env: {}, home, cwd: proj })
    expect(d.mcp).toEqual([
      { name: 'team', scope: 'project', allowable: true },
      { name: 'alpha', scope: 'user', allowable: true },
      { name: 'beta', scope: 'user', allowable: true },
      { name: 'extsrv', scope: 'extension', allowable: true },
    ])
    expect(d.plugins).toEqual(['tools'])
    expect(d.complete).toBe(true)
    // GEMINI_CLI_HOME moves the folder.
    expect(discoverGemini({ env: { GEMINI_CLI_HOME: tmp() }, home }).mcp).toEqual([])
  })

  it('parseJsonc keeps strings with slashes and drops comments and trailing commas', () => {
    expect(parseJsonc('{"u":"https://x//y", /* c */ "a":[1,2,],}')).toEqual({ u: 'https://x//y', a: [1, 2] })
  })
})

describe('discoverExtensions', () => {
  it('reads Claude, Codex and Gemini (with what each can limit), each with its own env', () => {
    const home = tmp('ext-all-')
    const seen: string[] = []
    const r = discoverExtensions({
      home,
      envFor: (v) => {
        seen.push(v)
        return v === 'codex' ? { CODEX_HOME: join(home, 'nothing') } : {}
      },
    })
    expect(r.vendors.map((v) => [v.vendor, v.support])).toEqual([
      ['claude', { mcp: true, skills: true }],
      ['codex', { mcp: true, skills: false }],
      ['gemini', { mcp: true, skills: false }],
    ])
    expect(seen).toEqual(['claude', 'codex', 'gemini'])
    expect(discoverVendor('grok', { home, envFor: () => ({}) })).toBeNull()
  })
})

describe('namesRedactor', () => {
  it('hides each name where it stands alone (JSON, a list, a flag value, an MCP tool name), not inside other words', () => {
    const r = namesRedactor(['alpha', 'db'])
    expect(r('{"name":"alpha","tools":["mcp__alpha__query"]}')).toBe(
      `{"name":"${REDACTED_NAME}","tools":["mcp__${REDACTED_NAME}__query"]}`,
    )
    expect(r('--allowed-mcp-server-names alpha,db')).toBe(
      `--allowed-mcp-server-names ${REDACTED_NAME},${REDACTED_NAME}`,
    )
    expect(r('alphabet dbx my-db db')).toBe(`alphabet dbx my-db ${REDACTED_NAME}`)
    expect(namesRedactor([])('alpha')).toBe('alpha')
    expect(namesRedactor(['a.b'])('a.b axb')).toBe(`${REDACTED_NAME} axb`)
  })
})

describe('sweepMcpScratch', () => {
  it("removes only the allowed-servers files a crash left in the runs' scratch folders", async () => {
    const run = tmp('ext-run-')
    const scratch = scratchDirOf(run)
    mkdirSync(scratch)
    const left = 'mcp-0b0c8b0e-0f1a-4c2b-9d3e-1a2b3c4d5e6f.json'
    expect(MCP_SCRATCH_FILE.test(left)).toBe(true)
    writeFileSync(join(scratch, left), '{}')
    writeFileSync(join(scratch, 'other.json'), '{}')
    expect(await sweepMcpScratch([run, join(run, 'no-such-run')])).toBe(1)
    expect(readdirSync(scratch)).toEqual(['other.json'])
  })
})
