// The Deploy checklist's manual ticks, one small file per folder under DIM_FACTORY_HOME/deploy/ (named by a hash of
// the folder's path, as saved briefs are). A tick is the user's own statement about an item Dim Factory cannot check;
// it is shown as "ticked by you", never as a pass. An unreadable or invalid file reads as no ticks.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { DEPLOY_TICKS_MAX } from '../../shared/deploy.ts'
import { briefKey } from '../brief/store.ts'
import { writeFileAtomic } from '../store/atomic.ts'

const TicksDocZ = z.object({
  ticks: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.number().int().nonnegative()),
})

export function deployTicksFile(home: string, folder: string): string {
  return join(home, 'deploy', `${briefKey(folder)}.json`)
}

export async function readDeployTicks(home: string, folder: string): Promise<Record<string, number>> {
  try {
    const v: unknown = JSON.parse(await readFile(deployTicksFile(home, folder), 'utf8'))
    const r = TicksDocZ.safeParse(v)
    return r.success ? { ...r.data.ticks } : {}
  } catch {
    return {}
  }
}

/** Tick (`at`) or untick (`null`) one manual item for the folder. */
export async function setDeployTick(
  home: string,
  folder: string,
  item: string,
  at: number | null,
): Promise<Record<string, number>> {
  const ticks = await readDeployTicks(home, folder)
  if (at === null) delete ticks[item]
  else ticks[item] = at
  const ids = Object.keys(ticks)
  // Bounded: an old item id that no class uses any more is dropped first (oldest first).
  if (ids.length > DEPLOY_TICKS_MAX) {
    for (const id of ids
      .sort((a, b) => (ticks[a] ?? 0) - (ticks[b] ?? 0))
      .slice(0, ids.length - DEPLOY_TICKS_MAX))
      delete ticks[id]
  }
  const doc = { folder: resolve(folder), ticks }
  await writeFileAtomic(deployTicksFile(home, folder), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  return ticks
}
