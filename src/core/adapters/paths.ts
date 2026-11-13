// Paths in tool lines (PassCard tool rows): a file inside the pass folder reads relative to it, so
// a clipped one-line summary keeps the file name. Codex (live X03a) and Claude (live balanced run) report absolute
// paths; a path anywhere else stays as given.
import { isAbsolute } from 'node:path'
import { relativeInside } from '../real-path.ts'

/**
 * A path inside the pass folder, relative to it with forward slashes; any other path as given. Codex reports a file
 * change by its absolute path (live X03a), which would push the file name out of a clipped summary. A vendor may
 * name the folder another way than the host did (macOS getcwd() reports /private/var for /var, Windows may expand an
 * 8.3 short name), so a path that is not inside as written is compared by real paths.
 */
export function relativeTo(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const unify = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = unify(path)
  const c = unify(cwd)
  // A drive-letter folder compares case-insensitively, as Windows does.
  const fold = /^[A-Za-z]:\//.test(c)
  const head = p.slice(0, c.length)
  const inside = p.length > c.length + 1 && p[c.length] === '/'
  if (inside && (fold ? head.toLowerCase() === c.toLowerCase() : head === c)) return p.slice(c.length + 1)
  if (!isNativeAbsolute(path) || !isNativeAbsolute(cwd)) return path
  const rel = relativeInside(cwd, path)
  return rel !== null && rel !== '' ? rel.split('\\').join('/') : path
}

/**
 * An absolute path of this machine (on Windows a drive or UNC path, never a bare `/x`), the only kind a real-path
 * lookup can say anything about.
 */
export function isNativeAbsolute(p: string): boolean {
  return process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p) : isAbsolute(p)
}
