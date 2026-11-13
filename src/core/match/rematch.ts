// A rematch's side that is built now: the original run's own settings as it recorded them (resolved.json: the same
// pipeline, checks, Brief and recipe, never resolved again), with the side's builder on the building steps, in an
// isolated copy written from the original's starting snapshot. The original's Clarify answers and its research are
// carried over, so the side asks nothing and plans from the same inputs. Its result is never applied (MatchRef.rematch).
import { copyFile } from 'node:fs/promises'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { MATCH_BUILD_PASSES, MATCH_TEXT } from '../../shared/match.ts'
import type { MatchContestant } from '../../shared/match.ts'
import { DimFactoryError } from '../errors.ts'
import { recordedSettings } from '../rerun.ts'
import type { RerunHost } from '../rerun.ts'
import type { PlannedRun } from './service.ts'
import { initSharedSide } from './shared.ts'

/** The run folder's files that go with the carried steps. */
const CARRIED_FILES = ['clarify', 'research', 'research.json'] as const

/**
 * The recorded settings with the side's builder: Plan, Implement and Fix on its vendor, model and effort; Clarify and
 * Research off (their results are carried); an isolated copy with no branch that never applies itself.
 */
export function sideConfig(config: ResolvedConfig, c: MatchContestant): ResolvedConfig {
  const next = structuredClone(config)
  for (const p of MATCH_BUILD_PASSES) {
    const pass = next.passes[p]
    pass.vendor = c.vendor
    pass.model = c.model ?? null
    pass.effort = c.effort ?? null
  }
  next.passes.plan.clarify = false
  next.passes.plan.research = false
  next.isolation = {
    ...next.isolation,
    mode: 'worktree',
    branch: 'none',
    worktree: { ...next.isolation.worktree, autoApply: false },
  }
  return next
}

/**
 * The side checked and ready to be made (the authoritative preflight with its settings, for a copy made from a
 * snapshot). Throws what a re-run throws: NOT_FOUND, STORAGE, VALIDATION, PREFLIGHT_BLOCKED with the report.
 */
export async function planRematchSide(
  host: Pick<RerunHost, 'paths' | 'log' | 'readDoc' | 'readResolved' | 'preflight' | 'createRun'>,
  runId: string,
  c: MatchContestant,
): Promise<PlannedRun> {
  const doc = await host.readDoc(runId)
  if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
  const src = doc.state
  const rec = await recordedSettings(host, src)
  const config = sideConfig(rec.config, c)
  const report = await host.preflight(
    src.folder,
    config,
    rec.runLayer,
    rec.brief?.testFirst,
    undefined,
    rec.recipe,
    true,
  )
  if (!report.ok) {
    const first = report.blocking[0]
    throw new DimFactoryError(
      'PREFLIGHT_BLOCKED',
      first !== undefined ? `${first.title}: ${first.detail}` : 'Preflight blocked the run.',
      { details: report },
    )
  }
  return {
    create: (extra) =>
      host.createRun({
        folder: src.folder,
        task: src.task,
        config,
        report,
        resolvedMeta: rec.resolvedMeta,
        ...(rec.brief !== undefined ? { brief: rec.brief } : {}),
        ...(rec.recipe !== undefined ? { recipe: rec.recipe } : {}),
        ...(rec.depth !== undefined ? { depth: rec.depth } : {}),
        matchOf: extra.matchOf,
        copyFrom: extra.copyFrom,
        initState: (init) =>
          initSharedSide({ ...init, title: src.title }, src, { note: MATCH_TEXT.rematchNote }),
        prepare: async (_runId, run) => {
          const from = host.paths.run(src.runId)
          for (const f of CARRIED_FILES) await copyFile(from.output(f), run.output(f)).catch(() => undefined)
        },
      }),
  }
}
