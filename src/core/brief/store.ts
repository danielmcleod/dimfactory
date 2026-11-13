// Saved briefs: one file per folder under DIM_FACTORY_HOME/briefs/, named by a hash of the folder's path, so a folder's
// brief comes back when the composer opens it again. Reset deletes it. An unreadable or invalid file reads as none.
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BriefInputZ } from '../../shared/brief.ts'
import type { BriefInput } from '../../shared/brief.ts'
import { writeFileAtomic } from '../store/atomic.ts'

/** A folder's identity for its saved brief: the absolute path (case folded on Windows and macOS). */
export function briefKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(folder)
  const norm = platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16)
}

export function briefFile(home: string, folder: string): string {
  return join(home, 'briefs', `${briefKey(folder)}.json`)
}

export async function readSavedBrief(home: string, folder: string): Promise<BriefInput | null> {
  try {
    const v: unknown = JSON.parse(await readFile(briefFile(home, folder), 'utf8'))
    const brief = (v as { brief?: unknown } | null)?.brief
    const r = BriefInputZ.safeParse(brief)
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** Save the folder's brief, or forget it (`null`: Reset). */
export async function saveBrief(
  home: string,
  folder: string,
  brief: BriefInput | null,
  at: number,
): Promise<void> {
  const file = briefFile(home, folder)
  if (brief === null) {
    await rm(file, { force: true })
    return
  }
  const doc = { folder: resolve(folder), savedAt: at, brief }
  await writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}
