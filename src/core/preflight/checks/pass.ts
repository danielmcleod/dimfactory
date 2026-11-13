// Pass-scope checks: pass.<p>.vendor, pass.<p>.mode (adapter.support), pass.<p>.readiness.*
// (adapter.readiness), pass.plan.native (info) and pass.fix.resume (info). They read vendor results from the
// probe store only, so the passBoundary mode (the P1 guard before every spawn) never spawns anything.
// pass.<p>.relay (W, "asks auto-denied, not prompted": a route without a question relay, Codex exec), and the
// local preset: an unknown `local-<id>` fails pass.<p>.vendor with a link to the presets, and the preset
// reaches the adapter's readiness (`ReadinessNeed.local`, loopback checks) and support().
// A vendor that asks for folder trust (Gemini) gets `ReadinessNeed.trustFolder` from the folder's trust.json
// `vendorFolder` grant, which its readiness `trust` check reads.
import { createHash } from 'node:crypto'
import type { ResolvedConfig } from '../../../shared/config-schema.ts'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import { passCheckId, vendorCheckId } from '../../../shared/preflight.ts'
import { PASS_NAMES, READONLY_PASSES } from '../../../shared/run.ts'
import type { FreshReason, Mode, PassName } from '../../../shared/run.ts'
import type { ReadinessNeed } from '../../../shared/vendors.ts'
import { KNOWN_VENDORS, modelEfforts, needsFolderTrust, supportsEffort } from '../../../shared/vendors.ts'
import {
  PASSTHROUGH_READONLY_WARNING,
  allowedFor,
  defaultExtensionLevel,
  extensionsSupport,
  extensionsVendor,
  isReadOnlyExtensionsPass,
  passExtensionsPlan,
} from '../../../shared/extensions.ts'
import { localPresetFor, presetForModel, unknownLocalPreset } from '../../config/local-presets.ts'
import { isVendorFolderGranted } from '../../config/trust.ts'
import { FRESH_REASON_TEXT, previewFixSession, previewOptions, sameModel } from '../../supervisor/sessions.ts'
import type { VendorSnapshot } from '../cache.ts'
import type { CheckContext, PreflightCheckDef, PreflightInput } from '../engine.ts'
import { PASS_LABELS } from './run.ts'
import { vendorDefId, vendorDisplayName } from './vendor.ts'

/** Passes this preflight covers: the boundary pass, else every enabled pass. */
export function passesToCheck(input: PreflightInput): PassName[] {
  const cfg = input.config
  if (cfg === undefined) return []
  if (input.pass !== undefined) return [input.pass]
  return PASS_NAMES.filter((p) => cfg.passes[p].enabled)
}

/**
 * Whether the Plan pass runs in the vendor's native plan mode: `planning.native` is `auto`, the probe reports a
 * native plan capability and `vendor.<v>.plan` passed. Without a probe the answer is false (template plan).
 */
export function planNativeFor(
  config: Pick<ResolvedConfig, 'planning'>,
  snap: VendorSnapshot | undefined,
): boolean {
  if (config.planning.native !== 'auto' || snap === undefined) return false
  if (snap.probe.capabilities.planMode !== 'native') return false
  const plan = snap.checks.find((c) => c.id === vendorCheckId(snap.probe.vendor, 'plan'))
  return plan === undefined || plan.status === 'pass'
}

/** The ReadinessNeed for a pass (also what the supervisor passes to `support()` / `start()`). */
export function readinessNeedFor(
  config: ResolvedConfig,
  pass: PassName,
  snap: VendorSnapshot | undefined,
  o: { resumeSessionId?: string; trustFolder?: boolean; cwd?: string | undefined } = {},
): ReadinessNeed {
  const need: ReadinessNeed = {
    pass,
    mode: config.passes[pass].mode,
    planNative: pass === 'plan' && planNativeFor(config, snap),
    trustFolder: o.trustFolder ?? false,
  }
  if (pass === 'fix' && o.resumeSessionId !== undefined) need.resumeSessionId = o.resumeSessionId
  // The copy of a pass may depend on its Extensions level (Codex: whether its MCP servers are off).
  const extensions = config.passes[pass].extensions
  if (extensions !== undefined) need.extensions = extensions
  // Live balanced run: the folder, for copy that depends on its settings (Claude's shell allow-rules).
  if (o.cwd !== undefined) need.cwd = o.cwd
  // The preset a `local-<id>` vendor runs (readiness checks its loopback server).
  // With the pass's own model when it names one (that model is what runs and what the server must list).
  const local = localPresetFor(config, config.passes[pass].vendor)
  if (local !== undefined) need.local = presetForModel(local, config.passes[pass].model)
  return need
}

const otherPrimary = (vendor: string): string => (vendor === 'claude' ? 'codex' : 'claude')

/**
 * Preferring Claude/Codex, then any third vendor switch_vendor can use: the vendor a mode failure's switch names.
 * The first other known vendor (Claude, Codex, then the rest) whose launch probe is ready and that supports the mode;
 * with none ready, the other primary vendor (core checks readiness again at the click and says why it cannot switch).
 * Never an Experimental vendor (Muse): the user picks it under "More", Dim Factory does not suggest it.
 */
function switchAlternative(ctx: CheckContext, current: string, pass: PassName, mode: Mode): string {
  for (const id of KNOWN_VENDORS) {
    if (id === current || ctx.deps.adapters.isExperimental?.(id) === true) continue
    const snap = ctx.vendors.latest(id)
    if (snap === undefined || !snap.probe.ok || snap.checks.some((c) => c.status === 'fail' && c.blocking))
      continue
    const s = ctx.deps.adapters.get(id)?.support({ pass, mode, planNative: false, trustFolder: false })
    if (s !== undefined && s.status !== 'unsupported') return id
  }
  return otherPrimary(current)
}

/**
 * Readiness `trust` (trust.json vendorFolder): whether the user trusted the check's folder for `vendor` (a
 * `vendorFolder` grant). Only vendors that ask for folder trust read trust.json; without a folder or a grant reader
 * the answer is no (fail closed: the vendor's own readiness then asks for the grant).
 */
export async function folderTrusted(ctx: CheckContext, vendor: string): Promise<boolean> {
  if (!needsFolderTrust(vendor) || ctx.folder === undefined || ctx.deps.trustGrants === undefined)
    return false
  try {
    return isVendorFolderGranted(await ctx.deps.trustGrants(ctx.folder), vendor)
  } catch {
    return false
  }
}

function dedupe(actions: RecoveryAction[]): RecoveryAction[] {
  const seen = new Set<string>()
  return actions.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
}

function vendorOf(ctx: CheckContext, pass: PassName): { configured: string; id: string; name: string } {
  const configured = ctx.config?.passes[pass].vendor ?? ''
  return { configured, id: ctx.vendors.resolveId(configured), name: vendorDisplayName(ctx, configured) }
}

const subject =
  (pass: PassName) =>
  (ctx: CheckContext): string => {
    const p = ctx.config?.passes[pass]
    return `${pass}|${p?.vendor ?? ''}|${p?.model ?? ''}|${p?.mode ?? ''}|${ctx.folder ?? ''}`
  }

/**
 * `pass.<p>.effort` (warn, never a block): the pass names an effort level its vendor has no setting for (it runs at
 * its default effort), or one its model does not list (the vendor may refuse it or use its nearest level). Nothing
 * while the vendor's probe has not answered, nor when the model list does not describe the model's levels.
 */
function effortResult(
  ctx: CheckContext,
  pass: PassName,
  label: string,
): ReturnType<CheckContext['result']> | [] {
  const p = ctx.config?.passes[pass]
  const effort = p?.effort ?? null
  if (p === undefined || effort === null) return []
  const name = vendorDisplayName(ctx, p.vendor)
  const fix = {
    id: `${passCheckId(pass, 'effort')}.default`,
    label: `Use the default effort for ${label}`,
    kind: 'config_patch' as const,
    target: 'runOverrides' as const,
    ops: [{ op: 'add' as const, path: `/passes/${pass}/effort`, value: null }],
    preview: `passes.${pass}.effort: null`,
  }
  if (!supportsEffort(p.vendor)) {
    return ctx.result({
      status: 'warn',
      title: `${label}: ${name} has no effort setting`,
      detail: `${label} asks for ${effort} effort, but ${name} takes no effort level here, so it runs at its default.`,
      recovery: [fix],
    })
  }
  const snap = ctx.vendors.latest(ctx.vendors.resolveId(p.vendor))
  if (snap === undefined) return []
  const listed = modelEfforts(snap.probe.models, p.model)
  if (listed === undefined || listed.includes(effort)) return []
  const model = p.model ?? 'its default model'
  return ctx.result({
    status: 'warn',
    title: `${label}: ${model} does not list ${effort} effort`,
    detail: `${name} lists ${listed.join(', ')} for ${model}. It may refuse ${effort}, or run at another level.`,
    recovery: [fix],
  })
}

/**
 * `pass.<p>.extensions` (warn, never a block): a read-only pass set to Pass through (its MCP tools and hooks may act
 * outside the sandbox and may not respect read-only), or an Allowed list naming MCP servers the vendor's settings no
 * longer define (the pass runs without them). The servers are never named: the count says how many.
 */
async function extensionsResult(
  ctx: CheckContext,
  pass: PassName,
  label: string,
): Promise<ReturnType<CheckContext['result']> | []> {
  const cfg = ctx.config
  const p = cfg?.passes[pass]
  if (cfg === undefined || p === undefined) return []
  const level = p.extensions ?? defaultExtensionLevel(pass)
  const none = {
    id: `${passCheckId(pass, 'extensions')}.none`,
    label: `Run ${label} with no extensions`,
    kind: 'config_patch' as const,
    target: 'runOverrides' as const,
    ops: [{ op: 'add' as const, path: `/passes/${pass}/extensions`, value: 'none' }],
    preview: `passes.${pass}.extensions: none`,
  }
  if (level === 'passthrough' && isReadOnlyExtensionsPass(pass)) {
    return ctx.result({
      status: 'warn',
      title: `${label} uses every extension`,
      detail: `${label} runs at Pass through. ${PASSTHROUGH_READONLY_WARNING}`,
      recovery: [none],
    })
  }
  if (level !== 'allowed' || !extensionsSupport(p.vendor).mcp) return []
  const vendor = extensionsVendor(p.vendor)
  // The list the pass really gets: the Allowed list with this run's Tools on top (a picked server must exist too).
  const allowed = passExtensionsPlan({
    pass,
    vendor: p.vendor,
    level,
    allowed: allowedFor(cfg.extensions, p.vendor),
    tools: (cfg as Partial<ResolvedConfig>).tools,
  }).mcp
  if (allowed.length === 0 || ctx.deps.extensionNames === undefined) return []
  let found: { mcp: string[]; complete: boolean } | null
  try {
    found = await ctx.deps.extensionNames(vendor, ctx.folder)
  } catch {
    return []
  }
  if (found === null || !found.complete) return []
  const have = new Set(found.mcp)
  const missing = allowed.filter((n) => !have.has(n)).length
  if (missing === 0) return []
  const name = vendorDisplayName(ctx, vendor)
  const which = missing === 1 ? 'One MCP server' : `${missing} MCP servers`
  return ctx.result({
    status: 'warn',
    title: `${label}: ${missing === 1 ? 'an allowed MCP server is' : `${missing} allowed MCP servers are`} gone`,
    detail: `${which} on your allowed list for ${name} ${missing === 1 ? 'is' : 'are'} no longer in its settings, so ${label} runs without ${missing === 1 ? 'it' : 'them'}. Update the list in Settings, Extensions, or run ${label} with no extensions.`,
    recovery: [
      {
        id: `${passCheckId(pass, 'extensions')}.settings`,
        label: 'Open Extensions settings',
        kind: 'settings_link',
        route: 'settings/extensions',
        pointer: `/extensions/allowed/${vendor}/mcp`,
      },
      none,
    ],
  })
}

export function passCheckDefs(input: PreflightInput): PreflightCheckDef[] {
  const defs: PreflightCheckDef[] = []
  for (const pass of passesToCheck(input)) {
    const configured = input.config?.passes[pass].vendor ?? ''
    const label = PASS_LABELS[pass]
    const applies = (ctx: CheckContext): boolean => ctx.config !== undefined

    defs.push({
      id: passCheckId(pass, 'vendor'),
      scope: 'pass',
      title: `${label} vendor`,
      dependsOn: [vendorDefId(configured)],
      onDependencyFailure: 'run',
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: applies,
      subjectKey: subject(pass),
      run(ctx) {
        const v = vendorOf(ctx, pass)
        const model = ctx.config?.passes[pass].model
        const preset = unknownLocalPreset(ctx.config, v.configured)
        if (preset !== null) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: `${label}: no local preset "${preset}"`,
              detail: `Your settings list no local model preset with the id "${preset}". Add it, or pick another vendor.`,
              category: 'config_invalid',
              recovery: [
                {
                  id: `${passCheckId(pass, 'vendor')}.local-presets`,
                  label: 'Open the local model presets',
                  kind: 'settings_link',
                  route: 'settings/vendors',
                  pointer: '/local/presets',
                },
              ],
            }),
          )
        }
        if (ctx.deps.adapters.get(v.configured) === undefined) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: `${label}: unknown vendor "${v.configured}"`,
              detail: 'Pick a vendor Dim Factory supports for this pass.',
              category: 'config_invalid',
              recovery: [
                {
                  id: `${passCheckId(pass, 'vendor')}.settings`,
                  label: `Choose the ${label} vendor`,
                  kind: 'settings_link',
                  route: 'settings/passes',
                  pointer: `/passes/${pass}/vendor`,
                },
              ],
            }),
          )
        }
        const snap = ctx.vendors.latest(v.id)
        if (snap === undefined) {
          return Promise.resolve(
            ctx.result({
              status: 'skip',
              title: `${label}: checking ${v.name}…`,
              detail: `${v.name} has not been probed yet.`,
            }),
          )
        }
        const blockers = snap.checks.filter((c) => c.status === 'fail' && c.blocking)
        if (blockers.length > 0) {
          const first = blockers[0] as CheckResult
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: `${label}: ${first.title}`,
              detail: blockers.map((b) => `${b.title}. ${b.detail}`).join('\n'),
              category: first.category ?? 'capability_missing',
              recovery: dedupe(blockers.flatMap((b) => b.recovery)),
            }),
          )
        }
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            title: `${label}: ${v.name}${model ? ` · ${model}` : ''}`,
            detail: snap.probe.version !== undefined ? `${v.name} ${snap.probe.version}` : v.name,
          }),
        )
      },
    })

    defs.push({
      id: passCheckId(pass, 'mode'),
      scope: 'pass',
      title: `${label} mode`,
      dependsOn: [passCheckId(pass, 'vendor')],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: applies,
      subjectKey: subject(pass),
      run(ctx) {
        const cfg = ctx.config as ResolvedConfig
        const v = vendorOf(ctx, pass)
        const adapter = ctx.deps.adapters.get(v.configured)
        if (adapter === undefined) return Promise.resolve([])
        const need = readinessNeedFor(cfg, pass, ctx.vendors.latest(v.id), {
          ...(ctx.input.resumeSessionId !== undefined ? { resumeSessionId: ctx.input.resumeSessionId } : {}),
          cwd: ctx.folder,
        })
        const s = adapter.support(need)
        const mode = cfg.passes[pass].mode
        if (s.status === 'unsupported') {
          const alt = switchAlternative(ctx, v.id, pass, mode)
          // Codex with its Windows sandbox not ready (autoedit unsupported; fix: vendor_setup unelevated → elevated
          // shell_copy; sandbox_unavailable): the vendor's own sandbox fixes, as its
          // probe offers them on vendor.<v>.winSandbox (its own switch included), so every pass the sandbox blocks
          // shows the same fix once.
          const sandbox =
            s.reason?.startsWith('winSandbox-') === true
              ? ctx.vendors
                  .latest(v.id)
                  ?.checks.find((c) => c.id === vendorCheckId(v.id, 'winSandbox') && c.status !== 'pass')
              : undefined
          const recovery: RecoveryAction[] = [...(sandbox?.recovery ?? [])]
          if (!recovery.some((a) => a.kind === 'switch_vendor')) {
            recovery.push({
              id: `${passCheckId(pass, 'mode')}.switch`,
              label: `Use ${vendorDisplayName(ctx, alt)} for ${label}`,
              kind: 'switch_vendor',
              pass,
              to: alt,
              model: null,
            })
          }
          if ((READONLY_PASSES as readonly PassName[]).includes(pass)) {
            recovery.push({
              id: `${passCheckId(pass, 'mode')}.disable`,
              label: `Run without ${label}`,
              kind: 'config_patch',
              target: 'runOverrides',
              ops: [{ op: 'add', path: `/passes/${pass}/enabled`, value: false }],
              preview: `passes.${pass}.enabled: false`,
            })
          }
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: `${v.name} cannot run ${label} in ${mode} mode`,
              // The sandbox case says it all in the copy (its reason is a code: winSandbox-notConfigured).
              detail:
                sandbox === undefined && s.reason !== undefined && s.reason !== s.copy
                  ? `${s.copy} (${s.reason})`
                  : s.copy,
              category: sandbox !== undefined ? 'sandbox_unavailable' : 'capability_missing',
              recovery,
            }),
          )
        }
        if (s.status === 'degraded') {
          return Promise.resolve(
            ctx.result({
              status: 'warn',
              title: `${label}: ${mode} is limited on ${v.name}`,
              detail: s.copy,
            }),
          )
        }
        return Promise.resolve(ctx.result({ status: 'pass', title: `${label}: ${mode}`, detail: s.copy }))
      },
    })

    // `pass.<p>.relay` (W): a pass that may need to ask (autoedit) on a route without a question relay
    // (Codex's exec fallback): what would ask is denied by the vendor, never shown. Read-only passes never ask, and
    // full mode asks nothing.
    defs.push({
      id: passCheckId(pass, 'relay'),
      scope: 'pass',
      title: `${label} questions`,
      dependsOn: [passCheckId(pass, 'vendor')],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: (ctx) => applies(ctx) && ctx.config?.passes[pass].mode === 'autoedit',
      subjectKey: subject(pass),
      run(ctx) {
        const v = vendorOf(ctx, pass)
        const snap = ctx.vendors.latest(v.id)
        // Only a probe that resolved its route knows whether that route relays questions.
        const route = snap?.probe.route
        if (snap === undefined || route === undefined || snap.probe.capabilities.askRelay) {
          return Promise.resolve([])
        }
        return Promise.resolve(
          ctx.result({
            status: 'warn',
            title: `${label}: asks auto-denied, not prompted`,
            detail: `${v.name} runs without a question relay here (${route} route): anything it would ask you is denied automatically.`,
          }),
        )
      },
    })

    defs.push({
      id: passCheckId(pass, 'effort'),
      scope: 'pass',
      title: `${label} effort`,
      dependsOn: [passCheckId(pass, 'vendor')],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: (ctx) => applies(ctx) && (ctx.config?.passes[pass].effort ?? null) !== null,
      subjectKey: (ctx) => `${subject(pass)(ctx)}|${ctx.config?.passes[pass].effort ?? ''}`,
      run(ctx) {
        return Promise.resolve(effortResult(ctx, pass, label))
      },
    })

    defs.push({
      id: passCheckId(pass, 'extensions'),
      scope: 'pass',
      title: `${label} extensions`,
      dependsOn: [passCheckId(pass, 'vendor')],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: (ctx) => applies(ctx) && (ctx.config?.passes[pass].enabled ?? false),
      subjectKey: (ctx) => {
        const c = ctx.config
        const p = c?.passes[pass]
        const allowed = p !== undefined ? allowedFor(c?.extensions, p.vendor) : undefined
        // The allow list (and the run's Tools) as a digest: the names never sit in a cache key.
        const digest = createHash('sha256')
          .update(
            JSON.stringify([allowed ?? null, (c as Partial<ResolvedConfig> | undefined)?.tools ?? null]),
          )
          .digest('hex')
          .slice(0, 16)
        return `${subject(pass)(ctx)}|${p?.extensions ?? ''}|${digest}`
      },
      run(ctx) {
        return extensionsResult(ctx, pass, label)
      },
    })

    defs.push({
      id: `pass.${pass}.readiness`,
      scope: 'pass',
      title: `${label} readiness`,
      dependsOn: [passCheckId(pass, 'vendor')],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative', 'passBoundary'],
      appliesTo: (ctx) => applies(ctx) && ctx.folder !== undefined,
      subjectKey: subject(pass),
      async run(ctx) {
        const cfg = ctx.config as ResolvedConfig
        const v = vendorOf(ctx, pass)
        const adapter = ctx.deps.adapters.get(v.configured)
        if (adapter === undefined) return []
        const need = readinessNeedFor(cfg, pass, ctx.vendors.latest(v.id), {
          ...(ctx.input.resumeSessionId !== undefined ? { resumeSessionId: ctx.input.resumeSessionId } : {}),
          // Readiness `trust`: the folder's trust.json vendorFolder grant for this vendor.
          trustFolder: await folderTrusted(ctx, v.id),
        })
        try {
          return await adapter.readiness(ctx.folder ?? '', need)
        } catch (err) {
          return ctx.result({
            id: `pass.${pass}.readiness.error`,
            status: 'warn',
            title: `${label}: readiness could not be checked`,
            detail: err instanceof Error ? err.message : String(err),
            category: 'unknown',
          })
        }
      },
    })

    if (pass === 'plan') {
      defs.push({
        id: passCheckId('plan', 'native'),
        scope: 'pass',
        title: 'Plan mode',
        dependsOn: [passCheckId('plan', 'vendor')],
        cost: 'cheap',
        ttlMs: 0,
        modes: ['live', 'authoritative', 'passBoundary'],
        appliesTo: applies,
        subjectKey: subject('plan'),
        run(ctx) {
          const cfg = ctx.config as ResolvedConfig
          const v = vendorOf(ctx, 'plan')
          if (cfg.planning.native === 'off') {
            return Promise.resolve(
              ctx.result({
                status: 'pass',
                title: 'Plan uses the plan template',
                detail: 'Native planning is off; Plan runs read-only with the plan template.',
              }),
            )
          }
          const snap = ctx.vendors.latest(v.id)
          if (planNativeFor(cfg, snap)) {
            const copy = ctx.deps.adapters
              .get(v.configured)
              ?.support(readinessNeedFor(cfg, 'plan', snap, { cwd: ctx.folder })).copy
            return Promise.resolve(
              ctx.result({
                status: 'pass',
                title: `Native plan mode (${v.name})`,
                detail: copy ?? `${v.name} plans in its own plan mode; Dim Factory captures the plan.`,
              }),
            )
          }
          return Promise.resolve(
            ctx.result({
              status: 'pass',
              title: 'Plan uses the plan template',
              detail:
                snap === undefined
                  ? `${v.name} has not been probed yet; Plan falls back to a read-only run with the plan template.`
                  : `${v.name} has no native plan mode here; Plan runs read-only with the plan template.`,
            }),
          )
        },
      })
    }

    if (pass === 'fix') defs.push(fixResumeDef(configured))
  }
  return defs
}

/** A model as the check words it (null = the CLI's default). */
const modelWords = (m: string | null): string =>
  m === null || m.trim() === '' ? "the CLI's default model" : m

const FRESH_TAIL =
  "it gets the task, the plan and the changes so far instead of continuing Implement's conversation."

/**
 * `pass.fix.resume` (info): whether Fix will continue Implement's session for the resolved
 * config. Before a run only the static rules are known — the Fix row's choice, the vendors, the Fix vendor's resume
 * capability and model switch (sessions.ts `previewFixSession`, which the composer's `fixSession` suggestion uses
 * too). Implement's session, canResume and the folder are runtime facts: the Fix card's session line says what
 * happened. The Fix vendor counts as the composer counts it (sessions.ts `previewOptions`): ready = probed with no
 * blocking failure, and only then its capabilities. It runs after that vendor's check (which probes it in the
 * authoritative preflight), so it reads the probe store once that check has filled it, failed or not.
 */
function fixResumeDef(configuredFixVendor: string): PreflightCheckDef {
  return {
    id: passCheckId('fix', 'resume'),
    scope: 'pass',
    title: 'Fix session',
    dependsOn: [vendorDefId(configuredFixVendor)],
    onDependencyFailure: 'run',
    cost: 'cheap',
    ttlMs: 0,
    modes: ['live', 'authoritative'],
    appliesTo: (ctx) => ctx.config !== undefined,
    subjectKey: (ctx) => {
      const p = ctx.config?.passes
      return [
        'fix-resume',
        p?.implement.vendor ?? '',
        p?.implement.model ?? '',
        p?.fix.vendor ?? '',
        p?.fix.model ?? '',
        String(p?.fix.reuseSession),
      ].join('|')
    },
    run(ctx) {
      const { implement, fix } = (ctx.config as ResolvedConfig).passes
      const snap = ctx.vendors.latest(ctx.vendors.resolveId(fix.vendor))
      const d = previewFixSession(
        { implement, fix },
        previewOptions(
          snap && {
            ready: !snap.checks.some((c) => c.status === 'fail' && c.blocking),
            capabilities: snap.probe.capabilities,
          },
        ),
      )
      const fixName = vendorDisplayName(ctx, fix.vendor)
      if (d.reuse) {
        const sw = sameModel(fix.model, implement.model)
          ? ''
          : ` It switches the session to ${modelWords(fix.model)}.`
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            title: "Fix will continue Implement's session",
            detail: `${fixName} resumes the session Implement leaves, so Fix keeps Implement's context.${sw}`,
          }),
        )
      }
      const why: Partial<Record<FreshReason, string>> = {
        'override-fresh': `The Fix session is set to start fresh: ${FRESH_TAIL}`,
        'override-other-vendor': `Fix is set to start fresh on ${fixName}: ${FRESH_TAIL}`,
        'vendor-differs':
          `Fix runs on ${fixName} and Implement on ${vendorDisplayName(ctx, implement.vendor)}; ` +
          'a session cannot move between vendors.',
        'cannot-resume': `${fixName} cannot continue a session, so Fix starts a new one.`,
        'model-differs':
          `Fix uses ${modelWords(fix.model)} and Implement ${modelWords(implement.model)}; ` +
          `${fixName} cannot switch models when it resumes a session.`,
      }
      const text = FRESH_REASON_TEXT[d.reason]
      return Promise.resolve(
        ctx.result({
          status: 'pass',
          title: `Fix will start fresh: ${text}`,
          detail: why[d.reason] ?? `${text.charAt(0).toUpperCase()}${text.slice(1)}.`,
        }),
      )
    },
  }
}
