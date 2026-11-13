// Storage sizes and clearing a folder's snapshots (Settings → Diagnostics: storage sizes, Clear
// snapshots; IPC `storage.usage`, `storage.clearShadow`). One walk of DIM_FACTORY_HOME attributes every byte to its
// area (runs, each folder's shadow, worktrees, catalog, logs); links are never followed. Clearing a shadow moves its
// folder aside first (one rename, so no half-deleted repository is ever opened again) and then deletes it.
import { randomBytes } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { StorageUsage } from '../../shared/ipc.ts'
import { errnoCode, storageError } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import { isPlainObject } from './versions.ts'

const FOLDER_KEY = /^[0-9a-f]{16}$/
const TRASH_PREFIX = '.trash-'
const WALK_CONCURRENCY = 32

export interface DirSize {
  bytes: number
  files: number
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Bytes and files under `dir` (lstat: links count as themselves, never followed); 0 when it does not exist. */
export async function dirSize(dir: string): Promise<DirSize> {
  const total: DirSize = { bytes: 0, files: 0 }
  const first = await lstat(dir).catch(() => null)
  if (first === null) return total
  if (!first.isDirectory()) return { bytes: first.size, files: 1 }
  // Breadth first: one level's folders are listed together, then its files are stat'ed together.
  let level = [dir]
  while (level.length > 0) {
    const folders: string[] = []
    const files: string[] = []
    await mapLimit(level, WALK_CONCURRENCY, async (d) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        ;(e.isDirectory() ? folders : files).push(join(d, e.name))
      }
    })
    await mapLimit(files, WALK_CONCURRENCY, async (p) => {
      const st = await lstat(p).catch(() => null)
      if (st === null) return
      total.bytes += st.size
      total.files++
    })
    level = folders
  }
  return total
}

/** Free bytes on the volume holding `dir` (null when the platform cannot say). */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** The folder a shadow snapshots (its meta.json `scopeRoot`), or null. */
async function shadowFolder(root: string): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'))
    return isPlainObject(v) && typeof v['scopeRoot'] === 'string' ? v['scopeRoot'] : null
  } catch {
    return null
  }
}

/** The folder the shadow `folderKey` snapshots (its meta.json `scopeRoot`), or null. */
export function shadowScopeRoot(paths: HomePaths, folderKey: string): Promise<string | null> {
  if (!FOLDER_KEY.test(folderKey)) return Promise.resolve(null)
  return shadowFolder(join(paths.shadowDir, folderKey))
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** `storage.usage`: home, totals per area, each folder's shadow (with the folder it snapshots) and free disk. */
export async function storageUsage(paths: HomePaths): Promise<StorageUsage> {
  const [top, runIds, shadowKeys, worktrees, free] = await Promise.all([
    readdir(paths.home, { withFileTypes: true }).catch(() => []),
    listDirs(paths.runsDir),
    listDirs(paths.shadowDir),
    listDirs(paths.worktreesDir),
    freeBytes(paths.home),
  ])
  const sized = await Promise.all(
    top.map(async (e) => ({ name: e.name, size: await dirSize(join(paths.home, e.name)) })),
  )
  const area = (abs: string): number => sized.find((s) => join(paths.home, s.name) === abs)?.size.bytes ?? 0
  const shadows = await Promise.all(
    shadowKeys
      .filter((k) => FOLDER_KEY.test(k))
      .map(async (folderKey) => {
        const root = join(paths.shadowDir, folderKey)
        const [size, folder] = await Promise.all([dirSize(root), shadowFolder(root)])
        return { folderKey, path: folder, bytes: size.bytes }
      }),
  )
  shadows.sort((a, b) => b.bytes - a.bytes || a.folderKey.localeCompare(b.folderKey))
  return {
    home: paths.home,
    totalBytes: sized.reduce((n, s) => n + s.size.bytes, 0),
    freeBytes: free,
    runs: { count: runIds.length, bytes: area(paths.runsDir) },
    shadows,
    worktrees: { count: worktrees.length, bytes: area(paths.worktreesDir) },
    catalogBytes: area(paths.catalogDir),
    logsBytes: area(paths.logsDir),
  }
}

async function retrying<T>(op: () => Promise<T>): Promise<T> {
  const waits = [100, 250, 500, 1000, 2000]
  for (let i = 0; ; i++) {
    try {
      return await op()
    } catch (err) {
      const code = errnoCode(err)
      const wait = waits[i]
      if (wait === undefined || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await delay(wait)
    }
  }
}

/**
 * Delete `shadow/<folderKey>`: renamed to `shadow/.trash-<key>-<random>` first, then removed (a removal that fails
 * part way leaves only trash, which the next clear sweeps). False when there was no shadow. The caller holds the
 * folder's shadow mutex and has checked that no run uses the folder.
 */
export async function removeShadow(paths: HomePaths, folderKey: string): Promise<boolean> {
  if (!FOLDER_KEY.test(folderKey)) throw new Error(`not a folder key: ${folderKey}`)
  const root = join(paths.shadowDir, folderKey)
  const exists = await lstat(root).then(
    () => true,
    () => false,
  )
  if (exists) {
    const trash = join(paths.shadowDir, `${TRASH_PREFIX}${folderKey}-${randomBytes(4).toString('hex')}`)
    try {
      await retrying(() => rename(root, trash))
    } catch (err) {
      throw storageError(`Dim Factory could not remove the snapshots in ${root}`, err)
    }
  }
  await sweepTrash(paths)
  return exists
}

/** Remove what earlier clears left in `shadow/.trash-*` (best effort). */
export async function sweepTrash(paths: HomePaths): Promise<void> {
  for (const name of await listDirs(paths.shadowDir)) {
    if (!name.startsWith(TRASH_PREFIX)) continue
    await rm(join(paths.shadowDir, name), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined)
  }
}
