// The files of a working tree or of a git tree, as `{ path, text }` (text undefined for a binary file), for the checks
// that read every file (scripts/check-brand.mjs and the publish tooling's checks).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Text, or undefined for a binary file (a NUL byte in its first 8 KB). */
export function textOf(buf) {
  return buf.subarray(0, 8192).includes(0) ? undefined : buf.toString('utf8')
}

const git = (cwd, args, input) =>
  execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] })

/** The files of the working tree at `root` (tracked, plus untracked ones not ignored), read from disk. */
export function* workingTreeFiles(root) {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8')
  for (const path of new Set(out.split('\0'))) {
    if (path === '') continue
    let buf
    try {
      buf = readFileSync(join(root, path))
    } catch {
      continue // deleted in the working tree, or a submodule's folder
    }
    yield { path, text: textOf(buf) }
  }
}

/** The files of a commit, branch or tree, read from the object store (submodules skipped). */
export function* treeFiles(root, ref) {
  const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', ref])
    .toString('utf8')
    .split('\0')
    .filter((e) => e !== '')
    .map((e) => {
      const tab = e.indexOf('\t')
      const [, type, oid] = e.slice(0, tab).split(' ')
      return { type, oid, path: e.slice(tab + 1) }
    })
    .filter((e) => e.type === 'blob')
  if (entries.length === 0) return
  const batch = git(root, ['cat-file', '--batch'], entries.map((e) => e.oid).join('\n') + '\n')
  let at = 0
  for (const e of entries) {
    const nl = batch.indexOf(10, at)
    const size = Number(batch.subarray(at, nl).toString('latin1').split(' ')[2])
    yield { path: e.path, text: textOf(batch.subarray(nl + 1, nl + 1 + size)) }
    at = nl + 1 + size + 1
  }
}
