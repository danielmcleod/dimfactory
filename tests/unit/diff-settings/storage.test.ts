// Storage (Settings → Diagnostics: storage sizes, Clear snapshots; IPC storage.usage /
// storage.clearShadow): store/storage.ts sizes every area of DIM_FACTORY_HOME in one walk, names each shadow's folder
// from its meta.json, and removes a shadow by moving it aside first (trash is swept).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { dirSize, removeShadow, storageUsage } from '../../../src/core/store/storage.ts'

const KEY_A = '0123456789abcdef'
const KEY_B = 'fedcba9876543210'

function put(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
}

function layout() {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  put(join(paths.runsDir, 'r1', 'run.json'), 100)
  put(join(paths.runsDir, 'r1', 'diffs', 'S0..S1.patch'), 50)
  put(join(paths.runsDir, 'r2', 'run.json'), 10)
  put(paths.runIndex, 5)
  put(join(paths.shadowDir, KEY_A, 'repo.git', 'objects', 'aa', 'x'), 1000)
  writeFileSync(join(paths.shadowDir, KEY_A, 'meta.json'), JSON.stringify({ scopeRoot: 'C:\\proj\\a' }))
  put(join(paths.shadowDir, KEY_B, 'repo.git', 'HEAD'), 20)
  put(join(paths.worktreesDir, 'r1', 'file.txt'), 300)
  put(join(paths.catalogDir, 'models.json'), 40)
  put(join(paths.logsDir, 'main.log'), 70)
  put(paths.userConfig, 3)
  return paths
}

describe('storage', () => {
  it('dirSize counts every file under a folder, and 0 for a folder that is not there', async () => {
    const paths = layout()
    expect(await dirSize(paths.runsDir)).toEqual({ bytes: 165, files: 4 })
    expect(await dirSize(join(paths.home, 'nope'))).toEqual({ bytes: 0, files: 0 })
  })

  it('storage.usage: totals per area, each shadow with its folder, biggest first', async () => {
    const paths = layout()
    const u = await storageUsage(paths)
    const metaBytes = Buffer.byteLength(JSON.stringify({ scopeRoot: 'C:\\proj\\a' }))
    expect(u).toMatchObject({
      home: paths.home,
      runs: { count: 2, bytes: 165 },
      worktrees: { count: 1, bytes: 300 },
      catalogBytes: 40,
      logsBytes: 70,
    })
    expect(u.shadows).toEqual([
      { folderKey: KEY_A, path: 'C:\\proj\\a', bytes: 1000 + metaBytes },
      { folderKey: KEY_B, path: null, bytes: 20 },
    ])
    expect(u.totalBytes).toBe(165 + 1000 + metaBytes + 20 + 300 + 40 + 70 + 3)
    expect(u.freeBytes === null || u.freeBytes > 0).toBe(true)
  })

  it('storage.usage of an empty home', async () => {
    const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
    expect(await storageUsage(paths)).toMatchObject({
      totalBytes: 0,
      runs: { count: 0, bytes: 0 },
      shadows: [],
      worktrees: { count: 0, bytes: 0 },
    })
  })

  it('removeShadow moves the shadow aside and deletes it; false when there is none; never another key', async () => {
    const paths = layout()
    put(join(paths.shadowDir, `.trash-${KEY_B}-dead`, 'left.txt'), 5)
    expect(await removeShadow(paths, KEY_A)).toBe(true)
    expect(existsSync(join(paths.shadowDir, KEY_A))).toBe(false)
    expect(readdirSync(paths.shadowDir)).toEqual([KEY_B])
    expect(await removeShadow(paths, KEY_A)).toBe(false)
    await expect(removeShadow(paths, '../escape')).rejects.toThrow('not a folder key')
    expect((await storageUsage(paths)).shadows.map((s) => s.folderKey)).toEqual([KEY_B])
  })
})
