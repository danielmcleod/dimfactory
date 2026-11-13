// Shared preflight engine: a DAG of PreflightCheckDef run per mode, with skip
// propagation, a spawn concurrency limit, a (id, subjectKey, inputsHash) cache and the three modes:
//  - live:          composer; cheap + io + git spawns (≤ 4, 2 s); vendor results ONLY from the launch-probe store
//  - authoritative: runs.start / a queued run acquiring its lock; everything; vendor bin/version/protocol/plan/
//                   winSandbox from the launch probe, `vendor.<v>.auth` re-run when older than 10 min (2 s budget);
//                   folder / disk / templates / config at TTL 0
//  - passBoundary:  the P1 guard before every spawn; `pass.<p>.*` only, from the stores (nothing spawns)
import { resolve as resolvePath } from 'node:path'
import type { ConfigScope, ResolvedConfig } from '../../shared/config-schema.ts'
import type { ConfigIssue, TrustGrants } from '../../shared/ipc.ts'
import type { RecipeLayer } from '../../shared/recipes.ts'
import type { BuiltinConfigErrorCode } from '../config/defaults.ts'
import type { ResolveIssue } from '../config/resolve.ts'
import type {
  CheckResult,
  CheckScope,
  CheckStatus,
  PreflightMode,
  PreflightReport,
} from '../../shared/preflight.ts'
import type { FailureCategory, RecoveryAction } from '../../shared/failure.ts'
import type { PassName } from '../../shared/run.ts'
import type { ProbeResult } from '../../shared/vendors.ts'
import type { Adapter } from '../adapters/types.ts'
import type { OsFamily } from '../heal/commands.ts'
import { osFamily } from '../heal/commands.ts'
import { resolveHome } from '../home.ts'
import { AUTH_TTL_MS, PreflightCache } from './cache.ts'
import type { CheckState, VendorSnapshot } from './cache.ts'
import { appCheckDefs } from './checks/app.ts'
import type { GitVersionResult, HomeWritableResult } from './checks/app.ts'
import { folderCheckDefs } from './checks/folder.ts'
import type { FolderGitFacts, FolderLockInfo, FolderSizeResult, GuardFn } from './checks/folder.ts'
import { passCheckDefs } from './checks/pass.ts'
import type { DepsFacts } from '../prepare/facts.ts'
import type { VerifyReadyReport } from '../prepare/readiness.ts'
import { runCheckDefs } from './checks/run.ts'
import type { VerifyFacts, WorktreeEligibilityResult } from './checks/run.ts'
import { vendorCheckDefs } from './checks/vendor.ts'
import type { GuardOwner } from './guard.ts'

export type { CheckState, VendorSnapshot } from './cache.ts'
export { authRecheckers, claudeAuthRechecker } from './checks/vendor.ts'
export type { AuthRechecker, ClaudeAuthRecheckOptions } from './checks/vendor.ts'
export type { GitVersionResult, HomeWritableResult } from './checks/app.ts'
export type {
  FolderGitFacts,
  FolderLockInfo,
  FolderSizeResult,
  GitOperation,
  GuardFn,
  GuardOptions,
  GuardResult,
} from './checks/folder.ts'
export type { VerifyCommandFact, VerifyFacts, WorktreeEligibilityResult } from './checks/run.ts'

export type CheckCost = 'cheap' | 'io' | 'spawn'

/** Who owns the folder (guard.ts GuardOwner). Owners other than `run` / `worktree` skip `folder.*` entirely. */
export type FolderOwner = GuardOwner

/** At most this many `spawn`-cost checks run at once. */
export const SPAWN_CONCURRENCY = 4
/** Live git spawns get this budget. */
export const LIVE_GIT_TIMEOUT_MS = 2000
/** Authoritative `vendor.<v>.auth` re-check budget. */
export const AUTH_RECHECK_TIMEOUT_MS = 2000

// ---- inputs / dependencies -------------------------------------------------------------------------------------

/** What is being checked. Everything is optional: no folder → no folder checks; no config → no run/pass checks. */
export interface PreflightInput {
  /** The run folder (scopeRoot). */
  folder?: string
  /** Default `run`. */
  owner?: FolderOwner
  config?: ResolvedConfig
  /** passBoundary: the pass about to spawn (other modes check every enabled pass). */
  pass?: PassName
  /** Fix resume target, forwarded to `adapter.readiness` (`pass.fix.readiness.resume`). */
  resumeSessionId?: string
  /** The Brief chooses Test-first: run.testFirst checks that Verify can show the new tests failing. */
  testFirst?: boolean
  /**
   * Research is on (core resolves its lenses): run.research names lens ids no pack defines (blocking) and the web
   * lenses left out when the Research vendor cannot search the web (`web` false; undefined before its first probe).
   */
  research?: { vendor: string; web?: boolean; unknown: string[]; offWeb: string[] }
  /**
   * The recipe the run uses (run.recipe names it). `setsAuto`: it is a project recipe and it is what turns Auto on
   * (folder.trust.recipeAuto asks for the grant bound to its id and `sha256`).
   */
  recipe?: PreflightRecipe
  /** Profile names `run.profile` accepts. Default: the built-in profiles (the config adds user/project profiles). */
  profiles?: readonly string[]
  /**
   * The config files behind `config`: `app.config.user`, `folder.project.config` and
   * `folder.trust.projectAuto` read them; a failed resolve (no `config`) is reported by run.profile / run.passes /
   * run.templates. Omitted → those checks do not run.
   */
  configFiles?: PreflightConfigFiles
  /**
   * The run's isolated copy is written from a snapshot of the folder (a match's side), not made as a git worktree: the
   * folder need not be a repository or have a commit, so the worktree checks do not apply.
   */
  snapshotCopy?: boolean
}

/** A run's recipe as preflight sees it. */
export interface PreflightRecipe {
  id: string
  label: string
  layer: RecipeLayer
  path: string
  sha256: string
  /** What it turns on and off (UI copy, shared/recipes.ts recipeSummary). */
  summary: string
  setsAuto: boolean
  /** The recipe adds verify commands (they still need the user's trust before they first run). */
  verifyCommands: number
}

/** One dimfactory.json as preflight sees it (core loads it; checks never read config files themselves). */
export interface ConfigFileState {
  scope: ConfigScope
  path: string
  exists: boolean
  /** sha256 of the file text; null when it does not exist. */
  sha256: string | null
  /** Load issues; any error leaves the file out of the resolve. */
  issues: readonly ConfigIssue[]
  /** "Restore last good" has something to restore (a last-good copy or a write backup). */
  restorable: boolean
}

export interface PreflightConfigFiles {
  user: ConfigFileState
  /** null: no project layer (no folder). A missing project file has `exists: false`. */
  project:
    | (ConfigFileState & { /** The project file is what turns Auto on for this run. */ setsAuto: boolean })
    | null
  /** The resolve failed, so `config` is undefined. */
  error?: {
    code: BuiltinConfigErrorCode
    message: string
    issues: readonly ResolveIssue[]
  }
}

/** The subset of AdapterRegistry the engine uses. */
export interface AdapterLookup {
  get(id: string): Adapter | undefined
  /** `local-<preset>` → `codex`. Default: identity. */
  resolveId?(id: string): string
  /** An Experimental vendor (Muse), never a switch the checks suggest. Default: none is. */
  isExperimental?(id: string): boolean
}

export interface PreflightDeps {
  adapters: AdapterLookup
  /** Where a folder's project memory file lives (the project root, else the repository's); default the folder. */
  memoryRoot?: (folder: string) => Promise<string>
  /** DIM_FACTORY_HOME. Default `resolveHome()`. */
  home?: string
  platform?: NodeJS.Platform
  now?: () => number
  /** Launch probe. Called by the authoritative preflight only. Default `adapter.probe({force})`. */
  probe?: (vendor: string, o: { force: boolean }) => Promise<ProbeResult>
  /**
   * Token-free auth status (`vendor.<v>.auth`, optionally `vendor.<v>.env`) within `timeoutMs`. Authoritative only.
   * Without it, the launch probe's auth result is used whatever its age.
   */
  recheckAuth?: (vendor: string, o: { timeoutMs: number }) => Promise<CheckResult[]>
  /** `git --version`. Default: proc `execCapture` with a git-sanitized env. */
  gitVersion?: (o: { timeoutMs?: number; signal?: AbortSignal }) => Promise<GitVersionResult>
  /** Default: home.ts `probeHomeWritable`. */
  homeWritable?: (home: string) => Promise<HomeWritableResult>
  /** Free bytes on the volume holding `path`, or null when unknown. Default `fs.statfs`. */
  diskFree?: (path: string) => Promise<number | null>
  /** Repo state for `folder.git` (git agent: repo.ts). Without it `folder.git` does not run. */
  gitFacts?: (folder: string, o: { timeoutMs?: number; signal?: AbortSignal }) => Promise<FolderGitFacts>
  /** Untracked size for `folder.size` (git agent: shadow size preflight). Without it `folder.size` does not run. */
  folderSize?: (folder: string, o: { timeoutMs?: number; signal?: AbortSignal }) => Promise<FolderSizeResult>
  /** The run this folder would queue behind (scheduler). Without it `folder.lock` does not run. */
  lockQuery?: (folder: string) => FolderLockInfo | null | Promise<FolderLockInfo | null>
  /**
   * `largeFolder` trust grant for the folder (trust.json; re-asked when the files or bytes double). Default: none.
   */
  hasLargeFolderGrant?: (folder: string, size: FolderSizeResult) => boolean | Promise<boolean>
  /** The folder's trust.json grants as stored. Without it every grant counts as missing. */
  trustGrants?: (folder: string) => Promise<TrustGrants>
  /**
   * `pass.<p>.extensions`: the MCP server names a vendor's own settings define for the folder (read in memory, names
   * only; core/extensions/discover.ts), or null when the vendor is not one Dim Factory reads. `complete` false: a file
   * could not be read or followed, so a name missing from the list may still exist. Without it the check only warns
   * about Pass through on a read-only pass.
   */
  extensionNames?: (
    vendor: string,
    folder: string | undefined,
  ) => Promise<{ mcp: string[]; complete: boolean } | null>
  /** Default: `isGuarded` from ./guard.ts. */
  isGuarded?: GuardFn
  /**
   * The scope root of a folder (git top level, else the folder; repo.ts `resolveScope`). `folder.guard` refuses a
   * guarded scope root too. Without it only the chosen folder is checked.
   */
  scopeRoot?: (folder: string) => Promise<string>
  /**
   * `run.branch`: `git check-ref-format --branch <name>` run in `cwd`. Default: git/branch.ts isValidBranchName.
   */
  branchNameValid?: (cwd: string, name: string) => Promise<boolean>
  /**
   * `run.verify`: the folder's enabled verify commands (bodies read now, trust against `trustGrants`, argv[0]
   * resolved) and, for an empty list, the detected ones. Default: checks/run.ts readVerifyFacts.
   */
  verifyFacts?: (folder: string, config: ResolvedConfig) => Promise<VerifyFacts>
  /**
   * `run.isolation.worktree`: whether the folder can run isolated (git/worktree.ts checkEligibility: a repository
   * with a commit, room for the worktree, the win32 path length). Without it the check does not run.
   */
  worktreeEligibility?: (
    folder: string,
    o: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<WorktreeEligibilityResult>
  /**
   * `run.deps`: the folder's install decision, the programs it needs and its `deps` trust. Default:
   * prepare/facts.ts readDepsFacts (with `trustGrants` and `scopeRoot`).
   */
  depsFacts?: (folder: string, config: ResolvedConfig) => Promise<DepsFacts>
  /**
   * `run.isolation.verifyReady` (prepare only: the folder is the worktree, owner `worktree`): each enabled verify
   * command's program resolved there. Default: prepare/readiness.ts checkVerifyReady.
   */
  verifyReady?: (folder: string, config: ResolvedConfig) => Promise<VerifyReadyReport>
}

/** Vendor results as seen by checks. Only the authoritative mode can spawn (`ensure`). */
export interface VendorAccess {
  /** The launch-probe store; never spawns. */
  latest(vendor: string): VendorSnapshot | undefined
  /**
   * Authoritative only (throws otherwise): probe when the store is empty or stale, re-run `vendor.<v>.auth` when
   * older than 10 min, store and return the result.
   */
  ensure(vendor: string): Promise<VendorSnapshot>
  /** Registry id for a configured vendor (`local-x` → `codex`). */
  resolveId(vendor: string): string
}

/** Partial result a check returns; the engine fills id/scope/at/ttl/blocking defaults. */
export interface ResultFields {
  id?: string
  status: CheckStatus
  title?: string
  detail: string
  blocking?: boolean
  category?: FailureCategory
  recovery?: RecoveryAction[]
  ttlMs?: number
}

export interface CheckContext {
  readonly mode: PreflightMode
  readonly input: PreflightInput
  readonly deps: PreflightDeps
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly os: OsFamily
  /** Absolute run folder, when given. */
  readonly folder: string | undefined
  readonly config: ResolvedConfig | undefined
  readonly vendors: VendorAccess
  readonly signal: AbortSignal | undefined
  now(): number
  /** Results of a def that already ran in this preflight (by def id). */
  resultsOf(defId: string): CheckResult[] | undefined
  /** Build a CheckResult for the current def (`id`/`title`/`ttlMs` default to the def's). */
  result(fields: ResultFields): CheckResult
}

export interface PreflightCheckDef {
  /** Def id; its results use this id or `<id>.<sub>` (vendor and readiness defs pass through their own ids). */
  id: string
  scope: CheckScope
  title: string
  /** Def ids that must finish first. Ids not selected in this preflight are ignored. */
  dependsOn: readonly string[]
  /** `skip` (default): a failed or skipped dependency turns this def into `skip`. `run`: run anyway. */
  onDependencyFailure?: 'skip' | 'run'
  cost: CheckCost
  /** Cache TTL (0 = never cached). */
  ttlMs: number
  /** TTL in the authoritative mode (default `ttlMs`); 0 for folder/disk/templates/config. */
  authoritativeTtlMs?: number
  /** Per-mode budget; on expiry the def reports `skip` ("timed out") and is not cached. */
  timeoutMs?: Partial<Record<PreflightMode, number>>
  modes: readonly PreflightMode[]
  appliesTo(ctx: CheckContext): boolean
  /** What the result is about (vendor id, folder, pass + vendor …); part of the cache key. */
  subjectKey(ctx: CheckContext): string
  /** File mtimes, config slices … ; part of the cache key. Default ''. */
  inputsHash?(ctx: CheckContext): string | Promise<string>
  run(ctx: CheckContext): Promise<CheckResult | CheckResult[]>
}

/** Builds the defs for one preflight (vendor and pass defs are per vendor / per enabled pass). */
export type CheckFactory = (input: PreflightInput) => PreflightCheckDef[]

// ---- registry ---------------------------------------------------------------------------------------------------

/**
 * The registry: app, vendor, folder, run and pass checks. With config files in the input, vendor probes wait
 * for `app.config.user`: an invalid user file says nothing reliable about which binary to probe (`vendors.<v>.path`),
 * so nothing is spawned until it is fixed.
 */
export function registryCheckDefs(input: PreflightInput): PreflightCheckDef[] {
  const gate = (d: PreflightCheckDef): PreflightCheckDef =>
    input.configFiles !== undefined ? { ...d, dependsOn: [...d.dependsOn, 'app.config.user'] } : d
  return [
    ...appCheckDefs(),
    ...vendorCheckDefs(input).map(gate),
    ...folderCheckDefs(),
    ...runCheckDefs(),
    ...passCheckDefs(input),
  ]
}

/** Reject duplicate ids and cycles (a def graph is static per input, so this is a programming error). */
export function assertDag(defs: readonly PreflightCheckDef[]): void {
  const byId = new Map<string, PreflightCheckDef>()
  for (const d of defs) {
    if (byId.has(d.id)) throw new Error(`duplicate preflight check id ${d.id}`)
    byId.set(d.id, d)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (d: PreflightCheckDef, path: string[]): void => {
    const s = state.get(d.id)
    if (s === 'done') return
    if (s === 'visiting') throw new Error(`preflight dependency cycle: ${[...path, d.id].join(' → ')}`)
    state.set(d.id, 'visiting')
    for (const dep of d.dependsOn) {
      const next = byId.get(dep)
      if (next !== undefined) visit(next, [...path, d.id])
    }
    state.set(d.id, 'done')
  }
  for (const d of defs) visit(d, [])
}

// ---- run --------------------------------------------------------------------------------------------------------

export interface RunPreflightOptions {
  cache?: PreflightCache
  /** Default {@link registryCheckDefs}. */
  checks?: CheckFactory
  /** Default {@link SPAWN_CONCURRENCY}. */
  spawnConcurrency?: number
  signal?: AbortSignal
}

type DefOutcome = { state: CheckState | 'skipped' | 'na'; results: CheckResult[] }

class Semaphore {
  #free: number
  readonly #waiting: (() => void)[] = []
  constructor(n: number) {
    this.#free = Math.max(1, n)
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--
    else await new Promise<void>((r) => this.#waiting.push(r))
    try {
      return await fn()
    } finally {
      const next = this.#waiting.shift()
      if (next !== undefined) next()
      else this.#free++
    }
  }
}

const TIMED_OUT = Symbol('timed-out')

async function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T | typeof TIMED_OUT> {
  if (ms === undefined || ms <= 0) return p
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => r(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([p, t])
  } finally {
    clearTimeout(timer)
  }
}

/** Report order within each list: app → vendor → folder → run → pass, then def order (a stable sort). */
export const SCOPE_ORDER: readonly CheckScope[] = ['app', 'vendor', 'folder', 'run', 'pass']

/**
 * blocking = fail ∧ blocking; warnings = warn, or a non-blocking fail; info = pass and skip. Each list is ordered by
 * scope (app → vendor → folder → run → pass), then def order, so the first three blockers are the Run button's
 * reasons (`runButtonReasons`) and the most basic problem comes first.
 */
export function buildReport(mode: PreflightMode, results: readonly CheckResult[]): PreflightReport {
  const blocking: CheckResult[] = []
  const warnings: CheckResult[] = []
  const info: CheckResult[] = []
  const rank = (r: CheckResult): number => {
    const i = SCOPE_ORDER.indexOf(r.scope)
    return i === -1 ? SCOPE_ORDER.length : i
  }
  const ordered = results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r)
  for (const r of ordered) {
    if (r.status === 'fail' && r.blocking) blocking.push(r)
    else if (r.status === 'warn' || r.status === 'fail') warnings.push(r)
    else info.push(r)
  }
  return { mode, ok: blocking.length === 0, blocking, warnings, info }
}

function createVendorAccess(
  mode: PreflightMode,
  deps: PreflightDeps,
  cache: PreflightCache,
  now: () => number,
): VendorAccess {
  const resolveId = (v: string): string => deps.adapters.resolveId?.(v) ?? v
  const inflight = new Map<string, Promise<VendorSnapshot>>()
  const ensureOnce = async (vendor: string): Promise<VendorSnapshot> => {
    const id = resolveId(vendor)
    let snap = cache.vendor(id)
    const authId = `vendor.${id}.auth`
    // A vendor that blocks for anything but its login is probed again (the run's "Recheck" after an install or
    // update, "I ran it → Re-check"); a healthy one keeps its launch probe (never re-run per run).
    const brokenBeyondAuth =
      snap?.checks.some((c) => c.status === 'fail' && c.blocking && c.id !== authId) === true
    let probedNow = false
    if (snap === undefined || snap.stale || brokenBeyondAuth) {
      const probe =
        deps.probe ??
        ((v: string, o: { force: boolean }): Promise<ProbeResult> => {
          const adapter = deps.adapters.get(v)
          if (adapter === undefined) return Promise.reject(new Error(`unknown vendor ${v}`))
          return adapter.probe({ force: o.force })
        })
      cache.setProbe(await probe(id, { force: snap !== undefined }))
      snap = cache.vendor(id)
      probedNow = true
    }
    if (snap === undefined) throw new Error(`no probe result for ${id}`)
    const binFailed = snap.checks.some((c) => c.id === `vendor.${id}.bin` && c.status === 'fail')
    // A failed login is re-checked every time (token-free, 2 s): the user may have just logged in.
    const authFailed = snap.checks.some((c) => c.id === authId && c.status === 'fail')
    if (
      deps.recheckAuth !== undefined &&
      !binFailed &&
      ((authFailed && !probedNow) || now() - snap.authAt >= AUTH_TTL_MS)
    ) {
      try {
        const checks = await deps.recheckAuth(id, { timeoutMs: AUTH_RECHECK_TIMEOUT_MS })
        if (checks.length > 0) cache.setAuth(id, checks, now())
      } catch {
        // Keep the probe's auth result; the run's own failure classification covers a real login problem.
      }
      snap = cache.vendor(id) ?? snap
    }
    return snap
  }
  return {
    latest: (vendor) => cache.vendor(resolveId(vendor)),
    resolveId,
    ensure(vendor) {
      if (mode !== 'authoritative') {
        return Promise.reject(
          new Error(`vendor probes run only in the authoritative preflight (mode ${mode})`),
        )
      }
      const id = resolveId(vendor)
      let p = inflight.get(id)
      if (p === undefined) {
        p = ensureOnce(id)
        inflight.set(id, p)
      }
      return p
    },
  }
}

/** Run one preflight. Never throws for a check's own failure (a crashing check becomes a `warn`). */
export async function runPreflight(
  mode: PreflightMode,
  input: PreflightInput,
  deps: PreflightDeps,
  o: RunPreflightOptions = {},
): Promise<PreflightReport> {
  const cache = o.cache ?? new PreflightCache()
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? resolveHome()
  const all = (o.checks ?? registryCheckDefs)(input)
  assertDag(all)
  const defs = all.filter((d) => d.modes.includes(mode))
  const byId = new Map(defs.map((d) => [d.id, d]))
  const vendors = createVendorAccess(mode, deps, cache, now)
  const spawnGate = new Semaphore(o.spawnConcurrency ?? SPAWN_CONCURRENCY)
  const outcomes = new Map<string, Promise<DefOutcome>>()
  const finished = new Map<string, CheckResult[]>()

  const contextFor = (def: PreflightCheckDef): CheckContext => ({
    mode,
    input,
    deps,
    home,
    platform,
    os: osFamily(platform),
    folder: input.folder !== undefined ? resolvePath(input.folder) : undefined,
    config: input.config,
    vendors,
    signal: o.signal,
    now,
    resultsOf: (id) => finished.get(id),
    result: (f) => {
      const r: CheckResult = {
        id: f.id ?? def.id,
        scope: def.scope,
        status: f.status,
        blocking: f.blocking ?? f.status === 'fail',
        title: f.title ?? def.title,
        detail: f.detail,
        recovery: f.recovery ?? [],
        at: now(),
        ttlMs: f.ttlMs ?? def.ttlMs,
      }
      if (f.category !== undefined) r.category = f.category
      return r
    },
  })

  const execute = async (def: PreflightCheckDef): Promise<DefOutcome> => {
    const ctx = contextFor(def)
    if (!def.appliesTo(ctx)) return { state: 'na', results: [] }
    const upstream = await Promise.all(
      def.dependsOn
        .map((id) => byId.get(id))
        .filter((d): d is PreflightCheckDef => d !== undefined)
        .map(async (d) => ({ id: d.id, outcome: await outcome(d) })),
    )
    const broken = upstream.find((d) => d.outcome.state === 'failed' || d.outcome.state === 'skipped')
    if (broken !== undefined && (def.onDependencyFailure ?? 'skip') === 'skip') {
      const why = upstream
        .filter((d) => d.outcome.state === 'failed' || d.outcome.state === 'skipped')
        .map((d) => d.outcome.results.find((r) => r.status === 'fail')?.title ?? d.id)
      return {
        state: 'skipped',
        results: [ctx.result({ status: 'skip', detail: `Not checked: ${why.join('; ')}`, ttlMs: 0 })],
      }
    }

    const ttl = mode === 'authoritative' ? (def.authoritativeTtlMs ?? def.ttlMs) : def.ttlMs
    const subject = def.subjectKey(ctx)
    const inputsHash = def.inputsHash !== undefined ? await def.inputsHash(ctx) : ''
    // "I ran it → Re-check": a check whose fix was handed out is re-run until it passes.
    const recheck = cache.needsRecheck(def.id, now())
    const hit = recheck ? undefined : cache.get(def.id, subject, inputsHash, now(), ttl)
    if (hit !== undefined) return { state: hit.state, results: hit.results }

    const go = async (): Promise<CheckResult[] | typeof TIMED_OUT> => {
      const r = await withTimeout(def.run(ctx), def.timeoutMs?.[mode])
      return r === TIMED_OUT ? r : Array.isArray(r) ? r : [r]
    }
    let results: CheckResult[]
    try {
      const r = def.cost === 'spawn' ? await spawnGate.use(go) : await go()
      if (r === TIMED_OUT) {
        const secs = Math.round((def.timeoutMs?.[mode] ?? 0) / 100) / 10
        return {
          state: 'skipped',
          results: [
            ctx.result({ status: 'skip', detail: `Still checking (no answer within ${secs} s).`, ttlMs: 0 }),
          ],
        }
      }
      results = r
    } catch (err) {
      return {
        state: 'ok',
        results: [
          ctx.result({
            status: 'warn',
            detail: `This check could not run: ${err instanceof Error ? err.message : String(err)}`,
            category: 'unknown',
            ttlMs: 0,
          }),
        ],
      }
    }
    const state: CheckState = results.some((r) => r.status === 'fail') ? 'failed' : 'ok'
    if (ttl > 0) cache.set(def.id, subject, inputsHash, { results, state, at: now() })
    if (recheck) cache.settleRecheck(def.id, results)
    return { state, results }
  }

  const outcome = (def: PreflightCheckDef): Promise<DefOutcome> => {
    let p = outcomes.get(def.id)
    if (p === undefined) {
      p = execute(def).then((out) => {
        finished.set(def.id, out.results)
        return out
      })
      outcomes.set(def.id, p)
    }
    return p
  }

  const ordered = await Promise.all(defs.map((d) => outcome(d)))
  return buildReport(
    mode,
    ordered.flatMap((x) => x.results),
  )
}

// ---- engine object --------------------------------------------------------------------------------------------

export interface PreflightEngine {
  readonly cache: PreflightCache
  run(mode: PreflightMode, input: PreflightInput, o?: { signal?: AbortSignal }): Promise<PreflightReport>
  /** Store a launch probe so live preflight can show it (app start, vendors.probe{force}). */
  recordProbe(result: ProbeResult): void
}

export interface CreatePreflightOptions {
  checks?: CheckFactory
  cache?: PreflightCache
  spawnConcurrency?: number
}

/** One engine per app/CLI process: shares the cache (and the vendor store) across preflights. */
export function createPreflightEngine(deps: PreflightDeps, o: CreatePreflightOptions = {}): PreflightEngine {
  const cache = o.cache ?? new PreflightCache()
  return {
    cache,
    run(mode, input, ro = {}) {
      return runPreflight(mode, input, deps, {
        cache,
        ...(o.checks !== undefined ? { checks: o.checks } : {}),
        ...(o.spawnConcurrency !== undefined ? { spawnConcurrency: o.spawnConcurrency } : {}),
        ...(ro.signal !== undefined ? { signal: ro.signal } : {}),
      })
    },
    recordProbe: (result) => cache.setProbe(result),
  }
}

/** First blocking result (R2b: step `preflight` fails with it), or undefined. */
export function firstBlocker(report: PreflightReport): CheckResult | undefined {
  return report.blocking[0]
}

/** Up to `n` one-line reasons for a disabled Run button. */
export function runButtonReasons(report: PreflightReport, n = 3): string[] {
  return report.blocking.slice(0, n).map((r) => r.title)
}
