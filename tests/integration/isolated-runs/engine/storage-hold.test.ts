// Review (findings 5 and 18; worktree shadows are dropped with their worktree; Settings → Diagnostics "Clear
// snapshots"): an isolated copy's shadow holds the snapshots its Apply, preview and Diff
// tab read, whether or not its run is loaded, so storage.usage marks it busy and storage.clearShadow refuses it while
// the copy exists. Once the copy is gone it can be cleared like any other. A real core, a real worktree.
import { existsSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { homePaths } from '../../../../src/core/home.ts'
import type { Result } from '../../../../src/shared/ipc.ts'
import { cleanupTemps, git } from '../../git/helpers.ts'
import { hermeticEnv } from '../../run/scenario.ts'
import { isolated } from '../git/fixture.ts'

const cores: Core[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanupTemps()
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

describe('Clear snapshots and an isolated copy', () => {
  it("refuses the copy's shadow while the copy exists (busy in storage.usage, FOLDER_BUSY on clear)", async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    const core = await createCore({ home: f.home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const usage = value(await core.invoke('storage.usage', undefined))
    const mine = usage.shadows.find((s) => s.folderKey === f.wt.folderKey)
    expect(mine?.busy).toContain('still has its isolated copy')
    const r = await core.invoke('storage.clearShadow', { folderKey: f.wt.folderKey })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('FOLDER_BUSY')
    expect(existsSync(homePaths(f.home).shadowRepo(f.wt.folderKey))).toBe(true)

    // The copy gone (removed outside Dim Factory): its shadow can be cleared.
    git(f.repo, ['worktree', 'remove', '--force', f.wt.path])
    rmSync(f.wt.path, { recursive: true, force: true })
    const after = value(await core.invoke('storage.usage', undefined))
    expect(after.shadows.find((s) => s.folderKey === f.wt.folderKey)?.busy).toBeUndefined()
    value(await core.invoke('storage.clearShadow', { folderKey: f.wt.folderKey }))
    expect(existsSync(homePaths(f.home).shadowRepo(f.wt.folderKey))).toBe(false)
  }, 120_000)
})
