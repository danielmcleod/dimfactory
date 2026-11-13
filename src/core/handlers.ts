// IPC/CLI command handlers. One table maps every command the core
// implements (runs/asks/cards/preflight/vendors; config/prompts/trust; diff.revert/undoRevert,
// diff.files/file and runs.branch through `ctx.runGit`; diff.blob/markReviewed and storage.* in
// handlers-diff-settings.ts; verify.detect in handlers-verify.ts; worktree.* in handlers-worktree.ts) to a function;
// everything else answers UNSUPPORTED. Handlers throw DimFactoryError; `dispatch` maps any throw to `{ok:false}` so the
// invoke promise never rejects.
import { guardrailSuggestions } from './guardrails/suggest.ts'
import { readProofs } from './guardrails/prove.ts'
import { readGuardrailLoosening, recordGuardrailLoosening } from './config/trust.ts'
import type { GuardrailProof, Guardrails, ProveKind } from '../shared/guardrails.ts'
import { PROVE_KINDS, loosenedBetween } from '../shared/guardrails.ts'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ConfigScope, RunOverrides } from '../shared/config-schema.ts'
import { CONFIG_SCOPES } from '../shared/config-schema.ts'
import type {
  BranchActionResult,
  Cmd,
  Commands,
  DiffFilePatch,
  DiffFiles,
  DiffSegment,
  Page,
  Req,
  Res,
  Result,
  RevertResult,
  TrustGrantInput,
} from '../shared/ipc.ts'
import { COMMAND_AREA, DIFF_SEGMENTS } from '../shared/ipc.ts'
import type { PreflightReport } from '../shared/preflight.ts'
import type { RunSnapshot, RunStatus, RunSummary } from '../shared/run.ts'
import type { BriefInput } from '../shared/brief.ts'
import { RUN_STATUSES, isAgentStep, isPassName } from '../shared/run.ts'
import { STEP_PROMPT_NAMES, isStepPromptName } from '../shared/prompt-names.ts'
import type { ProbeResult, ProbeView } from '../shared/vendors.ts'
import { isKnownVendor } from '../shared/vendors.ts'
import type { AdapterRegistry } from './adapters/registry.ts'
import { stubProbeResult } from './adapters/registry.ts'
import type { EventBus } from './bus/bus.ts'
import { isJsonPatchOp } from './config/patch.ts'
import type { ConfigService } from './config/service.ts'
import { DimFactoryError, toResult } from './errors.ts'
import { briefHandlers } from './handlers-brief.ts'
import type { BriefHost } from './handlers-brief.ts'
import { dashboardHandlers } from './handlers-dashboard.ts'
import type { DashboardDeps } from './handlers-dashboard.ts'
import { diffSettingsHandlers } from './handlers-diff-settings.ts'
import type { DiffViewHost, StorageHost } from './handlers-diff-settings.ts'
import { recoveryHandlers } from './handlers-recovery.ts'
import type { RecoveryHost } from './handlers-recovery.ts'
import { otherVerifyGrantBodies, verifyGrantBody, verifyHandlers } from './handlers-verify.ts'
import { previewGrantBody, previewHandlers } from './handlers-preview.ts'
import type { PreviewHost } from './handlers-preview.ts'
import { deployHandlers } from './handlers-deploy.ts'
import type { DeployHost } from './handlers-deploy.ts'
import { projectHandlers } from './handlers-project.ts'
import { factoryHandlers } from './handlers-factory.ts'
import type { FactoryHost } from './handlers-factory.ts'
import type { ProjectHost } from './handlers-project.ts'
import { easyHandlers } from './handlers-easy.ts'
import type { EasyHost } from './handlers-easy.ts'
import { otherPreviewGrantBodies } from './preview/trust.ts'
import { worktreeHandlers } from './handlers-worktree.ts'
import type { WorktreeHost } from './handlers-worktree.ts'
import { historyHandlers } from './handlers-history.ts'
import type { HistoryHost } from './handlers-history.ts'
import { catalogJobHandlers } from './handlers-catalog-job.ts'
import { catalogDataHandlers } from './handlers-catalog-data.ts'
import type { CatalogDataHost } from './handlers-catalog-data.ts'
import type { CatalogJobHost } from './handlers-catalog-job.ts'
import { rerunHandlers } from './handlers-rerun.ts'
import { matchHandlers } from './handlers-match.ts'
import type { MatchHost } from './handlers-match.ts'
import type { RerunFn } from './handlers-rerun.ts'
import type { HomePaths, RunTextOutput } from './home.ts'
import type { PreflightEngine } from './preflight/engine.ts'
import { readRunJson } from './store/run-store.ts'
import type { RunController, RunDoc } from './supervisor/controller.ts'
import { toRunSnapshot } from './supervisor/derive.ts'
import { withAllSteps } from './supervisor/loaded-state.ts'
import type { RunViewInputs } from './supervisor/derive.ts'
import type { RunState, UserCommand } from './supervisor/types.ts'
import { loadRecipes, resolveRecipe } from './recipes/load.ts'
import { RECIPE_ID_PATTERN } from '../shared/recipes.ts'
import {
  isPrepareOutputFile,
  isVerifyOutputFile,
  readPrepareOutput,
  readVerifyOutput,
} from './supervisor/verify-output.ts'

/** What the handlers need from the core (app-core.ts implements it). */
export interface HandlerContext {
  readonly kind: 'app' | 'cli'
  readonly readOnly: boolean
  readonly paths: HomePaths
  readonly bus: EventBus
  readonly adapters: AdapterRegistry
  readonly preflight: PreflightEngine
  now(): number
  /** runs.start: authoritative preflight, R1 (run folder + resolved.json) and the scheduler queue. */
  startRun(req: Req<'runs.start'>): Promise<Res<'runs.start'>>
  /** Live controller, loading the run from disk if needed (writable cores only). */
  controller(runId: string): Promise<RunController>
  /** The live controller if the run is loaded in this process. */
  liveController(runId: string): RunController | undefined
  /** run.json of a run (live state preferred). */
  readDoc(runId: string): Promise<RunDoc | null>
  summaries(): RunSummary[]
  summarize(state: RunState): RunSummary
  /** Live preflight for the composer (`preflight.run`). */
  livePreflight(
    folder: string,
    overrides?: RunOverrides,
    brief?: BriefInput,
    recipe?: string,
  ): Promise<PreflightReport>
  /** `depth.decide`: Quick or Thorough for a task, as runs.start would decide it. Absent: UNSUPPORTED. */
  decideDepth?(req: Req<'depth.decide'>): Promise<Res<'depth.decide'>>
  /** `task.check`: the prompt check for a task as typed (no model call). Absent: UNSUPPORTED. */
  checkTask?(req: Req<'task.check'>): Promise<Res<'task.check'>>
  /** `task.sharpen`: one read-only model call that proposes a clearer task. Absent: UNSUPPORTED. */
  sharpenTask?(req: Req<'task.sharpen'>): Promise<Res<'task.sharpen'>>
  /** `brief.detect`, `brief.save`, `brief.suggest` (handlers-brief.ts). Absent: UNSUPPORTED. */
  readonly brief?: BriefHost
  /** Config, prompts and trust: `config.*`, `prompts.*`, `trust.*`. */
  readonly config: ConfigService
  /** The frozen estimate (ETA) and the adapters' mode copy for a run's views (`runs.get`). */
  viewInputs?(state: RunState): RunViewInputs
  /** `estimates.get`, `dashboard.get`, `stats.get`, `usage.get`, `folders.recent` (handlers-dashboard.ts). */
  readonly dashboard?: DashboardDeps
  /** `recovery.execute`, `vendors.setPath`, `vendors.models`, `git.init` (handlers-recovery.ts). */
  readonly recovery?: RecoveryHost
  /** `diff.revert`, `diff.undoRevert`, `diff.files`, `diff.file`, `runs.branch` (app-core.ts). Absent: UNSUPPORTED. */
  readonly runGit?: RunGitHost
  /** `diff.blob`, `diff.markReviewed` (handlers-diff-settings.ts). Absent: UNSUPPORTED. */
  readonly diffView?: DiffViewHost
  /** `storage.usage`, `storage.clearShadow` (handlers-diff-settings.ts). Absent: UNSUPPORTED. */
  readonly storage?: StorageHost
  /** `worktree.preview/apply/undoApply/discard/undoDiscard` (handlers-worktree.ts). Absent: UNSUPPORTED. */
  readonly worktree?: WorktreeHost
  /** `runs.pin`, `runs.remove`, `runs.undoRemove` (handlers-history.ts, history.ts). Absent: UNSUPPORTED. */
  readonly history?: HistoryHost
  /** `runs.rerun` (handlers-rerun.ts, rerun.ts). Absent: UNSUPPORTED. */
  readonly rerun?: RerunFn
  /** `matches.*` (handlers-match.ts, match/service.ts). Absent: UNSUPPORTED. */
  readonly matches?: MatchHost
  /** `catalog.refreshPlan`, `catalog.refresh`, `catalog.cancel` (handlers-catalog-job.ts). Absent: UNSUPPORTED. */
  readonly catalogJobs?: CatalogJobHost
  /**
   * `catalog.get` (with the job, its diff review and the history), `catalog.apply`, `catalog.undo`,
   * `catalog.savePrice`, `catalog.setSchedule` (handlers-catalog-data.ts). Absent: catalog.get read-only, the writes
   * UNSUPPORTED.
   */
  readonly catalog?: CatalogDataHost
  /** `preview.*` (handlers-preview.ts): Run & Preview. Absent: UNSUPPORTED. */
  readonly preview?: PreviewHost
  /** `deploy.*` and `git.commit*` / `git.pr*` (handlers-deploy.ts): the Deploy helper. Absent: UNSUPPORTED. */
  readonly deploy?: DeployHost
  /** `templates.list`, `project.create` (handlers-project.ts): New project. Absent: UNSUPPORTED. */
  readonly project?: ProjectHost
  /** `queue.*` and `memory.*` (handlers-factory.ts): the factory. Absent: UNSUPPORTED. */
  readonly factory?: FactoryHost
  /** `easy.*` and `runs.limits` (handlers-easy.ts): Easy mode and run limits. Absent: UNSUPPORTED. */
  readonly easy?: EasyHost
  /** `guardrails.prove` and the Claude version `guardrails.state` compares proofs with. Absent: UNSUPPORTED. */
  readonly guardrails?: GuardrailsHost
}

/** Prove it, run by core (it needs the adapters and the catalog's cheapest model). */
export interface GuardrailsHost {
  prove(kind: ProveKind): Promise<GuardrailProof>
  /** The Claude CLI's version as last probed (null: not known); no probe is started for it. */
  claudeVersion(): string | null
}

/** Revert to S0 and the run branch's end-of-run actions: what core does for a run's folder and branch. */
export interface RunGitHost {
  /** Revert to S0 (F0 for `fix`) for `paths`, or every path the segment changed; FOLDER_BUSY while it is held. */
  revert(runId: string, req: { seg?: DiffSegment; paths?: string[] }): Promise<RevertResult>
  undoRevert(runId: string, undoToken: string): Promise<void>
  /** [Return to <prev>] / [Delete run branch] with the guards (git/branch.ts); otherwise the copyable commands. */
  branch(runId: string, action: 'return' | 'delete'): Promise<BranchActionResult>
  /** The files a diff segment changed (diff-segments.ts ends, read from the shadow). */
  files(runId: string, seg: DiffSegment): Promise<DiffFiles>
  /** One file's patch in a segment (`ignoreEol`: the viewer's "Ignore line endings"). */
  file(runId: string, seg: DiffSegment, path: string, ignoreEol: boolean): Promise<DiffFilePatch>
}

export type Handler<C extends Cmd> = (req: Req<C>) => Promise<Res<C>>
export type HandlerMap = { [C in Cmd]?: Handler<C> }

const need = (cond: unknown, message: string): void => {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const absFolder = (f: string): string => (isAbsolute(f) ? f : resolve(f))

/** `scope: 'user' | 'project'` of a config/prompts request. */
function configScopeOf(req: unknown): ConfigScope {
  const s = isObj(req) ? req['scope'] : undefined
  need(
    typeof s === 'string' && (CONFIG_SCOPES as readonly string[]).includes(s),
    'scope must be user or project',
  )
  return s as ConfigScope
}

/** The request's `folder` as an absolute path (required for project-scope requests). */
function folderOf(req: unknown, required: boolean): string | undefined {
  const f = isObj(req) ? req['folder'] : undefined
  if (f === undefined) {
    need(!required, 'folder is required')
    return undefined
  }
  need(typeof f === 'string' && f.trim() !== '', 'folder must be a path')
  return absFolder(f as string)
}

const PROMPT_NAMES: readonly string[] = [
  'plan',
  'implement',
  'review',
  'critic',
  'fix',
  'tests',
  ...STEP_PROMPT_NAMES,
  'heal',
  'catalog',
]

const SHA256_HEX = /^[0-9a-f]{64}$/

function isTrustGrantInput(v: unknown): v is TrustGrantInput {
  if (!isObj(v)) return false
  switch (v['kind']) {
    case 'vendorFolder':
      return typeof v['vendor'] === 'string' && v['vendor'] !== ''
    case 'largeFolder':
      return true
    case 'projectAuto':
      return (
        v['projectSha'] === undefined ||
        (typeof v['projectSha'] === 'string' && SHA256_HEX.test(v['projectSha']))
      )
    case 'recipeAuto':
      return (
        typeof v['recipeId'] === 'string' &&
        RECIPE_ID_PATTERN.test(v['recipeId']) &&
        (v['recipeSha'] === undefined ||
          (typeof v['recipeSha'] === 'string' && SHA256_HEX.test(v['recipeSha'])))
      )
    case 'command': {
      const c = v['command']
      return (
        isObj(c) &&
        (c['kind'] === 'verify' || c['kind'] === 'deps' || c['kind'] === 'preview') &&
        Array.isArray(c['argv']) &&
        c['argv'].length > 0 &&
        c['argv'].every((a) => typeof a === 'string') &&
        typeof c['cwdRel'] === 'string' &&
        (c['hash'] === undefined || (typeof c['hash'] === 'string' && SHA256_HEX.test(c['hash'])))
      )
    }
    default:
      return false
  }
}

function runIdOf(req: unknown): string {
  const id = isObj(req) ? req['runId'] : undefined
  need(typeof id === 'string' && id !== '', 'runId is required')
  return id as string
}

async function userCommand(ctx: HandlerContext, runId: string, cmd: UserCommand): Promise<void> {
  if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  const c = await ctx.controller(runId)
  const r = await c.command(cmd)
  if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message, { details: r.error.details })
}

// ---- vendors ------------------------------------------------------------------------------------------------------

/**
 * A vendor not in this build is never probed at launch; its view carries what its stub's probe answers (spawns
 * nothing), so the setup card and the vendor picker can offer its install command. One result per vendor, so two
 * views of it are equal.
 */
const stubProbes = new Map<string, ProbeResult>()
export function stubProbeOf(vendor: string): ProbeResult | null {
  if (!isKnownVendor(vendor)) return null
  let p = stubProbes.get(vendor)
  if (p === undefined) {
    p = stubProbeResult(vendor, Date.now())
    stubProbes.set(vendor, p)
  }
  return p
}

/** One vendor row for the renderer / CLI (health from the probe's checks). */
export function probeView(
  registry: AdapterRegistry,
  vendor: string,
  probe: ProbeResult | null,
  checking = false,
): ProbeView {
  const entry = registry.list().find((e) => e.id === vendor)
  const adapter = registry.get(vendor)
  const built = entry?.built === true
  const base = {
    vendor,
    displayName: adapter?.displayName ?? vendor,
    built,
    experimental: entry?.experimental === true,
    checking,
    versionFloor: adapter?.versionFloor || null,
    versionRecommended: adapter?.versionRecommended || null,
    testedUpTo: adapter?.testedUpTo || null,
    probe,
    candidates: probe?.binary !== undefined ? [probe.binary.path] : [],
  }
  if (!built) {
    return {
      ...base,
      probe: probe ?? stubProbeOf(vendor),
      health: 'not-built',
      healthDetail: 'Not available in this build',
    }
  }
  if (probe === null)
    return { ...base, health: 'checking', healthDetail: checking ? 'Checking…' : 'Not checked yet' }
  const failed = (check: string): boolean =>
    probe.checks.some((c) => c.id === `vendor.${vendor}.${check}` && c.status === 'fail')
  if (failed('bin')) return { ...base, health: 'not-installed', healthDetail: 'Not installed' }
  if (failed('version')) return { ...base, health: 'update-needed', healthDetail: 'Update needed' }
  if (failed('auth')) return { ...base, health: 'login-needed', healthDetail: 'Login needed' }
  if (failed('winSandbox')) return { ...base, health: 'sandbox-needed', healthDetail: 'Sandbox setup needed' }
  const blocker = probe.checks.find((c) => c.status === 'fail' && c.blocking)
  if (blocker !== undefined) return { ...base, health: 'error', healthDetail: blocker.title }
  const warn = probe.checks.find((c) => c.status === 'warn')
  if (warn !== undefined) return { ...base, health: 'warning', healthDetail: warn.title }
  return {
    ...base,
    health: 'ready',
    healthDetail: probe.version !== undefined ? `Ready · ${probe.version}` : 'Ready',
  }
}

// ---- runs.list ----------------------------------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export function filterSummaries(all: readonly RunSummary[], q: Req<'runs.list'>): Page<RunSummary> {
  const statuses = q.status !== undefined && q.status.length > 0 ? new Set<RunStatus>(q.status) : undefined
  const text = q.text?.trim().toLowerCase()
  const rows = all
    .filter((s) => q.folder === undefined || samePath(s.folder, q.folder))
    .filter((s) => statuses === undefined || statuses.has(s.status))
    .filter((s) => q.vendor === undefined || s.steps.some((st) => st.vendor === q.vendor))
    .filter((s) => text === undefined || text === '' || s.title.toLowerCase().includes(text))
    .filter((s) => q.from === undefined || s.createdAt >= q.from)
    .filter((s) => q.to === undefined || s.createdAt <= q.to)
    .sort(newestFirst)
  const limit = Math.max(1, Math.min(1000, q.limit ?? 100))
  // A keyset cursor (the last row's place in the order), so a run removed, deleted or started between two
  // pages never makes the next page skip or repeat one. A plain number is an offset (an earlier build's cursor).
  const after = q.cursor !== undefined ? parseRunsCursor(q.cursor) : undefined
  let start = 0
  if (typeof after === 'number') start = after
  else if (after !== undefined) {
    const i = rows.findIndex((s) => byPlace(after, s) < 0)
    start = i === -1 ? rows.length : i
  }
  const items = rows.slice(start, start + limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: start + limit < rows.length && last !== undefined ? runsCursor(last) : null,
  }
}

type RunsKey = Pick<RunSummary, 'createdAt' | 'displayNo'>

/** Where a row stands in runs.list's order (newest first: createdAt, then displayNo, both descending). */
function byPlace(a: RunsKey, b: RunsKey): number {
  return b.createdAt - a.createdAt || b.displayNo - a.displayNo
}

/** runs.list's order, with the run id last so equal places stay in one order. */
function newestFirst(a: RunSummary, b: RunSummary): number {
  return byPlace(a, b) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)
}

/** The cursor after a row: `k:<createdAt>:<displayNo>` (displayNo is unique in a home). */
export function runsCursor(s: RunsKey): string {
  return `k:${s.createdAt}:${s.displayNo}`
}

/** A keyset cursor's place, or an offset (a plain number); undefined for anything else (the first page). */
function parseRunsCursor(c: string): RunsKey | number | undefined {
  // createdAt is a whole millisecond from core's clock; a fraction (a hand-edited or imported summary) still reads.
  const m = /^k:(-?\d+(?:\.\d+)?):(-?\d+)$/.exec(c)
  if (m !== null) return { createdAt: Number(m[1]), displayNo: Number(m[2]) }
  return /^\d+$/.test(c) ? Number.parseInt(c, 10) : undefined
}

// ---- the table ------------------------------------------------------------------------------------------------------

/** A scope-relative path as the diff lists it: not blank, not absolute (on any OS), no `..` segment. */
function isRelativeRunPath(p: string): boolean {
  if (p.trim() === '' || isAbsolute(p) || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false
  return !p.split(/[\\/]+/).some((seg) => seg === '..')
}

export function createHandlers(ctx: HandlerContext): HandlerMap {
  /** Your own guardrails as they resolve with no folder (undefined when they cannot be read). */
  const userGuardrails = async (): Promise<Guardrails | undefined> =>
    (await ctx.config.snapshot({}).catch(() => null))?.config?.guardrails
  /** A change in Settings that loosened your guardrails goes on record in trust.json; a failed record changes nothing. */
  const noteLoosening = async (before: Guardrails): Promise<void> => {
    const after = await userGuardrails()
    if (after === undefined) return
    await recordGuardrailLoosening(loosenedBetween(before, after), {
      home: ctx.paths.home,
      now: () => ctx.now(),
    }).catch(() => undefined)
  }
  const runGit = (): RunGitHost => {
    const g = ctx.runGit
    if (g === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'Reverts and run branches are not available here.')
    return g
  }
  const snapshotOf = async (runId: string): Promise<RunSnapshot> => {
    const live = ctx.liveController(runId)
    if (live !== undefined) {
      const seq = ctx.bus.lastSeq(runId) ?? 0
      return withSummary(toRunSnapshot(live.state, seq, ctx.now(), ctx.viewInputs?.(live.state)), live.state)
    }
    const doc = await ctx.readDoc(runId)
    if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
    const lastSeq = Math.max(doc.lastSeq, ctx.bus.lastSeq(runId) ?? 0)
    return withSummary(toRunSnapshot(doc.state, lastSeq, ctx.now(), ctx.viewInputs?.(doc.state)), doc.state)
  }
  const withSummary = (snap: RunSnapshot, state: RunState): RunSnapshot => ({
    ...snap,
    summary: ctx.summarize(state),
  })

  const handlers: HandlerMap = {
    'runs.start': async (req) => {
      need(isObj(req), 'request body is required')
      need(typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(typeof req.task === 'string' && req.task.trim() !== '', 'task is required')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return ctx.startRun(req)
    },
    'runs.list': (req) => Promise.resolve(filterSummaries(ctx.summaries(), isObj(req) ? req : {})),
    'runs.get': (req) => snapshotOf(runIdOf(req)),
    'runs.events': async (req) => {
      const runId = runIdOf(req)
      if (ctx.liveController(runId) === undefined && (await ctx.readDoc(runId)) === null) {
        throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
      }
      need(typeof req.sinceSeq === 'number' && req.sinceSeq >= 0, 'sinceSeq must be a number ≥ 0')
      return ctx.bus.replay(runId, req.sinceSeq, req.limit ?? 2000)
    },
    'runs.output': async (req) => {
      const runId = runIdOf(req)
      const file = req.file
      // The pass texts, and findings.json: core's parsed findings (FindingsFile) for the Run view's reviewer cards.
      // A verify round's combined output (`verify:1` / `verify:2`, its last 256 KB). The baseline round
      // (`verify:0`) and an isolated run's dependency install (`prepare`).
      need(
        [
          'plan',
          'plan.original',
          'review',
          'critic',
          'findings',
          'research',
          'deploy',
          'acceptance',
          'explain',
        ].includes(file) ||
          isVerifyOutputFile(file) ||
          isPrepareOutputFile(file),
        `output "${file}" is not a text output`,
      )
      const doc = await ctx.readDoc(runId)
      if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
      const run = ctx.paths.run(runId)
      if (isPrepareOutputFile(file)) {
        const live = ctx.liveController(runId)?.state.outputs[file]
        try {
          const out = await readPrepareOutput(run)
          return { ...out, version: live ?? doc.state.outputs[file] ?? 1 }
        } catch {
          throw new DimFactoryError('NOT_FOUND', `Run ${runId} has no install output yet.`)
        }
      }
      if (isVerifyOutputFile(file)) {
        const live = ctx.liveController(runId)?.state.outputs[file]
        try {
          const out = await readVerifyOutput(run, file)
          return { ...out, version: live ?? doc.state.outputs[file] ?? 1 }
        } catch {
          throw new DimFactoryError('NOT_FOUND', `Run ${runId} has no ${file} output yet.`)
        }
      }
      const path = file === 'findings' ? run.findingsJson : run.output(file as RunTextOutput)
      try {
        const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
        return { text, mtime: st.mtimeMs, version: doc.state.outputs[file] ?? 1 }
      } catch {
        throw new DimFactoryError(
          'NOT_FOUND',
          file === 'findings' ? `Run ${runId} has no findings yet.` : `Run ${runId} has no ${file}.md yet.`,
        )
      }
    },
    'runs.stop': (req) => userCommand(ctx, runIdOf(req), { kind: 'stop' }),
    'runs.close': (req) => userCommand(ctx, runIdOf(req), { kind: 'close' }),
    'runs.resume': async (req) => {
      const runId = runIdOf(req)
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      const c = await ctx.controller(runId)
      const s = c.state
      // A failed prepare reruns through Resume too (runner steps rerun idempotently).
      const paused =
        Object.values(s.steps).some((st) => st.status === 'paused') || s.steps.prepare.status === 'failed'
      if (!paused) {
        // Loading the run is the resume for a run left queued or waiting on a card by an earlier process.
        if (s.status === 'queued' || s.status === 'waiting') return
        throw new DimFactoryError('CONFLICT', 'Nothing is paused.')
      }
      const r = await c.command(
        req.allowTimedOutAsk === true ? { kind: 'resume', allowTimedOutAsk: true } : { kind: 'resume' },
      )
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    'runs.retryPass': (req) => {
      need(isAgentStep(req.pass), 'pass is required')
      return userCommand(ctx, runIdOf(req), {
        kind: 'retry',
        step: req.pass,
        ...(req.strategy !== undefined ? { strategy: req.strategy } : {}),
      })
    },
    'runs.skipPass': (req) => {
      need(isAgentStep(req.pass), 'pass is required')
      return userCommand(ctx, runIdOf(req), { kind: 'skip', step: req.pass })
    },
    'runs.keepWaiting': (req) => {
      need(isAgentStep(req.pass), 'pass is required')
      return userCommand(ctx, runIdOf(req), { kind: 'keep-waiting', step: req.pass })
    },
    'runs.switchToAuto': async (req) => {
      const runId = runIdOf(req)
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      const c = await ctx.controller(runId)
      const r = await c.switchToAuto()
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message, { details: r.error.details })
    },
    'asks.answer': (req) => {
      need(typeof req.requestId === 'string', 'requestId is required')
      need(
        ['allow', 'allow-session', 'deny'].includes(req.decision),
        'decision must be allow, allow-session or deny',
      )
      return userCommand(ctx, runIdOf(req), {
        kind: 'answer',
        requestId: req.requestId,
        decision: req.decision,
        via: ctx.kind === 'cli' ? 'cli' : 'app',
        ...(req.graceMs !== undefined ? { graceMs: req.graceMs } : {}),
      })
    },
    'asks.undo': (req) => {
      need(typeof req.requestId === 'string', 'requestId is required')
      return userCommand(ctx, runIdOf(req), { kind: 'undo-deny', requestId: req.requestId })
    },
    'cards.resolve': (req) => {
      need(
        typeof req.cardId === 'string' && typeof req.choiceId === 'string',
        'cardId and choiceId are required',
      )
      return userCommand(ctx, runIdOf(req), {
        kind: 'card',
        cardId: req.cardId,
        choiceId: req.choiceId,
        ...(req.input !== undefined ? { input: req.input } : {}),
      })
    },
    // ---- revert, undo, run branch ----
    'diff.revert': (req) => {
      const runId = runIdOf(req)
      const paths = req.paths
      need(
        paths === 'all' ||
          (Array.isArray(paths) &&
            paths.length > 0 &&
            paths.every((p) => typeof p === 'string' && isRelativeRunPath(p))),
        "paths must be 'all' or a list of the run's relative file paths",
      )
      need(
        req.seg === undefined || (DIFF_SEGMENTS as readonly string[]).includes(req.seg),
        `seg must be one of ${DIFF_SEGMENTS.join(', ')}`,
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return runGit().revert(runId, {
        ...(req.seg !== undefined ? { seg: req.seg } : {}),
        ...(paths !== 'all' ? { paths } : {}),
      })
    },
    'diff.undoRevert': (req) => {
      const runId = runIdOf(req)
      need(typeof req.undoToken === 'string' && req.undoToken !== '', 'undoToken is required')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return runGit().undoRevert(runId, req.undoToken)
    },
    'diff.files': (req) => {
      const runId = runIdOf(req)
      need(
        (DIFF_SEGMENTS as readonly string[]).includes(req.seg),
        `seg must be one of ${DIFF_SEGMENTS.join(', ')}`,
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return runGit().files(runId, req.seg)
    },
    'diff.file': (req) => {
      const runId = runIdOf(req)
      need(
        (DIFF_SEGMENTS as readonly string[]).includes(req.seg),
        `seg must be one of ${DIFF_SEGMENTS.join(', ')}`,
      )
      need(typeof req.path === 'string' && isRelativeRunPath(req.path), "path must be one of the run's files")
      need(
        req.ignoreEol === undefined || typeof req.ignoreEol === 'boolean',
        'ignoreEol must be true or false',
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return runGit().file(runId, req.seg, req.path, req.ignoreEol === true)
    },
    'runs.branch': (req) => {
      const runId = runIdOf(req)
      need(req.action === 'return' || req.action === 'delete', 'action must be return or delete')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return runGit().branch(runId, req.action)
    },
    'preflight.run': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return ctx.livePreflight(folder, req.overrides, req.brief, req.recipe)
    },
    'depth.decide': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(typeof req.task === 'string', 'task is required')
      if (ctx.decideDepth === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'Choosing the depth is not available here.')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return ctx.decideDepth({ ...req, folder })
    },
    'task.check': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(typeof req.task === 'string', 'task is required')
      if (ctx.checkTask === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'The prompt check is not available here.')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return ctx.checkTask({ ...req, folder })
    },
    // One read-only call on the user's click: nothing is changed, so a read-only process may answer.
    'task.sharpen': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(typeof req.task === 'string', 'task is required')
      if (ctx.sharpenTask === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'Sharpen it is not available here.')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return ctx.sharpenTask({ ...req, folder })
    },
    'vendors.list': () => {
      const out = ctx.adapters
        .list()
        .map((e) => probeView(ctx.adapters, e.id, ctx.preflight.cache.effectiveProbe(e.id) ?? null))
      return Promise.resolve(out)
    },
    'vendors.probe': async (req) => {
      const want = isObj(req) && typeof req.vendor === 'string' ? [req.vendor] : undefined
      const entries = ctx.adapters.list().filter((e) => (want === undefined ? e.built : want.includes(e.id)))
      if (want !== undefined && entries.length === 0) {
        throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${want[0]}".`)
      }
      const force = isObj(req) && req.force === true
      return Promise.all(
        entries.map(async (e) => {
          const r = await e.adapter.probe(force ? { force: true } : {})
          ctx.preflight.recordProbe(r)
          return probeView(ctx.adapters, e.id, r)
        }),
      )
    },

    // ---- config / prompts / trust ----
    'config.resolve': async (req) => {
      const folder = folderOf(req, false)
      const overrides = isObj(req) ? req.overrides : undefined
      const recipeId = isObj(req) ? req.recipe : undefined
      // The recipe's layer (VALIDATION for an unknown id), so the composer's badges say where a value came from.
      const recipe =
        recipeId !== undefined
          ? await resolveRecipe({
              home: ctx.paths.home,
              ...(folder !== undefined ? { folder } : {}),
              id: recipeId,
            })
          : undefined
      return ctx.config.resolveView({
        ...(folder !== undefined ? { folder } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
        ...(recipe !== undefined ? { recipe } : {}),
      })
    },
    'recipes.list': (req) => {
      const folder = folderOf(req, false)
      return loadRecipes({ home: ctx.paths.home, ...(folder !== undefined ? { folder } : {}) })
    },
    'config.read': (req) => {
      const scope = configScopeOf(req)
      const folder = folderOf(req, scope === 'project')
      return ctx.config.read({ scope, ...(folder !== undefined ? { folder } : {}) })
    },
    'config.save': (req) => {
      const scope = configScopeOf(req)
      const folder = folderOf(req, scope === 'project')
      need(isObj(req.overrides), 'overrides is required')
      need(req.mode === 'row' || req.mode === 'projectDefault', 'mode must be row or projectDefault')
      if (req.mode === 'row') need(isPassName(req.pass), 'pass is required to save a row')
      return ctx.config.save({ ...req, scope, ...(folder !== undefined ? { folder } : {}) })
    },
    'config.patch': async (req) => {
      const scope = configScopeOf(req)
      const folder = folderOf(req, scope === 'project')
      need(Array.isArray(req.ops) && req.ops.every(isJsonPatchOp), 'ops must be JSON Patch operations')
      const touches = scope === 'user' && req.ops.some((o) => o.path.startsWith('/guardrails'))
      const before = touches ? await userGuardrails() : undefined
      const r = await ctx.config.patch({ scope, ...(folder !== undefined ? { folder } : {}), ops: req.ops })
      if (before !== undefined) await noteLoosening(before)
      return r
    },
    'config.restoreBackup': async (req) => {
      const scope = configScopeOf(req)
      const folder = folderOf(req, scope === 'project')
      need(typeof req.backupId === 'string' && req.backupId !== '', 'backupId is required')
      // Putting an older file back can loosen your guardrails too.
      const before = scope === 'user' ? await userGuardrails() : undefined
      const r = await ctx.config.restoreBackup({
        scope,
        ...(folder !== undefined ? { folder } : {}),
        backupId: req.backupId,
      })
      if (before !== undefined) await noteLoosening(before)
      return r
    },
    'prompts.get': (req) => {
      need(
        isObj(req) && PROMPT_NAMES.includes(String(req.name)),
        `name must be one of ${PROMPT_NAMES.join(', ')}`,
      )
      const folder = folderOf(req, false)
      return ctx.config.promptGet({ name: req.name, ...(folder !== undefined ? { folder } : {}) })
    },
    'prompts.save': (req) => {
      need(
        isObj(req) && (isPassName(req.name) || isStepPromptName(req.name)),
        `name must be a pass (plan, implement, review, critic, security, fix) or a step's prompt (${STEP_PROMPT_NAMES.join(', ')})`,
      )
      const scope = configScopeOf(req)
      const folder = folderOf(req, scope === 'project')
      need(req.text === null || typeof req.text === 'string', 'text must be a string, or null to remove it')
      return ctx.config.promptSave({
        name: req.name,
        scope,
        ...(folder !== undefined ? { folder } : {}),
        text: req.text,
      })
    },
    'guardrails.suggest': (req) => guardrailSuggestions(folderOf(req, true) as string),
    'guardrails.state': async () => ({
      proofs: await readProofs(ctx.paths.home),
      version: ctx.guardrails?.claudeVersion() ?? null,
      loosened: await readGuardrailLoosening({ home: ctx.paths.home }),
    }),
    'guardrails.prove': (req) => {
      need(
        isObj(req) && (PROVE_KINDS as readonly unknown[]).includes(req.kind),
        'kind must be a rule Prove it runs',
      )
      if (ctx.guardrails === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'Prove it runs in the app only.')
      return ctx.guardrails.prove(req.kind)
    },
    'trust.get': (req) => {
      const folder = folderOf(req, true) as string
      return ctx.config.trustGet(folder)
    },
    'trust.set': async (req) => {
      const folder = folderOf(req, true) as string
      need(isTrustGrantInput(req.grant), 'grant must be a trust grant')
      need(typeof req.trusted === 'boolean', 'trusted must be true or false')
      // A verify command's grant covers its script body, read now; the hash
      // the user was shown only guards a grant against a body that changed since.
      const input = req.grant
      let grant: TrustGrantInput = input
      let body: string | undefined
      if (input.kind === 'command') {
        const { kind, argv, cwdRel } = input.command
        grant = { kind: 'command', command: { kind, argv: [...argv], cwdRel } }
        if (kind === 'verify') {
          const { scopeRoot, grants } = await ctx.config.trustGet(folder)
          body = await verifyGrantBody(scopeRoot, input, req.trusted)
          // Untrust: the command's grants for older script bodies go too (else it reads "changed", not untrusted).
          if (!req.trusted) {
            for (const old of otherVerifyGrantBodies(grants, { argv, cwdRel }, body)) {
              await ctx.config.trustSet({
                folder,
                grant: { kind: 'command', command: { kind, argv: [...argv], cwdRel } },
                trusted: false,
                ...(old !== undefined ? { body: old } : {}),
              })
            }
          }
        } else if (kind === 'preview') {
          const { scopeRoot, grants } = await ctx.config.trustGet(folder)
          const cmd = {
            argv,
            cwdRel,
            ...(input.command.hash !== undefined ? { hash: input.command.hash } : {}),
          }
          body = await previewGrantBody(scopeRoot, cmd, req.trusted)
          if (!req.trusted) {
            for (const old of otherPreviewGrantBodies(grants, { argv, cwdRel }, body)) {
              await ctx.config.trustSet({
                folder,
                grant: { kind: 'command', command: { kind, argv: [...argv], cwdRel } },
                trusted: false,
                ...(old !== undefined ? { body: old } : {}),
              })
            }
          }
        }
      }
      return ctx.config.trustSet({
        folder,
        grant,
        trusted: req.trusted,
        ...(body !== undefined ? { body } : {}),
      })
    },
  }
  const table: HandlerMap = {
    ...handlers,
    ...dashboardHandlers(ctx),
    ...recoveryHandlers(ctx, () => table),
    ...diffSettingsHandlers(ctx),
    ...verifyHandlers(ctx),
    ...briefHandlers(ctx),
    ...worktreeHandlers(ctx),
    ...rerunHandlers(ctx),
    ...matchHandlers(ctx),
    ...historyHandlers(ctx),
    ...catalogJobHandlers(ctx),
    ...catalogDataHandlers(ctx),
    ...previewHandlers(ctx, ctx.preview),
    ...deployHandlers(ctx, ctx.deploy),
    ...projectHandlers(ctx),
    ...factoryHandlers(ctx, ctx.factory),
    ...easyHandlers(ctx),
  }
  return table
}

/** Run one command through the table; unknown or unbuilt commands answer UNKNOWN_COMMAND / UNSUPPORTED. */
export async function dispatch<C extends Cmd>(
  handlers: HandlerMap,
  cmd: C,
  req: Req<C>,
): Promise<Result<Res<C>>> {
  if (!Object.prototype.hasOwnProperty.call(COMMAND_AREA, cmd)) {
    return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${String(cmd)}".` } }
  }
  const h = handlers[cmd]
  if (h === undefined) {
    return { ok: false, error: { code: 'UNSUPPORTED', message: `${cmd} is not available in this build.` } }
  }
  return toResult(() => h(req))
}

/** The core run commands (the rest of `Commands` answers UNSUPPORTED). */
export const RUN_COMMANDS = [
  'runs.start',
  'runs.list',
  'runs.get',
  'runs.events',
  'runs.output',
  'runs.stop',
  'runs.close',
  'runs.resume',
  'runs.retryPass',
  'runs.skipPass',
  'runs.keepWaiting',
  'runs.switchToAuto',
  'asks.answer',
  'asks.undo',
  'cards.resolve',
  'preflight.run',
  'depth.decide',
  'task.check',
  'task.sharpen',
  'vendors.list',
  'vendors.probe',
] as const satisfies readonly (keyof Commands)[]

/** Config resolver, prompts and trust commands. */
export const CONFIG_COMMANDS = [
  'config.resolve',
  'config.read',
  'config.save',
  'config.patch',
  'config.restoreBackup',
  'prompts.get',
  'prompts.save',
  'guardrails.suggest',
  'guardrails.state',
  'guardrails.prove',
  'trust.get',
  'trust.set',
] as const satisfies readonly (keyof Commands)[]

/**
 * Dashboard data and estimates (handlers-dashboard.ts); recovery actions, vendor path and
 * models, git init: handlers-recovery.ts).
 */
export const DASHBOARD_COMMANDS = [
  'estimates.get',
  'dashboard.get',
  'stats.get',
  'usage.get',
  'context.report',
  'folders.recent',
  'recovery.execute',
  'vendors.setPath',
  'vendors.models',
  'git.init',
] as const satisfies readonly (keyof Commands)[]

/**
 * Revert to S0 and its undo, the run branch's end-of-run actions, and the diff segments' files
 * and patches that reconcile-restore.spec.ts reads.
 */
export const BRANCH_REVERT_COMMANDS = [
  'diff.revert',
  'diff.undoRevert',
  'runs.branch',
  'diff.files',
  'diff.file',
] as const satisfies readonly (keyof Commands)[]

/** Self-heal: `heal.diagnose` (the recovery executors run through `recovery.execute`). */
export const HEAL_COMMANDS = ['heal.diagnose'] as const satisfies readonly (keyof Commands)[]

/**
 * The Diff tab's image preview and reviewed marks; Settings → Diagnostics storage; Settings →
 * Catalog's read-only `catalog.get`, served by handlers-dashboard.ts. The main-owned `diagnostics.*` are
 * src/main/diagnostics.ts.
 */
export const DIFF_SETTINGS_COMMANDS = [
  'diff.blob',
  'diff.markReviewed',
  'storage.usage',
  'storage.clearShadow',
  'catalog.get',
] as const satisfies readonly (keyof Commands)[]

/** The Verify step: the folder's verify commands with their trust state (handlers-verify.ts). */
export const VERIFY_COMMANDS = ['verify.detect'] as const satisfies readonly (keyof Commands)[]

/** Recipes: the built-in, user and project recipe files (src/core/recipes/load.ts). */
export const RECIPE_COMMANDS = ['recipes.list'] as const satisfies readonly (keyof Commands)[]

/** The Brief (handlers-brief.ts). */
export const BRIEF_COMMANDS = [
  'brief.detect',
  'brief.save',
  'brief.suggest',
] as const satisfies readonly (keyof Commands)[]

/** Run & Preview (handlers-preview.ts); `preview.open` and `preview.smoke` are main's (src/main/preview.ts). */
export const PREVIEW_COMMANDS = [
  'preview.detect',
  'preview.start',
  'preview.trust',
  'preview.stop',
  'preview.list',
] as const satisfies readonly (keyof Commands)[]

/** The Deploy helper (handlers-deploy.ts): the report, the checklist ticks, and a finished run's commit and PR. */
export const DEPLOY_COMMANDS = [
  'deploy.inspect',
  'deploy.tick',
  'deploy.uploadFile',
  'deploy.build',
  'git.commitPreview',
  'git.commit',
  'git.prPreview',
  'git.prCreate',
] as const satisfies readonly (keyof Commands)[]

/** New project (handlers-project.ts): the templates, and creating the project's folder. */
export const PROJECT_COMMANDS = [
  'templates.list',
  'project.create',
] as const satisfies readonly (keyof Commands)[]

/** Easy mode and run limits (handlers-easy.ts). */
export const EASY_COMMANDS = [
  'easy.state',
  'easy.setExperience',
  'easy.resolve',
  'easy.create',
  'easy.change',
  'easy.changeEstimate',
  'easy.projects',
  'easy.attachCheck',
  'easy.permissions',
  'easy.permission',
  'easy.revokePermission',
  'easy.inspectFolder',
  'easy.work',
  'easy.intent',
  'easy.visual',
  'easy.visualReview',
  'easy.helperCost',
  'easy.think',
  'easy.ask',
  'easy.shareFiles',
  'easy.queue',
  'easy.queueAdd',
  'easy.queueStart',
  'easy.queuePause',
  'easy.queueRemove',
  'runs.limits',
] as const satisfies readonly (keyof Commands)[]

/** Matches (handlers-match.ts). */
export const MATCH_COMMANDS = [
  'matches.start',
  'matches.get',
  'matches.list',
  'matches.pick',
  'matches.undoPick',
  'matches.blind',
  'matches.compare',
  'matches.compareFile',
  'matches.rematch',
  'matches.rematchCheck',
  'matches.savePatch',
  'matches.scoreboard',
  'matches.batchPlan',
  'matches.batchAdd',
  'matches.offers',
  'matches.dismissOffer',
] as const satisfies readonly (keyof Commands)[]

/** The Runs history's row actions (handlers-history.ts). */
export const HISTORY_COMMANDS = [
  'runs.pin',
  'runs.remove',
  'runs.undoRemove',
] as const satisfies readonly (keyof Commands)[]

/** `runs.list` status filter values from a CLI string (`running,paused`). */
export function parseStatuses(text: string): RunStatus[] {
  const out: RunStatus[] = []
  for (const part of text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    if (!(RUN_STATUSES as readonly string[]).includes(part)) {
      throw new DimFactoryError('VALIDATION', `Unknown status "${part}". Use: ${RUN_STATUSES.join(', ')}`)
    }
    out.push(part as RunStatus)
  }
  return out
}

/** Read a run.json without loading the run (read-only cores, history). */
export async function readRunDoc(paths: HomePaths, runId: string): Promise<RunDoc | null> {
  const r = await readRunJson<RunDoc>(paths, runId, {
    validate: (doc) =>
      isObj(doc['state']) && isObj(doc['scope']) && typeof doc['runId'] === 'string'
        ? (doc as unknown as RunDoc)
        : null,
  }).catch(() => null)
  if (r === null || r.kind !== 'ok') return null
  // An earlier build's run.json has no row for steps added since: they read as unstarted.
  return {
    ...r.value,
    state: withAllSteps(r.value.state),
    lastSeq: typeof r.value.lastSeq === 'number' ? r.value.lastSeq : 0,
  }
}
