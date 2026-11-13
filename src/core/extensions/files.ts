// Small file readers for the vendors' own settings (Extensions discovery and launch). Reads only, in memory; a file that
// is missing is not an error, one that cannot be read or parsed makes the answer incomplete. Nothing read here is
// logged or stored by these helpers.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type Reader = (path: string) => string

export const defaultReader: Reader = (p) => readFileSync(p, 'utf8')

/** A file's text, `null` when it does not exist, `undefined` when it could not be read. */
export function readMaybe(read: Reader, path: string): string | null | undefined {
  try {
    return read(path)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** JSON with `//` and `/* *\/` comments and trailing commas (Gemini's settings allow comments). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i] ?? ''
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^\uFEFF/, ''))
}

/** A JSON object file: the object, `null` when absent, `undefined` when unreadable or not an object. */
export function readJsonObject(
  read: Reader,
  path: string,
  o: { comments?: boolean } = {},
): Record<string, unknown> | null | undefined {
  const text = readMaybe(read, path)
  if (text === null || text === undefined) return text
  try {
    const v: unknown =
      o.comments === true ? parseJsonc(text) : (JSON.parse(text.replace(/^\uFEFF/, '')) as unknown)
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** The object at `key` of `o`, when it is one. */
export function objectAt(
  o: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> {
  const v = o?.[key]
  return isObj(v) ? v : {}
}

export { isObj }

const exists = (p: string): boolean => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * `cwd` and each folder above it up to the git root (a folder holding `.git`), nearest first; only `cwd` when it is in
 * no repository (the folders a vendor reads project settings from).
 */
export function foldersToRoot(
  cwd: string,
  isRoot: (dir: string) => boolean = (d) => exists(join(d, '.git')),
): string[] {
  const dirs: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    dirs.push(dir)
    if (isRoot(dir)) return dirs
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return [resolve(cwd)]
}

/** Sub-folder names of `dir` that hold `file` (a skill folder holds SKILL.md). Empty when `dir` is absent. */
export function foldersHolding(dir: string, file: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((n) => exists(join(dir, n, file))).sort((a, b) => a.localeCompare(b))
}
