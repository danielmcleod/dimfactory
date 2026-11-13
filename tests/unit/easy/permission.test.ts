// Easy mode's project permission (easy/permission.ts) with the allow cache's live source (adapters/allow-cache.ts) and
// trust.json's easyProject grant (config/trust.ts):
// - the rule matches only inside its folder: the pass must work in the very folder that holds the grant (not a
//   subfolder, a sibling or another project), and only what the classifier covers;
// - never after a revoke, including a permit a running pass already holds (each ask is checked when it comes);
// - never for a run that is not an Easy run (another recipe, or a user recipe named like an Easy one);
// - the grant is bound to the folder it was given for: its path, and its file id (a folder made again in its place is
//   another folder); trust.json refuses it for a folder that is not its own scope root, and nothing on disk can turn the
//   in-memory marker on;
// - every use is logged (and counted per project and per run, across a restart).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AllowCache, ruleMatches } from '@core/adapters/allow-cache.ts'
import type { AllowQuery } from '@core/adapters/allow-cache.ts'
import {
  coveredByProject,
  grantTrust,
  readEasyProjectGrants,
  readTrustFile,
  revokeEasyProject,
  trustGrantsFor,
  withProjectPermission,
} from '@core/config/trust.ts'
import { ProjectPermissions, fileIdOf, isEasyRun } from '@core/easy/permission.ts'
import type { PermissionDeps, PermitRun } from '@core/easy/permission.ts'
import { DimFactoryError } from '@core/errors.ts'
import { silentLogger } from '@core/log.ts'
import { git } from '../../integration/run/scenario.ts'
import type { EasyProjectGrant } from '@shared/ipc.ts'
import { PROJECT_PERMISSION } from '@shared/ipc.ts'
import type { RunRecipe } from '@shared/recipes.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-perm-'))
  dirs.push(d)
  return d
}

const SHA = 'a'.repeat(64)
const EASY: RunRecipe = { id: 'easy-software', label: 'Easy: an app', layer: 'builtin', sha256: SHA }
const CHANGE: RunRecipe = { id: 'easy-change', label: 'Easy: a change', layer: 'builtin', sha256: SHA }

/** A project folder with a package.json and its own repository (a new Easy folder). */
function project(root: string, name = 'bakery'): string {
  const f = join(root, name)
  mkdirSync(f, { recursive: true })
  writeFileSync(join(f, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'node --test' } }))
  git(f, 'init', '-q')
  return f
}

const shell = (command: string): AllowQuery => ({
  vendor: 'claude',
  kind: 'shell',
  tool: 'Bash',
  argv: command.split(' '),
})

/** A permissions service on trust.json under `home`, with what it announced. */
function service(
  home: string,
  over: Partial<PermissionDeps> = {},
): { p: ProjectPermissions; changed: string[] } {
  const changed: string[] = []
  const p = new ProjectPermissions({
    home,
    log: silentLogger,
    now: () => 1_000,
    readGrants: () => readEasyProjectGrants({ home }),
    writeGrant: async (folder, ino) => {
      const st = await grantTrust(
        folder,
        { kind: 'easyProject', ...(ino !== undefined ? { ino } : {}) },
        { home },
      )
      return st.grants.easyProject as EasyProjectGrant
    },
    removeGrant: (folder) => revokeEasyProject(folder, { home }),
    changed: (f) => changed.push(f),
    ...over,
  })
  return { p, changed }
}

const run = (folder: string, over: Partial<PermitRun> = {}): PermitRun => ({
  runId: 'r1',
  folder,
  cwd: folder,
  recipe: EASY,
  ...over,
})

describe('the project permission', () => {
  it('covers what the classifier covers, in its folder, for an Easy run; each use logged and counted', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    const { p, changed } = service(home)
    await p.grant(folder)
    const permit = p.permitFor(run(folder))
    expect(permit).toBeDefined()
    const rule = permit?.(shell('npm install'), {})
    expect(rule).toMatchObject({
      vendor: 'claude',
      kind: 'shell',
      tool: 'Bash',
      source: 'project-permission',
    })
    expect(permit?.(shell('npm run dev'), {})).toBeDefined()
    // Not covered: nothing logged for it.
    expect(permit?.(shell('npm install -g left-pad'), {})).toBeUndefined()
    expect(
      permit?.({ vendor: 'claude', kind: 'edit', tool: 'Write', path: join(root, 'elsewhere.txt') }, {}),
    ).toBeUndefined()
    expect(p.view(folder, 'r1')).toMatchObject({ granted: true, uses: 2, runUses: 2 })
    expect(changed.length).toBeGreaterThanOrEqual(3)
    await p.flushed()
    const log = readFileSync(join(home, 'easy', 'permission-uses.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(log.map((l) => (JSON.parse(l) as { label: string; what: string }).label)).toEqual([
      'npm install',
      'npm run dev',
    ])
    // The counts survive a restart (read back from the log).
    const again = service(home).p
    await again.load()
    expect(again.view(folder, 'r1')).toMatchObject({ granted: true, uses: 2, runUses: 2 })
    expect(again.list()).toEqual(
      [{ folder, at: 1_000, uses: 2 }].map((x) => ({ ...x, at: expect.any(Number) as number })),
    )
  })

  it('matches only inside its folder: another project, a sibling, a subfolder or an isolated copy never match', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root, 'bakery')
    const other = project(root, 'bakery-2')
    const { p } = service(home)
    await p.grant(folder)
    expect(p.covers(run(folder))).toBe(true)
    expect(p.permitFor(run(other))).toBeUndefined()
    expect(p.covers(run(folder, { cwd: join(folder, 'sub') }))).toBe(false)
    expect(p.covers(run(folder, { cwd: join(home, 'worktrees', 'x') }))).toBe(false)
    expect(p.covers(run(other, { cwd: folder }))).toBe(false)
  })

  it('never after a revoke, even for a permit a running pass already holds; nothing is left in trust.json', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    const { p } = service(home)
    await p.grant(folder)
    const permit = p.permitFor(run(folder))
    expect(permit?.(shell('npm install'), {})).toBeDefined()
    await p.revoke(folder)
    expect(permit?.(shell('npm install'), {})).toBeUndefined()
    expect(p.covers(run(folder))).toBe(false)
    expect(p.permitFor(run(folder))).toBeUndefined()
    expect(await readEasyProjectGrants({ home })).toEqual([])
    expect((await readTrustFile({ home })).file.folders).toEqual({})
    // A new instance (the next launch) finds none.
    const next = service(home).p
    await next.load()
    expect(next.covers(run(folder))).toBe(false)
  })

  it('takes effect in memory before trust.json is written (a slow or failing write still revokes)', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    let release: () => void = () => undefined
    const { p } = service(home, {
      removeGrant: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    })
    await p.grant(folder)
    const permit = p.permitFor(run(folder))
    const revoking = p.revoke(folder)
    await Promise.resolve()
    expect(permit?.(shell('npm install'), {})).toBeUndefined()
    release()
    await revoking
  })

  it('never for a run that is not an Easy run', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    const { p } = service(home)
    await p.grant(folder)
    expect(p.covers(run(folder, { recipe: undefined }))).toBe(false)
    expect(p.covers(run(folder, { recipe: { ...EASY, id: 'build-feature' } }))).toBe(false)
    expect(p.covers(run(folder, { recipe: { ...EASY, layer: 'user' } }))).toBe(false)
    expect(p.covers(run(folder, { recipe: { ...EASY, layer: 'project' } }))).toBe(false)
    expect(p.covers(run(folder, { recipe: CHANGE }))).toBe(true)
    expect(isEasyRun(EASY)).toBe(true)
    expect(isEasyRun(undefined)).toBe(false)
  })

  it('is bound to the folder it was given for: a folder made again in its place does not have it', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    let id = 'ino-1'
    const { p } = service(home, { fileId: () => id })
    await p.grant(folder)
    expect(p.grantOf(folder)?.ino).toBe('ino-1')
    expect(p.covers(run(folder))).toBe(true)
    id = 'ino-2'
    expect(p.covers(run(folder))).toBe(false)
    expect(p.permitFor(run(folder))).toBeUndefined()
  })

  it('binds to the real file id of the folder', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    const { p } = service(home)
    const g = await p.grant(folder)
    const id = fileIdOf(folder)
    expect(g.ino).toBe(id)
    expect(g.folder).toBe(folder)
  })
})

describe("trust.json's easyProject grant", () => {
  it('is only for a folder that is its own scope root', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    const sub = join(folder, 'sub')
    mkdirSync(sub)
    await expect(grantTrust(sub, { kind: 'easyProject' }, { home })).rejects.toBeInstanceOf(DimFactoryError)
    const st = await grantTrust(folder, { kind: 'easyProject', ino: '42' }, { home })
    expect(st.grants.easyProject).toEqual({ at: expect.any(Number) as number, folder, ino: '42' })
  })

  it('is revoked by its folder even when the folder is gone', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    await grantTrust(folder, { kind: 'easyProject' }, { home })
    rmSync(folder, { recursive: true, force: true })
    await revokeEasyProject(folder, { home })
    expect(await readEasyProjectGrants({ home })).toEqual([])
  })

  it('never turns the in-memory marker on: a hand-edited trust.json cannot cover commands', async () => {
    const root = temp()
    const home = join(root, 'home')
    const folder = project(root)
    await grantTrust(folder, { kind: 'easyProject' }, { home })
    // A hand edit that names the marker's description as a key does nothing.
    const file = join(home, 'trust.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      folders: Record<string, { grants: Record<string, unknown> }>
    }
    for (const f of Object.values(raw.folders)) f.grants['dimf.projectPermission'] = true
    writeFileSync(file, JSON.stringify(raw))
    const grants = await trustGrantsFor(folder, { home })
    expect(grants.easyProject).toBeDefined()
    expect(coveredByProject(grants)).toBe(false)
    expect(coveredByProject(JSON.parse(JSON.stringify(withProjectPermission(grants))) as never)).toBe(false)
    expect(coveredByProject(withProjectPermission(grants))).toBe(true)
    expect(withProjectPermission(grants)[PROJECT_PERMISSION]).toBe(true)
  })
})

describe("the allow cache's live source", () => {
  it('is asked after the run rules; its rules are never kept and never match on their own', () => {
    let allow = true
    const cache = new AllowCache([], {}, (q) =>
      allow
        ? { vendor: q.vendor, kind: q.kind, tool: q.tool, match: {}, source: 'project-permission' }
        : undefined,
    )
    const q = shell('npm install')
    const rule = cache.match(q)
    expect(rule?.source).toBe('project-permission')
    allow = false
    expect(cache.match(q)).toBeUndefined()
    expect(
      cache.add({
        vendor: 'claude',
        kind: 'shell',
        tool: 'Bash',
        match: { argv: ['npm', 'install'] },
        source: 'project-permission',
      }),
    ).toBe(false)
    expect(cache.size).toBe(0)
    expect(
      ruleMatches(
        {
          vendor: 'claude',
          kind: 'shell',
          tool: 'Bash',
          match: { argv: ['npm', 'install'] },
          source: 'project-permission',
        },
        q,
      ),
    ).toBe(false)
  })
})
