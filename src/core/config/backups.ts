// Where dimfactory.json files live, their write backups and last-good copies, and the one primitive every config
// write goes through: back up the previous text, write atomically, report a unified diff and an undo token
// (errors and recovery, Save). save.ts builds edits on top; restore/undo live here.
//
// Layout (home.ts): user → `backups/dimfactory.<id>.jsonc` + `backups/last-good-user.jsonc`;
// project → `backups/project/<folderKey>/dimfactory.<id>.jsonc` + `…/last-good.jsonc` for the scope root's file, and
// `backups/project/<folderKey>/<fileKey>/…` for a subfolder's own file (paths.ts projectBackupDir), so two packages of
// one repo never share backups. Ten write backups are kept per file. A backup id is
// `<UTC yyyymmddThhmmssmmmZ>-<4 hex>`, so ids sort chronologically. Files are backed up and restored as bytes: a
// file that is not valid UTF-8 survives a backup/restore/undo unchanged (edits refuse such a file, save.ts).
import { createHash, randomBytes } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { BRAND } from '../../shared/brand.ts'
import type { ConfigScope } from '../../shared/config-schema.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import type { ConfigBackup, ConfigIssue, ConfigWriteResult } from '../../shared/ipc.ts'
import { DimFactoryError, errnoCode, storageError } from '../errors.ts'
import { folderKeyOf, lockKey, resolveScope } from '../git/repo.ts'
import { homePaths, projectPaths, resolveHome } from '../home.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { parseConfigText } from './load.ts'
import { LAST_GOOD_FILENAME, projectBackupDir } from './paths.ts'

/** Write backups kept per config file. */
export const BACKUPS_KEEP = 10
export const LAST_GOOD_ID = 'last-good'

const BACKUP_ID = /^\d{8}T\d{9}Z-[0-9a-f]{4}$/
/** A write backup's file name: the config file's base name, the backup id, `.jsonc`. */
const BACKUP_BASE = BRAND.configFileName.replace(/\.json$/, '')
const BACKUP_FILE = new RegExp(`^${BACKUP_BASE}\\.(\\d{8}T\\d{9}Z-[0-9a-f]{4})\\.jsonc$`)

// ---- locations -------------------------------------------------------------------------------------------------

/** A folder's scope root and folder key (`sha256(lockKey(scopeRoot)).slice(0,16)`). */
export interface FolderScope {
  scopeRoot: string
  folderKey: string
}

export interface ConfigLocation {
  scope: ConfigScope
  /** The dimfactory.json read and written. */
  path: string
  /** Project scope: the folder as given (absolute). */
  folder?: string
  /** Project scope. */
  folderScope?: FolderScope
  home: string
  backupDir: string
  lastGoodPath: string
  /** 0o600 for the user file; 0o644 for a project file (committed, inside the user's repo). */
  fileMode: number
  dirMode: number
}

export interface LocateOptions {
  /** DIM_FACTORY_HOME (default {@link resolveHome}). */
  home?: string
  /**
   * The folder's scope when the caller already has it (`ScopeInfo` from resolveScope). With only `scopeRoot`, the
   * key is derived with lockKey + folderKeyOf (no git spawn); with neither, resolveScope runs git once.
   */
  folderScope?: FolderScope | { scopeRoot: string }
}

/** Scope root + folder key for `folder` (git/repo.ts helpers; same key as the shadow repo and trust.json). */
export async function folderScopeOf(
  folder: string,
  given?: LocateOptions['folderScope'],
): Promise<FolderScope> {
  if (given !== undefined && 'folderKey' in given) return given
  if (given !== undefined)
    return { scopeRoot: given.scopeRoot, folderKey: folderKeyOf(await lockKey(given.scopeRoot)) }
  const s = await resolveScope(folder)
  return { scopeRoot: s.scopeRoot, folderKey: s.folderKey }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the file a scope reads and writes. Project: `<folder>/.dimfactory/dimfactory.json`, else the one at the scope
 * root; when neither exists, a new file is created under `<folder>` (the first place the loader looks).
 */
export async function configLocation(
  scope: ConfigScope,
  folder: string | undefined,
  opts: LocateOptions = {},
): Promise<ConfigLocation> {
  const home = resolve(opts.home ?? resolveHome())
  const hp = homePaths(home)
  if (scope === 'user') {
    return {
      scope,
      path: hp.userConfig,
      home,
      backupDir: hp.backupsDir,
      lastGoodPath: hp.lastGoodUserConfig,
      fileMode: 0o600,
      dirMode: 0o700,
    }
  }
  if (folder === undefined || folder === '') {
    throw new DimFactoryError('VALIDATION', 'A project config write needs a folder')
  }
  const abs = resolve(folder)
  const fs = await folderScopeOf(abs, opts.folderScope)
  const candidates = [projectPaths(abs).config, projectPaths(fs.scopeRoot).config]
  let path = candidates[0] as string
  for (const c of candidates) {
    if (await isFile(c)) {
      path = c
      break
    }
  }
  const backupDir = projectBackupDir(hp, fs.folderKey, fs.scopeRoot, path)
  return {
    scope,
    path,
    folder: abs,
    folderScope: fs,
    home,
    backupDir,
    lastGoodPath: join(backupDir, LAST_GOOD_FILENAME),
    fileMode: 0o644,
    dirMode: 0o755,
  }
}

// ---- reading -----------------------------------------------------------------------------------------------------

export interface ConfigText {
  /** The bytes decoded as UTF-8 (invalid sequences become U+FFFD). */
  text: string
  /** sha256 of the file's bytes. */
  sha256: string
  /** The file's bytes exactly as read. */
  bytes: Buffer
  /** `text` encodes back to exactly `bytes` (false for a file that is not valid UTF-8). */
  utf8: boolean
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A file's bytes as a ConfigText. */
export function configTextOf(bytes: Buffer): ConfigText {
  const text = bytes.toString('utf8')
  return { text, sha256: sha256Hex(bytes), bytes, utf8: Buffer.from(text, 'utf8').equals(bytes) }
}

/** Read a text file; null when it does not exist. STORAGE for other fs errors. */
export async function readConfigText(path: string): Promise<ConfigText | null> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw storageError(`cannot read ${path}`, err)
  }
  return configTextOf(buf)
}

const bytesOf = (data: string | Uint8Array): Buffer =>
  typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)

// ---- in-process serialization ----------------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>()

const lockId = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p)

/** Run `fn` with every path in `paths` held (in-process; sorted to avoid lock-order inversions). */
export async function withConfigLocks<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(paths.map(lockId))].sort()
  const run = ids.reduceRight<() => Promise<T>>(
    (inner, id) => () => {
      const prev = chains.get(id) ?? Promise.resolve()
      const next = prev.then(inner, inner)
      const settled = next.then(
        () => undefined,
        () => undefined,
      )
      chains.set(id, settled)
      void settled.then(() => {
        if (chains.get(id) === settled) chains.delete(id)
      })
      return next
    },
    fn,
  )
  return run()
}

// ---- backups -----------------------------------------------------------------------------------------------------

let lastStamp = 0

/** A new, strictly increasing (per process) backup id. */
export function newBackupId(now: number = Date.now()): string {
  const t = Math.max(now, lastStamp + 1)
  lastStamp = t
  const compact = new Date(t).toISOString().replace(/[-:]/g, '').replace('.', '')
  return `${compact}-${randomBytes(2).toString('hex')}`
}

export function isBackupId(id: string): boolean {
  return BACKUP_ID.test(id)
}

function backupTime(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id)
  if (!m) return 0
  const [, y, mo, d, h, mi, s, ms] = m.map((x) => Number(x))
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0, ms ?? 0)
}

function backupPath(loc: ConfigLocation, id: string): string {
  if (id === LAST_GOOD_ID) return loc.lastGoodPath
  if (!isBackupId(id)) throw new DimFactoryError('VALIDATION', `Invalid backup id ${JSON.stringify(id)}`)
  return join(loc.backupDir, `${BACKUP_BASE}.${id}.jsonc`)
}

async function writeBackupIds(loc: ConfigLocation): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(loc.backupDir)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return []
    throw storageError(`cannot list ${loc.backupDir}`, err)
  }
  const ids: string[] = []
  for (const n of names) {
    const m = BACKUP_FILE.exec(n)
    if (m?.[1] !== undefined) ids.push(m[1])
  }
  return ids.sort().reverse()
}

/** Write backups (newest first), then last-good when present. */
export async function listBackups(loc: ConfigLocation): Promise<ConfigBackup[]> {
  const out: ConfigBackup[] = []
  for (const id of await writeBackupIds(loc)) {
    const s = await stat(backupPath(loc, id)).catch(() => null)
    if (s) out.push({ id, at: backupTime(id), bytes: s.size, kind: 'write' })
  }
  const lg = await stat(loc.lastGoodPath).catch(() => null)
  if (lg?.isFile()) out.push({ id: LAST_GOOD_ID, at: lg.mtimeMs, bytes: lg.size, kind: 'last-good' })
  return out
}

/** A backup's text (`last-good` or a write backup id); null when it does not exist. */
export async function readBackup(loc: ConfigLocation, id: string): Promise<string | null> {
  return (await readBackupFile(loc, id))?.text ?? null
}

/** A backup's bytes and text (`last-good` or a write backup id); null when it does not exist. */
export async function readBackupFile(loc: ConfigLocation, id: string): Promise<ConfigText | null> {
  return readConfigText(backupPath(loc, id))
}

/** Save `data` (the replaced file's bytes) as a new write backup and keep the newest {@link BACKUPS_KEEP}. */
export async function createBackup(
  loc: ConfigLocation,
  data: string | Uint8Array,
  keep: number = BACKUPS_KEEP,
): Promise<string> {
  const id = newBackupId()
  await writeFileAtomic(backupPath(loc, id), data, { mode: 0o600, dirMode: 0o700 })
  await rotateBackups(loc, keep)
  return id
}

export async function rotateBackups(loc: ConfigLocation, keep: number = BACKUPS_KEEP): Promise<string[]> {
  const removed: string[] = []
  for (const id of (await writeBackupIds(loc)).slice(keep)) {
    await rm(backupPath(loc, id), { force: true })
    removed.push(id)
  }
  return removed
}

/** Store the last text that loaded (or was written) without errors. Skips an identical copy; true when written. */
export async function writeLastGood(loc: ConfigLocation, data: string | Uint8Array): Promise<boolean> {
  const cur = await readConfigText(loc.lastGoodPath)
  if (cur !== null && cur.bytes.equals(bytesOf(data))) return false
  await writeFileAtomic(loc.lastGoodPath, data, { mode: 0o600, dirMode: 0o700 })
  return true
}

export async function readLastGood(loc: ConfigLocation): Promise<string | null> {
  return (await readConfigText(loc.lastGoodPath))?.text ?? null
}

// ---- unified diff --------------------------------------------------------------------------------------------------

const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

type DiffLine = { tag: ' ' | '-' | '+'; text: string; a: number; b: number }

/** Line diff by LCS (config files are small); a whole-file replacement past ~4M cells. */
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const out: DiffLine[] = []
  if (n * m > 4_000_000) {
    a.forEach((t, i) => out.push({ tag: '-', text: t, a: i, b: 0 }))
    b.forEach((t, j) => out.push({ tag: '+', text: t, a: n, b: j }))
    return out
  }
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i] ?? '', a: i++, b: j++ })
    } else if (i < n && (j >= m || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
      out.push({ tag: '-', text: a[i] ?? '', a: i++, b: j })
    } else {
      out.push({ tag: '+', text: b[j] ?? '', a: i, b: j++ })
    }
  }
  return out
}

/**
 * Unified diff (3 lines of context) for "view diff" and the undo toast. `null` text = the file does not exist.
 * Line endings are not shown (CRLF and LF lines compare equal by content).
 */
export function unifiedDiff(before: string | null, after: string | null, label: string, context = 3): string {
  if (before === after) return ''
  const a = before === null ? [] : splitLines(before)
  const b = after === null ? [] : splitLines(after)
  const lines = diffLines(a, b)
  const changed = lines.map((l, idx) => (l.tag === ' ' ? -1 : idx)).filter((idx) => idx >= 0)
  if (changed.length === 0) return ''
  const name = label.replace(/\\/g, '/')
  const out = [
    before === null ? '--- /dev/null' : `--- a/${name}`,
    after === null ? '+++ /dev/null' : `+++ b/${name}`,
  ]
  let k = 0
  while (k < changed.length) {
    const first = changed[k] as number
    let last = first
    while (k + 1 < changed.length && (changed[k + 1] as number) - last <= context * 2 + 1)
      last = changed[++k] as number
    k++
    const from = Math.max(0, first - context)
    const to = Math.min(lines.length - 1, last + context)
    const hunk = lines.slice(from, to + 1)
    const aCount = hunk.filter((l) => l.tag !== '+').length
    const bCount = hunk.filter((l) => l.tag !== '-').length
    const head = lines[from] as DiffLine
    const aStart = aCount === 0 ? head.a : head.a + 1
    const bStart = bCount === 0 ? head.b : head.b + 1
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (const l of hunk) out.push(`${l.tag}${l.text}`)
  }
  return out.join('\n') + '\n'
}

// ---- the write primitive ----------------------------------------------------------------------------------------

/** One file touched by a config write. */
export interface ConfigFileWrite {
  scope: ConfigScope
  folder?: string
  path: string
  changed: boolean
  /** The file did not exist before this write. */
  created: boolean
  /** The write removed the file (undo of a create). */
  removed: boolean
  diff: string
  /** Backup of the previous text (null when there was no previous file or nothing changed). */
  backupId: string | null
  /** sha256 of the text now on disk (null when removed). */
  sha256: string | null
  /** The file changed on disk after the plan was made, and the edits were re-applied onto the new text. */
  reapplied: boolean
}

/** Result of save / patch / restore / undo. Extends the IPC ConfigWriteResult (primary file). */
export interface ConfigWriteOutcome extends ConfigWriteResult {
  /** Undoes every file this call wrote ({@link undoConfigWrite}); null when nothing changed. */
  undoToken: string | null
  /** Warnings on the written text (errors refuse the write instead). */
  issues: ConfigIssue[]
  writes: ConfigFileWrite[]
  /** Patch ops whose `project` scope was dropped because the path is user-only. */
  forcedToUser: JsonPatchOp[]
  /** Restore only: `last-good` or the write backup id the text came from. */
  restoredFrom?: string
}

export interface ReplaceOptions {
  /** Also store the new text as last-good (it passed full validation). */
  storeLastGood?: boolean
  reapplied?: boolean
}

/**
 * Replace a config file's content: back up `prev`'s bytes (if any), write `next` atomically (text as UTF-8, bytes as
 * they are; `.dimfactory/` is created), or remove the file when `next` is null. Callers hold {@link withConfigLocks}
 * for `loc.path`.
 */
export async function replaceConfigText(
  loc: ConfigLocation,
  prev: ConfigText | null,
  next: string | Uint8Array | null,
  opts: ReplaceOptions = {},
): Promise<ConfigFileWrite> {
  const base: Omit<ConfigFileWrite, 'changed' | 'created' | 'removed' | 'diff' | 'backupId' | 'sha256'> = {
    scope: loc.scope,
    ...(loc.folder !== undefined ? { folder: loc.folder } : {}),
    path: loc.path,
    reapplied: opts.reapplied ?? false,
  }
  const nextBytes = next === null ? null : bytesOf(next)
  const same =
    prev === null || nextBytes === null ? prev === null && nextBytes === null : prev.bytes.equals(nextBytes)
  if (same) {
    return {
      ...base,
      changed: false,
      created: false,
      removed: false,
      diff: '',
      backupId: null,
      sha256: prev?.sha256 ?? null,
    }
  }
  const backupId = prev !== null ? await createBackup(loc, prev.bytes) : null
  if (nextBytes === null) {
    try {
      await rm(loc.path, { force: true })
    } catch (err) {
      throw storageError(`cannot remove ${loc.path}`, err)
    }
  } else {
    await writeFileAtomic(loc.path, nextBytes, { mode: loc.fileMode, dirMode: loc.dirMode })
    if (opts.storeLastGood === true) await writeLastGood(loc, nextBytes)
  }
  return {
    ...base,
    changed: true,
    created: prev === null && nextBytes !== null,
    removed: nextBytes === null,
    diff: unifiedDiff(prev?.text ?? null, nextBytes?.toString('utf8') ?? null, loc.path),
    backupId,
    sha256: nextBytes === null ? null : sha256Hex(nextBytes),
  }
}

// ---- undo tokens ----------------------------------------------------------------------------------------------------

const UNDO_PREFIX = 'cfgundo1.'

const UndoEntryZ = z.strictObject({
  s: z.enum(['user', 'project']),
  f: z.string().min(1).max(4096).optional(),
  /** Backup holding the text before the write; null = the file did not exist. */
  b: z.string().regex(BACKUP_ID).nullable(),
  /** sha256 of the text the write left (null = the write removed the file). */
  h: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
})
const UndoTokenZ = z.strictObject({ w: z.array(UndoEntryZ).min(1).max(4) })
type UndoEntry = z.infer<typeof UndoEntryZ>

/** Opaque token for the undo toast. Paths are never taken from it: they are re-derived from scope + folder. */
export function encodeUndoToken(writes: readonly ConfigFileWrite[]): string | null {
  const w: UndoEntry[] = writes
    .filter((x) => x.changed)
    .map((x) => ({
      s: x.scope,
      ...(x.scope === 'project' && x.folder !== undefined ? { f: x.folder } : {}),
      b: x.backupId,
      h: x.sha256,
    }))
  if (w.length === 0) return null
  return UNDO_PREFIX + Buffer.from(JSON.stringify({ w }), 'utf8').toString('base64url')
}

export function decodeUndoToken(token: string): UndoEntry[] {
  const bad = (): never => {
    throw new DimFactoryError('VALIDATION', 'Invalid undo token')
  }
  if (typeof token !== 'string' || !token.startsWith(UNDO_PREFIX) || token.length > 16_384) return bad()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token.slice(UNDO_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    return bad()
  }
  const r = UndoTokenZ.safeParse(parsed)
  return r.success ? r.data.w : bad()
}

function outcomeOf(
  writes: ConfigFileWrite[],
  extra: Partial<Pick<ConfigWriteOutcome, 'issues' | 'forcedToUser' | 'restoredFrom'>> & {
    primaryScope?: ConfigScope
  } = {},
): ConfigWriteOutcome {
  const primary = writes.find((w) => w.scope === extra.primaryScope) ?? writes[0]
  return {
    path: primary?.path ?? '',
    changed: writes.some((w) => w.changed),
    diff: writes.map((w) => w.diff).join(''),
    backupId: primary?.backupId ?? null,
    undoToken: encodeUndoToken(writes),
    issues: extra.issues ?? [],
    writes,
    forcedToUser: extra.forcedToUser ?? [],
    ...(extra.restoredFrom !== undefined ? { restoredFrom: extra.restoredFrom } : {}),
  }
}

/** Assemble a ConfigWriteOutcome (used by save.ts). */
export function writeOutcome(
  writes: ConfigFileWrite[],
  extra: Partial<Pick<ConfigWriteOutcome, 'issues' | 'forcedToUser'>> & { primaryScope?: ConfigScope } = {},
): ConfigWriteOutcome {
  return outcomeOf(writes, extra)
}

export interface UndoOptions extends LocateOptions {
  /** Restore even when the file changed after the write being undone (default: refuse with CONFLICT). */
  force?: boolean
}

/**
 * Undo a config write: each file goes back to its backup (or is removed when the write created it). The undo is
 * itself a backed-up write, so it returns its own undo token. Refuses (CONFLICT) when a file changed since.
 */
export async function undoConfigWrite(token: string, opts: UndoOptions = {}): Promise<ConfigWriteOutcome> {
  const entries = decodeUndoToken(token)
  const locs = await Promise.all(entries.map((e) => configLocation(e.s, e.f, opts)))
  return withConfigLocks(
    locs.map((l) => l.path),
    async () => {
      const plans: { loc: ConfigLocation; cur: ConfigText | null; next: Buffer | null; from: string }[] = []
      for (const [i, e] of entries.entries()) {
        const loc = locs[i] as ConfigLocation
        const cur = await readConfigText(loc.path)
        if (opts.force !== true && (cur?.sha256 ?? null) !== e.h) {
          throw new DimFactoryError(
            'CONFLICT',
            `${loc.path} changed after this save; open the config file to undo by hand`,
            { details: { path: loc.path } },
          )
        }
        let next: Buffer | null = null
        if (e.b !== null) {
          next = (await readBackupFile(loc, e.b))?.bytes ?? null
          if (next === null) {
            throw new DimFactoryError('NOT_FOUND', `The backup ${e.b} of ${loc.path} no longer exists`)
          }
        }
        plans.push({ loc, cur, next, from: e.b ?? 'absent' })
      }
      const writes: ConfigFileWrite[] = []
      for (const p of plans) writes.push(await replaceConfigText(p.loc, p.cur, p.next))
      return outcomeOf(writes, { restoredFrom: plans.map((p) => p.from).join(',') })
    },
  )
}

// ---- restore -------------------------------------------------------------------------------------------------------

/** `config.restoreBackup`: put a write backup (or `last-good`) back. The current text is backed up first. */
export async function restoreBackup(
  scope: ConfigScope,
  folder: string | undefined,
  backupId: string,
  opts: LocateOptions = {},
): Promise<ConfigWriteOutcome> {
  const loc = await configLocation(scope, folder, opts)
  return withConfigLocks([loc.path], async () => {
    const backup = await readBackupFile(loc, backupId)
    if (backup === null) throw new DimFactoryError('NOT_FOUND', `No backup ${backupId} for ${loc.path}`)
    const cur = await readConfigText(loc.path)
    const w = await replaceConfigText(loc, cur, backup.bytes)
    return outcomeOf([w], { restoredFrom: backupId })
  })
}

/** A backup that may stand in for a missing last-good copy: it must load without errors. */
function loadsCleanly(t: ConfigText, loc: ConfigLocation): boolean {
  if (!t.utf8) return false
  const r = parseConfigText(t.text, { file: loc.path, scope: loc.scope })
  return !r.issues.some((i) => i.severity === 'error')
}

/**
 * "Restore last good": the last-good copy (stored by every load and write that had no errors). When the file already
 * holds exactly that, nothing changes (`changed: false`, "already matches"). Without a last-good copy, the newest write
 * backup that differs from the file and loads without errors — never a broken text an earlier restore replaced. The
 * current text is backed up first. NOT_FOUND when there is nothing to restore.
 */
export async function restoreLastGood(
  scope: ConfigScope,
  folder?: string,
  opts: LocateOptions = {},
): Promise<ConfigWriteOutcome> {
  const loc = await configLocation(scope, folder, opts)
  return withConfigLocks([loc.path], async () => {
    const cur = await readConfigText(loc.path)
    let source: string | null = null
    let next: Buffer | null = null
    const lastGood = await readConfigText(loc.lastGoodPath)
    if (lastGood !== null) {
      source = LAST_GOOD_ID
      next = lastGood.bytes
    } else {
      for (const id of await writeBackupIds(loc)) {
        const t = await readBackupFile(loc, id)
        if (t !== null && !(cur !== null && t.bytes.equals(cur.bytes)) && loadsCleanly(t, loc)) {
          source = id
          next = t.bytes
          break
        }
      }
    }
    if (source === null || next === null) {
      throw new DimFactoryError('NOT_FOUND', `There is no earlier version of ${loc.path} to restore`)
    }
    const w = await replaceConfigText(loc, cur, next)
    return outcomeOf([w], { restoredFrom: source })
  })
}
