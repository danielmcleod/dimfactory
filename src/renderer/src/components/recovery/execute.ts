// Recovery executors on the renderer side. Every
// action runs through `recovery.execute{actionId, runId?|folder?}`; core does the work and the renderer follows its
// result (navigate to the route, say it was copied or opened, offer Undo for a saved config fix, hand composer
// overrides back). When this build's core answers UNSUPPORTED for a kind, the run commands the older UI used (retry,
// skip, close, resume), the renderer clipboard and `shell.open` stand in; the three kinds that change nothing (copy,
// link, docs) also stand in when core has no record of the action. An action core marks `disabledReason` and a switch
// to a vendor that is not ready render disabled with the reason (laterReason). `vendor_setup` runs on its click,
// through components/recovery/sandboxSetup.ts. The vendorFolder grant runs like any other grant; the composer's
// strip and the setup card show it as the folder trust chip (components/recovery/FolderTrustChip.tsx).
import { useSyncExternalStore } from 'react'
import type { JsonPatchOp, RecoveryAction, RecoveryActionKind } from '@shared/failure.ts'
import type { ConfigPatchPersisted, RecoveryResult } from '@shared/ipc.ts'
import type { StepKey } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../ipc/client.ts'
import { vendorName } from '../../lib/format.ts'
import { navigate } from '../../lib/router.ts'
import { upsertProbes } from '../../state/actions.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { LATER_VERSION } from '../ui/DisabledHint.tsx'
import { runCommand } from '../run/commands.ts'
import { isAgent } from '../run/text.ts'

/** Where the actions were offered: a run (snag, run preflight card), a folder (composer preflight) or neither (probe). */
export interface RecoveryContext {
  runId?: string
  folder?: string
  /** The failed step of a snag: the pass the run-command fallback retries. */
  step?: StepKey
  /**
   * A composer preflight fix (config_patch `runOverrides` outside a run): core answers the checked ops and the
   * composer applies them to its run overrides. Nothing was written.
   */
  onOverrides?: ((ops: JsonPatchOp[]) => unknown) | undefined
}

/** Executors this build does not have yet: shown disabled. None today (vendor_setup runs on its click). */
export const LATER_KINDS: ReadonlySet<RecoveryActionKind> = new Set<RecoveryActionKind>()

/** A vendor that can take over a pass: ready, or ready with a warning (the health strip's reading). */
function usable(p: ProbeView): boolean {
  return p.health === 'ready' || p.health === 'warning'
}

/**
 * Why an action cannot run now, or null when it can: core's own `disabledReason` first; then a kind this build
 * does not have yet (none today); then a `switch_vendor` to a vendor this
 * build lacks ("Available in a later version") or that is not ready (its health in words): switch_vendor is built
 * but renders disabled until a second vendor is ready.
 */
export function laterReason(a: RecoveryAction, probe: ProbeView | undefined): string | null {
  if (a.disabledReason !== undefined && a.disabledReason.trim() !== '') return a.disabledReason
  if (LATER_KINDS.has(a.kind)) return LATER_VERSION
  if (a.kind === 'switch_vendor') {
    if (probe === undefined || !probe.built || probe.health === 'not-built') return LATER_VERSION
    if (!usable(probe)) return `${probe.displayName || vendorName(a.to)} is not ready: ${probe.healthDetail}`
  }
  return null
}

export const COPIED_MESSAGE = 'Copied. Run it in a terminal.'
export const COPIED_ELEVATED_MESSAGE = 'Copied. Run it in an administrator terminal.'
export const ELEVATED_NOTE = 'Run in an administrator terminal'
/** What an elevated command brings up on Windows (the Codex sandbox's elevated setup, X11c). */
export const UAC_NOTE = 'Windows asks you to allow it (a UAC prompt)'
export const OPENED_MESSAGE = 'Opened in your browser'
export const RECHECK_LABEL = 'I ran it → Re-check'
export const NO_OVERRIDES_MESSAGE =
  'Change this in the pass rows of the composer: it cannot be applied from here.'

// ---- what this build's core supports, per kind --------------------------------------------------------------------

type Support = 'unknown' | 'yes' | 'no'
const support = new Map<RecoveryActionKind, Support>()
const listeners = new Set<() => void>()
/** Routes core resolved for settings_link actions, by context + action id. */
const routes = new Map<string, string>()
const ROUTES_KEPT = 200
const resolving = new Map<string, Promise<void>>()

/** What a recovery.execute answer said about this build's core and `kind` (also the sandbox setup's own call). */
export function noteKindSupport(kind: RecoveryActionKind, s: Exclude<Support, 'unknown'>): void {
  setSupport(kind, s)
}

function setSupport(kind: RecoveryActionKind, s: Support): void {
  if (support.get(kind) === s) return
  support.set(kind, s)
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Whether core executes `kind` in this build: 'unknown' until a recovery.execute for that kind answered. */
export function useKindSupport(kind: RecoveryActionKind): Support {
  return useSyncExternalStore(subscribe, () => support.get(kind) ?? 'unknown')
}

/** Tests: forget what was learned about core's executors. */
export function resetRecoveryForTests(): void {
  support.clear()
  routes.clear()
  resolving.clear()
  for (const l of [...listeners]) l()
}

function contextKey(a: RecoveryAction, ctx: RecoveryContext): string {
  return `${ctx.runId ?? ''}|${ctx.folder ?? ''}|${a.id}`
}

function request(
  a: RecoveryAction,
  ctx: RecoveryContext,
): { actionId: string; runId?: string; folder?: string } {
  return {
    actionId: a.id,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    ...(ctx.folder !== undefined ? { folder: ctx.folder } : {}),
  }
}

/** recovery.execute's request for an action in its context. */
export const recoveryRequest = request

/** A route as a hash (core's `#/settings/vendors?field=…` is one already). */
export function routeHash(route: string): string {
  if (route.startsWith('#')) return route
  return route.startsWith('/') ? `#${route}` : `#/${route}`
}

/**
 * The link of a settings_link the way core builds it (`settings/<section>` + pointer → `#/settings/<section>?field=
 * <pointer>`, plus `&folder=` for a project file's link; `composer` → `#/?field=…`), for when core cannot look the
 * action up.
 */
export function settingsLinkHref(a: Extract<RecoveryAction, { kind: 'settings_link' }>): string {
  const segs = a.route.split('/').filter((s) => s !== '')
  const field = a.pointer === '' ? [] : [`field=${encodeURIComponent(a.pointer)}`]
  if (segs[0] === undefined || segs[0] === 'composer' || segs[0] === 'dashboard')
    return `#/${field.length > 0 ? `?${field.join('')}` : ''}`
  const s =
    typeof a.suggested === 'object' && a.suggested !== null ? (a.suggested as Record<string, unknown>) : {}
  const folder =
    s['scope'] === 'project' && typeof s['folder'] === 'string' && s['folder'] !== ''
      ? [`folder=${encodeURIComponent(s['folder'])}`]
      : []
  const params = [...field, ...folder]
  return `#/${segs.map(encodeURIComponent).join('/')}${params.length > 0 ? `?${params.join('&')}` : ''}`
}

/**
 * A settings_link only resolves a route in core (no other effect), so it is resolved when first shown while this
 * build's support for it is unknown: the button waits for that answer instead of offering a link that may not work.
 */
export function resolveSettingsLink(a: RecoveryAction, ctx: RecoveryContext): Promise<void> {
  const key = contextKey(a, ctx)
  const pending = resolving.get(key)
  if (pending !== undefined) return pending
  const p = (async () => {
    const r = await invoke('recovery.execute', request(a, ctx))
    if (r.ok) {
      if (r.value.route !== undefined) {
        routes.set(key, r.value.route)
        // Oldest first out: a long session shows many preflight reports.
        if (routes.size > ROUTES_KEPT) routes.delete(routes.keys().next().value ?? key)
      }
      setSupport('settings_link', 'yes')
    } else {
      // Any other answer means the command exists; a click executes again and shows core's message.
      setSupport('settings_link', r.error.code === 'UNSUPPORTED' ? 'no' : 'yes')
    }
  })().finally(() => resolving.delete(key))
  resolving.set(key, p)
  return p
}

// ---- running an action ---------------------------------------------------------------------------------------------

export type Outcome = 'done' | 'copied' | 'failed'

async function copyLocally(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    toast({ level: 'error', message: 'Could not copy the command to the clipboard.' })
    return false
  }
}

function copiedToast(a: Extract<RecoveryAction, { kind: 'shell_copy' }>): void {
  toast({ level: 'info', message: a.elevated === true ? COPIED_ELEVATED_MESSAGE : COPIED_MESSAGE })
}

/** Where a saved config fix went, in words. */
export function savedWhere(list: readonly ConfigPatchPersisted[]): string {
  return list.every((p) => p.scope === 'user') ? 'your user config' : "the project's config"
}

/** The ops that take a saved fix back out of a file Dim Factory created for it (no backup to restore). */
function removalOps(ops: readonly JsonPatchOp[]): JsonPatchOp[] {
  return ops
    .filter((op) => op.op === 'add' || op.op === 'replace')
    .map((op) => ({ op: 'remove', path: op.path }))
}

/** Undo a saved config fix: each file back to core's backup (or the keys removed from a file it created). */
async function undoPersisted(a: RecoveryAction, list: readonly ConfigPatchPersisted[]): Promise<void> {
  const ops = a.kind === 'config_patch' ? removalOps(a.ops) : []
  for (const p of list) {
    const where = p.folder !== undefined ? { folder: p.folder } : {}
    const r =
      p.backupId !== null
        ? await invoke('config.restoreBackup', { scope: p.scope, ...where, backupId: p.backupId })
        : ops.length > 0
          ? await invoke('config.patch', { scope: p.scope, ...where, ops })
          : null
    if (r !== null && !r.ok) toast({ level: 'error', message: r.error.message })
  }
}

/** A config fix core applied and saved: core's words (or where it went) with Undo. */
function persistedToast(a: RecoveryAction, res: RecoveryResult, list: readonly ConfigPatchPersisted[]): void {
  const said = res.message !== undefined && res.message !== '' ? res.message : `Saved to ${savedWhere(list)}.`
  toast({
    id: `recovery-saved:${a.id}`,
    level: 'info',
    message: said,
    action: { label: 'Undo', onClick: () => undoPersisted(a, list) },
  })
}

/** What to do with core's answer. */
async function follow(a: RecoveryAction, res: RecoveryResult, ctx: RecoveryContext): Promise<Outcome> {
  switch (a.kind) {
    case 'shell_copy': {
      // Main copies through its clipboard; when it did not (no `copied`), copy here instead.
      if (res.copied === undefined && !(await copyLocally(a.command))) return 'failed'
      copiedToast(a)
      return 'copied'
    }
    case 'settings_link':
      navigate(res.route !== undefined ? routeHash(res.route) : settingsLinkHref(a))
      return 'done'
    case 'open_docs':
      toast({ level: 'info', message: OPENED_MESSAGE })
      return 'done'
    case 'config_patch': {
      const persisted = res.persisted ?? []
      // Saved: the toast says so and offers Undo (a saved fix also reaches the composer through its config).
      if (persisted.length > 0) persistedToast(a, res, persisted)
      else if (res.overrides !== undefined && ctx.onOverrides === undefined) {
        // A composer fix shown where nothing takes the ops: say so rather than core's "Changed for this run".
        toast({ level: 'warn', message: NO_OVERRIDES_MESSAGE })
        return 'failed'
      } else if (res.message !== undefined && res.message !== '')
        toast({ level: 'info', message: res.message })
      if (res.overrides !== undefined) await ctx.onOverrides?.(res.overrides)
      if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
      return 'done'
    }
    case 'heal':
      // Outside a run the outcome comes with the answer and the control shows it; a run's arrives as StepView.heal.
      if (res.heal === undefined && res.message !== undefined && res.message !== '')
        toast({ level: 'info', message: res.message })
      if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
      return 'done'
    case 'switch_vendor':
      // Outside a run core answers the switch as run overrides for the composer (like a config_patch).
      if (res.overrides !== undefined) {
        if (ctx.onOverrides === undefined) {
          toast({ level: 'warn', message: NO_OVERRIDES_MESSAGE })
          return 'failed'
        }
        await ctx.onOverrides(res.overrides)
      }
      if (res.message !== undefined && res.message !== '') toast({ level: 'info', message: res.message })
      if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
      return 'done'
    case 'retry':
    case 'resume':
    case 'vendor_setup':
    case 'grant':
    case 'wait_until':
    case 'skip_pass':
    case 'close_run':
      if (res.message !== undefined && res.message !== '') toast({ level: 'info', message: res.message })
      if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
      return 'done'
  }
}

/** Kinds the renderer can carry out itself when core does not know the action: none of them changes anything. */
const LOCAL_KINDS: ReadonlySet<RecoveryActionKind> = new Set<RecoveryActionKind>([
  'shell_copy',
  'settings_link',
  'open_docs',
])

/**
 * This build's core has no executor for the kind (or, for the local kinds, no record of the action): the commands
 * the older UI ran directly, the renderer clipboard, `shell.open` (main re-checks the URL) and the router.
 */
async function fallback(a: RecoveryAction, ctx: RecoveryContext): Promise<Outcome> {
  const runId = ctx.runId
  const ran = (ok: boolean): Outcome => (ok ? 'done' : 'failed')
  switch (a.kind) {
    case 'shell_copy':
      if (!(await copyLocally(a.command))) return 'failed'
      copiedToast(a)
      return 'copied'
    case 'settings_link':
      if (support.get('settings_link') !== 'yes') break
      navigate(settingsLinkHref(a))
      return 'done'
    case 'open_docs': {
      const r = await invoke('shell.open', { target: 'url', url: a.url })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return 'failed'
      }
      toast({ level: 'info', message: OPENED_MESSAGE })
      return 'done'
    }
    case 'retry':
      if (runId !== undefined && ctx.step !== undefined && isAgent(ctx.step)) {
        const pass = ctx.step
        const strategy = a.strategy !== undefined ? { strategy: a.strategy } : {}
        return ran((await runCommand(runId, 'runs.retryPass', { runId, pass, ...strategy })).ok)
      }
      break
    case 'skip_pass':
      if (runId !== undefined)
        return ran((await runCommand(runId, 'runs.skipPass', { runId, pass: a.pass })).ok)
      break
    case 'close_run':
      if (runId !== undefined) return ran((await runCommand(runId, 'runs.close', { runId })).ok)
      break
    case 'resume':
      if (runId !== undefined) return ran((await runCommand(runId, 'runs.resume', { runId })).ok)
      break
    case 'config_patch':
    case 'vendor_setup':
    case 'switch_vendor':
    case 'grant':
    case 'wait_until':
    case 'heal':
      break
  }
  setSupport(a.kind, 'no')
  toast({ level: 'warn', message: `${a.label}: ${LATER_VERSION.toLowerCase()}.` })
  return 'failed'
}

/** An action's outcome, with core's answer when it gave one (wait_until's wait, a run-less heal's outcome). */
export interface Executed {
  outcome: Outcome
  result?: RecoveryResult
}

/** Run one action and keep core's answer: recovery.execute, then follow it; core's error message becomes a toast. */
export async function execute(a: RecoveryAction, ctx: RecoveryContext): Promise<Executed> {
  const key = contextKey(a, ctx)
  const known = a.kind === 'settings_link' ? routes.get(key) : undefined
  if (known !== undefined) {
    navigate(routeHash(known))
    return { outcome: 'done' }
  }
  const r = await invoke('recovery.execute', request(a, ctx))
  if (r.ok) {
    setSupport(a.kind, 'yes')
    return { outcome: await follow(a, r.value, ctx), result: r.value }
  }
  if (r.error.code === 'UNSUPPORTED') return { outcome: await fallback(a, ctx) }
  if (r.error.code === 'NOT_FOUND' && LOCAL_KINDS.has(a.kind)) return { outcome: await fallback(a, ctx) }
  toast({ level: 'error', message: r.error.message })
  return { outcome: 'failed' }
}

/** Run one action: recovery.execute, then follow core's result; core's error message becomes a toast. */
export async function executeAction(a: RecoveryAction, ctx: RecoveryContext): Promise<Outcome> {
  return (await execute(a, ctx)).outcome
}

// ---- I ran it → Re-check ------------------------------------------------------------------------------------------

/** The vendor a check id belongs to: `vendor.claude.auth` → `claude`; null for app/folder/run/pass checks. */
export function recheckVendor(checkId: string): string | null {
  const m = /^vendor\.([a-z][a-z0-9-]*)\./.exec(checkId)
  return m?.[1] ?? null
}

/**
 * Re-probe the vendor the copied command fixes (`vendors.probe {force}`), say how it is now, then let whoever showed
 * the action re-run its checks (the composer's preflight, a preflight card's Recheck).
 */
export async function recheck(
  a: Extract<RecoveryAction, { kind: 'shell_copy' }>,
  onRecheck: (() => unknown) | undefined,
): Promise<void> {
  const vendor = recheckVendor(a.recheck)
  if (vendor !== null) {
    const r = await invoke('vendors.probe', { vendor, force: true })
    if (r.ok) {
      upsertProbes(r.value)
      const view: ProbeView | undefined = r.value.find((v) => v.vendor === vendor)
      if (view !== undefined)
        toast({
          level: view.health === 'ready' || view.health === 'warning' ? 'info' : 'warn',
          message: `${view.displayName}: ${view.healthDetail}`,
        })
    } else {
      toast({ level: 'error', message: r.error.message })
    }
  }
  await onRecheck?.()
}

/** Whether Re-check has anything to do for this action. */
export function canRecheck(a: Extract<RecoveryAction, { kind: 'shell_copy' }>, onRecheck: unknown): boolean {
  return recheckVendor(a.recheck) !== null || onRecheck !== undefined
}
