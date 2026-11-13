// A rematch through a real core (the fake Claude for the passes): a run that ended in the folder is replayed against
// another builder, from the folder as it was when that run began, with the run's own recorded settings.
//   - side A is the original run as recorded; side B is built now in a copy of the old starting point, so what the
//     folder got since (the original's own result included) is not in it
//   - side B is never applied: no card offers it, Apply is refused, a pick is only a judgement
//   - the two results are put against each other (one in the folder's snapshots, one in the copy's)
//   - a side's changes are saved as a patch; the original run is pinned
//   - a vendor that has not run in the project is asked about first; a run that cannot be replayed says why
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunOverrides } from '../../../src/shared/config-schema.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { MATCH_TEXT, splitCompare } from '../../../src/shared/match.ts'
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

const VERSION = 'export const version = "1.0.0"\n'
const SECOND = `${VERSION}export const built = "second"\n`

const overrides: RunOverrides = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  isolation: { worktree: { install: 'never' } },
  verify: { enabled: false },
}

const ended = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled'

describe('Rematch (core + fake Claude)', () => {
  it('replays a finished run against another builder from where it began, and applies nothing', async () => {
    const sc = await makeScenario({
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: VERSION } },
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: SECOND } },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox({ git: false })
    dirs.push(home, sc.dir, folder)
    writeFileSync(join(folder, 'there-from-the-start.txt'), 'before the first run\n')
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)

    // ---- the original run, in the folder itself ----
    const first = value(await core.invoke('runs.start', { folder, task: 'add a --version flag', overrides }))
    const original = await core.controller(first.runId)?.waitFor(ended, 120_000)
    expect(original?.status, JSON.stringify(original?.notes)).toBe('completed')
    expect(readFileSync(join(folder, 'src', 'version.ts'), 'utf8')).toBe(VERSION)
    // The folder moves on.
    writeFileSync(join(folder, 'written-later.txt'), 'after the first run\n')

    // ---- can it be replayed, and against whom without asking ----
    const check = value(await core.invoke('matches.rematchCheck', { runId: first.runId }))
    expect(check.blocked).toBeUndefined()
    expect(check).toMatchObject({ displayNo: first.displayNo, task: 'add a --version flag' })
    expect(check.original?.vendor).toBe('claude')
    expect(check.knownVendors).toEqual(['claude'])
    const asked = await core.invoke('matches.rematch', {
      runId: first.runId,
      challenger: { vendor: 'codex' },
    })
    expect(asked.ok).toBe(false)
    if (!asked.ok) {
      expect(asked.error.code).toBe('CONFLICT')
      expect(asked.error.message).toBe(MATCH_TEXT.newVendor('codex'))
      expect(asked.error.details).toEqual({ newVendor: 'codex' })
    }
    expect(value(await core.invoke('matches.list'))).toEqual([])

    // ---- the rematch ----
    const m = value(
      await core.invoke('matches.rematch', {
        runId: first.runId,
        challenger: { vendor: 'claude', model: 'opus' },
      }),
    )
    expect(m.sides[0]).toEqual({ side: 'a', runId: first.runId, displayNo: first.displayNo })
    const bId = m.sides[1].runId ?? ''
    const b = await core.controller(bId)?.waitFor(ended, 120_000)
    expect(b?.status, JSON.stringify(b?.notes)).toBe('completed')
    expect(b?.matchOf).toEqual({ matchId: m.matchId, side: 'b', rematch: true })
    // Kept to be read, never offered: no card asked, and the run says why.
    expect(b?.isolation?.finalize?.state).toBe('kept')
    expect(b?.cards.map((c) => c.view.kind)).not.toContain('finalize')
    expect(b?.notes).toContain(MATCH_TEXT.notApplied)
    // Its copy is the folder as it was when the original began: none of what came after, the original's result included.
    const copy = b?.isolation?.worktree?.path ?? ''
    expect(readFileSync(join(copy, 'there-from-the-start.txt'), 'utf8')).toBe('before the first run\n')
    expect(existsSync(join(copy, 'written-later.txt'))).toBe(false)
    expect(readFileSync(join(copy, 'src', 'version.ts'), 'utf8')).toBe(SECOND)
    // The folder is untouched by it.
    expect(readFileSync(join(folder, 'src', 'version.ts'), 'utf8')).toBe(VERSION)

    const applied = await core.invoke('worktree.apply', { runId: bId })
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.error.message).toBe(MATCH_TEXT.notApplied)
    expect(readFileSync(join(folder, 'src', 'version.ts'), 'utf8')).toBe(VERSION)

    // ---- the match: the original as recorded on one side ----
    const view = value(await core.invoke('matches.get', { matchId: m.matchId }))
    expect(view).toMatchObject({
      kind: 'rematch',
      ready: true,
      ended: true,
      source: { runId: first.runId, displayNo: first.displayNo },
    })
    expect(view.sides[0]).toMatchObject({
      side: 'a',
      runId: first.runId,
      recorded: true,
      status: 'completed',
    })
    expect(view.sides[1]).toMatchObject({ side: 'b', contestant: { vendor: 'claude', model: 'opus' } })
    expect(view.sides[0].detail?.lines?.added).toBeGreaterThanOrEqual(1)
    expect(core.summary(first.runId)?.pinned).toBe(true)
    // The run's summary says it is a rematch's side (its chip, and the pages that hide Apply).
    expect(core.summary(bId)?.matchOf).toEqual({ matchId: m.matchId, side: 'b', rematch: true })

    // ---- one result against the other: the original's is in the folder's snapshots, the challenger's in its copy's ----
    const cmp = value(await core.invoke('matches.compare', { matchId: m.matchId }))
    expect(cmp.available).toEqual({ a: true, b: true, between: true })
    expect(splitCompare(cmp.files).both.map((f) => f.path)).toEqual(['src/version.ts'])
    const between = value(
      await core.invoke('matches.compareFile', { matchId: m.matchId, path: 'src/version.ts' }),
    )
    expect(between.patch).toContain('+export const built = "second"')

    // ---- a pick is a judgement; a side's changes can be saved as a patch ----
    const picked = value(await core.invoke('matches.pick', { matchId: m.matchId, side: 'b' }))
    expect(picked.match.pick).toMatchObject({ side: 'b' })
    expect(picked.match.pick?.undoToken).toBeUndefined()
    expect(picked.match.kept).toBeUndefined()
    expect(readFileSync(join(folder, 'src', 'version.ts'), 'utf8')).toBe(VERSION)
    const saved = value(await core.invoke('matches.savePatch', { matchId: m.matchId, side: 'b' }))
    expect(readFileSync(saved.path, 'utf8')).toContain('+export const built = "second"')
    expect(saved.bytes).toBeGreaterThan(20)

    // ---- a side of a match is not replayed itself ----
    const again = value(await core.invoke('matches.rematchCheck', { runId: bId }))
    expect(again.blocked).toContain('is already one side of a match')
  }, 300_000)
})
