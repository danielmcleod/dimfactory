// Codex's own extensions, names only: the MCP servers of the user's config.toml (CODEX_HOME as the child sees it, else
// ~/.codex) and of the project config files in the pass folder (mcp-isolation.ts reads them the same way for a pass),
// and the plugins config.toml names (`[plugins."<name>"]`). Codex cannot limit skills or plugins for one pass, so they
// are listed for information only.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DiscoveredItem } from '../../shared/extensions.ts'
import { isAllowableMcpName } from '../../shared/extensions.ts'
import { CODEX_APPS } from '../adapters/codex/launch.ts'
import { parseCodexMcpServers, projectConfigPaths } from '../adapters/codex/mcp-isolation.ts'
import { codexHome } from '../adapters/codex/session.ts'
import type { EnvInput } from '../proc/env.ts'
import type { Reader } from './files.ts'
import { defaultReader, readMaybe } from './files.ts'

const PLUGIN_HEADER = /^\s*\[\s*plugins\s*\.\s*(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_@.-]+))\s*\]/

/** Plugin names in a config.toml (`[plugins."name@marketplace"]` tables). */
export function codexPluginNames(toml: string): string[] {
  const out: string[] = []
  for (const line of toml.split(/\r?\n/)) {
    const m = PLUGIN_HEADER.exec(line)
    const n = m?.[1] ?? m?.[2] ?? m?.[3]
    if (n !== undefined && !out.includes(n)) out.push(n)
  }
  return out
}

export interface CodexExtensions {
  mcp: DiscoveredItem[]
  plugins: string[]
  complete: boolean
}

export function discoverCodex(o: {
  env: EnvInput
  home?: string | undefined
  cwd?: string | undefined
  read?: Reader | undefined
  isRoot?: ((dir: string) => boolean) | undefined
}): CodexExtensions {
  const read = o.read ?? defaultReader
  const userFile = join(codexHome(o.env, o.home ?? homedir()), 'config.toml')
  const mcp: DiscoveredItem[] = []
  const plugins: string[] = []
  let complete = true
  const take = (file: string, scope: 'user' | 'project'): void => {
    const text = readMaybe(read, file)
    if (text === null) return
    if (text === undefined) {
      complete = false
      return
    }
    const parsed = parseCodexMcpServers(text)
    if (!parsed.ok) complete = false
    for (const name of parsed.names) {
      if (mcp.some((m) => m.name === name)) continue
      mcp.push({ name, scope, allowable: isAllowableMcpName(name) })
    }
    for (const p of codexPluginNames(text)) if (!plugins.includes(p)) plugins.push(p)
  }
  if (o.cwd !== undefined && o.cwd !== '') {
    for (const file of projectConfigPaths(o.cwd, o.isRoot)) {
      if (resolve(file).toLowerCase() !== resolve(userFile).toLowerCase()) take(file, 'project')
    }
  }
  take(userFile, 'user')
  // The apps linked to the account come through Codex's built-in server, not config.toml: always listed, so the user
  // can allow them for a pass (launch.ts featuresOffKeys keeps `features.apps` on then).
  if (!mcp.some((m) => m.name === CODEX_APPS))
    mcp.push({ name: CODEX_APPS, scope: 'account', allowable: true })
  return { mcp, plugins, complete }
}
