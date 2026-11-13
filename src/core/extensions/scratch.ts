// A run's private scratch folder (`runs/<id>/tmp`). Claude's allowed MCP servers file lives there only while its pass
// runs (claude/run.ts deletes it when the process is gone); one a crash left behind is removed at the next launch,
// since it may hold the user's secrets (the servers' env values).
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** The scratch folder of a run folder. */
export const scratchDirOf = (runDir: string): string => join(runDir, 'tmp')

/** The name Claude's allowed MCP servers file has (`mcp-<uuid>.json`). */
export const MCP_SCRATCH_FILE = /^mcp-[0-9a-f-]{36}\.json$/i

/** Removes every allowed-servers file left in these run folders. Never throws; returns how many it removed. */
export async function sweepMcpScratch(runDirs: readonly string[]): Promise<number> {
  let removed = 0
  for (const dir of runDirs) {
    const scratch = scratchDirOf(dir)
    let names: string[]
    try {
      names = await readdir(scratch)
    } catch {
      continue
    }
    for (const n of names) {
      if (!MCP_SCRATCH_FILE.test(n)) continue
      try {
        await rm(join(scratch, n), { force: true })
        removed++
      } catch {
        // Tried again at the next launch.
      }
    }
  }
  return removed
}
