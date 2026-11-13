import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STEP_KEYS } from '../../../src/shared/run.ts'
import {
  assertSafeSegment,
  homePaths,
  probeHomeWritable,
  projectPaths,
  resolveHome,
} from '../../../src/core/home.ts'
import type { HomePaths, RunPaths } from '../../../src/core/home.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

/** Strip a Windows drive prefix so only path components are checked for `:`. */
const noDrive = (p: string): string => p.replace(/^[A-Za-z]:/, '')

describe('resolveHome', () => {
  it('uses DIM_FACTORY_HOME, expanding ~ and making it absolute', () => {
    const userHome = resolve('/users/someone')
    expect(resolveHome({ env: { DIM_FACTORY_HOME: '~' }, userHome })).toBe(userHome)
    expect(resolveHome({ env: { DIM_FACTORY_HOME: '~/x/y' }, userHome })).toBe(join(userHome, 'x', 'y'))
    expect(resolveHome({ env: { DIM_FACTORY_HOME: 'rel' }, userHome, cwd: resolve('/base') })).toBe(
      resolve('/base', 'rel'),
    )
    expect(resolveHome({ env: { DIM_FACTORY_HOME: resolve('/abs/h') }, userHome })).toBe(resolve('/abs/h'))
  })

  it('defaults to <user home>/.dimfactory when unset or blank', () => {
    const userHome = resolve('/users/someone')
    expect(resolveHome({ env: {}, userHome })).toBe(join(userHome, '.dimfactory'))
    expect(resolveHome({ env: { DIM_FACTORY_HOME: '  ' }, userHome })).toBe(join(userHome, '.dimfactory'))
  })
})

describe('homePaths', () => {
  const p: HomePaths = homePaths(resolve('/h'))
  const h = resolve('/h')

  it('builds every storage path', () => {
    expect(p.userConfig).toBe(join(h, 'dimfactory.json'))
    expect(p.runIndex).toBe(join(h, 'runs', 'index.jsonl'))
    expect(p.probeCache).toBe(join(h, 'probe-cache.json'))
    expect(p.state).toBe(join(h, 'state.json'))
    expect(p.trust).toBe(join(h, 'trust.json'))
    expect(p.healCache).toBe(join(h, 'heal', 'cache.json'))
    expect(p.probeCwd).toBe(join(h, 'tmp', 'probe-cwd'))
    expect(p.healTmp('abc')).toBe(join(h, 'tmp', 'heal', 'abc'))
    expect(p.backupsDir).toBe(join(h, 'backups'))
    expect(p.lastGoodUserConfig).toBe(join(h, 'backups', 'last-good-user.jsonc'))
    expect(p.projectBackups('k1')).toBe(join(h, 'backups', 'project', 'k1'))
    expect(p.lastGoodProjectConfig('k1')).toBe(join(h, 'backups', 'project', 'k1', 'last-good.jsonc'))
    expect(p.shadowRepo('k1')).toBe(join(h, 'shadow', 'k1', 'repo.git'))
    expect(p.worktree('r1')).toBe(join(h, 'worktrees', 'r1'))
    expect(p.schemaFile).toBe(join(h, 'schema', 'dimfactory.schema.json'))
    expect(p.emptyHooksDir).toBe(join(h, 'empty-hooks'))
    expect(p.log('main')).toBe(join(h, 'logs', 'main.log'))
    expect(p.log('cli')).toBe(join(h, 'logs', 'cli.log'))
    expect(p.instanceLock).toBe(join(h, 'instance.lock'))
    expect(p.session).toBe(join(h, 'session.json'))
    expect(p.catalogModels).toBe(join(h, 'catalog', 'models.json'))
    expect(p.catalogPricing).toBe(join(h, 'catalog', 'pricing.json'))
    expect(p.userPrompt('plan')).toBe(join(h, 'prompts', 'plan.md'))
  })

  it('builds every run path', () => {
    const r: RunPaths = p.run('20261005T120000Z-abcd')
    const d = join(h, 'runs', '20261005T120000Z-abcd')
    expect(r.dir).toBe(d)
    expect(r.runJson).toBe(join(d, 'run.json'))
    expect(r.resolvedJson).toBe(join(d, 'resolved.json'))
    expect(r.eventsJsonl).toBe(join(d, 'events.jsonl'))
    expect(r.findingsJson).toBe(join(d, 'findings.json'))
    expect(r.snapshotsJson).toBe(join(d, 'snapshots.json'))
    expect(r.procsJson).toBe(join(d, 'procs.json'))
    expect(r.reviewStateJson).toBe(join(d, 'review-state.json'))
    expect(r.output('plan')).toBe(join(d, 'plan.md'))
    expect(r.output('plan.original')).toBe(join(d, 'plan.original.md'))
    expect(r.output('review')).toBe(join(d, 'review.md'))
    expect(r.output('critic')).toBe(join(d, 'critic.md'))
    expect(r.diffPatch('implement')).toBe(join(d, 'diffs', 'implement.patch'))
    expect(r.raw('implement', 2)).toBe(join(d, 'raw', 'implement-2.ndjson'))
    expect(r.prompt('plan', 1)).toBe(join(d, 'prompts', 'plan-1.md'))
    expect(r.out('fix', 1, 'md')).toBe(join(d, 'out', 'fix-1.md'))
    expect(r.verify('verify:1')).toBe(join(d, 'verify', 'verify-1'))
    expect(r.heal('review', 1)).toBe(join(d, 'heal', 'review-1'))
  })

  it('fileSafe: no path built from any step key contains ":" (NTFS alternate data streams)', () => {
    const r = p.run('run1')
    for (const key of STEP_KEYS) {
      const built = [
        r.raw(key, 1),
        r.prompt(key, 3),
        r.out(key, 1),
        r.out(key, 1, '.json'),
        r.verify(key),
        r.heal(key, 2),
        r.diffPatch(key),
        r.diffPatch(`post-${key}`),
      ]
      for (const path of built) expect(noDrive(path)).not.toContain(':')
    }
    expect(r.raw('verify:2', 1)).toBe(join(r.dir, 'raw', 'verify-2-1.ndjson'))
  })

  it('rejects path segments that could escape their folder', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'c:x', 'a\u0000b']) {
      expect(() => assertSafeSegment(bad)).toThrow(/invalid/)
      expect(() => p.run(bad)).toThrow()
    }
    expect(() => p.shadowRepo('../x')).toThrow()
    expect(() => p.worktree('..')).toThrow()
    expect(assertSafeSegment('20261005T120000Z-abcd')).toBe('20261005T120000Z-abcd')
  })

  it('project paths live in <folder>/.dimfactory', () => {
    const pp = projectPaths(resolve('/repo'))
    expect(pp.config).toBe(join(resolve('/repo'), '.dimfactory', 'dimfactory.json'))
    expect(pp.prompt('review')).toBe(join(resolve('/repo'), '.dimfactory', 'prompts', 'review.md'))
  })
})

describe('probeHomeWritable', () => {
  it('passes for a writable home and leaves no probe file', async () => {
    const p = homePaths(join(home(), 'h'))
    const r = await probeHomeWritable(p)
    expect(r.ok).toBe(true)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(p.home)).toEqual([])
  })

  it('fails with STORAGE naming the path when home cannot be created', async () => {
    const { writeFile } = await import('node:fs/promises')
    const blocker = join(home(), 'file')
    await writeFile(blocker, 'x')
    const r = await probeHomeWritable(homePaths(join(blocker, 'sub')))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('STORAGE')
      expect(r.error.message).toContain('sub')
    }
  })
})
