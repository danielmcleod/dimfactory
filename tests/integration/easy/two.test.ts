// Easy's "Make two and pick" through a real core, real git and the fake Claude on temp folders: easy.create with `two`
// makes the project as for one version (a new repository with nothing committed), then starts a match with the names
// hidden whose two sides build in their own copies with no plan check; the project folder holds nothing of either
// until one is kept; keeping one puts its files in the project and leaves the other aside. And "Make a change" with
// `two`: the change made twice in copies of the project as it is, the project unchanged until one is kept.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { MatchView } from '../../../src/shared/match.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'

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

const FIRST = '<!doctype html><title>Knitting shop help</title><h1>Knitting shop help</h1>\n'
const SECOND = `${FIRST}<p>Second take.</p>\n`
const SUMMARY = '## What was built\nA small help guide.\n\n## How to run it\n1. Open index.html.\n'

describe('Make two and pick (core + fake Claude)', () => {
  it('a new project built twice in copies; the folder gets one version only when it is kept', async () => {
    const sc = await makeScenario({
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: FIRST } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: SECOND } },
      ],
      // Clarify and Explain take this list in turn (both run on the Plan pass's model). Clarify asks nothing here, so
      // the second version starts as soon as the first has asked; then each version's summary.
      // A version's builder names no model, so these passes run on Claude's own default.
      explainModel: null,
      explain: [
        { recording: 'C02-review-shape', text: '{"questions": []}' },
        { recording: 'C02-review-shape', text: SUMMARY },
        { recording: 'C02-review-shape', text: SUMMARY },
      ],
    })
    const { home } = await makeHome(sc)
    const root = mkdtempSync(join(tmpdir(), 'dimf-easy-two-'))
    const projects = join(root, 'Projects')
    dirs.push(home, sc.dir, root)
    const file = join(home, 'dimfactory.json')
    const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    // Clarify and Explain run on the Plan pass's model: haiku, so the fake tells them from the reviewers.
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...user,
          passes: { ...(user['passes'] as object), plan: { model: 'haiku' } },
          easy: { projectsDir: projects },
        },
        null,
        2,
      ),
    )
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    value(await core.invoke('vendors.probe', { vendor: 'claude' }))

    const idea = 'A help guide for the customers of my knitting shop'
    const resolved = value(await core.invoke('easy.resolve', { idea }))
    const started = value(
      await core.invoke('easy.create', {
        idea,
        kind: resolved.kind,
        folder: resolved.folder,
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: true,
        two: true,
      }),
    )
    const matchId = started.matchId ?? ''
    expect(matchId).not.toBe('')
    const folder = started.folder
    // The project is made as for one version: a new repository with nothing committed.
    expect(readdirSync(folder)).toContain('.git')

    // ---- the match: Easy's, names hidden, one vendor ready so two tries of it ----
    let view: MatchView = value(await core.invoke('matches.get', { matchId }))
    expect(view).toMatchObject({ kind: 'headToHead', folder })
    expect(view.blind?.revealedAt).toBeUndefined()
    expect(view.blind).toBeDefined()
    expect(view.sides.map((s) => s.contestant)).toEqual([{ vendor: 'claude' }, { vendor: 'claude' }])
    expect(view.sides[0].runId).toBe(started.runId)

    // Each side is an Easy run in its own copy, with no plan check.
    const resolvedJson = JSON.parse(
      readFileSync(join(home, 'runs', started.runId, 'resolved.json'), 'utf8'),
    ) as { config: Record<string, unknown>; matchOf?: unknown }
    expect(resolvedJson.config).toMatchObject({
      gates: { afterPlan: false },
      isolation: { mode: 'worktree', branch: 'none', worktree: { autoApply: false } },
      passes: { plan: { clarifyPlain: true }, implement: { vendor: 'claude' } },
    })
    expect(resolvedJson.matchOf).toEqual({ matchId, side: 'a' })

    // ---- both build; the folder holds nothing of either ----
    const describeSides = (): string => {
      const out: string[] = []
      for (const s of view.sides) {
        if (s.runId === undefined) {
          out.push(`${s.side}: no run (${s.notStarted ?? 'waiting'})`)
          continue
        }
        const st = core.controller(s.runId)?.state
        out.push(
          `${s.side}: ${s.status ?? '?'} ${s.outcome ?? ''} copy=${s.copyState ?? '-'} notes=${JSON.stringify(st?.notes ?? [])} failure=${JSON.stringify(st?.failure ?? null)}`,
        )
      }
      return out.join('\n')
    }
    for (let i = 0; i < 900 && !view.ready; i++) {
      await new Promise((r) => setTimeout(r, 200))
      view = value(await core.invoke('matches.get', { matchId }))
      if (view.sides.some((s) => s.status === 'failed')) break
    }
    expect(view.ready, describeSides()).toBe(true)
    expect(
      view.sides.map((s) => [s.copyState, s.notApplied]),
      describeSides(),
    ).toEqual([
      ['pending', true],
      ['pending', true],
    ])
    expect(existsSync(join(folder, 'index.html'))).toBe(false)

    // ---- keep one: its files are the project's; the other is left aside ----
    const picked = value(await core.invoke('matches.pick', { matchId, side: 'b' }))
    expect(picked.conflicts).toEqual([])
    expect(picked.match).toMatchObject({ kept: 'b', pick: { side: 'b' } })
    expect(picked.match.blind?.revealedAt).toBeDefined()
    const made = readFileSync(join(folder, 'index.html'), 'utf8')
    expect([FIRST, SECOND]).toContain(made)
    const [a, b] = picked.match.sides
    expect(core.summary(b.runId ?? '')?.worktree).toMatchObject({ state: 'applied' })
    // The side that was not kept keeps its copy for later and holds nothing in the folder.
    for (let i = 0; i < 100 && core.summary(a.runId ?? '')?.endedAt === undefined; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(core.summary(a.runId ?? '')?.worktree).toEqual({ state: 'kept', notApplied: true })

    // The project is Easy's, and its list leads to it.
    const list = value(await core.invoke('easy.projects'))
    expect(list[0]).toMatchObject({ folder, kind: resolved.kind })
  }, 300_000)

  it('a change made twice: the project stays as it is until one version of the change is kept', async () => {
    const CHANGED_A = `${FIRST}<p>Returns within 30 days.</p>\n`
    const CHANGED_B = `${FIRST}<p>You can send it back within a month.</p>\n`
    // Clarify asks nothing; every read-only pass on the default model gets the same answer, so it does not matter which
    // of the runs takes which (a version's summary is then that text, which is fine here).
    const quiet = { recording: 'C02-review-shape', text: '{"questions": []}' }
    const plan = { recording: 'C06-plan-native-host' }
    const sc = await makeScenario({
      plan: [plan, plan, plan],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: FIRST } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: CHANGED_A } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: CHANGED_B } },
      ],
      // The project's own run asks on the Plan pass's model (haiku, below); a version's builder names no model.
      clarify: [quiet],
      explainModel: null,
      explain: [quiet, quiet, quiet],
    })
    const { home } = await makeHome(sc)
    const root = mkdtempSync(join(tmpdir(), 'dimf-easy-two-'))
    const projects = join(root, 'Projects')
    dirs.push(home, sc.dir, root)
    const file = join(home, 'dimfactory.json')
    const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...user,
          passes: { ...(user['passes'] as object), plan: { model: 'haiku' } },
          // The project's own first run is not stopped at its plan.
          easy: { projectsDir: projects, skipPlanCheck: true },
        },
        null,
        2,
      ),
    )
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    value(await core.invoke('vendors.probe', { vendor: 'claude' }))
    const limits = { maxCostUsd: null, maxMinutes: null }
    const ended = (st: { status: string }): boolean =>
      st.status === 'completed' || st.status === 'failed' || st.status === 'cancelled'

    // ---- the project, made once, in its folder ----
    const idea = 'A help guide for the customers of my knitting shop'
    const resolved = value(await core.invoke('easy.resolve', { idea }))
    const made = value(
      await core.invoke('easy.create', {
        idea,
        kind: resolved.kind,
        folder: resolved.folder,
        limits,
        consent: true,
      }),
    )
    expect(made.matchId).toBeUndefined()
    const first = await core.controller(made.runId)?.waitFor(ended, 120_000)
    expect(first?.status, JSON.stringify(first?.failure ?? first?.notes)).toBe('completed')
    const folder = made.folder
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toBe(FIRST)

    // ---- the change, twice ----
    const started = value(
      await core.invoke('easy.change', { folder, change: 'Add a line about returns', limits, two: true }),
    )
    const matchId = started.matchId ?? ''
    expect(matchId).not.toBe('')
    let view: MatchView = value(await core.invoke('matches.get', { matchId }))
    expect(view).toMatchObject({ kind: 'headToHead', folder })
    expect(view.blind).toBeDefined()
    expect(view.task).toMatch(/^Add a line about returns/)
    const resolvedJson = JSON.parse(
      readFileSync(join(home, 'runs', started.runId, 'resolved.json'), 'utf8'),
    ) as { config: Record<string, unknown>; recipe?: { id?: string } }
    expect(resolvedJson.recipe?.id).toBe('easy-change')
    expect(resolvedJson.config).toMatchObject({
      gates: { afterPlan: false },
      isolation: { mode: 'worktree', worktree: { autoApply: false } },
    })
    const describeSides = (): string =>
      view.sides
        .map((sd) => {
          const st = sd.runId !== undefined ? core.controller(sd.runId)?.state : undefined
          return `${sd.side}: ${sd.status ?? sd.notStarted ?? '?'} copy=${sd.copyState ?? '-'} failure=${JSON.stringify(st?.failure ?? null)}`
        })
        .join('\n')
    for (let i = 0; i < 900 && !view.ready; i++) {
      await new Promise((r) => setTimeout(r, 200))
      view = value(await core.invoke('matches.get', { matchId }))
      if (view.sides.some((sd) => sd.status === 'failed')) break
    }
    expect(view.ready, describeSides()).toBe(true)
    expect(
      view.sides.map((sd) => [sd.copyState, sd.notApplied]),
      describeSides(),
    ).toEqual([
      ['pending', true],
      ['pending', true],
    ])
    // The project is as it was: neither version of the change is in it.
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toBe(FIRST)

    // ---- keep one ----
    const picked = value(await core.invoke('matches.pick', { matchId, side: 'a' }))
    expect(picked.conflicts).toEqual([])
    expect(picked.match.kept).toBe('a')
    expect([CHANGED_A, CHANGED_B]).toContain(readFileSync(join(folder, 'index.html'), 'utf8'))
  }, 300_000)
})
