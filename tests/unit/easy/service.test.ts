// Easy's core service (easy/service.ts) on fake deps and a temp home: who is asked once (a new home with no runs and
// no choice yet), the user file read defensively, an idea resolved into kind, template, folder (deduped, in the
// projects folder the user set or the Documents default, never created by resolving), estimate, limits and vendors;
// create checks the folder, saves the Brief, remembers the project and starts the run with the Easy recipe and the
// overrides layer; a change and "Continue with more" start follow-up runs; the project list groups runs by folder.
// "Make two and pick" starts the same run as two versions: who builds them, no plan check, and the match it answers.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { loadTemplates } from '@core/templates/load.ts'
import { EasyService, PROJECTS_FOLDER_NAME, homeLooksNew, readEasyUser } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { silentLogger } from '@core/log.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { MatchContestant } from '@shared/match.ts'
import { easyTwoHow } from '@shared/easy.ts'
import { twoErrorText, twoSides } from '@core/easy/two.ts'
import type { RunSummary } from '@shared/run.ts'
import { writeFileSync } from 'node:fs'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-easy-'))
  dirs.push(d)
  return d
}

function summary(
  runId: string,
  folder: string,
  createdAt: number,
  over: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId,
    displayNo: Number(runId.slice(1)),
    folder,
    folderKey: folder,
    title: 't',
    status: 'completed',
    // A finished run that has not said otherwise ended clean; a run still going has no outcome.
    ...(over.status === undefined || over.status === 'completed' ? { outcome: 'clean' as const } : {}),
    phase: 'done',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt,
    progress: { tokens: 0, costUsd: 0, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
    ...over,
  }
}

function world(
  o: {
    user?: unknown
    newHome?: boolean
    runs?: RunSummary[]
    ready?: boolean
    existing?: string[]
    /** Codex is ready too (the balanced profile). */
    codex?: boolean
    /** This process cannot start two versions. */
    noTwo?: boolean
    /** Starting two versions fails with this (a match's own words). */
    twoError?: DimFactoryError
  } = {},
) {
  const home = temp()
  const docs = join(temp(), 'Documents')
  let user: unknown = o.user ?? null
  const patches: JsonPatchOp[][] = []
  const starts: RunStartRequest[] = []
  const twos: { req: RunStartRequest; sides: readonly MatchContestant[]; hints: unknown }[] = []
  const prepared: string[] = []
  const briefs: string[] = []
  const runs = [...(o.runs ?? [])]
  const exists = new Set(o.existing ?? [])
  const deps: EasyDeps = {
    home,
    documentsDir: docs,
    newHome: o.newHome ?? true,
    log: silentLogger,
    now: () => 1000,
    readUser: () => Promise.resolve(user),
    patchUser: (ops) => {
      patches.push(ops)
      const op = ops[0]
      if (op?.op === 'add' && op.path === '/ui/experience') user = { ui: { experience: op.value } }
      return Promise.resolve()
    },
    packs: () => Promise.resolve(readBuiltinPacks().map((v) => v.pack)),
    templates: () => loadTemplates({ home }),
    readiness: () =>
      o.ready === false
        ? { claude: false, codex: false, profile: 'balanced', runnable: false }
        : o.codex === true
          ? { claude: true, codex: true, profile: 'balanced', runnable: true }
          : { claude: true, codex: false, profile: 'claude-only', runnable: true },
    toolchain: () => Promise.resolve({ node: false, python: false }),
    estimate: () =>
      Promise.resolve({
        total: {
          durationMs: { p50: 10 * 60_000, p80: 25 * 60_000 },
          costUsd: { p50: 1, p80: 3 },
          samples: 0,
          basis: 'typical',
          missingPricing: [],
        },
        steps: {},
        pFix: { value: 0.5, basis: 'prior' },
      }),
    prepareFolder: (folder) => {
      prepared.push(folder)
      return Promise.resolve(folder)
    },
    saveBrief: (folder) => {
      briefs.push(folder)
      return Promise.resolve()
    },
    startRun: (req) => {
      starts.push(req)
      return Promise.resolve({ runId: 'r9', displayNo: 9 })
    },
    ...(o.noTwo === true
      ? {}
      : {
          startTwo: (req: RunStartRequest, sides: readonly MatchContestant[], hints: unknown) => {
            twos.push({ req, sides, hints })
            if (o.twoError !== undefined) return Promise.reject(o.twoError)
            return Promise.resolve({ matchId: 'm1', runId: 'r7', displayNo: 7 })
          },
        }),
    summaries: () => runs,
    runTask: (runId) =>
      Promise.resolve(runId === 'r1' ? { task: 'Make a quiz about birds', folder: '/p/quiz' } : null),
    exists: (p) => exists.has(p),
  }
  return { svc: new EasyService(deps), home, docs, patches, starts, twos, prepared, briefs, runs }
}

describe('who is asked once', () => {
  it('a new home with no runs and no choice: asked; a choice, runs or an existing home: never', async () => {
    expect((await world().svc.state()).askWelcome).toBe(true)
    expect((await world({ newHome: false }).svc.state()).askWelcome).toBe(false)
    expect((await world({ runs: [summary('r1', '/p/a', 1)] }).svc.state()).askWelcome).toBe(false)
    expect((await world({ user: { ui: { experience: 'full' } } }).svc.state()).askWelcome).toBe(false)
  })

  it('choosing writes ui.experience to the user file', async () => {
    const t = world()
    const s = await t.svc.setExperience('easy')
    expect(t.patches).toEqual([[{ op: 'add', path: '/ui/experience', value: 'easy' }]])
    expect(s).toMatchObject({ experience: 'easy', askWelcome: false })
  })

  it('homeLooksNew: a finished first launch or a user file means an existing user', async () => {
    const dir = temp()
    const paths = { state: join(dir, 'state.json'), userConfig: join(dir, 'dimfactory.json') }
    expect(await homeLooksNew(paths)).toBe(true)
    writeFileSync(paths.state, JSON.stringify({ schemaVersion: 1, firstLaunchCompletedAt: 5 }))
    expect(await homeLooksNew(paths)).toBe(false)
    writeFileSync(paths.state, JSON.stringify({ schemaVersion: 1, firstLaunchCompletedAt: null }))
    expect(await homeLooksNew(paths)).toBe(true)
    writeFileSync(paths.userConfig, '{}')
    expect(await homeLooksNew(paths)).toBe(false)
  })

  it('reads the user file defensively, with no limits and the Documents folder by default', async () => {
    expect(
      readEasyUser({ ui: { experience: 'sideways' }, easy: { maxCostUsd: -1, maxMinutes: 12.4 } }),
    ).toEqual({
      experience: null,
      settings: {
        projectsDir: null,
        maxCostUsd: null,
        changeMaxCostUsd: null,
        maxMinutes: 12,
        skipPlanCheck: false,
      },
    })
    const t = world()
    const s = await t.svc.state()
    expect(s.settings).toEqual({
      projectsDir: null,
      maxCostUsd: null,
      changeMaxCostUsd: null,
      maxMinutes: null,
      skipPlanCheck: false,
    })
    expect(s.projectsDir).toBe(join(t.docs, PROJECTS_FOLDER_NAME))
  })
})

describe('resolve', () => {
  it('decides locally: kind, template, a free folder in the projects folder, the estimate, no limit, the vendors', async () => {
    const t = world()
    const dir = join(t.docs, PROJECTS_FOLDER_NAME)
    const r = await t.svc.resolve({ idea: 'A landing page for my bakery with a sign-up form' })
    expect(r).toMatchObject({
      kind: 'website',
      kindSource: 'words',
      template: { id: 'landing-page' },
      recipe: 'easy-design',
      folder: join(dir, 'landing-page-bakery'),
      folderName: 'landing-page-bakery',
      projectsDir: dir,
      research: true,
      limits: { maxCostUsd: null, maxMinutes: null },
      vendors: { claude: true, codex: false, ready: true },
      estimate: { durationMs: { p50: 600_000, p80: 1_500_000 }, costUsd: { p50: 1, p80: 3 } },
    })
    // Nothing is created by resolving.
    expect(t.prepared).toEqual([])
    expect(t.starts).toEqual([])
  })

  it('dedupes the folder, honours a chosen kind and the projects folder and limits from Easy settings', async () => {
    const custom = join(temp(), 'My Projects')
    const t = world({
      user: { easy: { projectsDir: custom, maxCostUsd: 5, maxMinutes: 45 } },
      existing: [join(custom, 'tip-splitter-friends')],
    })
    const r = await t.svc.resolve({ idea: 'A tip splitter my friends can use', kind: 'document' })
    expect(r).toMatchObject({
      kind: 'document',
      kindSource: 'chosen',
      template: { id: 'docs-simple' },
      recipe: 'easy-documents',
      research: false,
      folder: join(custom, 'tip-splitter-friends-2'),
      limits: { maxCostUsd: 5, maxMinutes: 45 },
    })
  })

  it('says why a toolchain template was not used, and gives no estimate when nobody can run it', async () => {
    const t = world({ ready: false })
    const r = await t.svc.resolve({ idea: 'A React app for my recipes' })
    expect(r.fallback).toEqual({
      wanted: { id: 'react-site', label: expect.any(String) as string },
      needs: 'node',
    })
    expect(r.template.id).toBe('static-site')
    expect(r.estimate).toBeNull()
    expect(r.vendors.ready).toBe(false)
  })

  it('refuses an empty idea', async () => {
    await expect(world().svc.resolve({ idea: '  ' })).rejects.toBeInstanceOf(DimFactoryError)
  })
})

describe('create, change and continue', () => {
  it('create: checks the folder, saves the Brief, remembers the project, starts the run with the recipe and overrides', async () => {
    const t = world({ user: { easy: { skipPlanCheck: true } } })
    const folder = join(t.docs, PROJECTS_FOLDER_NAME, 'bakery')
    const out = await t.svc.create({
      idea: 'A landing page for my bakery',
      kind: 'website',
      folder,
      limits: { maxCostUsd: 2, maxMinutes: null },
      consent: true,
    })
    expect(out).toEqual({ runId: 'r9', displayNo: 9, folder })
    expect(t.prepared).toEqual([folder])
    expect(t.briefs).toEqual([folder])
    const req = t.starts[0]
    expect(req?.recipe).toBe('easy-design')
    expect(req?.task.startsWith('A landing page for my bakery\n\n')).toBe(true)
    expect(req?.brief?.category).toBe('design')
    expect(req?.overrides).toMatchObject({
      profile: 'claude-only',
      auto: false,
      gates: { afterPlan: false, beforeFix: false },
      passes: { plan: { clarifyPlain: true, extensions: 'none' } },
      limits: { maxCostUsd: 2, maxMinutes: null },
    })
    // Implement and Fix run at the user's own Extensions level: Easy leaves them to it.
    expect(req?.overrides?.passes?.implement).toBeUndefined()
    expect(req?.overrides?.passes?.fix).toBeUndefined()
    t.runs.push(summary('r9', folder, 2000, { status: 'running' }))
    expect(await t.svc.project(folder)).toMatchObject({
      kind: 'website',
      consent: true,
      templateId: 'landing-page',
    })
  })

  it('two versions: one builder each when two are ready, the same one twice otherwise, nobody when none is', () => {
    expect(twoSides({ claude: true, codex: true })).toEqual([{ vendor: 'claude' }, { vendor: 'codex' }])
    expect(twoSides({ claude: true, codex: false })).toEqual([{ vendor: 'claude' }, { vendor: 'claude' }])
    expect(twoSides({ claude: false, codex: true })).toEqual([{ vendor: 'codex' }, { vendor: 'codex' }])
    expect(twoSides({ claude: false, codex: false })).toBeNull()
    expect(easyTwoHow({ claude: true, codex: true })).toBe('pair')
    expect(easyTwoHow({ claude: false, codex: true })).toBe('twice')
    expect(easyTwoHow({ claude: false, codex: false })).toBeNull()
  })

  it('create with two: the same run started as two versions, no plan check, and the match comes back', async () => {
    // The user's own setting asks for the plan check: two versions never show two plans.
    const t = world({ codex: true, user: { easy: { skipPlanCheck: false } } })
    const folder = join(t.docs, PROJECTS_FOLDER_NAME, 'bakery')
    const out = await t.svc.create({
      idea: 'A landing page for my bakery',
      kind: 'website',
      folder,
      limits: { maxCostUsd: 2, maxMinutes: null },
      consent: true,
      two: true,
    })
    expect(out).toEqual({ runId: 'r7', displayNo: 7, folder, matchId: 'm1' })
    // The project is made as for one version: the folder, its Brief, its record.
    expect(t.prepared).toEqual([folder])
    expect(t.briefs).toEqual([folder])
    expect(await t.svc.project(folder)).toMatchObject({ kind: 'website', consent: true })
    expect(t.starts).toEqual([])
    const two = t.twos[0]
    expect(two?.sides).toEqual([{ vendor: 'claude' }, { vendor: 'codex' }])
    expect(two?.req.recipe).toBe('easy-design')
    expect(two?.req.folder).toBe(folder)
    expect(two?.req.overrides).toMatchObject({
      profile: 'balanced',
      gates: { afterPlan: false, beforeFix: false },
      limits: { maxCostUsd: 2, maxMinutes: null },
    })
    // The same hints an Easy run of one version gets, so both versions are shaped alike.
    expect(two?.hints).toMatchObject({ easy: true, newProject: true, words: 'A landing page for my bakery' })
  })

  it('one version keeps the plan check the user has; two with one vendor ready is two tries of it', async () => {
    const one = world({ user: { easy: { skipPlanCheck: false } } })
    await one.svc.create({
      idea: 'A quiz about birds',
      kind: 'app',
      folder: join(one.docs, PROJECTS_FOLDER_NAME, 'quiz'),
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
    })
    expect(one.starts[0]?.overrides?.gates?.afterPlan).toBe(true)
    expect(one.twos).toEqual([])
    const t = world()
    await t.svc.create({
      idea: 'A quiz about birds',
      kind: 'app',
      folder: join(t.docs, PROJECTS_FOLDER_NAME, 'quiz'),
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
      two: true,
    })
    expect(t.twos[0]?.sides).toEqual([{ vendor: 'claude' }, { vendor: 'claude' }])
  })

  it('create with two refuses where two versions cannot be started, before making anything', async () => {
    const t = world({ noTwo: true })
    await expect(
      t.svc.create({
        idea: 'x',
        kind: 'app',
        folder: '/p/x',
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: false,
        two: true,
      }),
    ).rejects.toThrow(/two versions is not available/)
    expect(t.prepared).toEqual([])
    expect(t.starts).toEqual([])
  })

  it('a change with two: the change started as two versions of the project, no plan check', async () => {
    const t = world({ codex: true, user: { easy: { skipPlanCheck: false } } })
    const folder = join(t.docs, PROJECTS_FOLDER_NAME, 'bakery')
    const limits = { maxCostUsd: 2, maxMinutes: null }
    await t.svc.create({
      idea: 'A landing page for my bakery',
      kind: 'website',
      folder,
      limits,
      consent: true,
    })
    const out = await t.svc.change({ folder, change: 'Make the buttons bigger', limits, two: true })
    expect(out).toEqual({ runId: 'r7', displayNo: 7, folder, matchId: 'm1' })
    // Only the project's first run was started as one.
    expect(t.starts).toHaveLength(1)
    const two = t.twos[0]
    expect(two?.sides).toEqual([{ vendor: 'claude' }, { vendor: 'codex' }])
    expect(two?.req.recipe).toBe('easy-change')
    expect(two?.req.folder).toBe(folder)
    expect(two?.req.task).toMatch(/^Make the buttons bigger\n\n/)
    expect(two?.req.overrides).toMatchObject({ gates: { afterPlan: false }, limits })
    expect(two?.hints).toMatchObject({ easy: true, words: 'Make the buttons bigger' })
    // One version of a change keeps the plan check the user has.
    await t.svc.change({ folder, change: 'Make the buttons bigger', limits })
    expect(t.starts[1]?.overrides?.gates?.afterPlan).toBe(true)
    expect(t.twos).toHaveLength(1)
  })

  it('"It is not working" can be tried twice too; carrying on never is', async () => {
    const t = world()
    const limits = { maxCostUsd: null, maxMinutes: null }
    await t.svc.change({
      folder: '/p/quiz',
      change: 'The score stays at zero',
      notWorking: true,
      limits,
      two: true,
    })
    expect(t.twos[0]?.sides).toEqual([{ vendor: 'claude' }, { vendor: 'claude' }])
    expect(t.twos[0]?.req.recipe).toBe('easy-change')
    await expect(t.svc.change({ folder: '/p/quiz', continueRunId: 'r1', limits, two: true })).rejects.toThrow(
      'Carrying on makes one version.',
    )
    expect(t.twos).toHaveLength(1)
    expect(t.starts).toEqual([])
  })

  it('a reason two versions cannot start is said in Easy’s words, with its code and details kept', async () => {
    expect(twoErrorText('Side A cannot start. Claude needs you to log in.')).toBe(
      'Claude needs you to log in.',
    )
    expect(twoErrorText('Side B cannot start. Codex needs you to log in.')).toBe('Codex needs you to log in.')
    expect(twoErrorText('The match could not be started: disk full')).toBe(
      'The two versions could not be started: disk full',
    )
    expect(twoErrorText('The folder is busy.')).toBe('The folder is busy.')
    const t = world({
      twoError: new DimFactoryError('PREFLIGHT_BLOCKED', 'Side A cannot start. Claude needs you to log in.', {
        details: { blocking: [] },
      }),
    })
    const err = await t.svc
      .change({
        folder: '/p/quiz',
        change: 'Bigger buttons',
        limits: { maxCostUsd: null, maxMinutes: null },
        two: true,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DimFactoryError)
    expect(err).toMatchObject({
      code: 'PREFLIGHT_BLOCKED',
      message: 'Claude needs you to log in.',
      details: { blocking: [] },
    })
  })

  it('a change with two refuses where two versions cannot be started', async () => {
    const t = world({ noTwo: true })
    await expect(
      t.svc.change({
        folder: '/p/quiz',
        change: 'Bigger buttons',
        limits: { maxCostUsd: null, maxMinutes: null },
        two: true,
      }),
    ).rejects.toThrow(/two versions is not available/)
    expect(t.starts).toEqual([])
  })

  it('create refuses while nobody can run it, before making anything', async () => {
    const t = world({ ready: false })
    await expect(
      t.svc.create({
        idea: 'x',
        kind: 'app',
        folder: '/p/x',
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: false,
      }),
    ).rejects.toThrow(/Sign in to Claude or Codex/)
    expect(t.prepared).toEqual([])
  })

  it('a change and "Continue with more" start follow-up runs with easy-change', async () => {
    const t = world()
    await t.svc.change({
      folder: '/p/quiz',
      change: 'Bigger buttons',
      limits: { maxCostUsd: 2, maxMinutes: null },
    })
    await t.svc.change({
      folder: '/p/quiz',
      continueRunId: 'r1',
      limits: { maxCostUsd: 3, maxMinutes: null },
    })
    expect(t.starts.map((s) => s.recipe)).toEqual(['easy-change', 'easy-change'])
    expect(t.starts[0]?.task).toMatch(/^Bigger buttons\n\n/)
    expect(t.starts[1]?.task).toMatch(/Make a quiz about birds$/)
    expect(t.starts[1]?.overrides?.limits).toEqual({ maxCostUsd: 3, maxMinutes: null })
    await expect(
      t.svc.change({ folder: '/p/quiz', change: '  ', limits: { maxCostUsd: null, maxMinutes: null } }),
    ).rejects.toThrow(/Say what to change/)
    await expect(
      t.svc.change({
        folder: '/p/quiz',
        continueRunId: 'r7',
        limits: { maxCostUsd: null, maxMinutes: null },
      }),
    ).rejects.toThrow(/no longer there/)
  })
})

describe('projects', () => {
  it('every folder with runs, newest first, with its newest run and how many it has', async () => {
    const t = world({
      runs: [
        summary('r1', '/p/quiz', 100),
        summary('r2', '/p/memo', 200, { status: 'failed', outcome: 'failed' }),
        summary('r3', '/p/quiz', 300, { status: 'running' }),
      ],
    })
    const list = await t.svc.projects()
    expect(list.map((p) => [p.name, p.lastRunId, p.lastStatus, p.runs])).toEqual([
      ['quiz', 'r3', 'running', 2],
      ['memo', 'r2', 'failed', 1],
    ])
  })
})
