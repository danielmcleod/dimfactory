// New project through a real core and real git on temp folders: project.create makes the folder (missing parents
// too), git-inits it with nothing committed (an unborn HEAD), saves the template's Brief for it and answers the task;
// it refuses a non-empty folder, a folder inside another repository and a folder inside Dim Factory's home, creating
// nothing. Then the fake-CLI pipeline runs end to end in the fresh repository (live preflight, Verify discovery, Run &
// Preview detection, the shadow snapshots and the diff on an unborn HEAD), through the core and through `dimf new`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { tryGit } from '../../../src/core/git/exec.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { ScenarioSpec } from '../run/scenario.ts'

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

const settled = (s: RunState): boolean => ['completed', 'failed', 'cancelled'].includes(s.status)

const PIPELINE: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [
    {
      recording: 'C08a-session-id-implement',
      write: { path: 'index.html', content: '<!doctype html><title>Hello</title><h1>Hello</h1>\n' },
    },
  ],
}

async function boot(spec: ScenarioSpec = {}): Promise<{ core: Core; home: string }> {
  const sc = await makeScenario(spec)
  const { home } = await makeHome(sc)
  dirs.push(home, sc.dir)
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  value(await core.invoke('vendors.probe', { vendor: 'claude' }))
  return { core, home }
}

/** A temp parent folder (no repository above it in the temp dir). */
function tempParent(): string {
  const root = mkdtempSync(join(tmpdir(), 'dim-run-newproj-'))
  dirs.push(join(root, 'x'))
  return root
}

const unborn = async (folder: string): Promise<boolean> =>
  !(await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: folder })).ok

describe('project.create', () => {
  it('creates a new folder (and its parents), git-inits it without a commit and saves the Brief', async () => {
    const { core } = await boot()
    const folder = join(tempParent(), 'apps', 'hello-web')
    const created = value(
      await core.invoke('project.create', { folder, templateId: 'vite-react', goal: 'A tip calculator' }),
    )
    expect(created.folder).toBe(folder)
    expect(created.template).toEqual({ id: 'vite-react', label: 'Vite + React + TypeScript' })
    expect(created.recipe).toBe('new-web-app')
    expect(created.task).toContain('Scaffold a Vite + React + TypeScript')
    expect(created.task).toContain('What it should do: A tip calculator')
    expect(created.create?.command).toBe('npm create vite@latest . -- --template react-ts')
    expect(created.brief.category).toBe('software')
    expect(created.brief.fields['uiFramework']).toEqual({ choices: ['react'], source: 'user' })

    expect(readdirSync(folder)).toEqual(['.git'])
    expect(await unborn(folder)).toBe(true)
    const staged = await tryGit(['ls-files'], { cwd: folder })
    expect(staged.ok && staged.result.stdout).toBe('')

    // The composer restores it like any saved brief.
    const ctx = value(await core.invoke('brief.detect', { folder }))
    expect(ctx.saved).toEqual(created.brief)

    // An existing empty folder works too (OS clutter does not count).
    const empty = join(tempParent(), 'empty')
    mkdirSync(empty)
    writeFileSync(join(empty, '.DS_Store'), '')
    const again = value(await core.invoke('project.create', { folder: empty, templateId: 'docs-site' }))
    expect(again.recipe).toBe('write-docs')
    expect(existsSync(join(empty, '.git'))).toBe(true)
  }, 120_000)

  it('refuses a non-empty folder, a folder in another repository, Dim Factory home and an unknown template', async () => {
    const { core, home } = await boot()
    const full = join(tempParent(), 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'notes.txt'), 'x\n')
    const r1 = await core.invoke('project.create', { folder: full, templateId: 'vite-react' })
    expect(r1.ok === false && r1.error).toMatchObject({ code: 'VALIDATION' })
    if (!r1.ok) expect(r1.error.message).toContain('is not empty. Pick an empty or new folder.')
    expect(existsSync(join(full, '.git'))).toBe(false)

    const repo = makeSandbox({ git: true })
    dirs.push(repo)
    const nested = join(repo, 'packages', 'new-app')
    const r2 = await core.invoke('project.create', { folder: nested, templateId: 'vite-react' })
    expect(r2.ok === false && r2.error.code).toBe('VALIDATION')
    if (!r2.ok) expect(r2.error.message).toMatch(/is inside the git repository at .*Pick a folder outside it/)
    expect(existsSync(join(repo, 'packages'))).toBe(false)

    const inHome = join(home, 'projects', 'p1')
    const r3 = await core.invoke('project.create', { folder: inHome, templateId: 'vite-react' })
    expect(r3.ok === false && r3.error.code).toBe('VALIDATION')
    if (!r3.ok) expect(r3.error.message).toContain("inside Dim Factory's own data folder")
    expect(existsSync(join(home, 'projects'))).toBe(false)

    const r4 = await core.invoke('project.create', { folder: join(tempParent(), 'p'), templateId: 'nope' })
    expect(r4.ok === false && r4.error.code).toBe('VALIDATION')

    const r5 = await core.invoke('project.create', { folder: 'relative/path', templateId: 'vite-react' })
    expect(r5.ok === false && r5.error.message).toBe('Enter the full path of the new project folder.')
  }, 120_000)

  it('lists the templates grouped by pack, with a user override replacing its built-in', async () => {
    const { core, home } = await boot()
    mkdirSync(join(home, 'templates'))
    const own = JSON.parse(
      readFileSync(new URL('../../../src/core/templates/runbook.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    writeFileSync(join(home, 'templates', 'runbook.json'), JSON.stringify({ ...own, label: 'Our runbook' }))
    writeFileSync(join(home, 'templates', 'broken.json'), '{')
    const list = value(await core.invoke('templates.list'))
    expect(list.packs.map((p) => p.id)).toEqual([
      'software',
      'documents',
      'data',
      'design',
      'operations',
      'research-writing',
      'games',
    ])
    const runbook = list.templates.find((v) => v.template.id === 'runbook')
    expect(runbook).toMatchObject({ layer: 'user', template: { label: 'Our runbook' } })
    expect(list.issues).toEqual([expect.objectContaining({ file: join(home, 'templates', 'broken.json') })])
  }, 60_000)
})

describe('a run in a freshly created project (unborn HEAD)', () => {
  it('passes preflight, finds no verify commands, runs Plan → Implement → Review and diffs the new files', async () => {
    const { core } = await boot(PIPELINE)
    const folder = join(tempParent(), 'site')
    const created = value(await core.invoke('project.create', { folder, templateId: 'static-site' }))
    expect(await unborn(folder)).toBe(true)

    const overrides = { profile: 'claude-only', gates: { afterPlan: false, beforeFix: false } }
    const live = value(await core.invoke('preflight.run', { folder, overrides, brief: created.brief }))
    expect(live.blocking).toEqual([])
    // The template's recipe on top: nothing it turns on blocks a first run in an empty folder (no Test-first, no
    // Verify without commands).
    const withRecipe = value(
      await core.invoke('preflight.run', { folder, overrides, brief: created.brief, recipe: created.recipe }),
    )
    expect(withRecipe.blocking).toEqual([])
    expect(value(await core.invoke('verify.detect', { folder }))).toEqual([])
    const preview = value(await core.invoke('preview.detect', { folder }))
    expect(Array.isArray(preview.commands)).toBe(true)
    value(await core.invoke('estimates.get', { folder, overrides, brief: created.brief }))

    const { runId } = value(
      await core.invoke('runs.start', { folder, task: created.task, overrides, brief: created.brief }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('<h1>Hello</h1>')
    // Still nothing committed in the user's repository; the run's diff lists the new file.
    expect(await unborn(folder)).toBe(true)
    const files = value(await core.invoke('diff.files', { runId, seg: 'combined' }))
    expect(files.files.map((f) => f.path)).toContain('index.html')
    // After the run, Run & Preview finds the static site.
    const after = value(await core.invoke('preview.detect', { folder }))
    expect(after.commands.length).toBeGreaterThan(0)
  }, 180_000)

  it('branch prep and isolated copies wait for a first commit: preflight says so and offers Run in place', async () => {
    const { core } = await boot()
    const folder = join(tempParent(), 'branchy')
    const created = value(await core.invoke('project.create', { folder, templateId: 'static-site' }))
    for (const isolation of [{ branch: 'runBranch' as const }, { mode: 'worktree' as const }]) {
      const overrides = { profile: 'claude-only', isolation }
      const live = value(await core.invoke('preflight.run', { folder, overrides, brief: created.brief }))
      const head = live.blocking.find((c) => c.id === 'folder.git.head')
      expect(head, JSON.stringify(isolation)).toMatchObject({
        title: 'The repository has no commits yet',
        recovery: [expect.objectContaining({ label: 'Run in place instead' })],
      })
    }
    // In place (the default) the same folder is ready.
    const inPlace = value(
      await core.invoke('preflight.run', {
        folder,
        overrides: { profile: 'claude-only' },
        brief: created.brief,
      }),
    )
    expect(inPlace.blocking).toEqual([])
  }, 120_000)
})

describe('dimf new', () => {
  it('creates the project and runs the fake-CLI pipeline end to end in the fresh repository', async () => {
    const sc = await makeScenario(PIPELINE)
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const folder = join(tempParent(), 'hello')
    const out: string[] = []
    const err: string[] = []
    const code = await main(
      [
        'new',
        folder,
        '--template',
        'vite-react',
        '--task',
        'Say hello',
        '--gates',
        'approve',
        // The template's recipe (New web app) is applied; its extra steps are turned off here (the run layer wins over
        // the recipe layer) so the scripted pipeline stays Plan, Implement, Review.
        '--set',
        'passes.plan.clarify=false',
        '--set',
        'passes.plan.research=false',
        '--set',
        'passes.security.enabled=false',
        '--set',
        'passes.review.acceptance=false',
        '--set',
        'passes.plan.explain=false',
        '--set',
        'passes.fix.rounds=1',
        '--home',
        home,
      ],
      {
        out: (l) => out.push(l),
        write: (t) => out.push(t),
        err: (l) => err.push(l),
        stdin: Readable.from([]),
        isTTY: false,
        env: hermeticEnv(),
        cwd: tmpdir(),
        onInterrupt: () => () => undefined,
      },
    )
    expect(code, [...out, ...err].join('\n')).toBe(0)
    expect(err.join('\n')).toContain('from the "Vite + React + TypeScript" template')
    expect(err.join('\n')).toContain('npm create vite@latest . -- --template react-ts')
    expect(out.join('\n')).toMatch(/Run #1 completed/)
    expect([...out, ...err].join('\n')).toContain('Recipe: New web app')
    expect(existsSync(join(folder, 'index.html'))).toBe(true)
    expect(await unborn(folder)).toBe(true)
    const runs = readdirSync(join(home, 'runs'), { withFileTypes: true }).filter((d) => d.isDirectory())
    expect(runs).toHaveLength(1)
    const resolved = JSON.parse(
      readFileSync(join(home, 'runs', runs[0]?.name ?? '', 'resolved.json'), 'utf8'),
    ) as {
      brief?: { input: { category: string; fields: Record<string, unknown> } }
      recipe?: { id: string }
    }
    expect(resolved.recipe?.id).toBe('new-web-app')
    expect(resolved.brief?.input.category).toBe('software')
    expect(resolved.brief?.input.fields['uiFramework']).toEqual({ choices: ['react'], source: 'user' })
  }, 180_000)

  it('--list-templates lists by category; --no-run only creates; a non-empty folder is a usage error', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const io = (out: string[]) => ({
      out: (l: string) => out.push(l),
      write: (t: string) => out.push(t),
      err: (l: string) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      env: hermeticEnv(),
      cwd: tmpdir(),
      onInterrupt: () => () => undefined,
    })
    const listed: string[] = []
    expect(await main(['new', '--list-templates', '--home', home], io(listed))).toBe(0)
    expect(listed[0]).toBe('Software:')
    expect(listed.join('\n')).toMatch(/ {2}vite-react +Vite \+ React \+ TypeScript: /)
    expect(listed.join('\n')).toContain('Data and analysis:')

    const folder = join(tempParent(), 'later')
    const created: string[] = []
    expect(
      await main(['new', folder, '--template', 'fastapi', '--no-run', '--home', home], io(created)),
    ).toBe(0)
    expect(created.join('\n')).toContain('Start the run later with:')
    expect(existsSync(join(folder, '.git'))).toBe(true)
    expect(
      existsSync(join(home, 'runs'))
        ? readdirSync(join(home, 'runs')).filter((n) => n !== 'index.jsonl')
        : [],
    ).toEqual([])

    const again: string[] = []
    expect(await main(['new', folder, '--template', 'fastapi', '--home', home], io(again))).toBe(2)
    expect(again.join('\n')).toContain('is not empty. Pick an empty or new folder.')
    expect(await main(['new', folder], io([]))).toBe(2)
  }, 120_000)
})
