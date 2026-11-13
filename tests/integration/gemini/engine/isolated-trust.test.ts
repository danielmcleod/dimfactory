// Folder trust for an isolated run (Gemini "--skip-trust only with the vendorFolder grant or for
// Dim Factory-owned cwds (probe-cwd, heal)", trust.json `vendorFolder` keyed by the folder's scope; the
// worktree is a copy of the user's project under `<home>/worktrees/<runId>`, never a Dim Factory-owned
// working folder; the passBoundary preflight):
//   - the user's grant for the folder covers its isolated run: Gemini's readiness hears trustFolder:true at the pass
//     boundary and Implement starts in the worktree with trustFolder:true (the worktree has another folder key, so
//     looking the grant up by the worktree's own path would find nothing)
//   - without the grant the run is blocked before anything is created (no worktree, no Gemini process)
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import { ScriptedGemini, World, geminiPlays, value } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const PLAN = { plan: { recording: 'C06-plan-native-host' } }
const ISOLATED_GEMINI = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  passes: { implement: { vendor: 'gemini', model: null } },
  isolation: { mode: 'worktree' as const, worktree: { install: 'never' as const } },
}

const same = (a: string, b: string): boolean =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

const finished = (s: RunState): boolean =>
  s.status === 'completed' ||
  s.status === 'failed' ||
  s.status === 'cancelled' ||
  s.cards.some((c) => c.view.kind === 'finalize') ||
  s.steps.implement.status === 'failed'

describe('an isolated run on Gemini', () => {
  it("the folder's grant covers its worktree: Implement runs there with trustFolder:true", async () => {
    const gemini = new ScriptedGemini(geminiPlays([{ file: 'src/version.ts', text: 'Added --version.' }]))
    const t = await w.boot(PLAN, gemini, { trust: true })
    const { runId, c } = await w.start(t, ISOLATED_GEMINI)
    const s = await c.waitFor(finished, 180_000)

    expect(s.steps.implement.failure, JSON.stringify(s.steps.implement.failure ?? null)).toBeUndefined()
    expect(s.steps.implement).toMatchObject({ status: 'done', vendor: 'gemini' })
    const worktree = join(t.home, 'worktrees', runId)
    expect(s.isolation?.worktree?.path).toBe(worktree)
    const [impl] = gemini.starts
    expect(gemini.starts.map((x) => x.step)).toEqual(['implement'])
    expect(same(impl?.cwd ?? '', worktree), impl?.cwd).toBe(true)
    expect(impl?.trustFolder).toBe(true)
    // Every readiness asked for this run (the pass boundary included) heard the folder's grant.
    expect(gemini.readinessCalls.length).toBeGreaterThan(0)
    expect(gemini.readinessCalls.every((r) => r.need.trustFolder)).toBe(true)
    // The edit is in the worktree; the user's folder is untouched until Apply.
    expect(existsSync(join(worktree, 'src', 'version.ts'))).toBe(true)
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)
  }, 240_000)

  it('without the grant: blocked before a worktree is made or Gemini starts', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{}]))
    const t = await w.boot(PLAN, gemini)
    const r = await t.core.invoke('runs.start', {
      folder: t.folder,
      task: 'add a --version flag',
      overrides: ISOLATED_GEMINI,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    const report = value(
      await t.core.invoke('preflight.run', { folder: t.folder, overrides: ISOLATED_GEMINI }),
    )
    expect(report.blocking.find((x) => x.id === 'pass.implement.readiness.trust')).toMatchObject({
      category: 'trust_required',
    })
    expect(gemini.starts).toEqual([])
    expect(existsSync(join(t.home, 'worktrees'))).toBe(false)
  }, 120_000)
})
