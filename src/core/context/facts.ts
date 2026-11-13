// What Dim Factory knows of a pass's setup for its context health (ContextFacts): its own prompt's size, the window
// the catalog gives, and the project's own memory files the vendor loads into every request, sized from disk. Only
// the project folder is read (never ~/.claude or another vendor home beyond the existing discovery, never a
// credential), and only file sizes, never contents.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextContributor } from '../../shared/context.ts'
import { tokensFromBytes } from '../../shared/context.ts'
import type { ExtensionLevel } from '../../shared/extensions.ts'
import type { ContextFacts } from './state.ts'

/** The project memory files each vendor reads from the folder it works in (relative paths). */
export function memoryFilesFor(vendor: string): readonly string[] {
  if (vendor === 'claude') return ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']
  if (vendor === 'gemini') return ['GEMINI.md']
  if (vendor === 'muse') return []
  // Codex (and its local presets) and the other ACP vendors read AGENTS.md.
  return ['AGENTS.md']
}

/** The project's memory files for `vendor` in `cwd`, sized (bytes / 3.5); a file that is not there is left out. */
export function projectMemoryFiles(
  vendor: string,
  cwd: string,
  size: (path: string) => number | undefined = fileSize,
): ContextContributor[] {
  const out: ContextContributor[] = []
  for (const rel of memoryFilesFor(vendor)) {
    const bytes = size(join(cwd, rel))
    if (bytes === undefined || bytes <= 0) continue
    out.push({ kind: 'memory', name: rel, tokens: tokensFromBytes(bytes), from: 'estimate' })
  }
  return out
}

function fileSize(path: string): number | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

export interface FactsInput {
  vendor: string
  cwd: string
  prompt: string
  systemAppend?: string | undefined
  window: number | null | undefined
  resumed: boolean
  extensions?: ExtensionLevel | undefined
  /** The names active for the pass (the existing discovery, names only); absent: none known. */
  names?: { mcp: readonly string[]; skills: readonly string[] } | undefined
  size?: (path: string) => number | undefined
}

/** A spawn's ContextFacts. */
export function contextFacts(i: FactsInput): ContextFacts {
  const bytes = Buffer.byteLength(i.prompt, 'utf8') + Buffer.byteLength(i.systemAppend ?? '', 'utf8')
  return {
    promptTokens: tokensFromBytes(bytes),
    ...(i.window !== undefined && i.window !== null && i.window > 0 ? { window: i.window } : {}),
    resumed: i.resumed,
    ...(i.extensions !== undefined ? { extensions: i.extensions } : {}),
    projectFiles: projectMemoryFiles(i.vendor, i.cwd, i.size),
    mcpNames: [...(i.names?.mcp ?? [])].slice(0, 50),
    skillNames: [...(i.names?.skills ?? [])].slice(0, 50),
  }
}
