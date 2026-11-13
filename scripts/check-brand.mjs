#!/usr/bin/env node
// The former-name check. The product was renamed (src/shared/brand.ts holds every name it uses now); the former name
// may stay only where ALLOWLIST says why. This lists every other file that names it, in its text or in its path.
//
//   node scripts/check-brand.mjs [--ref <tree-ish>] [--json]
//
// (default)  the working tree: tracked files plus untracked ones that are not ignored (what `git add -A` would take).
// --ref      a commit, branch or tree instead of the working tree, read from git (nothing is checked out).
// --json     the findings as one JSON object instead of lines.
//
// A finding prints as `path:line:col: text` (line 0 for a path that names it). `pnpm lint` runs this check.
//
// Exit: 0 nothing found · 1 found · 2 usage or git error
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { treeFiles, workingTreeFiles } from './tree-files.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A character class around one letter (P[L]AN) keeps the private notes' names out of this published file. */
const plain = (s) => s.replace(/\[(.)\]/g, '$1')

/**
 * The private notes: planning and research kept on main and never published (the publish tooling's private set,
 * which a test keeps equal to this list).
 */
export const PRIVATE_NOTES = Object.freeze(
  ['docs/P[L]AN.md', 'docs/S[P]EC.md', 'docs/de[s]ign/', 'docs/fi[x]tures/'].map(plain),
)

const isPrivateNote = (p) => PRIVATE_NOTES.some((q) => (q.endsWith('/') ? p.startsWith(q) : p === q))

/** The former name, any case. */
export const FORMER_NAME = /conductor/gi
const NAMES_IT = /conductor/i

/**
 * Whether a recording's text holds live host frames: a live recording (its header does not say `"synthesized": true`)
 * or one made from a live recording by scripts/synthesize-fixtures.mjs, which keeps the host's frames as they were sent.
 */
export function isLiveRecording(text) {
  const first = text.split('\n', 1)[0] ?? ''
  try {
    const header = JSON.parse(first)
    return (
      header !== null &&
      typeof header === 'object' &&
      header.kind === 'header' &&
      (header.synthesized !== true ||
        String(header.synthesizedFrom ?? '').includes('scripts/synthesize-fixtures.mjs'))
    )
  } catch {
    return false
  }
}

/**
 * Where the former name may stay, and why. `path` is a repo path (a file, or a folder and everything in it with a
 * trailing `/`), `test` a predicate on the path for a family of files; `line` (optional) limits the entry to the lines
 * it matches; `live` limits it to a live recording's text; `echo` allows a match only when the words around it are in
 * the sibling live recording (vendor text the adapter passed on).
 */
export const ALLOWLIST = Object.freeze([
  {
    id: 'private-docs',
    test: (p) => isPrivateNote(p),
    why: 'The private planning notes (PRIVATE_NOTES): history kept on main, never published.',
  },
  {
    id: 'live-recordings',
    test: (p) => /^tests\/fixtures\/.+\/recording\.jsonl$/.test(p),
    live: true,
    why: "Recordings made from live vendor recordings under the former name. The host's frames are what it sent then and are never edited; the fake CLI masks the host name at replay.",
  },
  {
    id: 'live-expected-events',
    test: (p) => /^tests\/fixtures\/.+\/expected\.events\.json$/.test(p),
    echo: true,
    why: "A live recording's expected events: the model's own words, which quote the former host name, as the adapter passes them on.",
  },
  {
    id: 'live-recordings-private',
    path: 'tests/fixtures-private/',
    why: 'The live vendor recordings the synthesized fixtures are made from: kept on main only, never published.',
  },
  {
    id: 'fake-cli-mask',
    path: 'tests/fake-cli/fake-cli.mjs',
    line: /^export const RECORDED_HOST_NAMES = /,
    why: 'The host names the live recordings were made under, which the replay masks like ids.',
  },
  {
    id: 'former-project-folder',
    path: 'src/shared/brand.ts',
    line: /^export const FORMER_PROJECT_DIRNAME = /,
    why: "The former project folder's name: a project that still has one gets a notice offering to rename it.",
  },
  {
    id: 'checker',
    test: (p) =>
      p === 'scripts/check-brand.mjs' ||
      p === 'scripts/check-brand.d.mts' ||
      p === 'tests/unit/scripts/check-brand.test.ts',
    why: 'This check, its declarations and its test: they name what they look for.',
  },
])

const matchesPath = (entry, path) =>
  entry.test !== undefined
    ? entry.test(path)
    : entry.path.endsWith('/')
      ? path.startsWith(entry.path)
      : path === entry.path

/** The words (and spaces and light punctuation) around a match, for the echo rule. */
function contextAround(line, start, end) {
  const word = /[A-Za-z0-9 ,;:'`-]/
  let a = start
  let b = end
  while (a > 0 && start - a < 24 && word.test(line[a - 1])) a--
  while (b < line.length && b - end < 24 && word.test(line[b])) b++
  return line.slice(a, b).trim()
}

/**
 * Checks files (`{ path, text }`, text undefined for a binary file). `readSibling(path)` returns another file's text
 * (the echo rule's recording), or undefined.
 */
export function checkFiles(files, { readSibling = () => undefined } = {}) {
  const findings = []
  let scanned = 0
  const list = [...files]
  const byPath = new Map(list.map((f) => [f.path.replace(/\\/g, '/'), f.text]))
  const sibling = (p) => (byPath.has(p) ? byPath.get(p) : readSibling(p))
  for (const f of list) {
    const path = f.path.replace(/\\/g, '/')
    const entries = ALLOWLIST.filter((e) => matchesPath(e, path))
    if (NAMES_IT.test(path) && !entries.some((e) => e.line === undefined && !e.live && !e.echo)) {
      findings.push({ path, line: 0, col: 0, text: path })
    }
    if (f.text === undefined) continue
    scanned++
    if (entries.some((e) => e.line === undefined && !e.live && !e.echo)) continue
    if (entries.some((e) => e.live) && isLiveRecording(f.text)) continue
    const echo = entries.some((e) => e.echo)
      ? sibling(posix.join(posix.dirname(path), 'recording.jsonl'))
      : undefined
    const liveEcho = echo !== undefined && isLiveRecording(echo) ? echo : undefined
    const lines = f.text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (entries.some((e) => e.line !== undefined && e.line.test(line))) continue
      for (const m of line.matchAll(FORMER_NAME)) {
        if (liveEcho !== undefined && liveEcho.includes(contextAround(line, m.index, m.index + m[0].length)))
          continue
        findings.push({ path, line: i + 1, col: m.index + 1, text: line.trim().slice(0, 160) })
      }
    }
  }
  return { scanned, findings }
}

const USAGE = 'usage: node scripts/check-brand.mjs [--ref <tree-ish>] [--json]'

/** The command line. Returns the exit code. */
export function main(argv, { root = ROOT, log = console.log, err = console.error } = {}) {
  const o = { ref: undefined, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ref' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) o.ref = argv[++i]
    else if (a === '--json') o.json = true
    else {
      err(USAGE)
      return 2
    }
  }
  let r
  try {
    const files = o.ref === undefined ? workingTreeFiles(root) : treeFiles(root, o.ref)
    r = checkFiles(files)
  } catch (e) {
    err(`check-brand: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`)
    return 2
  }
  if (o.json) {
    log(JSON.stringify(r, null, 2))
    return r.findings.length > 0 ? 1 : 0
  }
  for (const f of r.findings) log(`${f.path}:${f.line}:${f.col}: ${f.text}`)
  if (r.findings.length === 0) {
    log(`No former product name in ${r.scanned} files.`)
    return 0
  }
  const files = new Set(r.findings.map((f) => f.path)).size
  err(`${r.findings.length} mention(s) of the former product name in ${files} of ${r.scanned} files.`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
