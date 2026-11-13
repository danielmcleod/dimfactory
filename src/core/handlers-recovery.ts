// Recovery and vendor commands (recovery actions, cache invalidation, executors, Settings → Vendors):
// `recovery.execute`, `vendors.setPath`, `vendors.models`, `git.init`. A HandlerMap fragment
// createHandlers spreads in. What a handler needs from the core beyond HandlerContext comes through `ctx.recovery`
// (app-core.ts), read when a command runs, so a context without it answers UNSUPPORTED instead of failing.
//
// Re-check ("I ran it → Re-check", how the UI asks for it with the existing commands): executing a shell_copy marks
// the check named by its `recheck` field (PreflightCache.awaitRecheck), so every later preflight re-runs that check
// until it passes. A `vendor.<v>.*` check comes from the launch probe, which live preflight never re-runs: the UI's
// Re-check sends `vendors.probe{vendor: <v>, force: true}` (token-free) and then `preflight.run`; for any other
// check id `preflight.run` alone re-checks it. A run's preflight card uses its own Recheck choice (the authoritative
// preflight re-checks a failed login and re-probes a vendor that is otherwise broken).
//
// Executors and self-heal (P22): the run-level kinds reach the run's controller (P22 config patch,
// heal, wait_until; a resume retry with its continuation), config_patch persistence and grants go through the config
// service (the `config_patch` allowlist on), switch_vendor reads the host's vendor readiness, and
// `heal.diagnose{runId, step}` starts a diagnosis whose outcome arrives as StepView.heal (an `output` body for `heal`
// announces it).
//
// vendor_setup: only this command runs a vendor's setup (the Codex Windows sandbox, unelevated), one per
// vendor at a time, then probes the vendor again with force and stores the probe (the `probe` AppEvent follows).
import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { ConfigScope } from '../shared/config-schema.ts'
import type { Failure, JsonPatchOp, RecoveryAction, RetryStrategy } from '../shared/failure.ts'
import type { Cmd, ConfigPatchPersisted, Req, Res } from '../shared/ipc.ts'
import type { StepKey, WaitView } from '../shared/run.ts'
import { isPassName } from '../shared/run.ts'
import { VENDOR_ID_PATTERN, localPresetIdOf } from '../shared/vendors.ts'
import { forEachEnvelope } from './bus/bus.ts'
import type { CatalogData } from './catalog/store.ts'
import { DimFactoryError } from './errors.ts'
import type { Handler, HandlerContext, HandlerMap } from './handlers.ts'
import { probeView, stubProbeOf } from './handlers.ts'
import { executeAction, findAction } from './recovery/dispatcher.ts'
import type { FoundAction, LookupDeps, RecoveryConfigDeps, RunCommandDeps } from './recovery/dispatcher.ts'
import { healViewOf } from './recovery/heal-api.ts'
import type { HealApi } from './recovery/heal-api.ts'
import { initRepository } from './recovery/git-init.ts'
import { mergeModelOptions } from './recovery/models.ts'
import type { VendorArgsCheck } from './recovery/config-patch.ts'
import type { RecoveryActionStore } from './recovery/store.ts'
import type { VendorReadiness } from './recovery/switch-vendor.ts'
import type { VendorPathCheck } from './recovery/vendor-path.ts'
import { hasVendorSetup } from './recovery/vendor-setup.ts'
import type { SetupsInFlight, VendorSetupHost } from './recovery/vendor-setup.ts'
import type { RunController } from './supervisor/controller.ts'
import type { RunState, UserCommand } from './supervisor/types.ts'

/** What the recovery and vendor commands need from the core (app-core.ts implements it). */
export interface RecoveryHost {
  /** Actions of each folder's latest live / blocked authoritative preflight, and the app/vendor ones. */
  readonly actions: RecoveryActionStore
  /**
   * Validate `path` as the vendor's CLI (only that file is examined). Null when this build cannot check a path for
   * the vendor (no adapter with a resolver).
   */
  validateVendorPath(vendor: string, path: string): Promise<VendorPathCheck> | null
  /** Re-read the user file's `vendors` section now and re-create the adapters it configures (awaitable). */
  syncUserVendors(): Promise<void>
  /** The model and price catalog (undefined when unavailable, e.g. a read-only core). */
  catalog(): CatalogData | undefined
  /** Forget what was cached about a folder (its scope, its last report's actions), e.g. after `git init`. */
  forgetFolder(folder: string): void
  /** Dim Factory's own environment (the folder guard reads DIM_FACTORY_HOME from it). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** switch_vendor: which vendors are built and ready for a pass. Absent: switch_vendor is UNSUPPORTED. */
  readonly vendors?: VendorReadiness
  /** The healer, for a diagnosis outside a run (a vendor or app check). Runs use their controller's. */
  readonly heal?: HealApi
  /** A vendor's CLI version from its launch probe (the heal request's `vendorVersion`). */
  vendorVersion?(vendor: string): string | null
  /**
   * The vendor adapters' own extraArgs / flagMap rules (Claude: launch.ts), applied to a config fix saved outside
   * a run, where no run's config is patched first.
   */
  readonly vendorArgs?: VendorArgsCheck
}

/** Commands this fragment answers. */
export const RECOVERY_COMMANDS = [
  'recovery.execute',
  'vendors.setPath',
  'vendors.models',
  'git.init',
] as const satisfies readonly Cmd[]

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

const absFolder = (f: string): string => (isAbsolute(f) ? f : resolve(f))

/** The actions of each step's latest `snag` event, read from the run's log (flushed first when it is open). */
async function snagActions(
  ctx: HandlerContext,
  runId: string,
): Promise<ReadonlyMap<StepKey, readonly RecoveryAction[]>> {
  if (ctx.bus.isOpen(runId)) await ctx.bus.sync(runId)
  const out = new Map<StepKey, readonly RecoveryAction[]>()
  await forEachEnvelope(ctx.paths, runId, 0, (env) => {
    if (env.body.t === 'snag') out.set(env.body.step, env.body.actions)
  })
  return out
}

export function recoveryHandlers(ctx: HandlerContext, table: () => HandlerMap): HandlerMap {
  const host = (): RecoveryHost => {
    const h = ctx.recovery
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Recovery actions are not available here.')
    return h
  }
  const writable = (): void => {
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }
  /** A command of the same table (the run-level kinds reuse the existing user commands). */
  const call = <C extends Cmd>(cmd: C, req: Req<C>): Promise<Res<C>> => {
    const h: Handler<C> | undefined = table()[cmd]
    if (h === undefined) {
      return Promise.reject(new DimFactoryError('UNSUPPORTED', `${cmd} is not available in this build.`))
    }
    return h(req)
  }
  /** The run's controller (writable cores only). */
  const controllerOf = async (runId: string): Promise<RunController> => {
    writable()
    return ctx.controller(runId)
  }
  /** A user command straight to the run (the recovery commands have no IPC of their own). */
  const command = async (runId: string, cmd: UserCommand): Promise<RunController> => {
    const c = await controllerOf(runId)
    const r = await c.command(cmd)
    if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message, { details: r.error.details })
    return c
  }
  const runCommands: RunCommandDeps = {
    retryPass: async (runId, pass, strategy?: RetryStrategy, continuation?: string) => {
      if (continuation === undefined) {
        return call('runs.retryPass', { runId, pass, ...(strategy !== undefined ? { strategy } : {}) })
      }
      await command(runId, {
        kind: 'retry',
        step: pass,
        continuation,
        ...(strategy !== undefined ? { strategy } : {}),
      })
    },
    skipPass: (runId, pass) => call('runs.skipPass', { runId, pass }),
    closeRun: (runId) => call('runs.close', { runId }),
    resumeRun: (runId) => call('runs.resume', { runId }),
    applyConfigPatch: async (runId, req) => {
      const c = await controllerOf(runId)
      const r = await c.applyConfigPatch(req)
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message, { details: r.error.details })
    },
    heal: async (runId, pass) => {
      await command(runId, { kind: 'heal', step: pass })
    },
    toggleWait: async (runId, pass): Promise<WaitView | undefined> => {
      const c = await command(runId, { kind: 'wait', step: pass })
      const w = c.state.steps[pass].wait
      if (w === undefined) return undefined
      const { auto: _auto, ...view } = w
      return view
    },
    resolveCard: (runId, cardId, choiceId) => call('cards.resolve', { runId, cardId, choiceId }),
  }
  const configDeps: RecoveryConfigDeps = {
    managedFlags: () => ctx.config.managedFlags(),
    vendorArgs: (vendor, v) => ctx.recovery?.vendorArgs?.(vendor, v),
    persist: async (scope: ConfigScope, folder: string | undefined, ops: JsonPatchOp[]) => {
      writable()
      const out = await ctx.config.patch({
        scope,
        ...(folder !== undefined ? { folder } : {}),
        ops,
        allowlist: true,
      })
      return out.writes
        .filter((w) => w.changed)
        .map((w): ConfigPatchPersisted => ({
          scope: w.scope,
          ...(w.folder !== undefined ? { folder: w.folder } : {}),
          path: w.path,
          backupId: w.backupId,
          diff: w.diff,
        }))
    },
    grant: async (folder, grant, body) => {
      writable()
      await ctx.config.trustSet({ folder, grant, trusted: true, ...(body !== undefined ? { body } : {}) })
    },
  }
  /** "Diagnose with AI" for a vendor or app check (no run): the healer's outcome, its fixes kept with the check. */
  const healCheck = async (h: RecoveryHost, found: FoundAction) => {
    const api = h.heal
    if (api === undefined) throw new DimFactoryError('UNSUPPORTED', 'Self-heal is not available here.')
    const src = found.source
    if (src.kind !== 'vendor' && src.kind !== 'app' && src.kind !== 'folder') {
      throw new DimFactoryError('VALIDATION', 'Open the run to diagnose this failure with AI.')
    }
    const vendor = src.kind === 'vendor' ? src.vendor : 'claude'
    const c = found.check
    const failure: Failure = {
      category: c?.category ?? 'unknown',
      message: c !== undefined ? `${c.title}: ${c.detail}` : found.action.label,
      raw: c?.detail ?? '',
      classifiedBy: 'app',
    }
    const outcome = await api.diagnose({
      step: 'probe',
      failure,
      trigger: 'user',
      vendor,
      vendorVersion: h.vendorVersion?.(vendor) ?? null,
      passArgv: [],
      tail: [],
    })
    const view = healViewOf(outcome, 'user', {
      step: 'probe',
      // Unique per diagnosis: a later one (another check, or this one again) never takes over these ids.
      nonce: `heal-${randomBytes(4).toString('hex')}`,
      vendor,
      managedFlags: ctx.config.managedFlags(),
      ...(h.vendorArgs !== undefined ? { vendorArgs: h.vendorArgs } : {}),
    })
    const refused = new Set(
      h.actions.addSuggested(
        src.kind === 'folder' ? src.folder : undefined,
        { checkId: src.checkId, scope: src.kind === 'folder' ? 'folder' : src.kind },
        view.actions,
      ),
    )
    // Only what core can find again by id is offered.
    return refused.size === 0 ? view : { ...view, actions: view.actions.filter((a) => !refused.has(a.id)) }
  }
  const lookup = (h: RecoveryHost): LookupDeps => ({
    runState: async (runId): Promise<RunState | null> => {
      const live = ctx.liveController(runId)
      if (live !== undefined) return live.state
      return (await ctx.readDoc(runId))?.state ?? null
    },
    snagActions: (runId) => snagActions(ctx, runId),
    store: h.actions,
    // The checks each vendor row shows: the probe store's, and for a vendor not in this build the stub probe its
    // view carries (probeView), so the setup card's install command is executable before anything probed it.
    vendorChecks: () =>
      ctx.adapters.list().map((e) => ({
        vendor: e.id,
        checks:
          ctx.preflight.cache.vendor(e.id)?.checks ?? (e.built ? [] : (stubProbeOf(e.id)?.checks ?? [])),
      })),
  })
  // vendor_setup: the adapter's own setup (Codex windowsSandbox/setupStart over a private app-server),
  // then a forced, token-free re-probe stored like `vendors.probe{force}` (vendor health, preflight, support()).
  const setupsInFlight: SetupsInFlight = new Map()
  const setupHost: VendorSetupHost = {
    vendor: (id) => {
      const rid = ctx.adapters.resolveId(id)
      const e = ctx.adapters.list().find((x) => x.id === rid)
      if (e === undefined) return undefined
      const adapter = e.adapter
      return {
        id: rid,
        displayName: adapter.displayName,
        built: e.built,
        ...(hasVendorSetup(adapter)
          ? { setup: (call, params, signal) => adapter.vendorSetup(call, params, signal) }
          : {}),
      }
    },
    reprobe: async (vendor) => {
      writable()
      const adapter = ctx.adapters.get(vendor)
      if (adapter === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${vendor}".`)
      ctx.preflight.cache.invalidateVendor(vendor)
      const probe = await adapter.probe({ force: true })
      ctx.preflight.recordProbe(probe)
      return probe
    },
  }

  /** A registered vendor (NOT_FOUND otherwise); `built: false` for registry stubs. */
  const entryOf = (vendor: unknown): { id: string; built: boolean; displayName: string } => {
    need(typeof vendor === 'string' && VENDOR_ID_PATTERN.test(vendor), 'vendor must be a vendor id')
    const e = ctx.adapters.list().find((x) => x.id === vendor)
    if (e === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${String(vendor)}".`)
    return { id: e.id, built: e.built, displayName: e.adapter.displayName }
  }

  return {
    'recovery.execute': async (req) => {
      need(isObj(req) && typeof req.actionId === 'string' && req.actionId !== '', 'actionId is required')
      need(
        req.runId === undefined || (typeof req.runId === 'string' && req.runId !== ''),
        'runId must be an id',
      )
      need(
        req.folder === undefined || (typeof req.folder === 'string' && req.folder.trim() !== ''),
        'folder must be a path',
      )
      const h = host()
      const found = await findAction(
        {
          actionId: req.actionId,
          ...(req.runId !== undefined ? { runId: req.runId } : {}),
          ...(req.folder !== undefined ? { folder: absFolder(req.folder) } : {}),
        },
        lookup(h),
      )
      return executeAction(found, {
        run: runCommands,
        awaitRecheck: (checkId) => ctx.preflight.cache.awaitRecheck(checkId, ctx.now()),
        config: configDeps,
        ...(h.vendors !== undefined ? { vendors: h.vendors } : {}),
        healCheck: (f) => healCheck(h, f),
        // A read-only core neither sets anything up nor stores the probe after it (UNSUPPORTED, nothing runs).
        ...(ctx.readOnly ? {} : { vendorSetup: { host: setupHost, inflight: setupsInFlight } }),
      })
    },

    // "Diagnose with AI" for a failed pass; the outcome arrives as StepView.heal (an `output` body for `heal`).
    'heal.diagnose': async (req) => {
      need(isObj(req) && typeof req.runId === 'string' && req.runId !== '', 'runId is required')
      const step = req.step
      if (!isPassName(step)) {
        throw new DimFactoryError('VALIDATION', 'step must be a pass (plan, implement, review, critic, fix)')
      }
      await command(req.runId, { kind: 'heal', step })
    },

    'vendors.setPath': async (req) => {
      need(isObj(req), 'request body is required')
      const e = entryOf(req.vendor)
      need(
        req.path === null || (typeof req.path === 'string' && req.path.trim() !== ''),
        'path must be a path or null',
      )
      writable()
      const h = host()
      if (!e.built)
        throw new DimFactoryError('UNSUPPORTED', `${e.displayName} is not available in this build.`)
      let ops: JsonPatchOp[]
      if (req.path === null) {
        ops = [{ op: 'remove', path: `/vendors/${e.id}/path` }]
      } else {
        const check = h.validateVendorPath(e.id, req.path)
        if (check === null) {
          throw new DimFactoryError('UNSUPPORTED', `${e.displayName}'s CLI path cannot be set in this build.`)
        }
        const r = await check
        if (!r.ok) throw new DimFactoryError('VALIDATION', r.reason)
        ops = [{ op: 'replace', path: `/vendors/${e.id}/path`, value: r.path }]
      }
      await ctx.config.patch({ scope: 'user', ops })
      // The adapter is re-created from the saved file before probing, so the probe uses the new path.
      await h.syncUserVendors()
      ctx.preflight.cache.invalidateVendor(e.id)
      const adapter = ctx.adapters.get(e.id)
      if (adapter === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${e.id}".`)
      const probe = await adapter.probe({ force: true })
      ctx.preflight.recordProbe(probe)
      return probeView(ctx.adapters, e.id, probe)
    },

    'vendors.models': async (req) => {
      need(isObj(req), 'request body is required')
      need(typeof req.vendor === 'string' && VENDOR_ID_PATTERN.test(req.vendor), 'vendor must be a vendor id')
      const id = ctx.adapters.resolveId(req.vendor)
      const adapter = ctx.adapters.get(req.vendor)
      if (adapter === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${req.vendor}".`)
      // A local preset lists models with `GET {baseUrl}/models` (loopback presets only): a `local-<id>` vendor lists
      // its own server's models (source `local-server`, free), never Codex's.
      const presetId = localPresetIdOf(req.vendor)
      if (presetId !== null) {
        const preset = ctx.config.user?.value?.local?.presets?.find((x) => x.id === presetId)
        if (preset === undefined) {
          throw new DimFactoryError('NOT_FOUND', `Your settings list no local model preset "${presetId}".`)
        }
        const local = await adapter.listModels({ local: { ...preset } })
        return mergeModelOptions(req.vendor, local, undefined)
      }
      const force = req.force === true
      let probe = force ? undefined : ctx.preflight.cache.vendor(id)?.probe
      if (probe === undefined) {
        // The token-free launch probe (Claude: initialize-only handshake); stored so vendor health follows it.
        probe = await adapter.probe(force ? { force: true } : {})
        ctx.preflight.recordProbe(probe)
      }
      return mergeModelOptions(id, probe.models, ctx.recovery?.catalog())
    },

    'git.init': async (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      writable()
      const h = host()
      const folder = absFolder(req.folder)
      await initRepository(folder, {
        dimFactoryHome: ctx.paths.home,
        emptyHooksDir: ctx.paths.emptyHooksDir,
        env: h.env,
      })
      // The folder is a repository now: its scope, folder.git and the checks that read them are re-evaluated.
      h.forgetFolder(folder)
      ctx.preflight.cache.invalidateConfig()
    },
  }
}
