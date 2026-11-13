// The private files that exist in a folder, by name only (nothing is read from inside a file): what a search over the
// folder would reach. A bounded walk, done once per pass the first time a search needs it, so a file the pass creates
// later is not in the list.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardrailRule } from '../../shared/guardrails.ts'
import { pathMatches } from '../../shared/guardrails.ts'

const MAX_DEPTH = 6
const MAX_ENTRIES = 20_000
const SKIP: ReadonlySet<string> = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__'])

export function privateFilesIn(folder: string, rules: readonly GuardrailRule[]): string[] {
  const globs = rules.flatMap((r) => (r.kind === 'privateFiles' ? r.paths : []))
  if (globs.length === 0) return []
  const out: string[] = []
  let seen = 0
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isFile() && pathMatches(path, globs) !== undefined) out.push(path)
      else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP.has(e.name))
        walk(join(dir, e.name), path, depth + 1)
    }
  }
  walk(folder, '', 0)
  return out
}
