// Re-run with same config and Re-run from Fix (R14; IPC `runs.rerun`, CLI `dimf rerun`). The source's settings
// come from its resolved.json through
// ResolvedConfigZ (patches applied); the authoritative preflight re-checks trust before anything is created (blocked:
// no run folder, as runs.start); the new run is made by the same path as runs.start. Re-run from Fix carries Plan,
// Implement, Review and Critic (supervisor/rerun-state.ts), copies their artifacts and seeds the new run's shadow ref
// with the source's last result snapshot (so retention of the source never takes the carried snapshots), and starts at
// the pre-Fix boundary. A source still holding its folder's lock is cancelled (its `stopped` snapshot, R13/P25) in the
// same step the new run queues, at the head of the queue, so no other run takes the folder between them.
import { access, copyFile, cp, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ResolvedConfig, ResolvedTemplate } from '../shared/config-schema.ts'
import { ResolvedTemplateZ } from '../shared/config-schema.ts'
import type { PreparedBrief } from './brief/service.ts'
import type { BriefRecord } from './brief/brief.ts'
import type { RunStarted } from '../shared/ipc.ts'
import type { PreflightReport } from '../shared/preflight.ts'
import type { RerunSource, RunOutputFile } from '../shared/run.ts'
import type { RunDepthView } from '../shared/depth.ts'
import type { MatchRef } from '../shared/match.ts'
import { DimFactoryError } from './errors.ts'
import { withFolderLock } from './git/mutex.ts'
import { SHADOW_REF_PREFIX, assertRunRefId } from './git/shadow.ts'
import type { Shadow } from './git/shadow.ts'
import type { HomePaths, RunPaths } from './home.ts'
import type { Logger } from './log.ts'
import { rerunConfig } from './resolved-json.ts'
import type { RunController, RunDoc } from './supervisor/controller.ts'
import { initRunState } from './supervisor/machine.ts'
import {
  RERUN_TEXT,
  carriedFindings,
  defaultFindingIds,
  implementEnds,
  rerunBase,
  rerunBlocked,
  rerunFromFixUnavailable,
} from './supervisor/rerun.ts'
import { initRerunFromFix } from './supervisor/rerun-state.ts'
import type { FolderScheduler } from './supervisor/scheduler.ts'
import type { RunInit, RunState, SnapshotCopySource } from './supervisor/types.ts'
import { RecipeRecordZ } from '../shared/recipes.ts'
import type { RecipeRecord } from '../shared/recipes.ts'

/** What app-core's run creation (runs.start after its preflight, and a re-run) takes. */
export interface NewRunSpec {
  folder: string
  task: string
  /** The settings, already through ResolvedConfigZ. */
  config: ResolvedConfig
  /** The authoritative preflight that passed (its warnings go to resolved.json). */
  report: PreflightReport
  /**
   * resolved.json's `provenance`, `layerHashes` and `layers`: where the settings came from (runs.start: the files it
   * resolved; a re-run: its source's).
   */
  resolvedMeta: Record<string, unknown>
  /** A re-run: its source (resolved.json `rerunOf`). */
  rerunOf?: RerunSource
  /** The run's Brief (runs.start: checked now; a re-run: as its source recorded it). */
  brief?: PreparedBrief
  /** The recipe the run used (runs.start: the chosen one; a re-run: as its source recorded it). */
  recipe?: RecipeRecord
  /** The folder holding the project's `.dimfactory/` (Test-first's template lookup); null: none. */
  projectRoot?: string | null
  /** The new run's state from its RunInit (default initRunState; Re-run from Fix: the carried steps). */
  initState?: (init: RunInit) => RunState
  /** Before the controller exists: the files the run starts with and its shadow ref. */
  prepare?: (runId: string, run: RunPaths) => Promise<void>
  /**
   * The folder key the run's snapshots must share (Re-run from Fix: the carried snapshots' shadow). A folder whose
   * scope moved since (a `git init` above it) is refused with CONFLICT before anything is written.
   */
  folderKey?: string
  /** How deep the run goes and why (runs.start: decided now; a re-run: as its source recorded it). */
  depth?: RunDepthView
  /** A match's side: the match and the side the run builds (resolved.json `matchOf`). */
  matchOf?: MatchRef
  /** The run's isolated copy is written from this snapshot of the folder, not made as a git worktree. */
  copyFrom?: SnapshotCopySource
}

/** resolved.json `depth`: the decision a run recorded (a re-run keeps it), or undefined. */
export function recordedDepth(resolved: Record<string, unknown>): RunDepthView | undefined {
  const d = resolved['depth']
  if (typeof d !== 'object' || d === null) return undefined
  const v = d as Record<string, unknown>
  if (v['depth'] !== 'direct' && v['depth'] !== 'full') return undefined
  if (v['source'] !== 'auto' && v['source'] !== 'chosen' && v['source'] !== 'profile') return undefined
  if (typeof v['reason'] !== 'string') return undefined
  return { depth: v['depth'], source: v['source'], reason: v['reason'] }
}

/** A run app-core made (its `created` event not sent yet: the caller orders it with the source's cancel). */
export interface CreatedRun {
  runId: string
  displayNo: number
  controller: RunController
}

/** What the re-run needs from the core (app-core.ts implements it). */
export interface RerunHost {
  readonly paths: HomePaths
  readonly scheduler: FolderScheduler
  readonly log: Logger
  /** run.json of a run (the live state when loaded). */
  readDoc(runId: string): Promise<RunDoc | null>
  /** The run's controller, loading it from disk if needed. */
  controller(runId: string): Promise<RunController>
  /** resolved.json of a run; null when missing or unreadable. */
  readResolved(runId: string): Promise<Record<string, unknown> | null>
  /**
   * The authoritative preflight for `config` in `folder` (trust and the folder re-checked; `runLayer` is the source's
   * run overrides, which say whether the project file is what turns Auto on).
   */
  preflight(
    folder: string,
    config: ResolvedConfig,
    runLayer: unknown,
    testFirst?: boolean,
    /** A re-run from the start that researches again: its brief's category (Research's lenses come from its pack). */
    category?: string,
    /** The source's recipe as it recorded it (a project recipe that turned Auto on is checked for its grant again). */
    recipe?: RecipeRecord,
    /** The run's isolated copy is written from a snapshot (a match's side): the folder need not be a repository. */
    snapshotCopy?: boolean,
  ): Promise<PreflightReport>
  /** runs.start's run creation, after its preflight. */
  createRun(spec: NewRunSpec): Promise<CreatedRun>
  /** The folder's shadow when it exists for `folderKey` (never created here); null when there is none. */
  shadow(folder: string, folderKey: string): Promise<Shadow | null>
}

export interface RerunRequest {
  runId: string
  from: 'start' | 'fix'
  findingIds?: readonly string[]
}

/** Text outputs a Re-run from Fix copies from its source (runs.output serves them). */
const CARRIED_TEXT = [
  'plan',
  'plan.original',
  'review',
  'critic',
  'security',
  'research',
  'research.json',
  'acceptance',
] as const

const runNo = (s: RunState): string => `Run #${s.displayNo}`

/** The findings Fix gets: the chosen ids (default: every must and the shoulds the gate selected), in list order. */
export function chosenFindings(s: RunState, ids: readonly string[] | undefined): string[] {
  const list = carriedFindings(s)
  const known = new Set(list.map((f) => f.id))
  const want = ids ?? defaultFindingIds(s)
  const unknown = [...new Set(want.filter((id) => !known.has(id)))]
  if (unknown.length > 0) {
    throw new DimFactoryError(
      'VALIDATION',
      `${runNo(s)} has no finding ${unknown.join(', ')}. Choose from ${list.map((f) => f.id).join(', ')}.`,
    )
  }
  const set = new Set(want)
  const out = list.filter((f) => set.has(f.id)).map((f) => f.id)
  if (out.length === 0) throw new DimFactoryError('VALIDATION', RERUN_TEXT.noneChosen)
  return out
}

/** The commits of `commits` the shadow does not hold (`cat-file --batch-check`, read only). */
export async function missingCommits(shadow: Shadow, commits: readonly string[]): Promise<string[]> {
  if (commits.length === 0) return []
  const r = await shadow.git(['cat-file', '--batch-check'], {
    stdin: `${commits.map((c) => `${c}^{commit}`).join('\n')}\n`,
  })
  const lines = r.stdout.split(/\r?\n/)
  return commits.filter((c, i) => !/^[0-9a-f]+ commit \d+$/.test(lines[i] ?? ''))
}

/**
 * Re-run from Fix reads the source's Implement segment and last result snapshot from the folder's shadow; when Clear
 * snapshots (or retention) took them, Fix would have nothing to start from.
 */
async function assertCarriedSnapshots(host: RerunHost, s: RunState): Promise<void> {
  const ends = implementEnds(s)
  const base = rerunBase(s)
  const commits = [ends?.s0.commit, ends?.s1.commit, base?.commit].filter((c): c is string => c !== undefined)
  const shadow = await host.shadow(s.folder, s.folderKey)
  const missing = shadow === null ? commits : await missingCommits(shadow, commits)
  if (missing.length > 0 || ends === undefined) {
    throw new DimFactoryError(
      'CONFLICT',
      `${runNo(s)}'s snapshots were cleared, so Fix has no changes to start from. Re-run starts the whole run again.`,
    )
  }
}

/**
 * The new run's ref names the source's last result snapshot before its first snapshot (create-only, under the
 * folder's shadow mutex): its F0 then chains to it, and every carried snapshot stays reachable from the new run's own
 * ref when retention deletes the source's.
 */
export async function seedRunRef(shadow: Shadow, runId: string, commit: string): Promise<void> {
  assertRunRefId(runId)
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`not a commit id: ${commit}`)
  await withFolderLock(shadow.folderKey, async () => {
    await shadow.git([
      'update-ref',
      '-m',
      'dim-factory: carried',
      `${SHADOW_REF_PREFIX}${runId}`,
      commit,
      '0'.repeat(commit.length),
    ])
  })
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

/** A file the new run starts with (its folder is made); a source without it is skipped. */
async function copyIfThere(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
}

/**
 * Re-run from Fix's files: plan.md (and plan.original.md), review.md, critic.md, the Implement segment's saved patch
 * (`diffs/S0..S1.patch`) and verify:1's round folder, from the source's run folder.
 */
async function copyCarried(src: RunPaths, dst: RunPaths, state: RunState): Promise<void> {
  for (const f of CARRIED_TEXT) await copyIfThere(src.output(f), dst.output(f))
  await copyIfThere(src.diffPatch('S0..S1'), dst.diffPatch('S0..S1'))
  const v1: RunOutputFile = 'verify:1'
  if (state.outputs[v1] !== undefined && (await exists(src.verify(v1)))) {
    await cp(src.verify(v1), dst.verify(v1), { recursive: true })
  }
}

/** resolved.json's `provenance`, `layerHashes` and `layers` (where the settings came from), as the source wrote them. */
function resolvedMetaOf(resolved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['provenance', 'layerHashes', 'layers'] as const) {
    if (resolved[k] !== undefined) out[k] = resolved[k]
  }
  return out
}

/**
 * The Brief its source recorded (resolved.json `brief`, and Test-first's `testsTemplate`), as a re-run takes it:
 * unchanged, never checked again (the same settings). undefined when the source had none or the record is not one.
 */
export function recordedBrief(resolved: Record<string, unknown>): PreparedBrief | undefined {
  const b = resolved['brief']
  if (b === null || typeof b !== 'object') return undefined
  const r = b as Partial<BriefRecord>
  if (typeof r.text !== 'string' || typeof r.testFirst !== 'boolean') return undefined
  const t = ResolvedTemplateZ.safeParse(resolved['testsTemplate'])
  const template: ResolvedTemplate | undefined = t.success ? t.data : undefined
  return {
    record: structuredClone(b) as BriefRecord,
    text: r.text,
    testFirst: r.testFirst,
    ...(template !== undefined ? { testsTemplate: template } : {}),
  }
}

/** The recipe its source recorded (resolved.json `recipe`); undefined when it used none or the record is not one. */
export function recordedRecipe(resolved: Record<string, unknown>): RecipeRecord | undefined {
  const r = RecipeRecordZ.safeParse(resolved['recipe'])
  return r.success ? r.data : undefined
}

function runLayerOf(resolved: Record<string, unknown>): unknown {
  const layers = resolved['layers']
  return layers !== null && typeof layers === 'object'
    ? (layers as Record<string, unknown>)['run']
    : undefined
}

/** A run's settings as it recorded them (resolved.json), for a run that starts from them again. */
export interface RecordedSettings {
  config: ResolvedConfig
  brief?: PreparedBrief
  recipe?: RecipeRecord
  depth?: RunDepthView
  resolvedMeta: Record<string, unknown>
  /** The source's run overrides (the preflight reads whether the project file is what turns Auto on). */
  runLayer: unknown
}

/** `src`'s recorded settings. STORAGE when they are missing, VALIDATION when they are not valid any more. */
export async function recordedSettings(
  host: Pick<RerunHost, 'readResolved' | 'log'>,
  src: Pick<RunState, 'runId' | 'displayNo'>,
): Promise<RecordedSettings> {
  const no = `Run #${src.displayNo}`
  const resolved = await host.readResolved(src.runId)
  if (resolved === null) {
    throw new DimFactoryError(
      'STORAGE',
      `${no}'s settings (resolved.json) are missing or unreadable, so it cannot be run again.`,
    )
  }
  const cfg = rerunConfig(resolved, (index, error) =>
    host.log.warn('a recorded recovery patch no longer applies; left out', {
      runId: src.runId,
      index,
      error,
    }),
  )
  if (!cfg.ok) {
    throw new DimFactoryError(
      'VALIDATION',
      `${no}'s settings (resolved.json) are not valid, so it cannot be run again: ${cfg.message}.`,
      { details: { issues: cfg.issues } },
    )
  }
  const brief = recordedBrief(resolved)
  const recipe = recordedRecipe(resolved)
  const depth = recordedDepth(resolved)
  return {
    config: cfg.config,
    ...(brief !== undefined ? { brief } : {}),
    ...(recipe !== undefined ? { recipe } : {}),
    ...(depth !== undefined ? { depth } : {}),
    resolvedMeta: resolvedMetaOf(resolved),
    runLayer: runLayerOf(resolved),
  }
}

/** `runs.rerun`: Re-run with same config (`start`) or Re-run from Fix (`fix`) of a run. */
export async function rerunRun(host: RerunHost, req: RerunRequest): Promise<RunStarted> {
  const doc = await host.readDoc(req.runId)
  if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${req.runId} not found.`)
  // A source still holding its folder's lock (paused, failed) is loaded first: it is cancelled once the new run has
  // queued. One already stopped (its `stopped` snapshot still to land) lets the folder go on its own: the new run
  // queues as any run does.
  const holds =
    (doc.state.lock === 'held' || host.scheduler.isHolder(req.runId)) && doc.state.stop === undefined
  const sourceC = holds ? await host.controller(req.runId) : undefined
  const src = sourceC?.state ?? doc.state
  const blocked = rerunBlocked(src)
  if (blocked !== undefined) throw new DimFactoryError('CONFLICT', blocked)
  if (req.from === 'fix') {
    const why = rerunFromFixUnavailable(src)
    if (why !== undefined) throw new DimFactoryError('CONFLICT', why)
  }
  const resolved = await host.readResolved(src.runId)
  if (resolved === null) {
    throw new DimFactoryError(
      'STORAGE',
      `${runNo(src)}'s settings (resolved.json) are missing or unreadable, so it cannot be re-run.`,
    )
  }
  const cfg = rerunConfig(resolved, (index, error) =>
    host.log.warn('a recorded recovery patch no longer applies; left out', {
      runId: src.runId,
      index,
      error,
    }),
  )
  if (!cfg.ok) {
    throw new DimFactoryError(
      'VALIDATION',
      `${runNo(src)}'s settings (resolved.json) are not valid, so it cannot be re-run: ${cfg.message}.`,
      { details: { issues: cfg.issues } },
    )
  }
  const findingIds = req.from === 'fix' ? chosenFindings(src, req.findingIds) : []
  if (req.from === 'fix') await assertCarriedSnapshots(host, src)
  // The source's Brief. Re-run from Fix starts at Fix: the Tests step and its red check do not run again.
  const recorded = recordedBrief(resolved)
  // The source's recipe: the frozen config already holds its switches (it is not resolved again), and it is shown.
  const recipe = recordedRecipe(resolved)
  const brief: PreparedBrief | undefined =
    recorded !== undefined && req.from === 'fix' ? { ...recorded, testFirst: false } : recorded
  // Trust and the folder are re-checked now; blocked → no run folder (as runs.start).
  const report = await host.preflight(
    src.folder,
    cfg.config,
    runLayerOf(resolved),
    brief?.testFirst,
    req.from === 'start' ? (brief?.record.input.category ?? 'software') : undefined,
    recipe,
  )
  if (!report.ok) {
    const first = report.blocking[0]
    throw new DimFactoryError(
      'PREFLIGHT_BLOCKED',
      first !== undefined ? `${first.title}: ${first.detail}` : 'Preflight blocked the run.',
      { details: report },
    )
  }
  const rerunOf: RerunSource = { runId: src.runId, displayNo: src.displayNo, from: req.from }
  const base = rerunBase(src)
  // The source's depth: the frozen config already has its shape (Quick or Thorough); the decision is shown again.
  const depth = recordedDepth(resolved)
  const spec: NewRunSpec =
    req.from === 'fix'
      ? {
          folder: src.folder,
          task: src.task,
          config: cfg.config,
          report,
          resolvedMeta: resolvedMetaOf(resolved),
          rerunOf,
          ...(brief !== undefined ? { brief } : {}),
          ...(recipe !== undefined ? { recipe } : {}),
          ...(depth !== undefined ? { depth } : {}),
          folderKey: src.folderKey,
          initState: (init) => initRerunFromFix(src, { ...init, title: src.title }, findingIds),
          prepare: async (runId, run) => {
            await copyCarried(host.paths.run(src.runId), run, src)
            const shadow = await host.shadow(src.folder, src.folderKey)
            if (shadow !== null && base !== undefined) await seedRunRef(shadow, runId, base.commit)
          },
        }
      : {
          folder: src.folder,
          task: src.task,
          config: cfg.config,
          report,
          resolvedMeta: resolvedMetaOf(resolved),
          rerunOf,
          ...(brief !== undefined ? { brief } : {}),
          ...(recipe !== undefined ? { recipe } : {}),
          ...(depth !== undefined ? { depth } : {}),
          initState: (init) => ({
            ...initRunState({ ...init, title: src.title }),
            rerunOf: { runId: src.runId, displayNo: src.displayNo, from: 'start' },
          }),
        }
  const made = await host.createRun(spec)
  // R14 "atomically": the new run's lock request enters at the head of the queue while the source still holds the
  // folder; the source's Stop (Close run when failed) then releases it after its `stopped` snapshot, straight to the
  // new run.
  const takeOver = sourceC !== undefined && sourceC.state.stop === undefined
  if (takeOver) host.scheduler.takeOverNext(made.runId)
  await made.controller.enqueue({ t: 'created' })
  if (takeOver && sourceC !== undefined) {
    const r = await sourceC.command({ kind: sourceC.state.status === 'failed' ? 'close' : 'stop' })
    if (!r.ok) {
      host.log.warn('the re-run source could not be stopped', {
        runId: src.runId,
        rerun: made.runId,
        error: r.error.message,
      })
    }
  }
  host.log.info('re-run started', { runId: made.runId, source: src.runId, from: req.from })
  return { runId: made.runId, displayNo: made.displayNo }
}
