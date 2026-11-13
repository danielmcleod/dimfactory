// `recovery.execute` (recovery actions and their executors). Core is the authority: an action runs only
// when it is found, by id, where the UI got it — a run's open snags (with their AI diagnosis) and open cards (runId),
// the folder's latest preflight report (folder), or the app/vendor-scope checks (the launch-probe store and the latest
// report). Run-level kinds go through the run's commands (runs.retryPass / skipPass / close / resume, and the
// controller's P22 config patch, heal and wait). Core never touches the clipboard or a browser: shell_copy answers the
// text to copy and open_docs the checked URL, and the host does the rest (src/main/recovery-host.ts; the CLI prints
// them). config_patch runs the config_patch allowlist before anything else; switch_vendor checks readiness again at
// the click; grant writes trust.json. vendor_setup runs the Codex Windows sandbox setup (unelevated only) on the click,
// re-probes the vendor, and retries a failed pass once the sandbox reads ready (recovery/vendor-setup.ts). The
// vendorFolder grant (Gemini) writes trust.json, then forces the readiness re-check (trust_required "grant → retry").
import type { ConfigScope } from '../../shared/config-schema.ts'
import { RUN_OVERRIDE_KEYS } from '../../shared/config-schema.ts'
import type {
  HealView,
  JsonPatchOp,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryActionOf,
  RetryStrategy,
} from '../../shared/failure.ts'
import { RECOVERY_ACTION_KINDS } from '../../shared/failure.ts'
import { allowedExternalUrl } from '../../shared/external-links.ts'
import type { ConfigPatchPersisted, RecoveryResult, TrustGrantInput } from '../../shared/ipc.ts'
import type { CheckResult } from '../../shared/preflight.ts'
import type { AgentStep, PassName, StepKey, WaitView } from '../../shared/run.ts'
import { PASS_NAMES, isAgentStep } from '../../shared/run.ts'
import { isKnownVendor, needsFolderTrust } from '../../shared/vendors.ts'
import { VENDOR_DISPLAY_NAMES } from '../adapters/registry.ts'
import { DimFactoryError } from '../errors.ts'
import { CHOICE, stepLabel } from '../supervisor/cards.ts'
import type { RunState } from '../supervisor/types.ts'
import { checkRecoveryOps } from './config-patch.ts'
import type { VendorArgsCheck } from './config-patch.ts'
import { settingsHref, suggestedFolder } from './routes.ts'
import type { CheckFacts, FolderPasses, RecoveryActionStore } from './store.ts'
import { notReadyReason } from './switch-vendor.ts'
import type { VendorReadiness } from './switch-vendor.ts'
import { runVendorSetup, setupMessage, setupResult } from './vendor-setup.ts'
import type { SetupsInFlight, VendorSetupHost } from './vendor-setup.ts'

export const STALE_ACTION_MESSAGE = 'This fix is no longer available; re-check.'
export const LATER_VERSION_MESSAGE = 'Available in a later version'

/** Where an action was found. */
export type ActionSource =
  | { kind: 'snag'; runId: string; step: StepKey }
  | { kind: 'card'; runId: string; cardId: string; step?: StepKey }
  | { kind: 'folder'; folder: string; checkId: string }
  | { kind: 'app'; checkId: string }
  | { kind: 'vendor'; vendor: string; checkId: string }

export interface FoundAction {
  action: RecoveryAction
  source: ActionSource
  /** The run's state at lookup (run sources only). */
  state?: RunState
  /** What the check that offered it said (folder, app and vendor sources). */
  check?: CheckFacts
  /** The passes of the config the folder's report was checked with (folder sources). */
  passes?: FolderPasses
}

export interface LookupDeps {
  /** A run's state (live controller first, else run.json); null when the run is unknown. */
  runState(runId: string): Promise<RunState | null>
  /** The actions of each step's latest `snag` event (the snapshot does not carry them). */
  snagActions(runId: string): Promise<ReadonlyMap<StepKey, readonly RecoveryAction[]>>
  store: RecoveryActionStore
  /** The launch-probe store's checks per vendor (vendor health, Settings → Vendors, the setup card). */
  vendorChecks(): readonly { vendor: string; checks: readonly CheckResult[] }[]
}

export interface ActionRequest {
  actionId: string
  runId?: string
  folder?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** A core-built RecoveryAction (id, label, a known kind). */
export function isRecoveryAction(v: unknown): v is RecoveryAction {
  return (
    isObj(v) &&
    typeof v['id'] === 'string' &&
    typeof v['label'] === 'string' &&
    typeof v['kind'] === 'string' &&
    (RECOVERY_ACTION_KINDS as readonly string[]).includes(v['kind'])
  )
}

/**
 * Every RecoveryAction inside a card payload (a preflight card lists `blocking[].recovery` and
 * `warnings[].recovery`; later cards may carry their own lists). Depth-limited, payloads are small.
 */
export function payloadActions(payload: unknown, depth = 0): RecoveryAction[] {
  if (depth > 5) return []
  if (Array.isArray(payload)) return payload.flatMap((x) => payloadActions(x, depth + 1))
  if (!isObj(payload)) return []
  if (isRecoveryAction(payload)) return [payload]
  return Object.values(payload).flatMap((x) => payloadActions(x, depth + 1))
}

const stale = (): DimFactoryError => new DimFactoryError('NOT_FOUND', STALE_ACTION_MESSAGE)

async function findInRun(
  runId: string,
  actionId: string,
  deps: LookupDeps,
): Promise<FoundAction | undefined> {
  const state = await deps.runState(runId)
  if (state === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
  const open = (Object.keys(state.steps) as StepKey[]).filter((k) => state.steps[k].snagOpen)
  if (open.length > 0) {
    const snags = await deps.snagActions(runId)
    for (const step of open) {
      // The snag's own actions, then its AI diagnosis's suggestions (StepView.heal).
      const a =
        snags.get(step)?.find((x) => x.id === actionId) ??
        state.steps[step].heal?.actions.find((x) => x.id === actionId)
      if (a !== undefined) return { action: a, source: { kind: 'snag', runId, step }, state }
    }
  }
  for (const c of state.cards) {
    const a = payloadActions(c.view.payload).find((x) => x.id === actionId)
    if (a !== undefined) {
      const source: ActionSource =
        c.step !== undefined
          ? { kind: 'card', runId, cardId: c.view.id, step: c.step }
          : { kind: 'card', runId, cardId: c.view.id }
      return { action: a, source, state }
    }
  }
  return undefined
}

function findGlobal(actionId: string, deps: LookupDeps): FoundAction | undefined {
  const app = deps.store.global(actionId)
  if (app !== undefined) {
    const vendor = /^vendor\.([^.]+)/.exec(app.checkId)?.[1]
    return {
      action: app.action,
      source:
        app.scope === 'vendor' && vendor !== undefined
          ? { kind: 'vendor', vendor, checkId: app.checkId }
          : { kind: 'app', checkId: app.checkId },
      ...(app.check !== undefined ? { check: app.check } : {}),
    }
  }
  for (const { vendor, checks } of deps.vendorChecks()) {
    for (const c of checks) {
      const a = c.recovery.find((x) => x.id === actionId)
      if (a !== undefined) {
        const check: CheckFacts = { title: c.title, detail: c.detail }
        if (c.category !== undefined) check.category = c.category
        return { action: a, source: { kind: 'vendor', vendor, checkId: c.id }, check }
      }
    }
  }
  return undefined
}

/**
 * Look an action up where the UI got it: the run (open snags, then open cards) when `runId` is given, then the
 * folder's latest report when `folder` is given, then the app/vendor-scope checks. NOT_FOUND ("no longer
 * available; re-check") when it is in none of them, e.g. the snag was resolved or the report has changed.
 */
export async function findAction(req: ActionRequest, deps: LookupDeps): Promise<FoundAction> {
  if (req.runId !== undefined) {
    const hit = await findInRun(req.runId, req.actionId, deps)
    if (hit !== undefined) return hit
    if (req.folder === undefined) throw stale()
  }
  if (req.folder !== undefined) {
    const s = deps.store.folder(req.folder, req.actionId)
    if (s !== undefined) {
      const passes = deps.store.passes(req.folder)
      return {
        action: s.action,
        source: { kind: 'folder', folder: req.folder, checkId: s.checkId },
        ...(s.check !== undefined ? { check: s.check } : {}),
        ...(passes !== undefined ? { passes } : {}),
      }
    }
  }
  const g = findGlobal(req.actionId, deps)
  if (g !== undefined) return g
  throw stale()
}

// ---- execution ---------------------------------------------------------------------------------------------------

/** A config patch for a run, as the run's controller applies it (P22). */
export interface RunPatchRequest {
  ops: JsonPatchOp[]
  label: string
  /** The failed pass it retries (absent: a preflight card's fix; the config only). */
  step?: AgentStep
  actionId: string
}

/** The existing user commands the run-level kinds reuse (handlers.ts runs.*; they throw DimFactoryError). */
export interface RunCommandDeps {
  /** `continuation`: a resume action's own text for the resume retry. */
  retryPass(runId: string, pass: AgentStep, strategy?: RetryStrategy, continuation?: string): Promise<void>
  skipPass(runId: string, pass: AgentStep): Promise<void>
  closeRun(runId: string): Promise<void>
  resumeRun(runId: string): Promise<void>
  /** P22: apply a checked patch to the run's resolved config (resolved.json `patches[]`), then retry. */
  applyConfigPatch?(runId: string, req: RunPatchRequest): Promise<void>
  /** "Diagnose with AI" for a failed pass (the outcome arrives as StepView.heal). */
  heal?(runId: string, pass: AgentStep): Promise<void>
  /** wait_until: arm or disarm the failed pass's wait (toggle); the wait as it is now (none: it retried). */
  toggleWait?(runId: string, pass: AgentStep): Promise<WaitView | undefined>
  /** A card choice (a preflight card's Recheck after its fix). */
  resolveCard?(runId: string, cardId: string, choiceId: string): Promise<void>
}

/** The config files and trust grants recovery actions write (ConfigService). */
export interface RecoveryConfigDeps {
  /** Per-vendor managed flags (extraArgs may not carry them; flagMap renames only them). */
  managedFlags(): Readonly<Record<string, readonly string[]>>
  /** The vendor adapters' own extraArgs / flagMap rules over the values a fix writes (absent: none). */
  vendorArgs?: VendorArgsCheck
  /** Persist allowlisted ops (`config.patch` with its allowlist; user-only pointers go to the user file). */
  persist(scope: ConfigScope, folder: string | undefined, ops: JsonPatchOp[]): Promise<ConfigPatchPersisted[]>
  /** Write a trust.json grant for the folder (`body`: the script body a command grant's hash covers). */
  grant(folder: string, grant: TrustGrantInput, body?: string): Promise<void>
}

export interface ExecuteDeps {
  run: RunCommandDeps
  /**
   * shell_copy was handed to the host: the check it fixes is re-run (not served from the cache) by the next
   * preflights until it passes, so "I ran it → Re-check" sees the new state.
   */
  awaitRecheck?(checkId: string): void
  /** config_patch persistence and grants. Absent: those kinds answer UNSUPPORTED. */
  config?: RecoveryConfigDeps
  /** switch_vendor: which vendors are built and ready. */
  vendors?: VendorReadiness
  /** Heal outside a run (a vendor or app check): run the healer and answer its outcome. */
  healCheck?(found: FoundAction): Promise<HealView>
  /** vendor_setup: the vendor's setup and its forced re-probe. Absent: vendor_setup answers UNSUPPORTED. */
  vendorSetup?: { host: VendorSetupHost; inflight: SetupsInFlight }
}

/** Kinds that are not executable yet. None today (vendor_setup arrived with Codex). */
export const LATER_KINDS: readonly RecoveryActionKind[] = []

function runOf(found: FoundAction, _kind: string): { runId: string; step: StepKey | undefined } {
  const s = found.source
  if (s.kind !== 'snag' && s.kind !== 'card') {
    // Plain words (a kind id never reaches the UI).
    throw new DimFactoryError('VALIDATION', 'This fix belongs to a run; open the run to use it.')
  }
  return { runId: s.runId, step: s.step }
}

/** The failed pass a run-level fix acts on (VALIDATION otherwise). */
function failedPassOf(found: FoundAction, kind: string): { runId: string; pass: AgentStep } {
  const { runId, step } = runOf(found, kind)
  if (step === undefined || !isAgentStep(step)) {
    throw new DimFactoryError('VALIDATION', 'This fix applies to a failed pass only.')
  }
  return { runId, pass: step }
}

/** The folder a grant or a persisted patch is for: the run's folder, or the composer's. */
function folderOf(found: FoundAction): string | undefined {
  const s = found.source
  if (s.kind === 'folder') return s.folder
  return found.state?.folder
}

function unsupported(message = LATER_VERSION_MESSAGE): DimFactoryError {
  return new DimFactoryError('UNSUPPORTED', message)
}

/** A preflight card's Recheck after its fix (the run's authoritative preflight runs again). */
async function recheckCard(found: FoundAction, run: RunCommandDeps): Promise<boolean> {
  const s = found.source
  if (s.kind !== 'card' || run.resolveCard === undefined) return false
  const card = found.state?.cards.find((c) => c.view.id === s.cardId)
  if (card?.view.kind !== 'preflight') return false
  await run.resolveCard(s.runId, s.cardId, CHOICE.recheck)
  return true
}

async function execConfigPatch(
  found: FoundAction,
  a: RecoveryActionOf<'config_patch'>,
  deps: ExecuteDeps,
): Promise<RecoveryResult> {
  // The config_patch allowlist first, wherever the action came from (a core-built one, a heal suggestion).
  const ops = checkRecoveryOps(a.ops, {
    target: a.target,
    managedFlags: deps.config?.managedFlags(),
    vendorArgs: deps.config?.vendorArgs,
  })
  const out: RecoveryResult = { kind: 'config_patch' }
  const s = found.source
  if (s.kind === 'snag' || s.kind === 'card') {
    // A run's overrides are part of its resolved config: both targets patch the run (P22).
    if (deps.run.applyConfigPatch === undefined) throw unsupported()
    const status = s.step !== undefined ? found.state?.steps[s.step].status : undefined
    const step = s.step !== undefined && isAgentStep(s.step) && status === 'failed' ? s.step : undefined
    await deps.run.applyConfigPatch(s.runId, {
      ops,
      label: a.label,
      actionId: a.id,
      ...(step !== undefined ? { step } : {}),
    })
    if (step !== undefined) out.message = `Applied. Retrying ${stepLabel(step)}.`
    else if (await recheckCard(found, deps.run)) out.message = 'Applied to this run. Checking again.'
    else out.message = 'Applied to this run.'
  } else {
    if (a.target === 'resolved') {
      throw new DimFactoryError('VALIDATION', 'This fix belongs to a run; open the run to use it.')
    }
    // A composer fix: the composer applies the checked ops to its run overrides. A setting a run cannot override
    // (timeouts, a vendor's flags) only takes effect saved to the settings.
    const runnable = ops.filter((op) =>
      (RUN_OVERRIDE_KEYS as readonly string[]).includes(op.path.split('/')[1] ?? ''),
    )
    if (runnable.length < ops.length && a.persist === undefined) {
      throw new DimFactoryError(
        'VALIDATION',
        'A single run cannot change this setting. Save it to your settings instead.',
      )
    }
    if (runnable.length > 0) {
      out.overrides = runnable
      out.message = 'Changed for this run.'
    }
  }
  if (a.persist !== undefined) {
    if (deps.config === undefined) throw unsupported('Saving settings is not available here.')
    const writes = ops.filter((op) => op.op !== 'test' && op.path !== '/auto')
    if (writes.length > 0) {
      out.persisted = await deps.config.persist(a.persist.scope, folderOf(found), writes)
      out.message = `${out.message ?? 'Applied.'} Saved to your ${out.persisted.some((p) => p.scope === 'project') ? 'project' : 'user'} settings.`
    }
  }
  return out
}

/**
 * A switch offered by the composer's checks (no run yet) becomes run overrides for the composer, like a
 * config_patch `runOverrides`: the passes it moves (`all`: every enabled pass not already on the target, so passes on
 * the target keep their model) get the vendor and the default model. Readiness is checked again for each. Elsewhere
 * (the setup card, Settings → Vendors) there is no run to change: refused in plain words.
 */
function switchOverrides(
  found: FoundAction,
  a: RecoveryActionOf<'switch_vendor'>,
  deps: ExecuteDeps,
): RecoveryResult {
  const name = (id: string): string => deps.vendors?.vendors().find((v) => v.id === id)?.displayName ?? id
  if (found.source.kind !== 'folder' || found.passes === undefined) {
    throw new DimFactoryError(
      'VALIDATION',
      `Choose ${name(a.to)} for each pass in the composer; there is no run here to switch.`,
    )
  }
  const vendors = deps.vendors
  if (vendors === undefined) throw unsupported(a.disabledReason ?? LATER_VERSION_MESSAGE)
  const target = vendors.vendors().find((v) => v.id === a.to)
  if (target === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${a.to}".`)
  const cfg = found.passes
  const passes: PassName[] =
    a.pass === 'all' ? PASS_NAMES.filter((p) => cfg[p].enabled && cfg[p].vendor !== target.id) : [a.pass]
  if (passes.length === 0) {
    return { kind: 'switch_vendor', message: `Every pass already uses ${target.displayName}.` }
  }
  for (const p of passes) {
    const ready = target.built
      ? vendors.readyFor(target.id, p, cfg[p].mode)
      : { ok: false as const, reason: '' }
    if (!ready.ok) {
      const reason = notReadyReason(target, ready)
      throw new DimFactoryError(
        target.built ? 'CONFLICT' : 'UNSUPPORTED',
        reason !== '' ? reason : `${target.displayName} is not ready.`,
      )
    }
  }
  const overrides: JsonPatchOp[] = passes.flatMap((p): JsonPatchOp[] => [
    { op: 'add', path: `/passes/${p}/vendor`, value: target.id },
    { op: 'add', path: `/passes/${p}/model`, value: a.model },
    // Another vendor's effort levels are not this one's: the pass runs at the new vendor's default effort.
    { op: 'add', path: `/passes/${p}/effort`, value: null },
  ])
  const labels = passes.map((p) => stepLabel(p))
  const message =
    labels.length === 1
      ? `${labels[0] ?? ''} now uses ${target.displayName} for this run.`
      : `${labels.join(', ')} now use ${target.displayName} for this run.`
  return { kind: 'switch_vendor', overrides, message }
}

async function execSwitchVendor(
  found: FoundAction,
  a: RecoveryActionOf<'switch_vendor'>,
  deps: ExecuteDeps,
): Promise<RecoveryResult> {
  const s = found.source
  if (s.kind !== 'snag' && s.kind !== 'card') return switchOverrides(found, a, deps)
  const { runId, pass } = failedPassOf(found, 'switch_vendor')
  const vendors = deps.vendors
  const run = deps.run
  if (vendors === undefined || run.applyConfigPatch === undefined) {
    throw unsupported(a.disabledReason ?? LATER_VERSION_MESSAGE)
  }
  const target = vendors.vendors().find((v) => v.id === a.to)
  if (target === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${a.to}".`)
  const state = found.state
  const passes: PassName[] =
    a.pass === 'all'
      ? PASS_NAMES.filter(
          (p) =>
            state === undefined || (state.config.passes[p].enabled && !isDoneStatus(state.steps[p].status)),
        )
      : [a.pass]
  // Checked again now: readiness may have changed since the snag was shown.
  for (const p of passes) {
    const mode = state?.config.passes[p].mode ?? 'readonly'
    const ready = target.built ? vendors.readyFor(target.id, p, mode) : { ok: false as const, reason: '' }
    if (!ready.ok) {
      const reason = notReadyReason(target, ready)
      throw new DimFactoryError(
        target.built ? 'CONFLICT' : 'UNSUPPORTED',
        reason !== '' ? reason : `${target.displayName} is not ready.`,
      )
    }
  }
  const ops = switchVendorOps(passes, target.id, a.model)
  await run.applyConfigPatch(runId, { ops, label: a.label, step: pass, actionId: a.id })
  return { kind: 'switch_vendor', message: `Switched to ${target.displayName}. Retrying ${stepLabel(pass)}.` }
}

/**
 * The run's config patch that moves `passes` to `vendor` (its `model`, null: its default) at that vendor's default
 * effort: what switch_vendor applies, and the factory's automatic fallback on a rate limit too.
 */
export function switchVendorOps(
  passes: readonly PassName[],
  vendor: string,
  model: string | null,
): JsonPatchOp[] {
  return passes.flatMap((p): JsonPatchOp[] => [
    { op: 'replace', path: `/passes/${p}/vendor`, value: vendor },
    { op: 'replace', path: `/passes/${p}/model`, value: model },
    // Another vendor's effort levels are not this one's: the pass runs at the new vendor's default effort.
    { op: 'replace', path: `/passes/${p}/effort`, value: null },
  ])
}

const isDoneStatus = (s: string): boolean => s === 'done' || s === 'skipped' || s === 'cancelled'

/**
 * trust.json `vendorFolder` and readiness `trust`: the vendor a folder grant names, checked before
 * anything is written. Only a vendor that asks for folder trust (Gemini) takes one, and only by its own id.
 */
function vendorFolderGrant(a: RecoveryActionOf<'grant'>): TrustGrantInput {
  const vendor = a.vendor
  if (vendor === undefined || vendor === '') {
    throw new DimFactoryError('VALIDATION', 'This fix does not name the vendor to trust the folder for.')
  }
  if (!needsFolderTrust(vendor)) {
    throw new DimFactoryError('VALIDATION', 'This vendor does not ask Dim Factory to trust folders.')
  }
  return { kind: 'vendorFolder', vendor }
}

/**
 * After a vendorFolder grant, the readiness check that asked for it runs again instead of being served from the
 * preflight cache: the check the action came from (a preflight report or card), else every pass's readiness for the
 * failed pass (a snag).
 */
function recheckAfterGrant(found: FoundAction, deps: ExecuteDeps): void {
  const s = found.source
  if (s.kind === 'folder' || s.kind === 'app' || s.kind === 'vendor') deps.awaitRecheck?.(s.checkId)
  else if (s.step !== undefined && isAgentStep(s.step))
    deps.awaitRecheck?.(`pass.${s.step === 'tests' ? 'implement' : s.step}.readiness`)
}

async function execGrant(
  found: FoundAction,
  a: RecoveryActionOf<'grant'>,
  deps: ExecuteDeps,
): Promise<RecoveryResult> {
  if (deps.config === undefined) throw unsupported('Trust grants are not available here.')
  const folder = folderOf(found)
  if (folder === undefined)
    throw new DimFactoryError('VALIDATION', 'This fix needs a folder; choose one first.')
  if (a.grant === 'vendorFolder') return execVendorFolderGrant(found, a, folder, deps.config, deps)
  let grant: TrustGrantInput
  switch (a.grant) {
    case 'largeFolder':
      grant = { kind: 'largeFolder' }
      break
    case 'projectAuto':
      grant =
        a.projectSha !== undefined
          ? { kind: 'projectAuto', projectSha: a.projectSha }
          : { kind: 'projectAuto' }
      break
    case 'recipeAuto':
      if (a.recipeId === undefined) {
        throw new DimFactoryError('VALIDATION', 'This fix does not name the recipe to trust.')
      }
      grant = {
        kind: 'recipeAuto',
        recipeId: a.recipeId,
        ...(a.recipeSha !== undefined ? { recipeSha: a.recipeSha } : {}),
      }
      break
    case 'command': {
      const c = a.command
      if (c === undefined || c.argv.length === 0) {
        throw new DimFactoryError('VALIDATION', 'This fix does not name the command to trust.')
      }
      grant = { kind: 'command', command: { kind: c.kind, argv: [...c.argv], cwdRel: c.cwdRel } }
      break
    }
  }
  await deps.config.grant(folder, grant, a.grant === 'command' ? a.command?.body : undefined)
  const s = found.source
  if (s.kind === 'snag' && s.step !== undefined && isAgentStep(s.step)) {
    // trust_required: "grant → retry".
    await deps.run.retryPass(s.runId, s.step, 'auto')
    return { kind: 'grant', message: `Allowed. Retrying ${stepLabel(s.step)}.` }
  }
  if (await recheckCard(found, deps.run)) return { kind: 'grant', message: 'Allowed. Checking again.' }
  return { kind: 'grant', message: 'Allowed. Re-check to continue.' }
}

/**
 * vendorFolder grant (trust.json `folders[folderKey].grants.vendorFolder[vendor] = {at}`;
 * trust_required "grant → retry"): write the grant for the folder's scope, then force the readiness check that asked
 * for it to run again. A failed pass's snag retries the pass (a user click: no retry budget spent), a preflight card
 * checks again, and the composer's report re-checks (the grant also invalidates the folder's cached checks).
 */
async function execVendorFolderGrant(
  found: FoundAction,
  a: RecoveryActionOf<'grant'>,
  folder: string,
  config: RecoveryConfigDeps,
  deps: ExecuteDeps,
): Promise<RecoveryResult> {
  const grant = vendorFolderGrant(a)
  const vendor = grant.kind === 'vendorFolder' ? grant.vendor : ''
  await config.grant(folder, grant)
  recheckAfterGrant(found, deps)
  const name =
    deps.vendors?.vendors().find((v) => v.id === vendor)?.displayName ??
    (isKnownVendor(vendor) ? VENDOR_DISPLAY_NAMES[vendor] : vendor)
  const trusted = `This folder is trusted for ${name}.`
  const s = found.source
  if (s.kind === 'snag' && s.step !== undefined && isAgentStep(s.step)) {
    await deps.run.retryPass(s.runId, s.step, 'auto')
    return { kind: 'grant', message: `${trusted} Retrying ${stepLabel(s.step)}.` }
  }
  // A preflight card's Recheck runs here; the composer re-runs its preflight when a folder fix answers (its check
  // was marked for a re-check above).
  if ((await recheckCard(found, deps.run)) || s.kind === 'folder') {
    return { kind: 'grant', message: `${trusted} Checking again.` }
  }
  return { kind: 'grant', message: `${trusted} Re-check to continue.` }
}

/** Run one found action. Never executes a shell command and never opens anything itself. */
export async function executeAction(found: FoundAction, deps: ExecuteDeps): Promise<RecoveryResult> {
  const a = found.action
  switch (a.kind) {
    case 'shell_copy': {
      if (a.recheck !== '') deps.awaitRecheck?.(a.recheck)
      return {
        kind: 'shell_copy',
        copied: a.command,
        message:
          a.elevated === true
            ? 'Copied. Run it in an administrator terminal, then re-check.'
            : 'Copied. Run it in a terminal, then re-check.',
      }
    }
    case 'settings_link':
      return { kind: 'settings_link', route: settingsHref(a.route, a.pointer, suggestedFolder(a.suggested)) }
    case 'open_docs': {
      const url = allowedExternalUrl(a.url)
      if (url === null) {
        throw new DimFactoryError('VALIDATION', 'Only https links to known documentation sites open.')
      }
      return { kind: 'open_docs', url, message: `Opening ${url} in your browser.` }
    }
    case 'retry': {
      const { runId, step } = runOf(found, 'retry')
      if (step === undefined || !isAgentStep(step)) {
        throw new DimFactoryError('VALIDATION', 'Only a failed pass can be retried.')
      }
      await deps.run.retryPass(runId, step, a.strategy)
      return { kind: 'retry', message: `Retrying ${stepLabel(step)}.` }
    }
    case 'skip_pass': {
      const { runId } = runOf(found, 'skip_pass')
      await deps.run.skipPass(runId, a.pass)
      return { kind: 'skip_pass', message: `Continuing without ${stepLabel(a.pass)}.` }
    }
    case 'close_run': {
      const { runId } = runOf(found, 'close_run')
      await deps.run.closeRun(runId)
      return { kind: 'close_run', message: 'Run closed.' }
    }
    case 'resume': {
      // A paused step resumes with the continuation its pause stored (the same failure row); a failed step
      // resumes its session through a resume retry carrying the action's own continuation.
      const { runId, step } = runOf(found, 'resume')
      const status = step !== undefined ? found.state?.steps[step].status : undefined
      if (step !== undefined && isAgentStep(step) && status === 'failed') {
        await deps.run.retryPass(runId, step, 'resume', a.continuation)
      } else {
        await deps.run.resumeRun(runId)
      }
      return { kind: 'resume', message: 'Resuming.' }
    }
    case 'config_patch':
      return execConfigPatch(found, a, deps)
    case 'switch_vendor':
      return execSwitchVendor(found, a, deps)
    case 'grant':
      return execGrant(found, a, deps)
    case 'wait_until': {
      const { runId, pass } = failedPassOf(found, 'wait_until')
      if (deps.run.toggleWait === undefined) throw unsupported()
      const wait = await deps.run.toggleWait(runId, pass)
      if (wait === undefined) return { kind: 'wait_until', message: `Retrying ${stepLabel(pass)} now.` }
      return {
        kind: 'wait_until',
        wait,
        message: wait.armed
          ? `Dim Factory retries ${stepLabel(pass)} when the wait is over.`
          : `Stopped waiting. Retry ${stepLabel(pass)} when you are ready.`,
      }
    }
    case 'heal': {
      const s = found.source
      if (s.kind === 'snag' || s.kind === 'card') {
        const { runId, pass } = failedPassOf(found, 'heal')
        if (deps.run.heal === undefined) throw unsupported()
        await deps.run.heal(runId, pass)
        return { kind: 'heal', message: 'Diagnosing with AI. This can take up to 90 seconds.' }
      }
      if (deps.healCheck === undefined) throw unsupported('Self-heal is not available here.')
      const heal = await deps.healCheck(found)
      return { kind: 'heal', heal, message: healMessage(heal) }
    }
    case 'vendor_setup':
      return execVendorSetup(found, a, deps)
  }
}

/**
 * vendor_setup: the vendor's own setup (unelevated), then a forced re-probe. A failed pass's snag retries the pass
 * once the sandbox reads ready (a user click: no retry budget spent); a preflight card checks again; elsewhere the
 * re-probe is all (the composer's live preflight reads it next).
 */
async function execVendorSetup(
  found: FoundAction,
  a: RecoveryActionOf<'vendor_setup'>,
  deps: ExecuteDeps,
): Promise<RecoveryResult> {
  const vs = deps.vendorSetup
  if (vs === undefined) throw unsupported(a.disabledReason ?? 'The sandbox setup is not available here.')
  const outcome = await runVendorSetup(a, vs.host, vs.inflight)
  const name = vs.host.vendor(a.vendor)?.displayName ?? a.vendor
  const s = found.source
  if (outcome.ready) {
    const status = s.kind === 'snag' && s.step !== undefined ? found.state?.steps[s.step].status : undefined
    if (s.kind === 'snag' && s.step !== undefined && isAgentStep(s.step) && status === 'failed') {
      await deps.run.retryPass(s.runId, s.step, 'auto')
      return setupResult(outcome, setupMessage(outcome, name, stepLabel(s.step)))
    }
    if (await recheckCard(found, deps.run)) {
      return setupResult(outcome, `${setupMessage(outcome, name)} Checking again.`)
    }
  }
  return setupResult(outcome, setupMessage(outcome, name))
}

/** One line for a finished run-less heal. */
function healMessage(h: HealView): string {
  switch (h.status) {
    case 'disabled':
      return 'Self-heal is turned off in Settings.'
    case 'failed':
      return 'The AI diagnosis failed.'
    case 'running':
    case 'ok':
    case 'cached':
      return h.diagnosis ?? 'The AI could not say what went wrong.'
  }
}
