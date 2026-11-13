// One spelling per folder: the path the file system itself reports.
//
// The same folder can be written several ways. On Windows a temp folder is often an 8.3 short name
// (C:\Users\RUNNER~1\AppData\Local\Temp) while its real name is long (C:\Users\runneradmin\...); on macOS /var and /tmp
// are links to /private/var and /private/tmp. Anything that compares two paths for identity or containment (is this
// cwd inside the project, is this the project folder itself) must compare the same spelling on both sides, or a folder
// counts as outside itself. realPathSync / realPath give that spelling: the native realpath (which expands 8.3 names
// and follows links, with the true case on Windows), taken of the nearest existing ancestor when the path does not
// exist yet, with the missing tail joined back on.
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Strip the win32 long-path prefixes `\\?\C:\…` and `\\?\UNC\server\share`. */
function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

/** The canonical spelling of `p` (absolute; links, 8.3 names and case resolved for the part that exists). */
export function realPathSync(p: string): string {
  let dir = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = stripLongPathPrefix(realpathSync.native(dir))
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return resolve(p)
      tail.push(basename(dir))
      dir = parent
    }
  }
}

/** realPathSync, without blocking. */
export async function realPath(p: string): Promise<string> {
  let dir = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = stripLongPathPrefix(await realpath(dir))
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return resolve(p)
      tail.push(basename(dir))
      dir = parent
    }
  }
}

/** `p` relative to `root` ('' for the root itself), or null when `p` is outside `root`. Purely lexical. */
function lexicalInside(root: string, p: string): string | null {
  const rel = relative(root, p)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

/**
 * `p` relative to `root` ('' for the root itself, native separators), or null when `p` is outside `root`. Read as
 * written first (so a link inside the project still counts as where it is written), then by both canonical spellings
 * (so C:\Users\RUNNER~1\x is inside C:\Users\runneradmin and /var/x is inside /private/var).
 */
export function relativeInside(root: string, p: string): string | null {
  const lexical = lexicalInside(resolve(root), resolve(p))
  if (lexical !== null) return lexical
  return lexicalInside(realPathSync(root), realPathSync(p))
}

/** The other spelling of a folder (its real path), or none when it is already spelled that way. */
export function otherSpellings(p: string): string[] {
  const real = realPathSync(p)
  return lexicalInside(resolve(p), real) === '' ? [] : [real]
}

/** A guardrail policy that knows the run folder's real spelling (see ToolPolicy.folderSpellings). */
export function withFolderSpellings<T extends object>(policy: T, cwd: string | undefined): T {
  if (cwd === undefined || cwd === '') return policy
  const spellings = otherSpellings(cwd)
  return spellings.length === 0 ? policy : { ...policy, folderSpellings: spellings }
}

/** The same folder or file, however each is spelled. */
export function samePath(a: string, b: string): boolean {
  return relativeInside(a, b) === ''
}
