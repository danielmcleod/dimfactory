// claude.ai connectors: the name each is allowed under, what an `mcp_status` reply gives (C22a), and when listing them
// is refused because the session would start other MCP servers too.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECTORS_BLOCKED,
  connectorKey,
  connectorListingBlocked,
  managedMcpFile,
  parseConnectors,
} from '@core/extensions/claude-connectors.ts'
import { withConnectors } from '@core/extensions/discover.ts'
import type { DiscoveredExtensions } from '@shared/extensions.ts'
import { connectorStatusText, isAllowableMcpName } from '@shared/extensions.ts'

const temp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const proxy = (n: string): { type: 'claudeai-proxy'; url: string; id: string } => ({
  type: 'claudeai-proxy',
  url: `https://mcp-proxy.example.invalid/${n}`,
  id: `srv_${n}`,
})

describe('connectorKey', () => {
  it('is the spelling the CLI uses in tool names, always an allowable name', () => {
    expect(connectorKey('claude.ai Example Mail')).toBe('claude_ai_Example_Mail')
    expect(connectorKey('-odd name')).toBe('_odd_name')
    expect(connectorKey('x'.repeat(300))).toHaveLength(128)
    for (const l of ['claude.ai Ünïcode', '...', 'a b'])
      expect(isAllowableMcpName(connectorKey(l) ?? '')).toBe(true)
  })
})

describe('parseConnectors', () => {
  it('takes the claude.ai-scoped claudeai-proxy servers only, with their status, once per name', () => {
    const reply = {
      mcpServers: [
        {
          name: 'claude.ai Mail',
          status: 'connected',
          scope: 'claudeai',
          source: 'claudeai',
          config: proxy('a'),
        },
        { name: 'claude.ai Drive', status: 'needs-auth', scope: 'claudeai', config: proxy('b') },
        { name: 'mine', status: 'connected', scope: 'user', config: { command: 'node' } },
        { name: 'dyn', status: 'connected', source: 'dynamic', config: proxy('c') },
        { name: 'claude.ai Mail', status: 'connected', source: 'claudeai', config: proxy('d') },
        {
          name: 'claude.ai Plain',
          source: 'claudeai',
          config: { type: 'claudeai-proxy', url: 'http://x', id: 'y' },
        },
        'junk',
      ],
    }
    expect(parseConnectors(reply)).toEqual([
      { name: 'claude_ai_Mail', label: 'claude.ai Mail', status: 'connected', def: proxy('a') },
      { name: 'claude_ai_Drive', label: 'claude.ai Drive', status: 'needs-auth', def: proxy('b') },
    ])
    expect(parseConnectors(undefined)).toEqual([])
    expect(parseConnectors({ mcpServers: 'no' })).toEqual([])
  })
})

describe('connectorListingBlocked', () => {
  const config = (doc: object, settings?: object): string => {
    const dir = temp('claude-config-')
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(doc))
    if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
    return dir
  }
  const absent = join(temp('no-managed-'), 'managed-mcp.json')

  it('nothing else would start: listing is allowed', () => {
    const cwd = temp('connectors-cwd-')
    expect(
      connectorListingBlocked({
        env: { CLAUDE_CONFIG_DIR: config({}) },
        home: temp('h-'),
        cwd,
        managedFile: absent,
      }),
    ).toBeUndefined()
  })

  it('a user server, an enabled plugin, managed servers or an unreadable settings file: refused, with why', () => {
    const cwd = temp('connectors-cwd-')
    const home = temp('h-')
    expect(
      connectorListingBlocked({
        env: { CLAUDE_CONFIG_DIR: config({ mcpServers: { mine: { command: 'node' } } }) },
        home,
        cwd,
        managedFile: absent,
      }),
    ).toBe(CONNECTORS_BLOCKED.servers)
    expect(
      connectorListingBlocked({
        env: { CLAUDE_CONFIG_DIR: config({}, { enabledPlugins: { 'tools@mkt': true } }) },
        home,
        cwd,
        managedFile: absent,
      }),
    ).toBe(CONNECTORS_BLOCKED.plugins)
    const managed = join(temp('managed-'), 'managed-mcp.json')
    writeFileSync(managed, '{}')
    expect(
      connectorListingBlocked({ env: { CLAUDE_CONFIG_DIR: config({}) }, home, cwd, managedFile: managed }),
    ).toBe(CONNECTORS_BLOCKED.managed)
    const broken = temp('claude-config-')
    writeFileSync(join(broken, '.claude.json'), '{not json')
    expect(
      connectorListingBlocked({ env: { CLAUDE_CONFIG_DIR: broken }, home, cwd, managedFile: absent }),
    ).toBe(CONNECTORS_BLOCKED.unread)
    // A folder's own .mcp.json counts too.
    const project = temp('connectors-cwd-')
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: 'node' } } }))
    expect(
      connectorListingBlocked({
        env: { CLAUDE_CONFIG_DIR: config({}) },
        home,
        cwd: project,
        managedFile: absent,
      }),
    ).toBe(CONNECTORS_BLOCKED.servers)
    for (const why of Object.values(CONNECTORS_BLOCKED)) expect(why).not.toContain('—')
  })

  it('the managed servers file is where Claude Code reads it on each OS', () => {
    expect(managedMcpFile('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-mcp.json')
    expect(managedMcpFile('linux')).toBe('/etc/claude-code/managed-mcp.json')
    expect(managedMcpFile('win32')).toMatch(/ClaudeCode[\\/]managed-mcp\.json$/)
  })
})

describe('withConnectors and their status text', () => {
  it('adds the listed connectors to the Claude servers as Account items; a settings server of that name wins', () => {
    const found: DiscoveredExtensions = {
      vendors: [
        {
          vendor: 'claude',
          mcp: [{ name: 'claude_ai_Mail', scope: 'user', allowable: true }],
          skills: [],
          plugins: [],
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
    const out = withConnectors(found, [
      { name: 'claude_ai_Mail', label: 'claude.ai Mail', status: 'connected', def: proxy('a') },
      { name: 'claude_ai_Drive', label: 'claude.ai Drive', status: 'needs-auth', def: proxy('b') },
    ])
    expect(out.vendors[0]?.mcp).toEqual([
      { name: 'claude_ai_Mail', scope: 'user', allowable: true },
      {
        name: 'claude_ai_Drive',
        scope: 'account',
        allowable: true,
        label: 'claude.ai Drive',
        status: 'needs-auth',
      },
    ])
    expect(out.vendors[1]).toBe(found.vendors[1])
    expect(withConnectors(found, undefined)).toBe(found)
    // The definition never travels to the renderer.
    expect(JSON.stringify(out)).not.toContain('srv_')
  })

  it('says a status that is not connected in plain words', () => {
    expect(connectorStatusText('connected')).toBeUndefined()
    expect(connectorStatusText(undefined)).toBeUndefined()
    expect(connectorStatusText('needs-auth')).toBe('Needs sign-in on claude.ai')
    expect(connectorStatusText('failed')).toBe('Did not connect')
    expect(connectorStatusText('pending')).toBe('Not connected yet')
  })
})
