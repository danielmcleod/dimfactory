// git.init (the "Initialize git" banner action, the Quick composer's "Dim Factory tracks changes itself
// [Initialize git]") on real temp folders with real git: a plain folder becomes a repository with nothing committed
// and nothing added; the folder's cached scope and folder.git result are dropped, so the next live preflight sees the
// repository at once. Refused: a folder already in a repository (or inside one), a missing folder, a guarded folder
// (Dim Factory's own home).
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { detectRepo } from '../../../src/core/git/repo.ts'
import { tryGit } from '../../../src/core/git/exec.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { PreflightReport } from '../../../src/shared/preflight.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

async function boot(): Promise<{ core: Core; home: string }> {
  const sc = await makeScenario({})
  const { home } = await makeHome(sc)
  dirs.push(home, sc.dir)
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  value(await core.invoke('vendors.probe', { vendor: 'claude' }))
  return { core, home }
}

const folderGit = (r: PreflightReport) =>
  [...r.blocking, ...r.warnings, ...r.info].filter((c) => c.id.startsWith('folder.git'))

describe('git.init', () => {
  it('initializes a plain folder without committing; the next live preflight sees the repository', async () => {
    const { core } = await boot()
    const folder = makeSandbox({ git: false })
    dirs.push(folder)
    const overrides = { profile: 'claude-only' }
    const before = value(await core.invoke('preflight.run', { folder, overrides }))
    expect(folderGit(before)).toEqual([
      expect.objectContaining({ id: 'folder.git', title: 'Not a git repository' }),
    ])

    value(await core.invoke('git.init', { folder }))
    const repo = await detectRepo(folder)
    expect(repo.isRepo).toBe(true)
    // Nothing committed, nothing added: an unborn HEAD and an empty index.
    expect((await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: folder })).ok).toBe(false)
    const staged = await tryGit(['ls-files'], { cwd: folder })
    expect(staged.ok && staged.result.stdout).toBe('')

    // folder.git is cached for 30 s; git.init dropped it with the folder's scope.
    const after = value(await core.invoke('preflight.run', { folder, overrides }))
    expect(folderGit(after).some((c) => c.title === 'Not a git repository')).toBe(false)
    expect(folderGit(after).length).toBeGreaterThan(0)

    const again = await core.invoke('git.init', { folder })
    expect(again.ok === false && again.error.code).toBe('CONFLICT')
    if (!again.ok) expect(again.error.message).toMatch(/already inside the git repository/)
  }, 120_000)

  it('refuses a folder inside a repository, a missing folder and a guarded folder', async () => {
    const { core, home } = await boot()
    const repo = makeSandbox({ git: true })
    dirs.push(repo)
    const sub = join(repo, 'src', 'nested')
    mkdirSync(sub, { recursive: true })
    const inside = await core.invoke('git.init', { folder: sub })
    expect(inside.ok === false && inside.error.code).toBe('CONFLICT')
    expect(existsSync(join(sub, '.git'))).toBe(false)

    const root = mkdtempSync(join(tmpdir(), 'dim-run-gitinit-'))
    dirs.push(join(root, 'x'))
    const missing = await core.invoke('git.init', { folder: join(root, 'no-such-folder') })
    expect(missing.ok === false && missing.error.code).toBe('NOT_FOUND')
    const file = join(root, 'a-file.txt')
    writeFileSync(file, 'x\n')
    const notDir = await core.invoke('git.init', { folder: file })
    expect(notDir.ok === false && notDir.error.code).toBe('VALIDATION')

    // Dim Factory's own data folder is guarded (as for runs): refused, nothing written there.
    const guarded = join(home, 'inside-home')
    mkdirSync(guarded)
    const refused = await core.invoke('git.init', { folder: guarded })
    expect(refused.ok === false && refused.error.code).toBe('FORBIDDEN')
    if (!refused.ok) expect(refused.error.message).toMatch(/^Dim Factory does not initialize git here: /)
    expect(existsSync(join(guarded, '.git'))).toBe(false)
  }, 120_000)
})
