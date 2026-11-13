// The Dim Factory-owned shadow repository per folder (setup, snapshots, diffs).
//
// `<home>/shadow/<folderKey>/repo.git` is a bare repo driven with GIT_DIR + GIT_WORK_TREE=<scopeRoot>, plumbing
// only. Snapshots, diffs and the live count never write the user's index, HEAD, refs or objects: the only reads of
// the user's repo are `rev-parse --git-path info/exclude` and `ls-files -c -i` (both `--no-optional-locks`).
// Byte-exact: `info/attributes` turns off every conversion (eol/crlf/filter/ident/encoding) and core.autocrlf is
// false at repo level, so system/global autocrlf or clean filters never reach a blob.
//
// Revert/restore lives in revert.ts and reuses `Shadow.gitEnv()` plus a scratch GIT_INDEX_FILE.
//
// Links to folders (Windows junctions, symbolic links to
// folders) are left out of every snapshot. Before `add -A` a walk finds them and info/exclude lists them; after it,
// any index entry at or under a link (a link the walk did not reach) is dropped before `write-tree`, so a link's
// target never enters a tree, a diff, a revert plan or an apply. Retention deletes a run's ref with one
// `update-ref --stdin` batch (`deleteRunRefs`), and `gcIfIdle` collects (or deletes, with no ref left) a shadow under
// the folder mutex once no run has used the folder for 5 minutes, at most daily.
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FileChange } from '../../shared/ipc.ts'
import { homePaths } from '../home.ts'
import { relativeInside } from '../real-path.ts'
import { writeFileAtomicLite } from '../proc/atomic-lite.ts'
import { dirSize, removeShadow } from '../store/storage.ts'
import { forgetDiffView } from './diff-view.ts'
import { GitError, chunkPaths, isGitError, runGit, splitNul, tryGit } from './exec.ts'
import type { GitResult, GitRunOptions } from './exec.ts'
import { isFolderLink, outermostLinks, scanFolderLinks, underLink, walkCovers } from './folder-links.ts'
import type { FolderLinkScan } from './folder-links.ts'
import { isFolderBusy, tryWithFolderLock, withFolderLock } from './mutex.ts'
import { buildPromptPatch, mergeDiff, promptPatchCap } from './patch.ts'
import type { DiffSummary, PromptPatch, PromptPatchFile } from './patch.ts'
import { listTrackedIgnored, readUserExclude, resolveScope } from './repo.ts'
import type { ScopeInfo } from './repo.ts'
import { BRAND } from '../../shared/brand.ts'

/** Every conversion off: blobs are the exact bytes on disk. `-working-tree-encoding` covers git ≥ 2.18. */
export const SHADOW_ATTRIBUTES = '* -text -eol -crlf -filter -ident -working-tree-encoding\n'

/** info/exclude for folders that are not git repos (in-tree .gitignore files still apply). */
export const NON_GIT_DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  'target/',
  '.next/',
  '.cache/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
]

export const SHADOW_IDENTITY = { name: BRAND.displayName, email: `${BRAND.slug}@localhost` } as const
export const SHADOW_REF_PREFIX = BRAND.runRefPrefix
/** A cold first `add -A` on a large, Defender-scanned folder can take minutes. */
export const SNAPSHOT_TIMEOUT_MS = 15 * 60_000
/**
 * Bumped when shadowConfig() changes, so existing shadows are reconfigured on open (2: core.hooksPath; 3:
 * core.symlinks from a probe, for revert).
 */
export const SHADOW_CONFIG_VERSION = 3
/** `<home>/empty-hooks` (HomePaths.emptyHooksDir): core.hooksPath of every shadow, so no user hook ever runs. */
export const EMPTY_HOOKS_DIRNAME = 'empty-hooks'

export interface SizeLimits {
  /** More untracked files than this blocks (cleared by the `largeFolder` grant). */
  maxFiles: number
  /** More untracked bytes than this blocks. */
  maxBytes: number
  /** Single files above this are auto-excluded with a note. */
  largeFileBytes: number
  /** Stat at most this many entries (the rest count as files of unknown size). */
  statLimit: number
}

export const DEFAULT_SIZE_LIMITS: Readonly<SizeLimits> = {
  maxFiles: 20_000,
  maxBytes: 1024 ** 3,
  largeFileBytes: 100 * 1024 ** 2,
  statLimit: 200_000,
}

export const SNAP_LABELS = [
  'run-start',
  'plan-end',
  'S0',
  'S1',
  'post-verify-1',
  'post-review',
  'fix-start',
  'S2',
  'post-verify-2',
  'pre-revert',
  'pre-retry',
  'stopped',
  'paused',
  'interrupted',
  'resume',
  'pre-apply',
  // Test-first: the Tests step's start and end, and the folder after its red check.
  'T0',
  'T1',
  'post-red',
  // Fix until green: the folder after a round's checks, before the next round.
  'post-round',
  // A match: the folder as it was when the match began (the ref is named for the match, not a run).
  'match-start',
  // The Deploy step's start and end.
  'deploy-start',
  'deploy-end',
] as const
export type SnapLabel = (typeof SNAP_LABELS)[number] | `reconcile-${string}`

/** One `runs/<id>/snapshots.json` entry (the caller appends it; this module never touches the run store). */
export interface SnapshotRecord {
  label: string
  tree: string
  commit: string
  at: number
  /** Paths git could not read (locked or permission denied); their previous snapshot content is kept. */
  unreadable: string[]
  /** The tree equalled this run's previous snapshot, so that commit was reused (no new object, no ref move). */
  reused: boolean
  ms: number
  /** Non-fatal notes: embedded repositories, case-only renames applied, unparsed add messages. */
  warnings: string[]
  /** Nested git repositories (their files are not in `tree`) and a fingerprint of each one's working state. */
  nested?: NestedRepo[]
  /**
   * Links to folders (junctions, symbolic links to folders) left out of `tree`, scope-relative; absent when there
   * is none. The run notes them (folder-links.ts `linksLeftOutNote`).
   */
  links?: string[]
}

/** Shadow.snapshot's options. */
export interface SnapshotOptions {
  /**
   * Scope-relative paths that go into this snapshot's tree even when the folder's ignore rules
   * leave them out (`add -f` on a scratch copy of the index, so later snapshots are unchanged). Files over the large
   * file limit, folders, missing paths and paths under a link are not added; a caller that needs one checks the tree.
   */
  force?: readonly string[]
}

export interface NestedRepo {
  /** Scope-relative, `/`-separated. */
  path: string
  fingerprint: string
}

export interface PrepareResult {
  excludeSource: 'repo' | 'defaults'
  /** Tracked-but-ignored files force-added to the shadow index. */
  forceAdded: number
  warnings: string[]
}

export interface SizePreflight {
  /** Untracked (not yet in the shadow) files, excluding auto-excluded large files. */
  files: number
  bytes: number
  /** Files over `largeFileBytes`, now listed in info/exclude. */
  largeFiles: { path: string; bytes: number }[]
  blocked: boolean
  reason?: 'files' | 'bytes'
  /** The listing or the stat pass was capped; counts are lower bounds. */
  partial: boolean
  limits: SizeLimits
  ms: number
}

export interface PatchOptions {
  /** Prompt post-processing (header, collapse, EOL-only list, size cap). Always ignores CR at EOL. */
  forPrompt?: boolean
  /** Prompt: explicit cap in bytes (default promptPatchCap(contextWindow)). UI: capture cap. */
  maxBytes?: number
  /** Prompt cap input; unknown → 200,000 tokens. */
  contextWindow?: number | null
  /** UI patch: `--ignore-cr-at-eol` (the viewer's "ignore line endings" toggle). */
  ignoreEol?: boolean
}

export interface PatchResult {
  text: string
  bytes: number
  /** The text was cut (UI: capture cap; prompt: even stubs did not fit). */
  truncated: boolean
  /** Prompt only: the cap applied. */
  capBytes: number | null
  files: number
  collapsed: string[]
  omitted: string[]
  eolOnly: string[]
}

export interface ShadowOpenOptions {
  /** DIM_FACTORY_HOME. The shadow lives at `<home>/shadow/<folderKey>/repo.git`. */
  home: string
  platform?: NodeJS.Platform
  /** Size thresholds (tests inject small ones). */
  limits?: Partial<SizeLimits>
  snapshotTimeoutMs?: number
  /** How long a snapshot waits for a leftover shadow `*.lock` to disappear before judging it (default 3 s). */
  lockWaitMs?: number
}

interface ShadowMeta {
  schemaVersion: 1
  folderKey: string
  scopeRoot: string
  lockKey: string
  isRepo: boolean
  ignorecase: boolean
  configVersion: number
  platform: NodeJS.Platform
  /** core.hooksPath written into the config (the shadow is rewritten when it changes, e.g. a moved home). */
  hooksPath?: string
  /** core.symlinks written into the config (the probe's answer; rewritten when it changes). */
  symlinks?: boolean
  largeFiles: string[]
  createdAt: number
  updatedAt: number
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BIG_OUTPUT = 256 * 1024 * 1024

/**
 * A copy of the shadow index that git reads as it reads the index itself. Git checks again the content of any file
 * changed in the same second its index was written (a "racy" entry); it tells that from the index file's own time.
 * A plain copy is newer on Linux (Windows keeps the time), so those entries would be trusted by size and time and a
 * same-size edit in that second missed. The copy keeps the index's times. A missing index is left missing.
 */
async function copyIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to)
  const st = await stat(from)
  await utimes(to, st.atime, st.mtime)
}

/** When this process started: a shadow lock file older than that was left by an earlier (dead) instance. */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000
/**
 * A lock this old is stale even if this process made it: every shadow git call times out well before, and a lock
 * left by one of this process's own timed-out calls is removed right after its timeout (`dropOwnLocks`).
 */
const STALE_LOCK_MS = SNAPSHOT_TIMEOUT_MS + 60_000
/** File timestamps can be this coarse (FAT: 2 s); a lock this much older than a call's start is not the call's. */
const LOCK_MTIME_SLACK_MS = 2000
/** Shadow commands that take its index or ref locks (always run under the folder mutex). */
const LOCKING_COMMANDS: ReadonlySet<string> = new Set(['add', 'update-index', 'update-ref', 'write-tree'])

/** The git subcommand of an argv (past `-c k=v` and other leading options). */
function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-c' || a === '-C') {
      i++
      continue
    }
    if (!a.startsWith('-')) return a
  }
  return ''
}
const CORRUPT_INDEX =
  /index file corrupt|bad signature|index file smaller than expected|bad index file|unknown index entry format/i
/** `add` errors a held file produces (sharing violation → EACCES on open, or a short/failed read). */
const TRANSIENT_ADD_ERROR =
  /^error: (?:open\(".+"\): (?:Permission denied|Invalid argument|Device or resource busy)|unable to (?:read|hash) |short read|read error)/m
const ADD_RETRY_DELAY_MS = 300

/** A path as a git config / `-c` value: forward slashes (git on Windows accepts them; `\` is an escape). */
export function gitConfigPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p
}

/**
 * Repo-level config of a shadow. Repo level beats system/global (autocrlf=true here). `hooksPath`
 * (an empty Dim Factory-owned folder) overrides a global `core.hooksPath`: "plumbing only, so no hooks run" also
 * holds on git ≥ 2.24/2.28, where `add`, `update-index` and `update-ref` fire post-index-change and
 * reference-transaction hooks.
 */
export function shadowConfig(
  platform: NodeJS.Platform,
  ignorecase: boolean,
  hooksPath?: string,
  symlinks?: boolean,
): [string, string][] {
  const cfg: [string, string][] = [
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.quotepath', 'false'],
    // empty = off on 2.17 (hook path) and on 2.36+ (bool-or-path): no fsmonitor daemon on the user's folder
    ['core.fsmonitor', ''],
    ['core.logAllRefUpdates', 'false'],
    ['core.ignorecase', ignorecase ? 'true' : 'false'],
    ['gc.auto', '0'],
    ['commit.gpgsign', 'false'],
    ['user.name', SHADOW_IDENTITY.name],
    ['user.email', SHADOW_IDENTITY.email],
  ]
  if (hooksPath !== undefined) cfg.push(['core.hooksPath', gitConfigPath(hooksPath)])
  // Revert writes a mode-120000 entry as a real symbolic link only with core.symlinks true (git for Windows'
  // system config and `init` say false); where none can be made, revert skips links instead of writing text files.
  if (symlinks !== undefined) cfg.push(['core.symlinks', symlinks ? 'true' : 'false'])
  if (platform === 'darwin') cfg.push(['core.precomposeunicode', 'true'])
  if (platform === 'win32') cfg.push(['core.longpaths', 'true'], ['core.filemode', 'false'])
  return cfg
}

/** A config-file value: quoted (with `\` and `"` escaped) when it has spaces, `;`, `#` or quotes. */
function configFileValue(v: string): string {
  if (!/[\s;#"\\]/.test(v)) return v
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const CONFIG_BEGIN = '# >>> Dim Factory shadow settings (generated; rewritten on upgrade) >>>'
const CONFIG_END = '# <<< Dim Factory shadow settings <<<'

/**
 * The shadow's `config` file with Dim Factory's settings block appended (replacing an earlier block). git reads
 * repeated sections and the last value wins, so one file write replaces a dozen `git config` spawns.
 */
export function withShadowConfigBlock(existing: string, entries: readonly [string, string][]): string {
  let base = existing
  const start = base.indexOf(CONFIG_BEGIN)
  if (start !== -1) {
    const end = base.indexOf(CONFIG_END, start)
    base =
      base.slice(0, start) + (end === -1 ? '' : base.slice(end + CONFIG_END.length).replace(/^\r?\n/, ''))
  }
  const sections = new Map<string, string[]>()
  for (const [key, value] of entries) {
    const dot = key.indexOf('.')
    const section = key.slice(0, dot)
    const name = key.slice(dot + 1)
    const lines = sections.get(section) ?? []
    lines.push(value === '' ? `\t${name} =` : `\t${name} = ${configFileValue(value)}`)
    sections.set(section, lines)
  }
  const block = [CONFIG_BEGIN]
  for (const [section, lines] of sections) block.push(`[${section}]`, ...lines)
  block.push(CONFIG_END)
  const head = base.trimEnd()
  return `${head === '' ? '' : `${head}\n`}${block.join('\n')}\n`
}

const IDENTITY_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: SHADOW_IDENTITY.name,
  GIT_AUTHOR_EMAIL: SHADOW_IDENTITY.email,
  GIT_COMMITTER_NAME: SHADOW_IDENTITY.name,
  GIT_COMMITTER_EMAIL: SHADOW_IDENTITY.email,
}

/** A run id usable as one ref component (`refs/dimfactory/runs/<runId>`). */
export function assertRunRefId(runId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) ||
    runId.includes('..') ||
    runId.endsWith('.lock') ||
    runId.endsWith('.')
  ) {
    throw new GitError('exit', `invalid run id for a snapshot ref: ${JSON.stringify(runId)}`, {
      args: [],
      category: 'snapshot_failed',
    })
  }
  return runId
}

/** One of the shadow's own refs, or its tree (`<ref>^{tree}`). */
const OWN_REF_OR_TREE = new RegExp(`^${BRAND.refNamespace}[A-Za-z0-9._/-]+(\\^\\{tree\\})?$`)

/** A tree-ish Dim Factory passes to diff-tree: an object id or one of its own refs (never an option). */
function assertRev(rev: string): string {
  if (/^[0-9a-f]{4,64}$/i.test(rev) || OWN_REF_OR_TREE.test(rev)) return rev
  throw new GitError('exit', `invalid revision: ${JSON.stringify(rev)}`, {
    args: [],
    category: 'snapshot_failed',
  })
}

/** `/<path>` anchored, with wildmatch specials escaped, as an info/exclude line. */
export function excludeLine(rel: string, dir = false): string {
  const posix = rel.split(path.sep).join('/').replace(/^\/+/, '')
  const esc = posix.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ +$/, (m) => m.replace(/ /g, '\\ '))
  return `/${esc}${dir ? '/' : ''}`
}

/** Paths and notes from `git add -A --ignore-errors` stderr (exit 1 = some files could not be indexed). */
export function parseAddStderr(stderr: string): { unreadable: string[]; warnings: string[] } {
  const unreadable = new Set<string>()
  const warnings: string[] = []
  for (const line of stderr.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('error:')) {
      const msg = t.slice('error:'.length).trim()
      const m =
        /^open\("(.+)"\)/.exec(msg) ??
        /^unable to index file '?(.+?)'?$/.exec(msg) ??
        /^unable to (?:stat|read|hash|add) '?([^':]+)'?/.exec(msg) ??
        /^'(.+?)'/.exec(msg)
      unreadable.add(m?.[1] ?? msg)
    } else if (t.startsWith('warning:')) {
      warnings.push(t)
    }
  }
  return { unreadable: [...unreadable], warnings }
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  )
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** The base of a shadow's info/exclude: the user repo's `--git-path info/exclude`, or Dim Factory's defaults. */
async function baseExcludeFor(scope: ScopeInfo): Promise<{ source: 'repo' | 'defaults'; text: string }> {
  if (scope.isRepo) {
    const user = await readUserExclude(scope.scopeRoot)
    return { source: 'repo', text: `# copied from ${user.path ?? '(no info/exclude)'}\n${user.text}` }
  }
  return {
    source: 'defaults',
    text: `# Dim Factory defaults (not a git repository)\n${NON_GIT_DEFAULT_EXCLUDES.join('\n')}\n`,
  }
}

/**
 * DIM_FACTORY_HOME relative to the scope root (`/`-separated) when it lies inside it, however each is spelled (the scope
 * root is a real path; the home may be an 8.3 short name or under a linked temp folder).
 */
function homeInside(scopeRoot: string, home: string): string | undefined {
  const relHome = relativeInside(scopeRoot, home)
  if (relHome === null || relHome === '') return undefined
  return relHome.split(path.sep).join('/')
}

/**
 * info/exclude text: the base, DIM_FACTORY_HOME when it lies inside the scope, the auto-excluded large files and
 * the links to folders.
 */
function excludeFileText(
  base: string,
  scopeRoot: string,
  home: string,
  largeFiles: readonly string[],
  limits: SizeLimits,
  links: readonly string[] = [],
): string {
  const lines = [
    '# Written by Dim Factory for its shadow snapshots; regenerated at every run start.',
    base.trimEnd(),
    '# Dim Factory',
  ]
  const relHome = homeInside(scopeRoot, home)
  if (relHome !== undefined) lines.push(excludeLine(relHome, true))
  if (largeFiles.length > 0) {
    lines.push(`# files over ${Math.round(limits.largeFileBytes / 1024 ** 2)} MB (auto-excluded)`)
    for (const f of largeFiles) lines.push(excludeLine(f))
  }
  if (links.length > 0) {
    lines.push('# links to folders (junctions, symbolic links): never snapshotted')
    for (const l of links) lines.push(excludeLine(l))
  }
  return `${lines.join('\n')}\n`
}

interface Measured {
  files: number
  bytes: number
  largeFiles: { path: string; bytes: number }[]
  partial: boolean
}

/**
 * What the next snapshot would add: `ls-files -z -o --exclude-standard [--exclude-from]` against a shadow GIT_DIR,
 * then stat. `previousLarge` (excluded by the current info/exclude, so not listed) is stat'ed on its own: still
 * large → stays excluded; shrunk → counts like any untracked file. Writes nothing.
 */
async function measureUntracked(o: {
  scopeRoot: string
  env: Record<string, string>
  limits: SizeLimits
  previousLarge: readonly string[]
  excludeFrom?: string
  git?: (args: readonly string[], opts: Omit<GitRunOptions, 'cwd'>) => Promise<GitResult>
}): Promise<Measured> {
  const L = o.limits
  const args = ['ls-files', '-z', '-o', '--exclude-standard']
  if (o.excludeFrom !== undefined) args.push(`--exclude-from=${o.excludeFrom}`)
  const opts = { maxBytes: BIG_OUTPUT, timeoutMs: 5 * 60_000 }
  const out =
    o.git !== undefined
      ? await o.git(args, opts)
      : await runGit(args, { ...opts, cwd: o.scopeRoot, env: o.env, category: 'snapshot_failed' })
  const all = splitNul(out.stdout)
  const sample = all.slice(0, Math.max(0, L.statLimit))
  const sizeOf = async (rel: string): Promise<number | null> => {
    try {
      const s = await lstat(path.join(o.scopeRoot, rel))
      return s.isFile() ? s.size : 0
    } catch {
      return null
    }
  }
  const sizes = await mapLimit(sample, 32, sizeOf)
  let files = all.length - sample.length
  let bytes = 0
  const largeFiles: { path: string; bytes: number }[] = []
  const add = (rel: string, size: number): void => {
    if (size > L.largeFileBytes) largeFiles.push({ path: rel, bytes: size })
    else {
      files++
      bytes += size
    }
  }
  sample.forEach((rel, i) => add(rel, sizes[i] ?? 0))
  const listed = new Set(all)
  for (const rel of o.previousLarge) {
    if (listed.has(rel)) continue
    const size = await sizeOf(rel)
    if (size !== null) add(rel, size)
  }
  return { files, bytes, largeFiles, partial: out.truncated || all.length > sample.length }
}

function sizeResult(m: Measured, L: SizeLimits, t0: number): SizePreflight {
  const result: SizePreflight = {
    files: m.files,
    bytes: m.bytes,
    largeFiles: m.largeFiles,
    blocked: m.files > L.maxFiles || m.bytes > L.maxBytes,
    partial: m.partial,
    limits: L,
    ms: Date.now() - t0,
  }
  if (m.files > L.maxFiles) result.reason = 'files'
  else if (m.bytes > L.maxBytes) result.reason = 'bytes'
  return result
}

async function readShadowMeta(root: string): Promise<ShadowMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'meta.json'), 'utf8')) as Partial<ShadowMeta>
    return parsed.schemaVersion === 1 ? (parsed as ShadowMeta) : null
  } catch {
    return null
  }
}

interface StagedEntry {
  mode: string
  sha: string
  stage: string
  path: string
}

/** `ls-files -z -s` records. */
function parseStaged(out: string): StagedEntry[] {
  const entries: StagedEntry[] = []
  for (const rec of splitNul(out)) {
    const m = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(rec)
    if (m !== null) entries.push({ mode: m[1] ?? '', sha: m[2] ?? '', stage: m[3] ?? '', path: m[4] ?? '' })
  }
  return entries
}

/** At most this many nested repositories are fingerprinted per snapshot. */
const NESTED_FINGERPRINT_MAX = 32

/**
 * A nested repository's working state, from reads of that repository (`--no-optional-locks`: its index is never
 * refreshed or locked): HEAD, its index (staged content), the tracked files whose stat differs from the index and
 * the untracked files, each with size and mtime. An edit there changes it. Unreadable → a unique value.
 */
async function nestedFingerprint(scopeRoot: string, rel: string): Promise<string> {
  const cwd = path.join(scopeRoot, rel)
  const read = {
    cwd,
    noOptionalLocks: true,
    maxBytes: BIG_OUTPUT,
    timeoutMs: 120_000,
    category: 'git_state' as const,
  }
  try {
    const [head, index, modified, untracked] = await Promise.all([
      tryGit(['rev-parse', '-q', '--verify', 'HEAD'], read),
      runGit(['ls-files', '-z', '-s'], read),
      runGit(['diff-files', '-z', '--name-only'], read),
      runGit(['ls-files', '-z', '-o', '--exclude-standard'], read),
    ])
    const h = createHash('sha256')
    h.update(head.ok ? head.result.stdout.trim() : '(unborn)')
    h.update('\0').update(index.stdout).update('\0')
    const paths = [...new Set([...splitNul(modified.stdout), ...splitNul(untracked.stdout)])].sort()
    const stats = await mapLimit(paths, 32, async (p) => {
      try {
        const st = await lstat(path.join(cwd, p))
        return `${p}\t${st.size}\t${st.mtimeMs}`
      } catch {
        return `${p}\t-`
      }
    })
    h.update(stats.join('\n'))
    return h.digest('hex')
  } catch {
    return `unknown:${Date.now()}`
  }
}

/** One fingerprint over every nested repository of a snapshot (undefined when there is none). */
export function nestedReposKey(rec: Pick<SnapshotRecord, 'nested'>): string | undefined {
  if (rec.nested === undefined || rec.nested.length === 0) return undefined
  const h = createHash('sha256')
  for (const n of rec.nested) h.update(`${n.path}\0${n.fingerprint}\n`)
  return h.digest('hex')
}

interface DirNames {
  exact: Set<string>
  folded: Map<string, string[]>
}

/** On-disk spelling of index paths on a case-insensitive volume (one readdir per directory). */
class CaseResolver {
  private readonly root: string
  private readonly nfc: boolean
  private readonly dirs = new Map<string, Promise<DirNames | null>>()

  constructor(root: string, nfc: boolean) {
    this.root = root
    this.nfc = nfc
  }

  private list(dir: string): Promise<DirNames | null> {
    const key = dir.toLowerCase()
    let p = this.dirs.get(key)
    if (p === undefined) {
      p = readdir(dir).then(
        (names) => {
          const exact = new Set<string>()
          const folded = new Map<string, string[]>()
          for (const raw of names) {
            const name = this.nfc ? raw.normalize('NFC') : raw
            exact.add(name)
            const k = name.toLowerCase()
            const list = folded.get(k)
            if (list === undefined) folded.set(k, [name])
            else list.push(name)
          }
          return { exact, folded }
        },
        () => null,
      )
      this.dirs.set(key, p)
    }
    return p
  }

  /** The path as spelled on disk, or null when it cannot be resolved unambiguously. */
  async actual(rel: string): Promise<string | null> {
    let dir = this.root
    const out: string[] = []
    for (const part of rel.split('/')) {
      const names = await this.list(dir)
      if (names === null) return null
      const want = this.nfc ? part.normalize('NFC') : part
      let name: string | undefined
      if (names.exact.has(want)) name = want
      else {
        const cands = names.folded.get(want.toLowerCase())
        if (cands === undefined || cands.length !== 1) return null
        name = cands[0]
      }
      if (name === undefined) return null
      out.push(name)
      dir = path.join(dir, name)
    }
    return out.join('/')
  }
}

/**
 * Can this process make a symbolic link in `dir` (win32: developer mode or the privilege)? Probed in the shadow's own
 * folder, never in the user's: a volume that refuses links there makes checkout-index fail on the link, which revert
 * then reports as skipped.
 */
async function probeSymlinks(dir: string): Promise<boolean> {
  const probe = path.join(dir, `symlink-probe-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await symlink('symlink-probe-target', probe, 'file')
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true }).catch(() => undefined)
  }
}

export class Shadow {
  readonly scope: ScopeInfo
  /** `<home>/shadow/<folderKey>` (repo.git + meta.json). */
  readonly root: string
  /** `<home>/shadow/<folderKey>/repo.git` */
  readonly gitDir: string
  readonly platform: NodeJS.Platform
  readonly limits: SizeLimits
  private readonly home: string
  private readonly snapshotTimeoutMs: number
  private readonly lockWaitMs: number
  private prepared = false
  private canSymlink = false
  private baseExclude: { source: 'repo' | 'defaults'; text: string } | null = null
  private largeFiles: string[] = []
  /** Links to folders in info/exclude (found again before every snapshot). */
  private links: string[] = []
  private createdAt = Date.now()

  private constructor(scope: ScopeInfo, opts: ShadowOpenOptions) {
    this.scope = scope
    this.home = path.resolve(opts.home)
    this.root = path.join(this.home, 'shadow', scope.folderKey)
    this.gitDir = path.join(this.root, 'repo.git')
    this.platform = opts.platform ?? process.platform
    this.limits = { ...DEFAULT_SIZE_LIMITS, ...opts.limits }
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS
    this.lockWaitMs = opts.lockWaitMs ?? 3000
  }

  /** Create (or reopen) the shadow for a scope: `init --bare`, repo config, info/attributes. */
  static async open(scope: ScopeInfo, opts: ShadowOpenOptions): Promise<Shadow> {
    const shadow = new Shadow(scope, opts)
    await withFolderLock(scope.folderKey, () => shadow.initLocked())
    return shadow
  }

  get folderKey(): string {
    return this.scope.folderKey
  }

  get scopeRoot(): string {
    return this.scope.scopeRoot
  }

  get isRepo(): boolean {
    return this.scope.isRepo
  }

  /**
   * Symbolic links can be made here (probed next to the shadow at open; core.symlinks follows it). Revert skips
   * mode-120000 entries when false rather than writing them as text files.
   */
  get symlinks(): boolean {
    return this.canSymlink
  }

  /** Shadow work (snapshot/prepare/refresh) is running for this folder. */
  get busy(): boolean {
    return isFolderBusy(this.folderKey)
  }

  /** Env for every shadow git call. revert.ts adds a scratch GIT_INDEX_FILE on top. */
  gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.scopeRoot, ...extra }
  }

  /** Run git against the shadow (cwd = scopeRoot). Callers that write must hold the folder lock. */
  git(args: readonly string[], extra: Omit<GitRunOptions, 'cwd'> = {}): Promise<GitResult> {
    const t0 = Date.now()
    return runGit(args, {
      category: 'snapshot_failed',
      ...extra,
      cwd: this.scopeRoot,
      env: this.gitEnv(extra.env),
    }).catch(async (err: unknown) => {
      if (isGitError(err) && err.kind === 'timeout' && LOCKING_COMMANDS.has(gitSubcommand(args)))
        await this.dropOwnLocks(t0)
      throw err
    })
  }

  /**
   * One of this process's own shadow git calls timed out and was killed (tree-killed on win32, process group on
   * POSIX) while holding a lock. The caller holds the folder mutex, so no other git of this process runs and only
   * read-only Dim Factory processes touch the shadow: a lock created since the call started is that git's. Removed
   * at once — else the next snapshot (the snapshot_failed retry, a manual Retry) fails for STALE_LOCK_MS.
   */
  private async dropOwnLocks(since: number): Promise<void> {
    const refsDir = path.join(this.gitDir, ...SHADOW_REF_PREFIX.split('/').filter((x) => x !== ''))
    const locks = [path.join(this.gitDir, 'index.lock'), path.join(this.gitDir, 'packed-refs.lock')]
    for (const name of await readdir(refsDir).catch(() => [] as string[])) {
      if (name.endsWith('.lock')) locks.push(path.join(refsDir, name))
    }
    for (const lock of locks) {
      const st = await stat(lock).catch(() => null)
      if (st === null || st.mtimeMs < since - LOCK_MTIME_SLACK_MS) continue
      // win32: the killed git may release its handle a moment after the exit is reported.
      for (let i = 0; i < 12; i++) {
        try {
          await rm(lock, { force: true })
          break
        } catch {
          await delay(250)
        }
      }
    }
  }

  // ---- setup -------------------------------------------------------------------------------

  private metaPath(): string {
    return path.join(this.root, 'meta.json')
  }

  private readMeta(): Promise<ShadowMeta | null> {
    return readShadowMeta(this.root)
  }

  /** `<home>/empty-hooks`: the shadow's core.hooksPath (an empty folder Dim Factory owns). */
  get hooksPath(): string {
    return path.join(this.home, EMPTY_HOOKS_DIRNAME)
  }

  private async writeMeta(): Promise<void> {
    const meta: ShadowMeta = {
      schemaVersion: 1,
      folderKey: this.folderKey,
      scopeRoot: this.scopeRoot,
      lockKey: this.scope.lockKey,
      isRepo: this.isRepo,
      ignorecase: this.scope.caseInsensitive,
      configVersion: SHADOW_CONFIG_VERSION,
      platform: this.platform,
      hooksPath: gitConfigPath(this.hooksPath),
      symlinks: this.canSymlink,
      largeFiles: this.largeFiles,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    }
    await writeFileAtomicLite(this.metaPath(), `${JSON.stringify(meta, null, 2)}\n`)
  }

  private async initLocked(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await mkdir(this.hooksPath, { recursive: true })
    const fresh = !(await exists(path.join(this.gitDir, 'HEAD')))
    if (fresh) {
      // --template= : no hooks/description/info from the user's init.templateDir; -c core.hooksPath: a global
      // hooks path must not run for the init itself (reference-transaction on HEAD, git ≥ 2.28).
      await runGit(
        [
          '-c',
          `core.hooksPath=${gitConfigPath(this.hooksPath)}`,
          'init',
          '--bare',
          '-q',
          '--template=',
          this.gitDir,
        ],
        { cwd: this.root, category: 'snapshot_failed' },
      )
    }
    this.canSymlink = await probeSymlinks(this.root)
    const meta = await this.readMeta()
    if (meta !== null) {
      this.createdAt = meta.createdAt
      this.largeFiles = Array.isArray(meta.largeFiles) ? meta.largeFiles : []
    }
    const stale =
      fresh ||
      meta === null ||
      meta.configVersion !== SHADOW_CONFIG_VERSION ||
      meta.ignorecase !== this.scope.caseInsensitive ||
      meta.platform !== this.platform ||
      meta.hooksPath !== gitConfigPath(this.hooksPath) ||
      meta.symlinks !== this.canSymlink
    if (stale) {
      const configFile = path.join(this.gitDir, 'config')
      const current = await readFile(configFile, 'utf8')
      const entries = shadowConfig(this.platform, this.scope.caseInsensitive, this.hooksPath, this.canSymlink)
      await writeFileAtomicLite(configFile, withShadowConfigBlock(current, entries), { mode: 0o644 })
    }
    const info = path.join(this.gitDir, 'info')
    await mkdir(info, { recursive: true })
    const attributes = path.join(info, 'attributes')
    if ((await readFile(attributes, 'utf8').catch(() => null)) !== SHADOW_ATTRIBUTES) {
      await writeFileAtomicLite(attributes, SHADOW_ATTRIBUTES)
    }
    if (stale) await this.writeMeta()
  }

  /**
   * info/exclude, written atomically (a concurrent reader — `add -A`, a read-only size measurement in another
   * process — never sees it truncated).
   */
  private async writeExclude(): Promise<'repo' | 'defaults'> {
    this.baseExclude ??= await baseExcludeFor(this.scope)
    const text = excludeFileText(
      this.baseExclude.text,
      this.scopeRoot,
      this.home,
      this.largeFiles,
      this.limits,
      this.links,
    )
    await writeFileAtomicLite(path.join(this.gitDir, 'info', 'exclude'), text)
    return this.baseExclude.source
  }

  // ---- links to folders -------------------------------------------------------------------------

  /**
   * The links to folders in the scope now: the walk's, plus links found earlier where the walk did not read (a pruned
   * folder) that are still links. info/exclude is rewritten when the list changed, unless `write` is false (the caller
   * writes it).
   */
  private async scanLinksLocked(o: { write?: boolean } = {}): Promise<FolderLinkScan> {
    const home = homeInside(this.scopeRoot, this.home)
    const scan = await scanFolderLinks(this.scopeRoot, home !== undefined ? { skip: [home] } : {})
    const earlier = this.links.filter((l) => !walkCovers(scan, l) && !underLink(l, scan.links))
    const still = await mapLimit(earlier, 16, async (l) =>
      (await isFolderLink(path.join(this.scopeRoot, ...l.split('/')))) ? l : null,
    )
    const links = outermostLinks(
      [...scan.links, ...still.filter((l): l is string => l !== null)],
      this.scope.caseInsensitive,
    )
    if (o.write === false) this.links = links
    else await this.setLinksLocked(links)
    return { ...scan, links }
  }

  private async setLinksLocked(links: string[]): Promise<void> {
    if (sameList(links, this.links)) return
    this.links = links
    await this.writeExclude()
  }

  /**
   * After `add -A`: index entries at or under a link to a folder leave the index (`update-index --index-info` with
   * mode 0) before the tree is written. The links come from the walk, plus any folder of an entry the walk did not
   * read that is a link (asked with lstat, shallowest first) and any symbolic-link entry there that points at a
   * folder. A new one joins info/exclude so the next `add -A` skips it.
   * Entries inside a nested repository the walk found leave too: older git (2.17 among them) stages the files of a
   * repository without a commit as the project's own (current git refuses: "does not have a commit checked out"); such a
   * repository is returned in `unborn` so the snapshot reports it as nested, as it does on current git.
   */
  private async dropLinkedLocked(
    staged: readonly StagedEntry[],
    scan: FolderLinkScan,
    indexFile?: string,
  ): Promise<{ staged: StagedEntry[]; links: string[]; unborn: string[] }> {
    const fold = this.scope.caseInsensitive
    const key = (p: string): string => (fold ? p.toLowerCase() : p)
    const repoKeys = scan.repos.map((r) => `${key(r)}/`)
    const repoOf = (p: string): string | undefined => {
      const k = key(p)
      const i = repoKeys.findIndex((r) => k.startsWith(r))
      return i === -1 ? undefined : scan.repos[i]
    }
    const unborn = new Set<string>()
    const visited = new Set([...scan.visited].map(key))
    let links = scan.links
    const unread = new Map<number, Set<string>>()
    const ask = (rel: string): void => {
      const depth = rel.split('/').length
      let set = unread.get(depth)
      if (set === undefined) unread.set(depth, (set = new Set()))
      set.add(rel)
    }
    for (const e of staged) {
      if (underLink(e.path, links, fold)) continue
      const repo = repoOf(e.path)
      if (repo !== undefined) {
        unborn.add(repo)
        continue
      }
      const parts = e.path.split('/')
      let prefix = ''
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix === '' ? (parts[i] ?? '') : `${prefix}/${parts[i] ?? ''}`
        if (!visited.has(key(prefix))) ask(prefix)
      }
      // A symbolic-link entry the walk did not judge (its folder was not read), or a gitlink there: `add -A` stores a
      // junction to another repository (or back to this one) as a 160000 entry of the target's HEAD.
      if ((e.mode === '120000' || e.mode === '160000') && !walkCovers({ visited }, key(e.path))) ask(e.path)
    }
    const found: string[] = []
    for (const depth of [...unread.keys()].sort((a, b) => a - b)) {
      const todo = [...(unread.get(depth) ?? [])].filter((rel) => !underLink(rel, found, fold))
      const hits = await mapLimit(todo, 32, async (rel) =>
        (await isFolderLink(path.join(this.scopeRoot, ...rel.split('/')))) ? rel : null,
      )
      for (const h of hits) if (h !== null) found.push(h)
    }
    if (found.length > 0) links = outermostLinks([...links, ...found], fold)
    const drop = staged.filter((e) => underLink(e.path, links, fold) || repoOf(e.path) !== undefined)
    for (const r of [...unborn]) if (underLink(r, links, fold)) unborn.delete(r)
    if (drop.length > 0) {
      const lines = drop.map((e) => `0 ${'0'.repeat(e.sha.length)}\t${e.path}`)
      await this.git(['update-index', '-z', '--index-info'], {
        stdin: `${lines.join('\0')}\0`,
        ...(indexFile !== undefined ? { env: { GIT_INDEX_FILE: indexFile } } : {}),
      })
    }
    await this.setLinksLocked(links)
    const dropped = new Set(drop)
    return { staged: staged.filter((e) => !dropped.has(e)), links, unborn: [...unborn].sort() }
  }

  private async forceAddTrackedIgnored(warnings: string[]): Promise<number> {
    if (!this.isRepo || this.scope.repo.dubiousOwnership) return 0
    let tracked: string[]
    try {
      tracked = await listTrackedIgnored(this.scopeRoot)
    } catch (err) {
      warnings.push(`could not list tracked-but-ignored files: ${(err as Error).message}`)
      return 0
    }
    if (tracked.length === 0) return 0
    const large = new Set(this.largeFiles)
    const keep = (
      await mapLimit(tracked, 32, async (rel) => {
        if (large.has(rel) || underLink(rel, this.links, this.scope.caseInsensitive)) return null
        try {
          const s = await lstat(path.join(this.scopeRoot, rel))
          return s.isSymbolicLink() || (s.isFile() && s.size <= this.limits.largeFileBytes) ? rel : null
        } catch {
          return null
        }
      })
    ).filter((p): p is string => p !== null)
    for (const batch of chunkPaths(keep)) {
      try {
        await this.git(['add', '-f', '--ignore-errors', '--', ...batch], {
          literalPathspecs: true,
          okCodes: [0, 1],
          timeoutMs: this.snapshotTimeoutMs,
        })
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err))
      }
    }
    return keep.length
  }

  private async prepareLocked(): Promise<PrepareResult> {
    const warnings: string[] = []
    this.baseExclude = null
    // Another Shadow object for this folder may have re-measured large files since this one opened.
    const meta = await this.readMeta()
    if (meta !== null && Array.isArray(meta.largeFiles)) this.largeFiles = meta.largeFiles
    // The links to folders are listed (info/exclude is written with them) before anything is force-added.
    await this.scanLinksLocked({ write: false })
    const excludeSource = await this.writeExclude()
    const forceAdded = await this.forceAddTrackedIgnored(warnings)
    this.prepared = true
    return { excludeSource, forceAdded, warnings }
  }

  private async ensurePreparedLocked(): Promise<void> {
    if (!this.prepared) await this.prepareLocked()
  }

  /**
   * Run-start setup: regenerate info/exclude (the user's `--git-path info/exclude`, or Dim Factory defaults for a
   * non-git folder; plus DIM_FACTORY_HOME when inside the scope and auto-excluded large files) and force-add files
   * the user tracks although they match ignore rules. Snapshot/sizePreflight call it once if nobody did.
   */
  prepare(): Promise<PrepareResult> {
    return withFolderLock(this.folderKey, () => this.prepareLocked())
  }

  /**
   * Size preflight (the guard): `ls-files -o --exclude-standard` + stat. More than `maxFiles` untracked files
   * or `maxBytes` blocks (the `largeFolder` grant clears it); files over `largeFileBytes` go into info/exclude.
   * Files excluded as large earlier are stat'ed again (they may have shrunk). The listing never runs against a
   * stripped info/exclude: the new large-file list is computed in memory and written once, atomically, only when
   * it changed; a failed listing changes nothing. Read-only callers use `sizePreflightReadOnly` instead.
   */
  sizePreflight(limits: Partial<SizeLimits> = {}): Promise<SizePreflight> {
    return withFolderLock(this.folderKey, async () => {
      const t0 = Date.now()
      const L: SizeLimits = { ...this.limits, ...limits }
      await this.ensurePreparedLocked()
      // Another Shadow object (or process) may have re-measured since; info/exclude matches its meta.json.
      const meta = await this.readMeta()
      if (meta !== null && Array.isArray(meta.largeFiles) && !sameList(meta.largeFiles, this.largeFiles)) {
        this.largeFiles = meta.largeFiles
        await this.writeExclude()
      }
      // A link to a folder made since is never measured as the project's files.
      await this.scanLinksLocked()
      const m = await measureUntracked({
        scopeRoot: this.scopeRoot,
        env: this.gitEnv(),
        limits: L,
        previousLarge: this.largeFiles,
        git: (args, o) => this.git(args, o),
      })
      const next = m.largeFiles.map((f) => f.path)
      if (!sameList(next, this.largeFiles)) {
        this.largeFiles = next
        await this.writeExclude()
        await this.writeMeta()
      }
      return sizeResult(m, L, t0)
    })
  }

  // ---- crash leftovers ----------------------------------------------------------------------

  /**
   * A git killed mid-write (app crash, kill -9; on win32 the job object kills git with the app) leaves its
   * `*.lock` in the shadow and every later snapshot would fail. Callers hold the folder lock, so no git of this
   * process is running: wait up to `waitMs` for the file to go (a POSIX orphan finishing), then remove it if it
   * predates this process or is older than any shadow git call can run.
   */
  private async clearStaleLocks(locks: readonly string[], waitMs: number, warnings: string[]): Promise<void> {
    for (const lock of locks) {
      for (let waited = 0; ; waited += 250) {
        const st = await stat(lock).catch(() => null)
        if (st === null) break
        if (waited >= waitMs) {
          if (st.mtimeMs < PROCESS_START_MS || Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            await rm(lock, { force: true })
            warnings.push(`removed a stale ${path.relative(this.gitDir, lock)} left by an interrupted git`)
          }
          break
        }
        await delay(250)
      }
    }
  }

  /**
   * `add -A --ignore-errors`; a corrupt shadow index (it is only a stat cache) is dropped and rebuilt once. Files
   * that could not be opened or read get one more try after a pause: on Windows a file just written is often held
   * for a moment (antivirus, indexer), which git reports as "Permission denied" on open.
   */
  private async addAll(warnings: string[], indexFile?: string): Promise<GitResult> {
    const env = indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : undefined
    const run = (): Promise<GitResult> =>
      this.git(['add', '-A', '--ignore-errors'], {
        okCodes: [0, 1],
        timeoutMs: this.snapshotTimeoutMs,
        ...(env !== undefined ? { env } : {}),
      })
    let r: GitResult
    try {
      r = await run()
    } catch (err) {
      if (!isGitError(err) || !CORRUPT_INDEX.test(err.stderr)) throw err
      await rm(indexFile ?? path.join(this.gitDir, 'index'), { force: true })
      warnings.push('rebuilt the shadow index (it was corrupt)')
      r = await run()
    }
    if (r.code === 0 || !TRANSIENT_ADD_ERROR.test(r.stderr)) return r
    await delay(ADD_RETRY_DELAY_MS)
    return run()
  }

  // ---- snapshots -----------------------------------------------------------------------------

  private async runRefLocked(runId: string): Promise<{ commit: string; tree: string } | null> {
    const ref = SHADOW_REF_PREFIX + runId
    const r = await this.git(['cat-file', '--batch-check'], { stdin: `${ref}\n${ref}^{tree}\n` })
    const [c, t] = r.stdout.split(/\r?\n/)
    const cm = /^([0-9a-f]+) commit \d+$/.exec(c ?? '')
    const tm = /^([0-9a-f]+) tree \d+$/.exec(t ?? '')
    return cm !== null && tm !== null ? { commit: cm[1] ?? '', tree: tm[1] ?? '' } : null
  }

  /** The commit and tree `refs/dimfactory/runs/<runId>` points at, or null before the run's first snapshot. */
  async runRef(runId: string): Promise<{ commit: string; tree: string } | null> {
    return this.runRefLocked(assertRunRefId(runId))
  }

  /** On a case-insensitive volume, rewrite index paths whose on-disk spelling changed (case-only renames). */
  private async fixCaseLocked(staged: readonly StagedEntry[], indexFile?: string): Promise<string[]> {
    const resolver = new CaseResolver(this.scopeRoot, this.platform === 'darwin')
    const fixes: { mode: string; sha: string; from: string; to: string }[] = []
    for (const e of staged) {
      if (e.stage !== '0') continue
      const from = e.path
      const to = await resolver.actual(from)
      if (to !== null && to !== from) fixes.push({ mode: e.mode, sha: e.sha, from, to })
    }
    if (fixes.length === 0) return []
    const zero = (n: number): string => '0'.repeat(n)
    const lines = fixes.flatMap((f) => [`0 ${zero(f.sha.length)}\t${f.from}`, `${f.mode} ${f.sha}\t${f.to}`])
    await this.git(['update-index', '-z', '--index-info'], {
      stdin: `${lines.join('\0')}\0`,
      ...(indexFile !== undefined ? { env: { GIT_INDEX_FILE: indexFile } } : {}),
    })
    return fixes.map((f) => `case-only rename: ${f.from} -> ${f.to}`)
  }

  /**
   * The folder's tree right now, without a snapshot (for reconciliation): the snapshot pipeline
   * (`add -A --ignore-errors`, case-only rename fixes, write-tree) on a scratch copy of the shadow index. No ref
   * moves; only blob and tree objects are added to the shadow's store. The shadow's own index is written only by
   * the one-time prepare (force-adding tracked-but-ignored files) when no snapshot ran in this process yet.
   */
  async treeNow(): Promise<{ tree: string; unreadable: string[]; warnings: string[]; ms: number }> {
    return withFolderLock(this.folderKey, async () => {
      const t0 = Date.now()
      const notes: string[] = []
      await this.ensurePreparedLocked()
      // The same link exclusion as a snapshot (the tree is compared with snapshots).
      const linkScan = await this.scanLinksLocked()
      const scratch = path.join(this.root, `scratch-${process.pid}-${randomBytes(6).toString('hex')}.index`)
      try {
        // A copy keeps the stat cache: only files changed since the last snapshot are hashed again.
        await copyIndex(path.join(this.gitDir, 'index'), scratch).catch(() => undefined)
        const add = await this.addAll(notes, scratch)
        const { unreadable, warnings } = parseAddStderr(add.stderr)
        warnings.unshift(...notes)
        if (add.code !== 0 && /^fatal:/m.test(add.stderr)) {
          throw new GitError('exit', `git add failed: ${add.stderr.trim().split(/\r?\n/)[0] ?? ''}`, {
            args: add.args,
            exitCode: add.code,
            stderr: add.stderr,
            category: 'snapshot_failed',
          })
        }
        const env = { GIT_INDEX_FILE: scratch }
        // A complete walk that found no link leaves nothing to drop: the listing is needed only for case fixes then.
        if (this.scope.caseInsensitive || linkScan.partial || linkScan.links.length > 0) {
          const listed = parseStaged(
            (await this.git(['ls-files', '-z', '-s'], { maxBytes: BIG_OUTPUT, env })).stdout,
          )
          const { staged } = await this.dropLinkedLocked(listed, linkScan, scratch)
          if (this.scope.caseInsensitive) warnings.push(...(await this.fixCaseLocked(staged, scratch)))
        }
        const tree = (await this.git(['write-tree'], { env })).stdout.trim()
        if (!SHA.test(tree)) throw this.badOutput('write-tree', tree)
        return { tree, unreadable, warnings, ms: Date.now() - t0 }
      } finally {
        await rm(scratch, { force: true }).catch(() => undefined)
        await rm(`${scratch}.lock`, { force: true }).catch(() => undefined)
      }
    })
  }

  /**
   * `add -A --ignore-errors` (exit 1 tolerated; `error:` lines → unreadable) → write-tree → commit-tree (the run's
   * previous commit is reused when the tree is unchanged; fixed identity; --no-gpg-sign) →
   * `update-ref refs/dimfactory/runs/<runId>`. Returns the snapshots.json entry for the caller to append.
   * Throws GitError (category snapshot_failed / disk_full) when git fails.
   */
  async snapshot(runId: string, label: SnapLabel, opts: SnapshotOptions = {}): Promise<SnapshotRecord> {
    assertRunRefId(runId)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
      throw new GitError('exit', `invalid snapshot label: ${JSON.stringify(label)}`, {
        args: [],
        category: 'snapshot_failed',
      })
    }
    return withFolderLock(this.folderKey, async () => {
      const t0 = Date.now()
      const notes: string[] = []
      const locks = [
        path.join(this.gitDir, 'index.lock'),
        path.join(this.gitDir, `${SHADOW_REF_PREFIX}${runId}.lock`),
      ]
      await this.clearStaleLocks(locks, this.lockWaitMs, notes)
      await this.ensurePreparedLocked()
      // Links to folders are excluded before add reads the folder.
      const linkScan = await this.scanLinksLocked()
      // The run's previous snapshot is read while add runs (refs and the index do not interact).
      const [add, prev] = await Promise.all([this.addAll(notes), this.runRefLocked(runId)])
      const { unreadable, warnings } = parseAddStderr(add.stderr)
      warnings.unshift(...notes)
      if (add.code !== 0 && /^fatal:/m.test(add.stderr)) {
        throw new GitError('exit', `git add failed: ${add.stderr.trim().split(/\r?\n/)[0] ?? ''}`, {
          args: add.args,
          exitCode: add.code,
          stderr: add.stderr,
          category: 'snapshot_failed',
        })
      }
      const listed = parseStaged((await this.git(['ls-files', '-z', '-s'], { maxBytes: BIG_OUTPUT })).stdout)
      // Nothing at or under a link to a folder, or inside a nested repository, reaches the tree.
      const { staged, links, unborn } = await this.dropLinkedLocked(listed, linkScan)
      if (this.scope.caseInsensitive) warnings.push(...(await this.fixCaseLocked(staged)))
      const nested = await this.nestedRepos(staged, [...unreadable, ...unborn])
      const nestedSet = new Set(nested.map((n) => n.path))
      const readable = unreadable.filter((u) => !nestedSet.has(u.replace(/\/+$/, '')))
      const forced = await this.forceable(opts.force ?? [])
      const tree =
        forced.length > 0
          ? await this.treeWithForced(forced, warnings)
          : (await this.git(['write-tree'])).stdout.trim()
      if (!SHA.test(tree)) throw this.badOutput('write-tree', tree)
      let commit: string
      let reused = false
      if (prev !== null && prev.tree === tree) {
        commit = prev.commit
        reused = true
      } else {
        const args = ['commit-tree', '--no-gpg-sign', '-m', `${runId} ${label}`]
        if (prev !== null) args.push('-p', prev.commit)
        args.push(tree)
        commit = (await this.git(args, { env: IDENTITY_ENV })).stdout.trim()
        if (!SHA.test(commit)) throw this.badOutput('commit-tree', commit)
        const old = prev?.commit ?? '0'.repeat(commit.length)
        await this.git(['update-ref', '-m', `dim-factory: ${label}`, SHADOW_REF_PREFIX + runId, commit, old])
      }
      return {
        label,
        tree,
        commit,
        at: Date.now(),
        unreadable: readable,
        reused,
        ms: Date.now() - t0,
        warnings,
        ...(nested.length > 0 ? { nested } : {}),
        ...(links.length > 0 ? { links } : {}),
      }
    })
  }

  /**
   * Git repositories nested in the scope — submodules and embedded repos (gitlinks, mode 160000) and repos without
   * a commit (`add` cannot read them) — with a fingerprint of their working state: their files are not in the
   * shadow tree, so tree(S0) = tree(S1) says nothing about them. Reads only (`--no-optional-locks`).
   */
  private async nestedRepos(
    staged: readonly StagedEntry[],
    unreadable: readonly string[],
  ): Promise<NestedRepo[]> {
    const dirs = new Set(staged.filter((e) => e.mode === '160000').map((e) => e.path))
    for (const u of unreadable) {
      const rel = u.replace(/\/+$/, '')
      if (rel !== '' && (await exists(path.join(this.scopeRoot, rel, '.git')))) dirs.add(rel)
    }
    const list = [...dirs].sort()
    if (list.length > NESTED_FINGERPRINT_MAX) {
      // Too many to read on every snapshot: unknown state, so no pass is ever judged to have made no changes.
      return list.map((p) => ({ path: p, fingerprint: `unknown:${Date.now()}` }))
    }
    return mapLimit(list, 4, async (p) => ({
      path: p,
      fingerprint: await nestedFingerprint(this.scopeRoot, p),
    }))
  }

  /**
   * The `force` paths `add -f` can take: plain relative paths to a file (at most the large file limit) or a symbolic
   * link, with no link or file in the place of a parent folder (git refuses a path beyond a link).
   */
  private async forceable(paths: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(paths.map((p) => p.replace(/\\/g, '/')))].filter((p) => {
      if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
      return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
    })
    const parents = new Map<string, boolean>()
    const parentOk = async (rel: string): Promise<boolean> => {
      const parts = rel.split('/')
      let prefix = ''
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix === '' ? (parts[i] ?? '') : `${prefix}/${parts[i] ?? ''}`
        let ok = parents.get(prefix)
        if (ok === undefined) {
          ok = await lstat(path.join(this.scopeRoot, prefix)).then(
            (s) => s.isDirectory(),
            () => false,
          )
          parents.set(prefix, ok)
        }
        if (!ok) return false
      }
      return true
    }
    const keep: string[] = []
    for (const rel of wanted) {
      // Nothing at or under a link to a folder (`add -f` would read a junction's target as a folder).
      if (underLink(rel, this.links, this.scope.caseInsensitive)) continue
      if (!(await parentOk(rel))) continue
      const abs = path.join(this.scopeRoot, rel)
      const s = await lstat(abs).catch(() => null)
      if (s === null) continue
      if (s.isSymbolicLink()) {
        if (!(await isFolderLink(abs))) keep.push(rel)
      } else if (s.isFile() && s.size <= this.limits.largeFileBytes) keep.push(rel)
    }
    return keep
  }

  /**
   * The index's tree plus `paths` added with `add -f` (ignore rules do not apply), on a scratch copy of the shadow
   * index: the shadow's own index, and so every later snapshot, stays as `add -A` leaves it. A batch git refuses as a
   * whole is added path by path; a path it still refuses is left out with a warning.
   */
  private async treeWithForced(paths: readonly string[], warnings: string[]): Promise<string> {
    const scratch = path.join(this.root, `force-${process.pid}-${randomBytes(6).toString('hex')}.index`)
    const env = { GIT_INDEX_FILE: scratch }
    const add = (batch: readonly string[]): Promise<GitResult> =>
      this.git(['add', '-f', '--ignore-errors', '--', ...batch], {
        env,
        literalPathspecs: true,
        okCodes: [0, 1, 128],
        timeoutMs: this.snapshotTimeoutMs,
      })
    try {
      await copyIndex(path.join(this.gitDir, 'index'), scratch)
      for (const batch of chunkPaths(paths)) {
        const r = await add(batch)
        if (r.code !== 128) continue
        for (const one of batch) {
          const r1 = await add([one])
          if (r1.code === 128)
            warnings.push(`could not save ${one}: ${r1.stderr.trim().split(/\r?\n/)[0] ?? ''}`)
        }
      }
      return (await this.git(['write-tree'], { env })).stdout.trim()
    } finally {
      await rm(scratch, { force: true }).catch(() => undefined)
      await rm(`${scratch}.lock`, { force: true }).catch(() => undefined)
    }
  }

  private badOutput(cmd: string, out: string): GitError {
    return new GitError('exit', `git ${cmd} printed no object id: ${out.slice(0, 200)}`, {
      args: [cmd],
      category: 'snapshot_failed',
    })
  }

  // ---- diffs -----------------------------------------------------------------------------------

  /** `diff-tree -r -z -M` --raw + --numstat (+ --numstat --ignore-cr-at-eol for EOL-only detection), merged. */
  async diffSummary(a: string, b: string): Promise<DiffSummary> {
    const base = ['diff-tree', '-r', '-z', '-M', '--no-ext-diff', '--no-textconv']
    const revs = [assertRev(a), assertRev(b)]
    const opts = { maxBytes: BIG_OUTPUT }
    const [raw, num, numCr] = await Promise.all([
      this.git([...base, '--raw', ...revs], opts),
      this.git([...base, '--numstat', ...revs], opts),
      this.git([...base, '--numstat', '--ignore-cr-at-eol', ...revs], opts),
    ])
    return mergeDiff(raw.stdout, num.stdout, numCr.stdout)
  }

  /** Files changed between two snapshots (commits, trees or shadow refs). Renames count once. */
  async changes(a: string, b: string): Promise<FileChange[]> {
    return (await this.diffSummary(a, b)).changes
  }

  /** linguist-generated paths per `check-attr` in the shadow env (in-tree .gitattributes). */
  private async generatedPaths(paths: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>()
    if (paths.length === 0) return out
    const r = await tryGit(['check-attr', '-z', '--stdin', 'linguist-generated'], {
      cwd: this.scopeRoot,
      env: this.gitEnv(),
      stdin: `${paths.join('\0')}\0`,
      category: 'snapshot_failed',
    })
    if (!r.ok) return out
    const t = splitNul(r.result.stdout)
    for (let i = 0; i + 2 < t.length; i += 3) {
      const value = t[i + 2]
      if (value === 'set' || value === 'true') out.add(t[i] ?? '')
    }
    return out
  }

  /**
   * UI patch (`forPrompt` false): `diff-tree -r -p -M --no-color --no-ext-diff [--ignore-cr-at-eol]`, persisted as
   * `diffs/<a>..<b>.patch` by the caller. Prompt patch: the same with --ignore-cr-at-eol, post-processed by
   * buildPromptPatch (header, collapse, EOL-only list, cap min(150 KB, 0.25 × contextWindow × 3.5)).
   */
  async patch(a: string, b: string, opts: PatchOptions = {}): Promise<PatchResult> {
    const revs = [assertRev(a), assertRev(b)]
    const base = ['diff-tree', '-r', '-p', '-M', '--no-color', '--no-ext-diff', '--no-textconv']
    if (opts.forPrompt !== true) {
      const maxBytes = opts.maxBytes ?? BIG_OUTPUT
      const r = await this.git(
        [...base, ...(opts.ignoreEol === true ? ['--ignore-cr-at-eol'] : []), ...revs],
        {
          maxBytes,
        },
      )
      return {
        text: r.stdout,
        bytes: Buffer.byteLength(r.stdout, 'utf8'),
        truncated: r.truncated,
        capBytes: null,
        files: (r.stdout.match(/^diff --git /gm) ?? []).length,
        collapsed: [],
        omitted: [],
        eolOnly: [],
      }
    }
    const [summary, raw] = await Promise.all([
      this.diffSummary(a, b),
      this.git([...base, '--ignore-cr-at-eol', ...revs], { maxBytes: BIG_OUTPUT }),
    ])
    const generated = await this.generatedPaths(summary.changes.map((c) => c.path))
    const files: PromptPatchFile[] = summary.changes.map((change) => {
      const s = summary.promptStats.get(change.path)
      return {
        change,
        added: s?.added ?? change.added,
        deleted: s?.deleted ?? change.deleted,
        generated: generated.has(change.path),
      }
    })
    const capBytes = opts.maxBytes ?? promptPatchCap(opts.contextWindow)
    const built: PromptPatch = buildPromptPatch(raw.stdout, files, { capBytes })
    return { ...built, truncated: built.truncated || raw.truncated, capBytes: built.capBytes }
  }

  // ---- live count ------------------------------------------------------------------------------

  /**
   * Paths changed since the last snapshot: `update-index -q --refresh` + `diff-files --name-only -z` ∪
   * `ls-files -z -o --exclude-standard`. With `skipIfBusy` (default) it returns null instead of waiting when a
   * snapshot holds the folder lock, so the poll just skips that tick.
   *
   * `since` (live balanced run): a commit the count starts from instead, the run's S0. The paths the snapshots
   * since it changed (`diff-index --cached --name-only` against the shadow index, which holds the last snapshot) are
   * added, so Fix's live count is the run's files, not only the ones Fix touched since its own start snapshot (it read
   * "0 files" while Fix ran). A path changed and then put back exactly is still counted until the next snapshot's
   * exact figures replace the live count. When that commit cannot be read, the count is the plain one.
   */
  async liveChanged(opts: { skipIfBusy?: boolean; since?: string } = {}): Promise<string[] | null> {
    const work = async (): Promise<string[]> => {
      if (!this.prepared && !(await exists(path.join(this.gitDir, 'info', 'exclude'))))
        await this.prepareLocked()
      await this.clearStaleLocks([path.join(this.gitDir, 'index.lock')], 0, [])
      await this.git(['update-index', '-q', '--refresh'], { okCodes: [0, 1], timeoutMs: 120_000 })
      const [mod, untracked, earlier] = await Promise.all([
        this.git(['diff-files', '--name-only', '-z'], { maxBytes: BIG_OUTPUT, timeoutMs: 120_000 }),
        this.git(['ls-files', '-z', '-o', '--exclude-standard'], {
          maxBytes: BIG_OUTPUT,
          timeoutMs: 120_000,
        }),
        opts.since === undefined
          ? Promise.resolve(null)
          : this.git(['diff-index', '--cached', '--no-renames', '--name-only', '-z', opts.since, '--'], {
              maxBytes: BIG_OUTPUT,
              timeoutMs: 120_000,
            }).catch(() => null),
      ])
      return [
        ...new Set([
          ...splitNul(mod.stdout),
          ...splitNul(untracked.stdout),
          ...(earlier !== null ? splitNul(earlier.stdout) : []),
        ]),
      ].sort()
    }
    if (opts.skipIfBusy ?? true) return (await tryWithFolderLock(this.folderKey, work)) ?? null
    return withFolderLock(this.folderKey, work)
  }
}

/** resolveScope(folder) + Shadow.open(scope, opts). */
export async function openShadow(folder: string, opts: ShadowOpenOptions): Promise<Shadow> {
  return Shadow.open(await resolveScope(folder, opts.platform), opts)
}

/**
 * The size preflight for read-only cores (CLI `preflight`, `doctor`): they hold no home lock, so they must not
 * touch a shadow a running Dim Factory may be snapshotting (its index, info/exclude, meta.json). Lists against the
 * existing shadow's index read-only — or a throwaway bare repo in the temp folder when there is no shadow yet —
 * with the exclude rules built in a temp file. Nothing under DIM_FACTORY_HOME is created or written.
 */
export async function sizePreflightReadOnly(
  scope: ScopeInfo,
  opts: ShadowOpenOptions & { overrides?: Partial<SizeLimits> },
): Promise<SizePreflight> {
  const t0 = Date.now()
  const L: SizeLimits = { ...DEFAULT_SIZE_LIMITS, ...opts.limits, ...opts.overrides }
  const home = path.resolve(opts.home)
  const root = path.join(home, 'shadow', scope.folderKey)
  const tmp = await mkdtemp(path.join(tmpdir(), 'dim-factory-size-'))
  try {
    let gitDir = path.join(root, 'repo.git')
    if (!(await exists(path.join(gitDir, 'HEAD')))) {
      gitDir = path.join(tmp, 'repo.git')
      const hooks = path.join(tmp, 'hooks')
      await mkdir(hooks)
      await runGit(
        ['-c', `core.hooksPath=${gitConfigPath(hooks)}`, 'init', '--bare', '-q', '--template=', gitDir],
        {
          cwd: tmp,
          category: 'snapshot_failed',
        },
      )
    }
    const meta = await readShadowMeta(root)
    const previousLarge = meta !== null && Array.isArray(meta.largeFiles) ? meta.largeFiles : []
    const excludeFrom = path.join(tmp, 'exclude')
    const base = await baseExcludeFor(scope)
    // Links to folders are not the project's files (the walk only reads).
    const relHome = homeInside(scope.scopeRoot, home)
    const { links } = await scanFolderLinks(scope.scopeRoot, relHome !== undefined ? { skip: [relHome] } : {})
    await writeFile(excludeFrom, excludeFileText(base.text, scope.scopeRoot, home, previousLarge, L, links))
    const m = await measureUntracked({
      scopeRoot: scope.scopeRoot,
      env: { GIT_DIR: gitDir, GIT_WORK_TREE: scope.scopeRoot },
      limits: L,
      previousLarge,
      excludeFrom,
    })
    return sizeResult(m, L, t0)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

const shared = new Map<string, Promise<Shadow>>()

/**
 * One Shadow object per (home, folderKey) for the whole process, so preflight, the supervisor and the live-count
 * poll share prepare state. A failed open is not cached.
 */
export function shadowFor(scope: ScopeInfo, opts: ShadowOpenOptions): Promise<Shadow> {
  const key = `${path.resolve(opts.home)}\0${scope.folderKey}`
  let p = shared.get(key)
  if (p === undefined) {
    p = Shadow.open(scope, opts)
    shared.set(key, p)
    void p.catch(() => shared.delete(key))
  }
  return p
}

/** Forget cached Shadow objects (tests; Settings → Clear snapshots). */
export function forgetShadows(folderKey?: string): void {
  for (const key of [...shared.keys()])
    if (folderKey === undefined || key.endsWith(`\0${folderKey}`)) shared.delete(key)
}

// ---- retention: snapshot refs and shadow gc ----------------------------------------------------------------------

/** gcIfIdle collects a shadow only when no run has used its folder for this long. */
export const SHADOW_GC_IDLE_MS = 5 * 60_000
/** ...and at most once a day per shadow. */
export const SHADOW_GC_INTERVAL_MS = 24 * 60 * 60_000
const GC_TIMEOUT_MS = 30 * 60_000
const FOLDER_KEY_RE = /^[0-9a-f]{16}$/

/** `<home>/shadow/<folderKey>/gc.json`: when the shadow was last collected, and when refs were last deleted from it. */
export interface ShadowGcState {
  lastGcAt?: number
  refsDeletedAt?: number
  /**
   * The mtime (wall clock) of `refs/dimfactory/runs` right after Dim Factory's own write to it (deleteRunRefs,
   * or gc packing the refs). The idle check leaves the folder out while it is no newer: that write is not a run using
   * the folder (a run's snapshot also writes the index; and only one Dim Factory process writes a home at a time).
   */
  refsDirMtime?: number
}

/** gc.json's record of an own write to the refs folder (`after`: its mtime once done; unchanged: nothing new). */
function ownRefsWrite(
  prev: ShadowGcState,
  before: number | undefined,
  after: number | undefined,
): Pick<ShadowGcState, 'refsDirMtime'> {
  if (after !== undefined && after !== before) return { refsDirMtime: after }
  return prev.refsDirMtime !== undefined ? { refsDirMtime: prev.refsDirMtime } : {}
}

const shadowRootOf = (home: string, folderKey: string): string =>
  path.dirname(homePaths(home).shadowRepo(folderKey))

export async function readShadowGcState(home: string, folderKey: string): Promise<ShadowGcState> {
  try {
    const v: unknown = JSON.parse(await readFile(path.join(shadowRootOf(home, folderKey), 'gc.json'), 'utf8'))
    if (v === null || typeof v !== 'object') return {}
    const o = v as Record<string, unknown>
    return {
      ...(typeof o['lastGcAt'] === 'number' ? { lastGcAt: o['lastGcAt'] } : {}),
      ...(typeof o['refsDeletedAt'] === 'number' ? { refsDeletedAt: o['refsDeletedAt'] } : {}),
      ...(typeof o['refsDirMtime'] === 'number' ? { refsDirMtime: o['refsDirMtime'] } : {}),
    }
  } catch {
    return {}
  }
}

async function writeShadowGcState(root: string, s: ShadowGcState): Promise<void> {
  await writeFileAtomicLite(path.join(root, 'gc.json'), `${JSON.stringify({ schemaVersion: 1, ...s })}\n`)
}

/** The folder keys that have a shadow under `<home>/shadow` (sorted). */
export async function listShadowKeys(home: string): Promise<string[]> {
  const entries = await readdir(homePaths(home).shadowDir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isDirectory() && FOLDER_KEY_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}

/** The shadow's repository exists. */
export async function shadowRepoExists(home: string, folderKey: string): Promise<boolean> {
  return exists(path.join(homePaths(home).shadowRepo(folderKey), 'HEAD'))
}

/**
 * Plumbing on a shadow repository alone (GIT_DIR, no work tree; cwd its own folder), so it works when the project
 * folder is gone. Hooks are off (`<home>/empty-hooks`) whatever an old shadow's config says.
 */
function bareGit(
  home: string,
  folderKey: string,
  args: readonly string[],
  extra: Omit<GitRunOptions, 'cwd'> = {},
): Promise<GitResult> {
  const gitDir = homePaths(home).shadowRepo(folderKey)
  const hooks = gitConfigPath(path.join(path.resolve(home), EMPTY_HOOKS_DIRNAME))
  return runGit(['-c', `core.hooksPath=${hooks}`, ...args], {
    category: 'snapshot_failed',
    ...extra,
    cwd: path.dirname(gitDir),
    env: { ...extra.env, GIT_DIR: gitDir },
  })
}

/** The run ids with a snapshot ref (`refs/dimfactory/runs/<runId>`) in the shadow, sorted (rev-parse; 2.17-safe). */
export async function listRunRefs(home: string, folderKey: string): Promise<string[]> {
  if (!(await shadowRepoExists(home, folderKey))) return []
  const r = await bareGit(home, folderKey, [
    'rev-parse',
    '--symbolic-full-name',
    `--glob=${SHADOW_REF_PREFIX}*`,
  ])
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(SHADOW_REF_PREFIX))
    .map((l) => l.slice(SHADOW_REF_PREFIX.length))
    .sort()
}

/**
 * Delete the snapshot refs of `runIds` from the shadow `folderKey` in one `update-ref --stdin` transaction, under the
 * folder's shadow mutex. Only refs that exist are named; the shadow is marked for gc (`refsDeletedAt`). Returns the
 * run ids whose ref was deleted. Throws GitError when git refuses (nothing is deleted then: it is one transaction).
 */
export async function deleteRunRefs(
  home: string,
  folderKey: string,
  runIds: readonly string[],
  o: { now?: number } = {},
): Promise<string[]> {
  for (const id of runIds) assertRunRefId(id)
  return withFolderLock(folderKey, async () => {
    const present = new Set(await listRunRefs(home, folderKey))
    const targets = [...new Set(runIds)].filter((id) => present.has(id)).sort()
    if (targets.length === 0) return []
    const refsMtime = (): Promise<number | undefined> =>
      stat(runRefsDir(home, folderKey)).then(
        (st) => st.mtimeMs,
        () => undefined,
      )
    const before = await refsMtime()
    await bareGit(home, folderKey, ['update-ref', '--stdin'], {
      stdin: targets.map((id) => `delete ${SHADOW_REF_PREFIX}${id}\n`).join(''),
      timeoutMs: 120_000,
    })
    const prev = await readShadowGcState(home, folderKey)
    // The delete wrote the refs folder itself (its lock files, the loose refs that went): recorded, so gcIfIdle does
    // not take that write for a run's snapshot.
    const own = ownRefsWrite(prev, before, await refsMtime())
    const next: ShadowGcState = { ...prev, refsDeletedAt: o.now ?? Date.now(), ...own }
    await writeShadowGcState(shadowRootOf(home, folderKey), next)
    return targets
  })
}

export interface GcIfIdleOptions {
  home: string
  folderKey: string
  now: number
  /** True while a run holds, waits for or works in this folder (asked again under the mutex). */
  inUse: () => boolean
  /** When a run last released this folder's lock in this process. */
  lastLockAt?: number | undefined
  /** Default SHADOW_GC_IDLE_MS (5 min). */
  idleMs?: number
  /** Default SHADOW_GC_INTERVAL_MS (a day). */
  intervalMs?: number
  /** `dimf gc`: collect now, even when no ref was deleted since or it was collected today. */
  force?: boolean
  /** Report what would be done; change nothing. */
  dryRun?: boolean
}

export interface ShadowGcResult {
  folderKey: string
  /** `gc`: collected; `deleted`: no ref was left, so the shadow went; `skipped`: see `reason`; `none`: no shadow. */
  action: 'gc' | 'deleted' | 'skipped' | 'none'
  reason?: string
  refs?: number
  bytesBefore?: number
  bytesAfter?: number
}

/** `refs/dimfactory/runs` in a shadow repository. */
const runRefsDir = (home: string, folderKey: string): string =>
  path.join(homePaths(home).shadowRepo(folderKey), ...SHADOW_REF_PREFIX.split('/').filter((x) => x !== ''))

/**
 * The latest write to the shadow (its index, info/exclude, a ref, meta.json): about when a run last used it. The refs
 * folder as Dim Factory's own ref delete or gc left it (`refsDirMtime`) is not a run's write.
 */
async function lastShadowWrite(home: string, folderKey: string, state: ShadowGcState): Promise<number> {
  const gitDir = homePaths(home).shadowRepo(folderKey)
  const mtime = (f: string): Promise<number> =>
    stat(f).then(
      (s) => s.mtimeMs,
      () => 0,
    )
  const [index, exclude, meta, refs] = await Promise.all(
    [
      path.join(gitDir, 'index'),
      path.join(gitDir, 'info', 'exclude'),
      path.join(shadowRootOf(home, folderKey), 'meta.json'),
      runRefsDir(home, folderKey),
    ].map(mtime),
  )
  const ownRefs = state.refsDirMtime !== undefined && (refs ?? 0) <= state.refsDirMtime
  return Math.max(0, index ?? 0, exclude ?? 0, meta ?? 0, ownRefs ? 0 : (refs ?? 0))
}

/**
 * Shadow GC: after retention deleted refs (`refsDeletedAt` newer than `lastGcAt`), at most daily, and only
 * when no run has used the folder for 5 minutes (no lock now, none released in the last 5 minutes, no shadow write
 * since): `git gc --prune=now --quiet` under the folder mutex. A shadow with no ref left is deleted instead. `force`
 * (dimf gc) drops the "deleted since" and daily rules, never the idle ones.
 */
export async function gcIfIdle(o: GcIfIdleOptions): Promise<ShadowGcResult> {
  const { home, folderKey } = o
  const skipped = (reason: string): ShadowGcResult => ({ folderKey, action: 'skipped', reason })
  if (!FOLDER_KEY_RE.test(folderKey)) return skipped('not a shadow')
  if (!(await shadowRepoExists(home, folderKey))) return { folderKey, action: 'none', reason: 'no snapshots' }
  const state = await readShadowGcState(home, folderKey)
  if (o.force !== true) {
    if ((state.refsDeletedAt ?? 0) <= (state.lastGcAt ?? 0)) return skipped('no snapshots were deleted since')
    if (state.lastGcAt !== undefined && o.now - state.lastGcAt < (o.intervalMs ?? SHADOW_GC_INTERVAL_MS)) {
      return skipped('collected less than a day ago')
    }
  }
  if (o.inUse() || isFolderBusy(folderKey)) return skipped('a run is using this folder')
  // A lock release is on the core's clock; the shadow's files are on the wall clock.
  const idleMs = o.idleMs ?? SHADOW_GC_IDLE_MS
  if (
    o.now - (o.lastLockAt ?? 0) < idleMs ||
    Date.now() - (await lastShadowWrite(home, folderKey, state)) < idleMs
  ) {
    return skipped('a run used this folder in the last 5 minutes')
  }
  const root = shadowRootOf(home, folderKey)
  if (o.dryRun === true) {
    const refs = (await listRunRefs(home, folderKey)).length
    const { bytes } = await dirSize(root)
    return { folderKey, action: refs === 0 ? 'deleted' : 'gc', refs, bytesBefore: bytes }
  }
  return withFolderLock(folderKey, async () => {
    if (o.inUse()) return skipped('a run is using this folder')
    const refs = (await listRunRefs(home, folderKey)).length
    const before = (await dirSize(root)).bytes
    if (refs === 0) {
      await removeShadow(homePaths(home), folderKey)
      forgetShadows(folderKey)
      forgetDiffView(homePaths(home).shadowRepo(folderKey))
      return { folderKey, action: 'deleted', refs: 0, bytesBefore: before, bytesAfter: 0 }
    }
    // Scratch indexes a killed process left behind (no shadow work runs while the mutex is held).
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (/^(?:scratch|force)-\d+-[0-9a-f]+\.index(?:\.lock)?$/.test(name)) {
        await rm(path.join(root, name), { force: true }).catch(() => undefined)
      }
    }
    const refsMtime = (): Promise<number | undefined> =>
      stat(runRefsDir(home, folderKey)).then(
        (st) => st.mtimeMs,
        () => undefined,
      )
    const unpacked = await refsMtime()
    await bareGit(home, folderKey, ['gc', '--prune=now', '--quiet'], { timeoutMs: GC_TIMEOUT_MS })
    // gc packs the loose refs (its own write to the refs folder, like a ref delete's).
    const now = await readShadowGcState(home, folderKey)
    await writeShadowGcState(root, {
      ...now,
      lastGcAt: o.now,
      ...ownRefsWrite(now, unpacked, await refsMtime()),
    })
    const after = (await dirSize(root)).bytes
    return { folderKey, action: 'gc', refs, bytesBefore: before, bytesAfter: after }
  })
}
