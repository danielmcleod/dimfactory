// Gemini's own extensions, names only: the MCP servers of the user's settings (`<GEMINI_CLI_HOME or home>/.gemini/
// settings.json`), of the folder's workspace settings (`.gemini/settings.json`) and of its installed extensions
// (`.gemini/extensions/<name>/gemini-extension.json`). Gemini loads every one of them whatever a client sends in
// session/new, so a pass limits them with `--allowed-mcp-server-names` (gemini/config.ts).
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import type { DiscoveredItem, ExtensionScope } from '../../shared/extensions.ts'
import { isAllowableMcpName } from '../../shared/extensions.ts'
import { geminiDir } from '../adapters/gemini/home.ts'
import type { EnvInput } from '../proc/env.ts'
import type { Reader } from './files.ts'
import { defaultReader, objectAt, readJsonObject } from './files.ts'

export interface GeminiExtensions {
  mcp: DiscoveredItem[]
  /** Installed extensions (Gemini's plugins). */
  plugins: string[]
  complete: boolean
}

const subfolders = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export function discoverGemini(o: {
  env: EnvInput
  home?: string | undefined
  cwd?: string | undefined
  read?: Reader | undefined
}): GeminiExtensions {
  const read = o.read ?? defaultReader
  const dir = geminiDir(o.env, o.home ?? homedir())
  const mcp: DiscoveredItem[] = []
  const plugins: string[] = []
  let complete = true
  const take = (file: string, scope: ExtensionScope): Record<string, unknown> | null => {
    const doc = readJsonObject(read, file, { comments: true })
    if (doc === undefined) {
      complete = false
      return null
    }
    for (const name of Object.keys(objectAt(doc, 'mcpServers'))) {
      if (!mcp.some((m) => m.name === name)) mcp.push({ name, scope, allowable: isAllowableMcpName(name) })
    }
    return doc
  }
  const userFile = join(dir, 'settings.json')
  if (o.cwd !== undefined && o.cwd !== '') {
    const ws = join(resolve(o.cwd), '.gemini', 'settings.json')
    if (resolve(ws).toLowerCase() !== resolve(userFile).toLowerCase()) take(ws, 'project')
  }
  take(userFile, 'user')
  for (const ext of subfolders(join(dir, 'extensions'))) {
    const doc = take(join(dir, 'extensions', ext, 'gemini-extension.json'), 'extension')
    if (doc === null) continue
    const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : ext
    if (!plugins.includes(name)) plugins.push(name)
  }
  return { mcp, plugins, complete }
}
