// Settings > Extensions: what each vendor's own settings define (names only, read in memory, never logged), for the
// folder chosen (its project and local scopes) or the user's settings alone. Each vendor is read with the env its
// child would get (`vendors.<id>.env` over Dim Factory's), so CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME point
// where the CLI itself would look.
import type { DiscoveredExtensions, DiscoveredVendor } from '../../shared/extensions.ts'
import { EXTENSION_VENDORS, extensionsSupport, isAllowableSkillName } from '../../shared/extensions.ts'
import type { EnvInput } from '../proc/env.ts'
import { discoverClaude } from './claude.ts'
import type { ClaudeConnector } from './claude-connectors.ts'
import { discoverCodex } from './codex.ts'
import { discoverGemini } from './gemini.ts'

export interface DiscoverOptions {
  /** The env a vendor's child would see (base env with `vendors.<id>.env` on top). */
  envFor: (vendor: string) => EnvInput
  home?: string | undefined
  folder?: string | undefined
}

/** The names one vendor's settings define for `folder` (`null` for a vendor Dim Factory does not read). */
export function discoverVendor(vendor: string, o: DiscoverOptions): DiscoveredVendor | null {
  const base = { env: o.envFor(vendor), home: o.home, cwd: o.folder }
  const support = extensionsSupport(vendor)
  try {
    switch (vendor) {
      case 'claude': {
        const c = discoverClaude(base)
        return {
          vendor,
          mcp: c.mcp,
          skills: c.skills,
          plugins: c.plugins,
          agents: c.agents,
          complete: c.complete,
          support,
        }
      }
      case 'codex': {
        const c = discoverCodex(base)
        return { vendor, mcp: c.mcp, skills: [], plugins: c.plugins, complete: c.complete, support }
      }
      case 'gemini': {
        const g = discoverGemini(base)
        return { vendor, mcp: g.mcp, skills: [], plugins: g.plugins, complete: g.complete, support }
      }
      default:
        return null
    }
  } catch {
    // A reader bug never breaks Settings: the vendor shows as not fully read.
    return { vendor, mcp: [], skills: [], plugins: [], complete: false, support }
  }
}

/**
 * Claude's lists with what the probe's initialize-only handshake named (no tokens): skills and subagents the settings
 * files do not show (plugins', claude.ai-synced) are added; what the files found keeps its scope.
 */
export function withHandshakeNames(
  found: DiscoveredExtensions,
  names: { skills: readonly string[]; agents: readonly string[] } | undefined,
): DiscoveredExtensions {
  if (names === undefined) return found
  return {
    vendors: found.vendors.map((v) => {
      if (v.vendor !== 'claude') return v
      const skills = [...v.skills]
      for (const n of names.skills) {
        if (skills.some((s) => s.name === n)) continue
        skills.push({
          name: n,
          scope: n.includes(':') ? 'plugin' : 'user',
          allowable: isAllowableSkillName(n),
        })
      }
      const agents = [...(v.agents ?? [])]
      for (const n of names.agents) if (!agents.includes(n)) agents.push(n)
      return { ...v, skills, agents }
    }),
  }
}

/** Claude's MCP servers with the claude.ai connectors this app session listed (scope `account`). */
export function withConnectors(
  found: DiscoveredExtensions,
  connectors: readonly ClaudeConnector[] | undefined,
): DiscoveredExtensions {
  if (connectors === undefined || connectors.length === 0) return found
  return {
    vendors: found.vendors.map((v) => {
      if (v.vendor !== 'claude') return v
      const mcp = [...v.mcp]
      for (const c of connectors) {
        // A server of the user's own settings with that name wins, as it does at launch.
        if (mcp.some((m) => m.name === c.name)) continue
        mcp.push({ name: c.name, scope: 'account', allowable: true, label: c.label, status: c.status })
      }
      return { ...v, mcp }
    }),
  }
}

export function discoverExtensions(o: DiscoverOptions): DiscoveredExtensions {
  const vendors: DiscoveredVendor[] = []
  for (const v of EXTENSION_VENDORS) {
    const d = discoverVendor(v, o)
    if (d !== null) vendors.push(d)
  }
  return { vendors }
}
