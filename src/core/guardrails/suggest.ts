// Rules worth offering for a project, from what is in it: a bounded look at the folder's names, with no model call and
// nothing read from inside a file. Nothing here applies a rule; the user accepts each one.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { GuardrailSuggestion } from '../../shared/guardrails.ts'
import { suggestGuardrails } from '../../shared/guardrails.ts'

const MAX_DEPTH = 3
const MAX_PATHS = 5000
const SKIP: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '__pycache__',
])

export async function projectPaths(folder: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_PATHS) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_PATHS) return
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isFile()) out.push(path)
      else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP.has(e.name))
        await walk(join(dir, e.name), path, depth + 1)
    }
  }
  await walk(folder, '', 0)
  return out
}

export async function guardrailSuggestions(folder: string): Promise<GuardrailSuggestion[]> {
  return suggestGuardrails(await projectPaths(folder))
}
