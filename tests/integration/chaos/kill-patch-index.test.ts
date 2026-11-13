// Chaos (kill at each effect boundary; state-machine row P22, "Crash relaunch"; the runs/index.jsonl
// compaction; the relaunch orphan sweep): a recovery patch (P22) killed at each step of its write,
// the runs index killed in the middle of its compaction, and Dim Factory killed by its pid while Implement's process has
// a grandchild. Fixed here, with the patch cases as the proof: the reducer accepted a patch before resolved.json had
// it, so a kill in between lost the patch from the run's config (its retry, a Resume and a Re-run ran without it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { passArgvs } from '../run/scenario.ts'
import {
  Chaos,
  FULL_RUN,
  FULL_SPEC,
  PATCH_RUN,
  PATCH_SPEC,
  alive,
  indexEntries,
  settled,
  sleep,
  value,
  verifyRelaunch,
  version,
} from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const resolvedPatches = (home: string, runId: string): { actionId?: string; ops: unknown[] }[] =>
  (JSON.parse(readFileSync(join(home, 'runs', runId, 'resolved.json'), 'utf8')) as { patches?: [] })
    .patches ?? []

describe('chaos: a recovery patch, the index compaction and a grandchild, killed and relaunched', () => {
  for (const [what, point] of [
    ['the patch accepted, nothing written yet', 'command:config-patch#1'],
    ['the patch about to be written', 'effect:apply-patch#1'],
    ['resolved.json read, the patch not yet written', 'patch:write#1'],
    ['the patch written', 'patch:written#1'],
  ] as const) {
    it(`${what} (${point}): resolved.json holds the patch once, and Resume runs Plan with it`, async () => {
      const w = await chaos.world(PATCH_SPEC)
      const k = await chaos.child(w, PATCH_RUN, { kill: point })
      const { core, runId } = await verifyRelaunch(chaos, w, k, point, { paused: ['plan'] })
      const patches = resolvedPatches(w.home, runId)
      expect(patches).toEqual([
        expect.objectContaining({
          actionId: 'plan:default-model',
          ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
        }),
      ])
      value(await core.invoke('runs.resume', { runId }))
      const c = core.controller(runId)
      if (c === undefined) throw new Error('no controller')
      const end = await c.waitFor(settled, 180_000)
      expect(end).toMatchObject({ status: 'completed', outcome: 'clean' })
      expect(end.config.passes.plan.model).toBeNull()
      const plans = passArgvs(w.sc.entries()).filter((a) => a.includes('plan'))
      expect(plans[0]).toContain('--model')
      expect(plans.at(-1)).not.toContain('--model')
      // Loaded again, the run's config still has the patch once (no second append).
      await chaos.stop(core)
      const again = await chaos.relaunch(w)
      value(await again.core.invoke('runs.get', { runId }))
      expect(resolvedPatches(w.home, runId)).toHaveLength(1)
    }, 300_000)
  }

  it("Plan's failure recorded, its process being ended (effect:kill#1): still failed, and its fix still works", async () => {
    const w = await chaos.world(PATCH_SPEC)
    const point = 'effect:kill#1'
    const k = await chaos.child(w, PATCH_RUN, { kill: point })
    const { core, runId, snap } = await verifyRelaunch(chaos, w, k, point, { status: 'failed' })
    expect(snap.steps.plan.status).toBe('failed')
    expect(snap.summary.failure).toEqual({ step: 'plan', category: 'model_unavailable' })
    expect(resolvedPatches(w.home, runId)).toEqual([])
    value(await core.invoke('recovery.execute', { actionId: 'plan:default-model', runId }))
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(resolvedPatches(w.home, runId)).toHaveLength(1)
  }, 300_000)

  it('the runs index killed in the middle of its compaction (index:compact#1)', async () => {
    const w = await chaos.world(FULL_SPEC, { trustCheck: true })
    // 101 lines for one finished run: the run's 4th index line (its gate opening) passes 2 × live + 100.
    const phantom = {
      runId: '20260101T000000Z-0000',
      displayNo: 7,
      folder: w.folder,
      folderKey: 'phantom',
      title: 'an old run',
      status: 'completed',
      phase: 'done',
      outcome: 'clean',
      profile: 'claude-only',
      auto: false,
      isolation: 'inPlace',
      pinned: false,
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      endedAt: Date.parse('2026-01-01T00:10:00Z'),
      progress: { tokens: 0, costUsd: 0, filesChanged: 0 },
      findings: { must: 0, should: 0 },
      steps: [],
    }
    mkdirSync(join(w.home, 'runs'), { recursive: true })
    writeFileSync(
      join(w.home, 'runs', 'index.jsonl'),
      `${Array.from({ length: 101 }, () => JSON.stringify({ v: 1, op: 'put', s: phantom })).join('\n')}\n`,
    )
    const point = 'index:compact#1'
    const k = await chaos.child(
      w,
      { overrides: FULL_RUN.overrides, actions: [{ until: 'card:gate:afterPlan' }, { sleep: 3000 }] },
      { kill: point },
    )
    const { runId } = await verifyRelaunch(chaos, w, k, point, {
      status: 'waiting',
      cards: ['gate:afterPlan'],
    })
    const index = indexEntries(w.home)
    expect(index.get(phantom.runId)).toMatchObject({ status: 'completed', displayNo: 7 })
    expect(index.get(runId)).toMatchObject({ status: 'waiting', phase: 'plan-review' })
  }, 180_000)

  it("Dim Factory killed by its pid while Implement's process has a grandchild: the relaunch sweeps it", async () => {
    const w = await chaos.world(
      {
        ...FULL_SPEC,
        implement: [
          { recording: 'C08a-session-id-implement', write: version('0.1.0'), grandchildThenSleepMs: 120_000 },
        ],
      },
      { trustCheck: true },
    )
    const grandchild = (): number | undefined => {
      const e = w.sc.entries().find((x) => x.kind === 'grandchild')
      return e !== undefined ? Number(e['pid']) : undefined
    }
    const k = await chaos.child(w, FULL_RUN, { killWhen: () => grandchild() !== undefined })
    const pid = grandchild()
    expect(pid).toBeDefined()
    // The OS ends what Dim Factory started with it, but not a process its vendor detached: that one is still there.
    await sleep(500)
    expect(alive(pid ?? 0)).toBe(true)
    await verifyRelaunch(chaos, w, k, 'external', { paused: ['implement'] })
    expect(alive(pid ?? 0)).toBe(false)
  }, 180_000)
})
