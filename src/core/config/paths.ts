// Config file locations:
// - user:    DIM_FACTORY_HOME/dimfactory.json
// - project: <folder>/.dimfactory/dimfactory.json, else <scopeRoot>/.dimfactory/dimfactory.json. Exactly one project
//            file is used; project files never stack.
// - editor schema: DIM_FACTORY_HOME/schema/dimfactory.schema.json, generated from DimFactoryConfigZ.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ConfigScope } from '../../shared/config-schema.ts'
import { DimFactoryConfigZ } from '../../shared/config-schema.ts'
import { homePaths, projectPaths } from '../home.ts'
import type { HomePaths } from '../home.ts'
import { relativeInside } from '../real-path.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { BRAND } from '../../shared/brand.ts'

export const CONFIG_FILENAME = BRAND.configFileName
export const PROJECT_DIRNAME = BRAND.projectDirName

/** DIM_FACTORY_HOME/dimfactory.json */
export function userConfigPath(home: string): string {
  return homePaths(home).userConfig
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)

/** The project file candidates in lookup order: the run folder's, then the scope root's (when different). */
export function projectConfigCandidates(folder: string, scopeRoot?: string | null): string[] {
  const out = [projectPaths(folder).config]
  if (scopeRoot !== undefined && scopeRoot !== null && !samePath(folder, scopeRoot)) {
    out.push(projectPaths(scopeRoot).config)
  }
  return out
}

export interface ProjectConfigLocation {
  /** The file that is (or, when none exists, would be) the project layer. */
  path: string
  exists: boolean
  /** The folder holding `.dimfactory/` (project prompts are looked up under it). */
  root: string
  candidates: string[]
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The single project file for a run folder. When neither candidate exists, the location is the run folder's
 * (where a first "Save to project" creates it).
 */
export async function locateProjectConfig(
  folder: string,
  scopeRoot?: string | null,
): Promise<ProjectConfigLocation> {
  const candidates = projectConfigCandidates(folder, scopeRoot)
  for (const path of candidates) {
    if (await isFile(path)) return { path, exists: true, root: dirname(dirname(path)), candidates }
  }
  const first = candidates[0] ?? projectPaths(folder).config
  return { path: first, exists: false, root: resolve(folder), candidates }
}

// ---- per-file backup locations ------------------------------------------------------------------------------------

/** {@link projectRelDir} of the scope root's own project file. */
export const ROOT_REL_DIR = '.'

/**
 * The folder holding a project file's `.dimfactory/`, relative to the scope root (`/` separators, case-folded where
 * the file system ignores case; `.` for the scope root's own file). A folder outside the scope keeps its absolute
 * path. Several subfolders of one repo can each have their own project file, so backups, last-good and
 * projectAuto grants are kept per file under the scope's folderKey.
 */
export function projectRelDir(scopeRoot: string, configPath: string): string {
  const root = dirname(dirname(resolve(configPath)))
  // By real name: the scope root is a real path, the file's may be spelled with an 8.3 short name or a linked folder.
  const r = relativeInside(scopeRoot, root)
  const rel = r === '' ? ROOT_REL_DIR : r === null ? root : r
  const slashed = rel.replace(/\\/g, '/')
  return process.platform === 'win32' || process.platform === 'darwin' ? slashed.toLowerCase() : slashed
}

/** `sha256(projectRelDir).slice(0,16)` for a nested project file; null for the scope root's own file. */
export function projectFileKey(scopeRoot: string, configPath: string): string | null {
  const rel = projectRelDir(scopeRoot, configPath)
  return rel === ROOT_REL_DIR ? null : createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Write backups and last-good of one project file: `backups/project/<folderKey>/` for the scope root's file,
 * `backups/project/<folderKey>/<fileKey>/` for a subfolder's own file. Without a scope root the file
 * is taken to be the scope root's.
 */
export function projectBackupDir(
  paths: HomePaths,
  folderKey: string,
  scopeRoot: string | null | undefined,
  configPath: string,
): string {
  const key = scopeRoot !== undefined && scopeRoot !== null ? projectFileKey(scopeRoot, configPath) : null
  return key === null ? paths.projectBackups(folderKey) : join(paths.projectBackups(folderKey), key)
}

/** The last-good copy inside a backup directory. */
export const LAST_GOOD_FILENAME = 'last-good.jsonc'

/**
 * Where a successful load stores the file's text (Restore last good). Project needs the scope's folderKey, and the
 * scope root + file path to tell a subfolder's own file from the scope root's ({@link projectBackupDir}).
 */
export function lastGoodPath(
  paths: HomePaths,
  scope: ConfigScope,
  folderKey?: string,
  file?: { scopeRoot?: string | null; path: string },
): string | undefined {
  if (scope === 'user') return paths.lastGoodUserConfig
  if (folderKey === undefined) return undefined
  if (file === undefined) return paths.lastGoodProjectConfig(folderKey)
  return join(projectBackupDir(paths, folderKey, file.scopeRoot, file.path), LAST_GOOD_FILENAME)
}

// ---- editor schema ------------------------------------------------------------------------------------------------

/**
 * JSON Schema for dimfactory.json (draft-07, which every editor understands). `allowComments` /
 * `allowTrailingCommas` are VS Code extensions that stop it flagging JSONC syntax.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(DimFactoryConfigZ, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >
  return {
    ...schema,
    title: 'Dim Factory configuration (dimfactory.json)',
    allowComments: true,
    allowTrailingCommas: true,
  }
}

/** Write DIM_FACTORY_HOME/schema/dimfactory.schema.json when its content differs. */
export async function writeConfigSchema(paths: HomePaths): Promise<{ path: string; changed: boolean }> {
  const text = `${JSON.stringify(configJsonSchema(), null, 2)}\n`
  const current = await readFile(paths.schemaFile, 'utf8').catch(() => undefined)
  if (current === text) return { path: paths.schemaFile, changed: false }
  await writeFileAtomic(paths.schemaFile, text)
  return { path: paths.schemaFile, changed: true }
}
