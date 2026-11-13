// A git patch read for the grounding checks: the lines each file gained (`+` lines), by path. Pure.
import { normPath } from './evidence.ts'

/** Added lines per file (paths relative to the run's folder: `prefix`, the folder inside its repo, is cut off). */
export function addedLinesByFile(patch: string, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | null = null
  const cut = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null
      continue
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim()
      if (raw === '/dev/null') {
        current = null
        continue
      }
      let p = normPath(raw.replace(/^"|"$/g, '').replace(/^b\//, ''))
      if (cut !== '' && p.startsWith(cut)) p = p.slice(cut.length)
      current = out.get(p) ?? []
      out.set(p, current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('+') && !line.startsWith('+++')) current.push(line.slice(1))
  }
  return out
}

/** Every added line of the patch, in one text (what "first appears in the run's own added lines" searches). */
export function addedText(patch: string): string {
  return [...addedLinesByFile(patch).values()].map((l) => l.join('\n')).join('\n')
}
