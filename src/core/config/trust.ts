// DIM_FACTORY_HOME/trust.json: one-time grants per folder.
//
//   {schemaVersion:1, folders:{[folderKey]:{path, grants:{vendorFolder?, largeFolder?, projectAuto?{at, projectSha},
//     nestedProjectAuto?{[relDir]:{at, projectSha}}, recipeAuto?{[recipeId]:{at, sha}},
//     commands?{[hash]:{kind, argv, cwdRel, body?, at}}, easyProject?{at, folder, ino?}}}},
//    guardrails?{loosened:[{at, what}]}}
//
// - guardrails.loosened records each time your own guardrails were loosened in the app (a preset lowered, a rule
//   removed): a record for the Guardrails section, not a grant. It is not per folder, as your guardrails are not.
// - folderKey = sha256(lockKey(scopeRoot)).slice(0,16) (git/repo.ts; the shadow repo and project backups use it too).
// - A command grant's key is sha256(JSON{kind, argv, cwdRel, body}), so a changed script body needs re-trust.
// - projectAuto is bound to the project file's sha256 (of its bytes, as the loader hashes them): any edit to that
//   file voids the grant. A subfolder of the scope may have its own project file; its grant is kept in
//   `nestedProjectAuto[relDir]` (paths.ts projectRelDir), so grants for different files never void each other.
//   Every read for a folder returns the grant of the file that folder uses as `projectAuto` (the "folder view").
// - recipeAuto is bound to the project recipe file's sha256 (of its text, as the recipe loader hashes it), per recipe
//   id: an edit to that recipe file voids its grant.
// - largeFolder is re-asked when files or bytes double.
// - easyProject (Easy mode's project permission) is bound to the folder Dim Factory created: its path and file id as
//   created, and only for a folder that is its own scope root. It is never granted over trust.set (Easy's create does
//   it); trust.set and Easy settings revoke it. What it covers is core/easy/ask-tier.ts and coveredByProject below.
// Reads fail closed: a missing or corrupt file grants nothing. A file from a newer Dim Factory is read-only.
import { createHash } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { GuardrailLoosening } from '../../shared/guardrails.ts'
import { PROJECT_PERMISSION } from '../../shared/ipc.ts'
import type {
  EasyProjectGrant,
  TrustCommandGrant,
  TrustFile,
  TrustGrantInput,
  TrustGrants,
  TrustState,
} from '../../shared/ipc.ts'
import { VENDOR_ID_PATTERN } from '../../shared/vendors.ts'
import { DimFactoryError } from '../errors.ts'
import { homePaths, resolveHome } from '../home.ts'
import { realPathSync } from '../real-path.ts'
import { readJsonFile } from '../store/atomic.ts'
import { isPlainObject, versionInfo, writeVersionedJson } from '../store/versions.ts'
import { configLocation, folderScopeOf, readConfigText, withConfigLocks } from './backups.ts'
import type { FolderScope, LocateOptions } from './backups.ts'
import { ROOT_REL_DIR, projectRelDir } from './paths.ts'

export const TRUST_SCHEMA_VERSION = 1

// ---- schema ----------------------------------------------------------------------------------------------------------

const AtZ = z.number().int().nonnegative()
const Sha256Z = z.string().regex(/^[0-9a-f]{64}$/)

const CommandGrantZ = z.looseObject({
  kind: z.enum(['verify', 'deps', 'preview']),
  argv: z.array(z.string()).min(1),
  cwdRel: z.string(),
  body: z.string().optional(),
  at: AtZ,
})

const ProjectAutoZ = z.looseObject({ at: AtZ, projectSha: Sha256Z })

const GrantsZ = z.looseObject({
  vendorFolder: z.record(z.string().regex(VENDOR_ID_PATTERN), z.looseObject({ at: AtZ })).optional(),
  largeFolder: z
    .looseObject({ at: AtZ, files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
    .optional(),
  projectAuto: ProjectAutoZ.optional(),
  nestedProjectAuto: z.record(z.string().min(1).max(4096), ProjectAutoZ).optional(),
  recipeAuto: z.record(z.string().min(1).max(40), z.looseObject({ at: AtZ, sha: Sha256Z })).optional(),
  commands: z.record(Sha256Z, CommandGrantZ).optional(),
  easyProject: z
    .looseObject({ at: AtZ, folder: z.string().min(1).max(4096), ino: z.string().max(64).optional() })
    .optional(),
})

const TrustFileZ = z.looseObject({
  schemaVersion: z.literal(TRUST_SCHEMA_VERSION),
  folders: z.record(z.string().regex(/^[0-9a-f]{16}$/), z.looseObject({ path: z.string(), grants: GrantsZ })),
  guardrails: z
    .looseObject({ loosened: z.array(z.looseObject({ at: AtZ, what: z.string().max(2000) })).max(500) })
    .optional(),
})

function emptyTrust(): TrustFile {
  return { schemaVersion: 1, folders: {} }
}

// ---- hashes -----------------------------------------------------------------------------------------------------------

export interface TrustedCommand {
  kind: 'verify' | 'deps' | 'preview'
  argv: readonly string[]
  /** Working directory relative to the scope root (`.` for the root; `/` separators). */
  cwdRel: string
  /** Script body (e.g. the package.json script text) — part of the hash. */
  body?: string
}

/** `.`-rooted, forward-slash cwdRel so the same command hashes alike on every OS. */
export function normalizeCwdRel(cwdRel: string): string {
  const s = cwdRel
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  return s === '' ? '.' : s
}

/** `sha256(JSON{kind, argv, cwdRel, body})` (body null when absent). */
export function commandGrantHash(cmd: TrustedCommand): string {
  const payload = JSON.stringify({
    kind: cmd.kind,
    argv: [...cmd.argv],
    cwdRel: normalizeCwdRel(cmd.cwdRel),
    body: cmd.body ?? null,
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

// ---- grant checks (pure) -----------------------------------------------------------------------------------------------

export function isCommandGranted(grants: TrustGrants, cmd: TrustedCommand): boolean {
  return grants.commands?.[commandGrantHash(cmd)] !== undefined
}

export function isVendorFolderGranted(grants: TrustGrants, vendor: string): boolean {
  return grants.vendorFolder?.[vendor] !== undefined
}

/** The projectAuto grant still holds only for the exact project file text it was given for. */
export function isProjectAutoGranted(grants: TrustGrants, projectSha: string | null): boolean {
  return projectSha !== null && grants.projectAuto?.projectSha === projectSha
}

/** A project recipe's recipeAuto grant holds only for the exact recipe file text it was given for. */
export function isRecipeAutoGranted(grants: TrustGrants, recipeId: string, sha: string | null): boolean {
  return sha !== null && grants.recipeAuto?.[recipeId]?.sha === sha
}

/** A largeFolder grant covers the folder until its file count or byte size doubles. */
export function isLargeFolderGranted(grants: TrustGrants, size: { files: number; bytes: number }): boolean {
  const g = grants.largeFolder
  return g !== undefined && size.files <= g.files * 2 && size.bytes <= g.bytes * 2
}

/**
 * The run's own commands (verify, install, preview) count as trusted: the grants were read for an Easy run while its
 * project permission held (the controller adds the in-memory marker; nothing on disk can).
 */
export function coveredByProject(grants: TrustGrants): boolean {
  return grants[PROJECT_PERMISSION] === true
}

/** The grants with the project permission's in-memory marker (an Easy run whose permission holds now). */
export function withProjectPermission(grants: TrustGrants): TrustGrants {
  return { ...grants, [PROJECT_PERMISSION]: true }
}

/** Drop grants that no longer hold (projectAuto whose project file changed). */
export function liveGrants(grants: TrustGrants, projectSha: string | null): TrustGrants {
  if (grants.projectAuto === undefined || isProjectAutoGranted(grants, projectSha)) return grants
  const { projectAuto: _stale, ...rest } = grants
  return rest
}

/**
 * Folders compare by their real names (an 8.3 short name or a linked temp folder is the folder it names; a folder that
 * is gone by its nearest existing parent), without case on Windows and macOS, and without a trailing separator.
 */
function sameFolder(a: string, b: string): boolean {
  const f = (p: string): string => {
    const t = realPathSync(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? t.toLowerCase() : t
  }
  return f(a) === f(b)
}

// ---- store ---------------------------------------------------------------------------------------------------------------

export interface TrustOptions extends LocateOptions {
  now?: () => number
  /**
   * sha256 of the folder's project dimfactory.json (null = none). When omitted it is read from disk (the same file
   * the config loader uses).
   */
  projectSha?: string | null
}

export interface TrustRead {
  file: TrustFile
  /** Written by a newer Dim Factory: grants are honored, but nothing is written. */
  readOnly: boolean
  /** The file exists but could not be parsed: nothing is granted until it is rewritten. */
  corrupt: boolean
}

function trustPath(opts: LocateOptions): string {
  return homePaths(resolve(opts.home ?? resolveHome())).trust
}

/** Read trust.json (missing → empty; unparsable → empty + `corrupt`; newer → what parses, read-only). */
export async function readTrustFile(opts: LocateOptions = {}): Promise<TrustRead> {
  const r = await readJsonFile(trustPath(opts))
  if (r.kind === 'missing') return { file: emptyTrust(), readOnly: false, corrupt: false }
  const info = r.kind === 'ok' ? versionInfo(r.value, TRUST_SCHEMA_VERSION) : null
  if (r.kind === 'corrupt' || info === null || !isPlainObject(r.value)) {
    return { file: emptyTrust(), readOnly: false, corrupt: true }
  }
  // Validate against this version's shape (a newer file is read with it too; it is never written back).
  const v = TrustFileZ.safeParse({ ...r.value, schemaVersion: TRUST_SCHEMA_VERSION })
  return {
    file: v.success ? (v.data as TrustFile) : emptyTrust(),
    readOnly: info.readOnly,
    corrupt: !v.success,
  }
}

/** The project file a folder uses: its place in the scope (paths.ts projectRelDir) and its sha256 (null: none). */
interface ProjectFile {
  relDir: string
  sha: string | null
}

async function projectFileFor(folder: string, fs: FolderScope, opts: TrustOptions): Promise<ProjectFile> {
  const loc = await configLocation('project', folder, { ...opts, folderScope: fs })
  const relDir = projectRelDir(fs.scopeRoot, loc.path)
  if (opts.projectSha !== undefined) return { relDir, sha: opts.projectSha }
  return { relDir, sha: (await readConfigText(loc.path))?.sha256 ?? null }
}

/** A folder's view of the stored grants: `projectAuto` is the grant of the project file it uses. */
export function grantsView(stored: TrustGrants, relDir: string): TrustGrants {
  const { projectAuto, nestedProjectAuto, ...rest } = stored
  const own = relDir === ROOT_REL_DIR ? projectAuto : nestedProjectAuto?.[relDir]
  return own !== undefined ? { ...rest, projectAuto: own } : rest
}

/** Fold a changed folder view back into the stored grants (other files' projectAuto grants are kept). */
function storeView(stored: TrustGrants, relDir: string, view: TrustGrants): TrustGrants {
  const { projectAuto: own, nestedProjectAuto: _ignored, ...rest } = view
  const out: TrustGrants = { ...rest }
  const nested = { ...stored.nestedProjectAuto }
  if (relDir === ROOT_REL_DIR) {
    if (own !== undefined) out.projectAuto = own
  } else {
    if (stored.projectAuto !== undefined) out.projectAuto = stored.projectAuto
    if (own !== undefined) nested[relDir] = own
    else delete nested[relDir]
  }
  if (Object.keys(nested).length > 0) out.nestedProjectAuto = nested
  return out
}

/** The grants as stored for `folder`'s scope, in the folder's view (stale projectAuto included; preflight reads it). */
export async function trustGrantsFor(folder: string, opts: TrustOptions = {}): Promise<TrustGrants> {
  const abs = resolve(folder)
  const fs = await folderScopeOf(abs, opts.folderScope)
  const { file } = await readTrustFile(opts)
  const { relDir } = await projectFileFor(abs, fs, { ...opts, projectSha: null })
  return grantsView(file.folders[fs.folderKey]?.grants ?? {}, relDir)
}

/** `trust.get`: the folder's grants that still hold. */
export async function getTrust(folder: string, opts: TrustOptions = {}): Promise<TrustState> {
  const abs = resolve(folder)
  const fs = await folderScopeOf(abs, opts.folderScope)
  const { file } = await readTrustFile(opts)
  const project = await projectFileFor(abs, fs, opts)
  const grants = grantsView(file.folders[fs.folderKey]?.grants ?? {}, project.relDir)
  return {
    folder: abs,
    folderKey: fs.folderKey,
    scopeRoot: fs.scopeRoot,
    grants: liveGrants(grants, project.sha),
  }
}

/** A grant request: the IPC TrustGrantInput plus what core knows at grant time. */
export type TrustGrantRequest =
  | { kind: 'vendorFolder'; vendor: string }
  | { kind: 'largeFolder'; files: number; bytes: number }
  /** `projectSha`: the file version the user was shown; CONFLICT when the file changed since. */
  | { kind: 'projectAuto'; projectSha?: string }
  /**
   * `recipeSha`: the recipe file version the user was shown (CONFLICT when it changed since); `currentSha`: the
   * file's sha256 now (null: no such project recipe).
   */
  | { kind: 'recipeAuto'; recipeId: string; recipeSha?: string; currentSha: string | null }
  | { kind: 'command'; command: TrustedCommand }
  /** Easy's project permission for the folder Dim Factory just created (its file id binds the grant to it). */
  | { kind: 'easyProject'; ino?: string }

/** What to revoke: a kind, or one command by its grant hash (or by the command itself). */
export type TrustRevokeRequest =
  | { kind: 'vendorFolder'; vendor: string }
  | { kind: 'largeFolder' }
  | { kind: 'projectAuto' }
  | { kind: 'recipeAuto'; recipeId: string }
  | { kind: 'command'; hash: string }
  | { kind: 'command'; command: TrustedCommand }
  | { kind: 'easyProject' }

async function mutate(
  folder: string,
  opts: TrustOptions,
  change: (
    grants: TrustGrants,
    ctx: { projectSha: string | null; now: number; scopeRoot: string },
  ) => TrustGrants,
): Promise<TrustState> {
  const abs = resolve(folder)
  const fs = await folderScopeOf(abs, opts.folderScope)
  const { relDir, sha: projectSha } = await projectFileFor(abs, fs, opts)
  const path = trustPath(opts)
  return withConfigLocks([path], async () => {
    const read = await readTrustFile(opts)
    if (read.readOnly) {
      throw new DimFactoryError(
        'NEWER_SCHEMA',
        `${path} was written by a newer Dim Factory; it is read-only here`,
      )
    }
    if (read.corrupt) {
      // Keep the unreadable file for inspection; start over (fail closed: it granted nothing anyway).
      await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    }
    const now = (opts.now ?? Date.now)()
    const stored = read.file.folders[fs.folderKey]?.grants ?? {}
    // Only the grant of the file this folder uses is checked (and dropped when stale); other files' grants stay.
    const view = change(liveGrants(grantsView(stored, relDir), projectSha), {
      projectSha,
      now,
      scopeRoot: fs.scopeRoot,
    })
    const next = storeView(stored, relDir, view)
    const folders = { ...read.file.folders }
    if (Object.keys(next).length === 0) delete folders[fs.folderKey]
    else folders[fs.folderKey] = { path: fs.scopeRoot, grants: next }
    await writeVersionedJson(
      path,
      { ...read.file, folders },
      { current: TRUST_SCHEMA_VERSION, knownWritable: true },
    )
    return { folder: abs, folderKey: fs.folderKey, scopeRoot: fs.scopeRoot, grants: view }
  })
}

/** Record a grant. projectAuto needs an existing project file (its sha256 is what gets trusted). */
export async function grantTrust(
  folder: string,
  grant: TrustGrantRequest,
  opts: TrustOptions = {},
): Promise<TrustState> {
  return mutate(folder, opts, (grants, { projectSha, now, scopeRoot }) => {
    switch (grant.kind) {
      case 'vendorFolder':
        if (!VENDOR_ID_PATTERN.test(grant.vendor)) {
          throw new DimFactoryError('VALIDATION', `Unknown vendor id ${JSON.stringify(grant.vendor)}`)
        }
        return { ...grants, vendorFolder: { ...grants.vendorFolder, [grant.vendor]: { at: now } } }
      case 'largeFolder':
        return { ...grants, largeFolder: { at: now, files: grant.files, bytes: grant.bytes } }
      case 'projectAuto':
        if (projectSha === null) {
          throw new DimFactoryError('NOT_FOUND', 'This folder has no project dimfactory.json to trust')
        }
        if (grant.projectSha !== undefined && grant.projectSha !== projectSha) {
          // The grant trusts exactly the text the user was shown, never a version they have not seen.
          throw new DimFactoryError(
            'CONFLICT',
            "The project's dimfactory.json changed since it was shown; review it and allow Auto mode again",
          )
        }
        return { ...grants, projectAuto: { at: now, projectSha } }
      case 'recipeAuto':
        if (grant.currentSha === null) {
          throw new DimFactoryError(
            'NOT_FOUND',
            `This folder has no project recipe "${grant.recipeId}" to trust`,
          )
        }
        if (grant.recipeSha !== undefined && grant.recipeSha !== grant.currentSha) {
          throw new DimFactoryError(
            'CONFLICT',
            `The project recipe "${grant.recipeId}" changed since it was shown; review it and allow its Auto mode again`,
          )
        }
        return {
          ...grants,
          recipeAuto: { ...grants.recipeAuto, [grant.recipeId]: { at: now, sha: grant.currentSha } },
        }
      case 'easyProject':
        // Only a folder that is its own scope root (a new project folder with its own repository) can hold it.
        if (!sameFolder(resolve(folder), scopeRoot)) {
          throw new DimFactoryError(
            'VALIDATION',
            'A project permission is only for the project folder itself',
          )
        }
        return {
          ...grants,
          easyProject: {
            at: now,
            folder: resolve(folder),
            ...(grant.ino !== undefined ? { ino: grant.ino } : {}),
          },
        }
      case 'command': {
        const c = grant.command
        if (c.argv.length === 0) throw new DimFactoryError('VALIDATION', 'A command grant needs a command')
        const entry: TrustCommandGrant = {
          kind: c.kind,
          argv: [...c.argv],
          cwdRel: normalizeCwdRel(c.cwdRel),
          ...(c.body !== undefined ? { body: c.body } : {}),
          at: now,
        }
        return { ...grants, commands: { ...grants.commands, [commandGrantHash(c)]: entry } }
      }
    }
  })
}

/** Remove a grant (no-op when absent). The folder's entry disappears once it has no grants. */
export async function revokeTrust(
  folder: string,
  what: TrustRevokeRequest,
  opts: TrustOptions = {},
): Promise<TrustState> {
  return mutate(folder, opts, (grants) => {
    const out: TrustGrants = { ...grants }
    switch (what.kind) {
      case 'vendorFolder': {
        const rest = { ...grants.vendorFolder }
        delete rest[what.vendor]
        if (Object.keys(rest).length > 0) out.vendorFolder = rest
        else delete out.vendorFolder
        return out
      }
      case 'largeFolder':
        delete out.largeFolder
        return out
      case 'projectAuto':
        delete out.projectAuto
        return out
      case 'easyProject':
        delete out.easyProject
        return out
      case 'recipeAuto': {
        const rest = { ...grants.recipeAuto }
        delete rest[what.recipeId]
        if (Object.keys(rest).length > 0) out.recipeAuto = rest
        else delete out.recipeAuto
        return out
      }
      case 'command': {
        const hash = 'hash' in what ? what.hash : commandGrantHash(what.command)
        const rest = { ...grants.commands }
        delete rest[hash]
        if (Object.keys(rest).length > 0) out.commands = rest
        else delete out.commands
        return out
      }
    }
  })
}

/**
 * `trust.set{folder, grant, trusted}`. A largeFolder grant records `size` (the folder.size check's numbers); a
 * command grant may carry `body` (TrustGrantInput has none; core adds it from verify detection).
 */
export async function setTrust(
  folder: string,
  grant: TrustGrantInput,
  trusted: boolean,
  opts: TrustOptions & {
    size?: { files: number; bytes: number }
    body?: string
    /** recipeAuto: the project recipe file's sha256 now (null: none). */
    recipeSha?: string | null
  } = {},
): Promise<TrustState> {
  if (grant.kind === 'command') {
    const command: TrustedCommand = {
      ...grant.command,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }
    return trusted
      ? grantTrust(folder, { kind: 'command', command }, opts)
      : revokeTrust(folder, { kind: 'command', command }, opts)
  }
  if (grant.kind === 'recipeAuto') {
    if (!trusted) return revokeTrust(folder, { kind: 'recipeAuto', recipeId: grant.recipeId }, opts)
    return grantTrust(
      folder,
      {
        kind: 'recipeAuto',
        recipeId: grant.recipeId,
        ...(grant.recipeSha !== undefined ? { recipeSha: grant.recipeSha } : {}),
        currentSha: opts.recipeSha ?? null,
      },
      opts,
    )
  }
  if (!trusted) return revokeTrust(folder, grant, opts)
  if (grant.kind === 'largeFolder') {
    if (opts.size === undefined)
      throw new DimFactoryError('VALIDATION', 'A large-folder grant needs the folder size')
    return grantTrust(folder, { kind: 'largeFolder', ...opts.size }, opts)
  }
  return grantTrust(folder, grant, opts)
}

// ---- guardrails loosened -------------------------------------------------------------------------------------------

/** How many loosenings trust.json keeps (the oldest go first). */
export const LOOSENED_KEEP = 50

/** The loosenings of your guardrails on record, newest last. */
export async function readGuardrailLoosening(opts: LocateOptions = {}): Promise<GuardrailLoosening[]> {
  const { file } = await readTrustFile(opts)
  return file.guardrails?.loosened ?? []
}

/**
 * Record that your guardrails were loosened in the app (a preset lowered, a rule removed), with the time. Not a grant
 * that anything checks: a record, so the Guardrails section can say when and what. Nothing to record: no write.
 */
export async function recordGuardrailLoosening(
  what: readonly string[],
  opts: LocateOptions & { now?: () => number } = {},
): Promise<void> {
  if (what.length === 0) return
  const path = trustPath(opts)
  await withConfigLocks([path], async () => {
    const read = await readTrustFile(opts)
    if (read.readOnly) return
    if (read.corrupt) await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    const at = (opts.now ?? Date.now)()
    const loosened = [...(read.file.guardrails?.loosened ?? []), ...what.map((w) => ({ at, what: w }))]
    await writeVersionedJson(
      path,
      { ...read.file, guardrails: { loosened: loosened.slice(-LOOSENED_KEEP) } },
      { current: TRUST_SCHEMA_VERSION, knownWritable: true },
    )
  })
}

// ---- Easy mode's project permission -------------------------------------------------------------------------------

/** Every `easyProject` grant in trust.json (Easy's project permissions), as stored. */
export async function readEasyProjectGrants(opts: LocateOptions = {}): Promise<EasyProjectGrant[]> {
  const { file } = await readTrustFile(opts)
  return Object.values(file.folders)
    .map((f) => f.grants.easyProject)
    .filter((g): g is EasyProjectGrant => g !== undefined)
}

/**
 * Remove the `easyProject` grant of `folder` wherever trust.json keeps it (matched by the folder it was given for, so
 * a folder that was moved or deleted since can still be revoked). A folder entry left with no grants goes.
 */
export async function revokeEasyProject(folder: string, opts: TrustOptions = {}): Promise<void> {
  const path = trustPath(opts)
  const key = resolve(folder)
  await withConfigLocks([path], async () => {
    const read = await readTrustFile(opts)
    if (read.readOnly) {
      throw new DimFactoryError(
        'NEWER_SCHEMA',
        `${path} was written by a newer Dim Factory; it is read-only here`,
      )
    }
    const folders = { ...read.file.folders }
    let changed = false
    for (const [k, entry] of Object.entries(folders)) {
      const g = entry.grants.easyProject
      if (g === undefined || !sameFolder(g.folder, key)) continue
      const { easyProject: _gone, ...rest } = entry.grants
      if (Object.keys(rest).length === 0) delete folders[k]
      else folders[k] = { ...entry, grants: rest }
      changed = true
    }
    if (!changed) return
    await writeVersionedJson(
      path,
      { ...read.file, folders },
      { current: TRUST_SCHEMA_VERSION, knownWritable: true },
    )
  })
}
