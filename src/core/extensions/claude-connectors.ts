// claude.ai connectors: the MCP servers a Claude account links on claude.ai. The CLI fetches them only when strict MCP
// is off (C22a/C22b: under `--strict-mcp-config` its `mcp_status` lists none; without it, it lists them with scope
// `claudeai` and their `claudeai-proxy` definition), and a session with strict MCP off also starts every MCP server the
// user, the folder and the enabled plugins define. So Dim Factory lists them (an initialize-only session that asks
// `mcp_status` and never sends a user message: no tokens) only where such a session would start nothing else, and
// never with `claude mcp list`.
// One is allowed for a pass as an explicit `claudeai-proxy` entry in the allowed servers' config file, which the CLI
// connects under `--strict-mcp-config` whatever ENABLE_CLAUDEAI_MCP_SERVERS says (C22c). Its address and id are kept in
// memory only, for the launches of this app session, and never logged or stored.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isAllowableMcpName } from '../../shared/extensions.ts'
import { discoverClaude } from './claude.ts'
import type { ClaudeOptions } from './claude.ts'
import { isObj } from './files.ts'

/** A connector's launch definition (the `mcp_status` config of a connector, as the CLI reports it). */
export interface ConnectorDef {
  type: 'claudeai-proxy'
  url: string
  id: string
}

export interface ClaudeConnector {
  /** The name Dim Factory allows it under (its claude.ai name with anything but letters, digits, - and _ as _). */
  name: string
  /** Its name on claude.ai. */
  label: string
  /** `mcp_status` status when listed: connected, needs-auth, failed, pending or disabled. */
  status: string
  def: ConnectorDef
}

/**
 * The allow-list name of a connector: the CLI's own spelling in tool names (`claude.ai Example` → `claude_ai_Example`),
 * cut to the 128 characters an allowed name may have. Undefined when nothing allowable is left.
 */
export function connectorKey(label: string): string | undefined {
  const key = label
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^-+/, '_')
    .slice(0, 128)
  return isAllowableMcpName(key) ? key : undefined
}

/** The connectors in an `mcp_status` reply (`{mcpServers: [...]}`): scope `claudeai`, a `claudeai-proxy` config. */
export function parseConnectors(response: unknown): ClaudeConnector[] {
  const list = isObj(response) ? response['mcpServers'] : undefined
  if (!Array.isArray(list)) return []
  const out: ClaudeConnector[] = []
  for (const s of list) {
    if (!isObj(s)) continue
    const scope = s['source'] ?? s['scope']
    const config = s['config']
    const label = s['name']
    if (scope !== 'claudeai' || !isObj(config) || typeof label !== 'string') continue
    const { type, url, id } = config
    if (type !== 'claudeai-proxy' || typeof url !== 'string' || typeof id !== 'string') continue
    if (!/^https:\/\//i.test(url) || url.length > 2048 || id.length > 512) continue
    const name = connectorKey(label)
    if (name === undefined || out.some((c) => c.name === name)) continue
    out.push({
      name,
      label,
      status: typeof s['status'] === 'string' ? s['status'] : 'unknown',
      def: { type, url, id },
    })
  }
  return out
}

/** Where Claude Code reads managed (enterprise) MCP servers on each OS. */
export function managedMcpFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32')
    return join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'ClaudeCode', 'managed-mcp.json')
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-mcp.json'
  return '/etc/claude-code/managed-mcp.json'
}

/** Why connectors are not listed: a session with strict MCP off would start other MCP servers too. */
export const CONNECTORS_BLOCKED = {
  servers:
    'Listing your claude.ai connectors would also start the MCP servers in your Claude settings, so Dim Factory does not list them.',
  plugins:
    'Listing your claude.ai connectors would also start the MCP servers your Claude plugins bring, so Dim Factory does not list them.',
  managed:
    'Listing your claude.ai connectors would also start the MCP servers your organization manages, so Dim Factory does not list them.',
  unread:
    'Dim Factory could not read all of your Claude settings, so it does not list your claude.ai connectors.',
} as const

/**
 * Undefined when a Claude session in `cwd` (an empty folder of Dim Factory's own) would start no MCP server but the
 * account's connectors: no user or local server, no `.mcp.json` from that folder up, no enabled plugin, no managed
 * servers, and every settings file read. Otherwise why not.
 */
export function connectorListingBlocked(
  o: ClaudeOptions & { cwd: string; managedFile?: string | undefined },
): string | undefined {
  const found = discoverClaude(o)
  if (!found.complete) return CONNECTORS_BLOCKED.unread
  if (found.mcp.length > 0) return CONNECTORS_BLOCKED.servers
  if (found.plugins.length > 0) return CONNECTORS_BLOCKED.plugins
  if (existsSync(o.managedFile ?? managedMcpFile())) return CONNECTORS_BLOCKED.managed
  return undefined
}

/** What listing the connectors found. */
export type ConnectorListing =
  { ok: true; connectors: ClaudeConnector[] } | { ok: false; blocked?: string; error?: string }
