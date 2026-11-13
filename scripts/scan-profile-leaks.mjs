#!/usr/bin/env node
// The review scan before live data is committed (tests/fixtures/codex/README.md "Re-recording live", step 4). The
// recorder redacts what its rules know; this looks through the repo for what only the recording profile itself names,
// which no committed rule can know:
//   - its own ids: every UUID in <CODEX_HOME>/session_index.jsonl (the user's own threads, which Codex Desktop also
//     keys its prompt history by) and the install's installation_id (a unit test once picked up the id of
//     one of the user's real threads);
//   - its terms (scripts/redact-codex.mjs profileTerms: MCP commands, args, URLs and env values, trusted folders,
//     instruction lines), and with --names its MCP server names as whole words (common words make these noisy);
//   - the machine: the user name as a path segment and the host name;
//   - a Claude config folder's terms (scripts/redact-claude.mjs profileTerms: hook, status-line and settings env
//     commands and values, the synced skills' folder, CLAUDE.md lines) and, with --names, the names of the user's
//     skills, commands, subagents, output styles and plugins as whole words.
// Everything is read in memory only and nothing is written: it prints counts per file and kind, never a value, and it
// never opens Codex's credential file (auth.json) nor Claude's (.credentials.json, .claude.json).
//
//   node scripts/scan-profile-leaks.mjs [--codex-home <dir>] [--claude-config <dir>] [--since <ISO date>] [--names]
//     [path...]   (at least one of --codex-home and --claude-config)
//
// --since  a UUIDv7 id created at or after it is the recording's own (a fixture names its thread) and is skipped.
// path     files or folders to scan, relative to the repo (default: tests src scripts, where live data and the code
//          that quotes it land; name docs too when a write-up quotes a recording).
// Exit: 0 nothing found · 1 found (the summary says where) · 2 usage
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileTerms as claudeProfileTerms } from './redact-claude.mjs'
import { profileTerms, wordMatchers } from './redact-codex.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATHS = ['tests', 'src', 'scripts']
/** Build output, dependencies and tool state: never the repo's own text. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '.bin',
  'coverage',
  'test-results',
  'playwright-report',
])
/** Files with the profile's own ids (never the credential file). */
const ID_FILES = ['session_index.jsonl', 'installation_id']
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The time a UUIDv7 carries (ms), or undefined for another version. */
export function uuidV7Ms(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) return undefined
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}

/** The profile's own ids: the UUIDs in its id files (`since`: a v7 id from then on is skipped). */
export function profileIds(codexHome, since) {
  const ids = new Set()
  for (const name of ID_FILES) {
    const file = join(codexHome, name)
    let text
    try {
      text = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined
    } catch {
      text = undefined
    }
    if (text === undefined) continue
    for (const m of text.matchAll(UUID)) {
      const id = m[0].toLowerCase()
      const at = uuidV7Ms(id)
      if (since !== undefined && at !== undefined && at >= since) continue
      ids.add(id)
    }
  }
  return [...ids]
}

/** A literal's spellings as text and JSON hold it (a path with either separator, escaped once or twice). */
function spellings(l) {
  // A term JSON leaves as it is is one spelling, so each occurrence counts once.
  if (!/[\\/]/.test(l)) return [...new Set([l, JSON.stringify(l).slice(1, -1)])]
  const back = l.replace(/\//g, '\\')
  const json1 = back.replace(/\\/g, '\\\\')
  return [...new Set([l, l.replace(/\\/g, '/'), back, json1, json1.replace(/\\/g, '\\\\')])]
}

/**
 * Matchers for everything the profile and the machine name, by kind. `home`: the home folder (a trusted folder that is
 * the home folder or above it is left to the user-name check, which the fixture redaction test also makes).
 */
export function scanMatchers({
  codexHome,
  claudeConfig,
  since,
  names = false,
  home = homedir(),
  user,
  host,
}) {
  const out = []
  const homeKey = home.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const literals = (list, kind) => {
    for (const l of list) {
      const key = l.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (isAbsolute(l) && (homeKey === key || homeKey.startsWith(`${key}/`))) continue
      for (const s of spellings(l)) out.push({ kind, re: new RegExp(escapeRegExp(s), 'gi') })
    }
  }
  if (codexHome !== undefined) {
    for (const id of profileIds(codexHome, since))
      out.push({ kind: 'profile-id', re: new RegExp(escapeRegExp(id), 'gi') })
    const terms = profileTerms(codexHome)
    literals(terms.literals, 'profile-term')
    if (names) for (const { re } of wordMatchers(terms.names)) out.push({ kind: 'profile-name', re })
  }
  // What a Claude config folder names (the live re-record on the everyday ~/.claude).
  if (claudeConfig !== undefined) {
    const terms = claudeProfileTerms(claudeConfig)
    literals(terms.literals, 'claude-term')
    if (names) for (const { re } of wordMatchers(terms.names)) out.push({ kind: 'claude-name', re })
  }
  if (user !== undefined && user.length > 1 && user.toLowerCase() !== 'user')
    out.push({
      kind: 'user-name',
      re: new RegExp(`(?:Users|home)(?:\\\\{1,4}|/)${escapeRegExp(user)}(?![A-Za-z0-9_.-])`, 'gi'),
    })
  if (host !== undefined && host.length >= 6)
    out.push({ kind: 'host-name', re: new RegExp(escapeRegExp(host), 'gi') })
  return out
}

function listFiles(path, files) {
  let st
  try {
    st = statSync(path)
  } catch {
    return
  }
  if (st.isFile()) {
    files.push(path)
    return
  }
  if (!st.isDirectory() || SKIP_DIRS.has(basename(path))) return
  for (const e of readdirSync(path, { withFileTypes: true })) listFiles(join(path, e.name), files)
}

/** Counts per file and kind of what `matchers` find under `paths` (relative to `root`). */
export function scanFiles(root, paths, matchers) {
  const files = []
  for (const p of paths) listFiles(resolve(root, p), files)
  const found = []
  let scanned = 0
  for (const file of files.sort()) {
    const buf = readFileSync(file)
    if (buf.includes(0)) continue
    scanned++
    const text = buf.toString('utf8')
    const kinds = {}
    for (const { kind, re } of matchers) {
      re.lastIndex = 0
      const n = text.match(re)?.length ?? 0
      if (n > 0) kinds[kind] = (kinds[kind] ?? 0) + n
    }
    for (const [kind, count] of Object.entries(kinds))
      found.push({ file: relative(root, file).split('\\').join('/'), kind, count })
  }
  return { scanned, found }
}

function main(argv) {
  const opts = { paths: [], names: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--codex-home') opts.codexHome = argv[++i]
    else if (a === '--claude-config') opts.claudeConfig = argv[++i]
    else if (a === '--since') opts.since = argv[++i]
    else if (a === '--names') opts.names = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else opts.paths.push(a)
  }
  if (opts.help) {
    process.stdout.write(
      'node scripts/scan-profile-leaks.mjs [--codex-home <dir>] [--claude-config <dir>] [--since <ISO date>] [--names] [path...]\n',
    )
    return 0
  }
  if (opts.codexHome === undefined && opts.claudeConfig === undefined)
    throw new Error('--codex-home <dir> or --claude-config <dir> is required')
  for (const [flag, dir] of [
    ['--codex-home', opts.codexHome],
    ['--claude-config', opts.claudeConfig],
  ])
    if (dir !== undefined && !existsSync(dir)) throw new Error(`${flag} ${dir} does not exist`)
  const since = opts.since !== undefined ? Date.parse(opts.since) : undefined
  if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${opts.since}`)
  const matchers = scanMatchers({
    ...(opts.codexHome !== undefined ? { codexHome: resolve(opts.codexHome) } : {}),
    ...(opts.claudeConfig !== undefined ? { claudeConfig: resolve(opts.claudeConfig) } : {}),
    since,
    names: opts.names,
    user: userInfo().username,
    host: hostname(),
  })
  const { scanned, found } = scanFiles(ROOT, opts.paths.length > 0 ? opts.paths : DEFAULT_PATHS, matchers)
  const kinds = {}
  for (const m of matchers) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
  process.stdout.write(`${JSON.stringify({ scanned, terms: kinds, found }, null, 2)}\n`)
  return found.length > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`scan-profile-leaks: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  }
}
