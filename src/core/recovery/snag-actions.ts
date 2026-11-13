// Snag recovery lists (each failure category's recovery, primary first): the
// category's templates (heal/categories.ts) materialized into RecoveryAction[] for one failed step, followed by the
// default set (Resume · Retry · Continue without · Close run, cards.ts defaultSnagActions). Templates whose condition
// does not hold, or that have nothing to point at (no command for the vendor, no docs page, no model to drop), are
// left out. Ids are stable per step: `<step>:<what>` and `run:close` (the default set's ids are kept).
import { localClockText } from '../../shared/clock-text.ts'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { Failure, JsonPatchOp, RecoveryAction } from '../../shared/failure.ts'
import type { Mode, StepKey } from '../../shared/run.ts'
import { READONLY_PASSES, configPassOf, isAgentStep } from '../../shared/run.ts'
import {
  accountDefaultMayDiffer,
  localPresetIdOf,
  modelOverrideIgnored,
  namesModel,
  needsFolderTrust,
} from '../../shared/vendors.ts'
import { CATEGORY_INFO, fillTemplate } from '../heal/categories.ts'
import type { RecoveryCondition, RecoveryTemplate } from '../heal/categories.ts'
import type { OsFamily } from '../heal/commands.ts'
import { commandFor, gitInstallCommand, osFamily, repairCommand } from '../heal/commands.ts'
import { defaultSnagActions, stepLabel } from '../supervisor/cards.ts'
import { patchPreview } from './config-patch.ts'
import { docsLink } from './docs.ts'
import type { SwitchTarget } from './switch-vendor.ts'

export interface SnagActionInput {
  step: StepKey
  failure: Failure
  hasSession: boolean
  /** `failureHints` from the adapter (e.g. `claude-env-key`). */
  hints: readonly string[]
  /** When the failure happened (a `retryAfterMs` counts from it). */
  at: number
  /** The step's vendor and its display name. */
  vendor?: string
  vendorName?: string
  platform?: NodeJS.Platform
  /** The run's config now (models, extraArgs; the patch previews diff against it). */
  config?: ResolvedConfig
  /** The vendor adapter's testedUpTo (the pinned-install command). */
  testedUpTo?: string
  /** The pass's mode (switch_vendor readiness). */
  mode?: Mode
  /** switch_vendor's target (null: no other vendor exists). */
  switchTarget?: SwitchTarget | null
  /** The run's folder (git safe.directory). */
  folder?: string
  /** Local time of day for a wait (`14:05`); default from the platform clock. */
  clockText?: (at: number, now: number) => string
  /**
   * Live balanced run: the model the failed spawn ran because the pass names none, as its vendor said (StepState
   * .modelUsed); absent when the vendor did not say (Codex's exec route: the CLI chose).
   */
  modelUsed?: string
  /**
   * Live balanced run: with modelUsed, the model the vendor's own settings chose, which Dim Factory replaced with the
   * account's default (StepState.modelReplaced).
   */
  modelReplaced?: string
  /**
   * The account's default Dim Factory asked for on turn/start in place of modelReplaced,
   * which the vendor never confirmed running (StepState.modelAsked; modelUsed is then absent).
   */
  modelAsked?: string
  /**
   * Live balanced run: the vendor's default model for this account, as its probe listed it (Codex: model/list's
   * `isDefault`), for a vendor whose pass with no model may run another (ACCOUNT_DEFAULT_VENDORS); absent otherwise.
   */
  accountDefaultModel?: string
}

export { localClockText }

/**
 * When a wait_until for this failure retries: the vendor's reset time or its retry-after, else null. A limit that
 * named no time gets no wait (Dim Factory never invents a reset time, and a rate limit is retried
 * on its own only when retry-after ≤ 120 s); the snag's Retry and switch_vendor remain.
 */
export function waitUntilFor(f: Failure, at: number): number | null {
  if (f.resetsAt !== undefined && Number.isFinite(f.resetsAt)) return f.resetsAt
  if (f.retryAfterMs !== undefined && Number.isFinite(f.retryAfterMs)) return at + Math.max(0, f.retryAfterMs)
  return null
}

/** context_exceeded on a pass whose prompt has no diff to trim (Plan, Implement). */
export const FRESH_SESSION_LABEL = 'Retry in a fresh session'

const GIT_OP = /\b(merge|rebase|cherry-pick|revert|am|bisect)\b/i
const LIMIT_FLAGS = ['--max-turns', '--max-budget-usd']

const isLimitArg = (a: string): boolean => LIMIT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))

/** extraArgs without the turn / budget limit flags (and their values), or null when there are none. */
function withoutLimitFlags(args: readonly string[]): string[] | null {
  const out: string[] = []
  let dropped = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (isLimitArg(a)) {
      dropped = true
      if (!a.includes('=') && i + 1 < args.length && !(args[i + 1] as string).startsWith('-')) i++
      continue
    }
    out.push(a)
  }
  return dropped ? out : null
}

function holds(cond: RecoveryCondition | undefined, i: SnagActionInput, os: OsFamily): boolean {
  const text = `${i.failure.message}\n${i.failure.raw}`
  switch (cond) {
    case undefined:
      return true
    case 'session-exists':
      return i.hasSession
    case 'claude-env-key':
      return i.hints.includes('claude-env-key')
    case 'size-guard':
      return i.hints.includes('size-guard') || /very large|too large|20,000 files|1 GB/i.test(text)
    case 'git-lock':
      return /index\.lock/i.test(text)
    case 'git-dubious':
      return /dubious ownership/i.test(text)
    case 'git-op':
      return GIT_OP.test(text) && /in progress|--abort|--continue|MERGE_HEAD|unmerged/i.test(text)
    case 'win32':
      return os === 'win32'
    case 'pass-optional':
      return (READONLY_PASSES as readonly string[]).includes(i.step)
    case 'tested-up-to':
      return i.testedUpTo !== undefined && i.testedUpTo !== ''
    case 'limit-in-extra-args': {
      const args = i.vendor !== undefined ? i.config?.vendors[i.vendor]?.extraArgs : undefined
      return args !== undefined && withoutLimitFlags(args) !== null
    }
  }
}

/** The vendor whose sandbox a `sandboxSetup` command sets up: a local preset's is Codex's. */
const sandboxVendor = (kind: string, vendor: string): string =>
  kind === 'sandboxSetup' && localPresetIdOf(vendor) !== null ? 'codex' : vendor

/** The check a shell_copy fixes (its "I ran it, Re-check"). */
function recheckFor(kind: string, vendor: string | undefined): string {
  if (vendor !== undefined) {
    if (kind === 'login' || kind === 'unsetApiKey') return `vendor.${vendor}.auth`
    if (kind === 'install') return `vendor.${vendor}.bin`
    if (kind === 'update' || kind === 'pin') return `vendor.${vendor}.version`
    if (kind === 'sandboxSetup') return `vendor.${vendor}.winSandbox`
  }
  if (kind === 'gitInstall') return 'app.git'
  if (['safeDirectory', 'abort'].includes(kind)) return 'folder.git'
  return ''
}

function configPatch(i: SnagActionInput, id: string, label: string, ops: JsonPatchOp[]): RecoveryAction {
  return {
    id,
    label,
    kind: 'config_patch',
    target: 'resolved',
    ops,
    preview: patchPreview(ops, i.config),
  }
}

/** One template → an action, or null when it does not apply here. */
function materialize(
  t: RecoveryTemplate,
  i: SnagActionInput,
  vars: Record<string, string | undefined>,
  os: OsFamily,
): RecoveryAction | null {
  if (!holds(t.when, i, os)) return null
  // The configured pass behind the step (Test-first's Tests step runs on Implement's config).
  const pass = isAgentStep(i.step) ? configPassOf(i.step) : undefined
  const label = fillTemplate(t.label, vars)
  const s = i.step
  switch (t.kind) {
    case 'retry':
      // A failed prepare (the isolated copy could not be made) reruns through Resume: runner steps rerun
      // idempotently, and the run's own worktree is adopted, never made twice.
      if (pass === undefined && s === 'prepare' && t.strategy !== 'fresh')
        return { id: `${s}:retry`, label, kind: 'resume', continuation: '' }
      if (pass === undefined) return null
      return {
        id: t.strategy === 'fresh' ? `${s}:retry-fresh` : `${s}:retry`,
        // context_exceeded: a fresh retry of Review, Critic or Fix halves the prompt's diff (LaunchPlan.diffTrim);
        // Plan and Implement carry no diff, so theirs is only a fresh session.
        label:
          i.failure.category === 'context_exceeded' && (pass === 'plan' || pass === 'implement')
            ? FRESH_SESSION_LABEL
            : label,
        kind: 'retry',
        strategy: t.strategy ?? 'auto',
      }
    case 'resume':
      // A failed pass resumes its session (mutating passes only; a read-only pass starts fresh anyway).
      if (pass === undefined || !i.hasSession || (pass !== 'implement' && pass !== 'fix')) return null
      return { id: `${s}:continue`, label, kind: 'resume', continuation: fillTemplate(t.continuation, vars) }
    case 'config_patch': {
      if (pass === undefined) return null
      const cfg = i.config
      switch (t.patch) {
        case 'model-null': {
          if (cfg === undefined || cfg.passes[pass].model !== null) {
            return configPatch(i, `${s}:default-model`, label, [
              { op: 'replace', path: `/passes/${pass}/model`, value: null },
            ])
          }
          // Live balanced run: already on the default model, and the vendor's own settings chose a model the account
          // refused (X09h). One click puts the account's default model on the pass instead (a named model, sent on
          // thread/start), only for a vendor whose pass with no model may run another (never Gemini, never a local
          // preset), and only when it can differ from what ran: not when the pass ran the account's default itself, nor
          // when the vendor's words name it as refused. The default Dim Factory sent on turn/start in place of the vendor's
          // own choice, which the vendor did not run (its words name that choice, not the default), is not the default
          // having run.
          const account = i.accountDefaultModel?.trim() ?? ''
          if (account === '' || !accountDefaultMayDiffer(i.vendor)) return null
          // The default asked for and not confirmed counts as sent, as it did before Codex's word was awaited.
          const sent = i.modelUsed ?? i.modelAsked
          const ignored =
            sent === account &&
            modelOverrideIgnored({
              modelUsed: sent,
              modelReplaced: i.modelReplaced,
              failure: i.failure,
            })
          if (sent === account && !ignored) return null
          if (namesModel(`${i.failure.message}\n${i.failure.raw}`, account)) return null
          const who = vars['vendor'] ?? 'the vendor'
          return configPatch(i, `${s}:account-model`, `Use ${account} (${who}'s default for this account)`, [
            { op: 'replace', path: `/passes/${pass}/model`, value: account },
          ])
        }
        case 'pass-disabled':
          return configPatch(i, `${s}:turn-off`, label, [
            { op: 'replace', path: `/passes/${pass}/enabled`, value: false },
          ])
        case 'drop-limit-flags': {
          const args = i.vendor !== undefined ? cfg?.vendors[i.vendor]?.extraArgs : undefined
          const next = args !== undefined ? withoutLimitFlags(args) : null
          if (next === null || i.vendor === undefined) return null
          return configPatch(i, `${s}:drop-limit`, label, [
            { op: 'replace', path: `/vendors/${i.vendor}/extraArgs`, value: next },
          ])
        }
        case 'install-never':
          return configPatch(i, `${s}:install-never`, label, [
            { op: 'replace', path: '/isolation/worktree/install', value: 'never' },
          ])
        case 'larger-model':
          // No model is known to have a larger window here; "Diagnose with AI" and switch_vendor remain.
          return null
      }
      return null
    }
    case 'settings_link': {
      const pointer = fillTemplate(t.pointer, vars)
      const lbl = /\bat $/.test(label) || label.endsWith(' at') ? 'Open the config file' : label
      return {
        id: `${s}:settings:${t.route.replace(/[^a-z0-9]+/gi, '-')}${pointer !== '' ? `:${pointer.split('/').pop() ?? ''}` : ''}`,
        label: lbl,
        kind: 'settings_link',
        route: t.route,
        pointer: pointer.startsWith('/') ? pointer : '',
      }
    }
    case 'shell_copy': {
      let cmd: { command: string; shell: 'powershell' | 'sh'; elevated?: boolean } | null
      let idPart: string = t.command
      if (t.command === 'gitInstall') cmd = gitInstallCommand(os)
      else if (
        t.command === 'install' ||
        t.command === 'login' ||
        t.command === 'update' ||
        t.command === 'pin' ||
        t.command === 'sandboxSetup' ||
        t.command === 'unsetApiKey'
      ) {
        // deps_missing names a tool, not the vendor: nothing to install from here.
        if (i.vendor === undefined || i.failure.category === 'deps_missing') return null
        // A `local-<preset>` runs on Codex, whose Windows sandbox it shares (its elevated setup and re-check).
        cmd = commandFor(t.command, sandboxVendor(t.command, i.vendor), os, i.testedUpTo)
        if (t.command === 'unsetApiKey') idPart = 'unset-api-key'
      } else {
        const text = `${i.failure.message}\n${i.failure.raw}`
        const arg =
          t.command === 'abort'
            ? GIT_OP.exec(text)?.[1]?.toLowerCase()
            : t.command === 'safeDirectory'
              ? i.folder
              : undefined
        if (t.command === 'longPaths' && os !== 'win32') return null
        cmd = repairCommand(t.command, os, arg)
      }
      if (cmd === null) return null
      return {
        id: `${s}:${idPart}`,
        label,
        kind: 'shell_copy',
        command: cmd.command,
        shell: cmd.shell,
        reason: fillTemplate(t.reason, vars),
        recheck: recheckFor(
          t.command,
          i.vendor === undefined ? undefined : sandboxVendor(t.command, i.vendor),
        ),
        ...(t.elevated === true || cmd.elevated === true ? { elevated: true } : {}),
      }
    }
    case 'vendor_setup': {
      // The Codex Windows sandbox setup, unelevated (the elevated one is the next row's copied command). Only
      // Codex has one (a `local-<preset>` runs on Codex), and only on Windows.
      if (i.vendor === undefined || os !== 'win32') return null
      const vendor = localPresetIdOf(i.vendor) !== null ? 'codex' : i.vendor
      if (vendor !== 'codex') return null
      return {
        id: `${s}:sandbox-setup`,
        label,
        kind: 'vendor_setup',
        vendor,
        call: 'windowsSandbox/setupStart',
        params: { mode: 'unelevated' },
      }
    }
    case 'switch_vendor': {
      const target = i.switchTarget
      if (pass === undefined || target === undefined || target === null) return null
      return {
        id: `${s}:switch`,
        label: `Use ${target.displayName} instead`,
        kind: 'switch_vendor',
        pass,
        to: target.to,
        model: target.model,
        ...(target.disabledReason !== undefined ? { disabledReason: target.disabledReason } : {}),
      }
    }
    case 'grant':
      if (t.grant === 'command') return null // the verify step names the command
      if (t.grant === 'vendorFolder') {
        // Trusting the folder for the pass's own vendor (Gemini), then Retry ("grant → retry"). A failure
        // without such a vendor (a preflight step, a vendor that never asks for folder trust) has nothing to trust.
        if (i.vendor === undefined || !needsFolderTrust(i.vendor)) return null
        return {
          id: `${s}:grant-${t.grant}`,
          label,
          kind: 'grant',
          grant: t.grant,
          vendor: i.vendor,
          detail: `${vars['vendor'] ?? i.vendor} works in ${i.folder ?? 'this folder'} from now on.`,
        }
      }
      return {
        id: `${s}:grant-${t.grant}`,
        label,
        kind: 'grant',
        grant: t.grant,
        detail: i.failure.message,
      }
    case 'wait_until': {
      if (pass === undefined) return null
      const until = waitUntilFor(i.failure, i.at)
      if (until === null) return null
      const when = (i.clockText ?? localClockText)(until, i.at)
      return {
        id: `${s}:wait`,
        label: fillTemplate(t.label, { ...vars, resetsAt: when }),
        kind: 'wait_until',
        until,
        armed: t.armed,
      }
    }
    case 'skip_pass':
      if (pass === undefined || pass === 'implement') return null
      return { id: `${s}:skip`, label, kind: 'skip_pass', pass }
    case 'close_run':
      return { id: 'run:close', label, kind: 'close_run' }
    case 'open_docs': {
      const url = docsLink(i.vendor, t.doc)
      if (url === null) return null
      return { id: `${s}:docs-${t.doc}`, label, kind: 'open_docs', url }
    }
    case 'heal':
      if (pass === undefined) return null
      return { id: `${s}:heal`, label, kind: 'heal' }
  }
}

/**
 * The snag's recovery list for a failed step: its category's recovery (primary first), then the default set and,
 * for a known category that allows it, "Diagnose with AI" (a self-heal trigger). Never an em dash.
 */
export function snagActions(i: SnagActionInput): RecoveryAction[] {
  const info = CATEGORY_INFO[i.failure.category]
  const os = osFamily(i.platform ?? process.platform)
  const name = i.vendorName ?? i.vendor ?? 'The vendor'
  const vars: Record<string, string | undefined> = {
    vendor: name,
    vendorId: i.vendor,
    pass: stepLabel(i.step),
    testedUpTo: i.testedUpTo,
    denied: i.failure.message !== '' ? i.failure.message : 'the request',
    location: '',
    pointer: '',
    op: GIT_OP.exec(`${i.failure.message}\n${i.failure.raw}`)?.[1]?.toLowerCase() ?? 'merge',
    tool: '',
  }
  const out: RecoveryAction[] = []
  const seen = new Set<string>()
  const add = (a: RecoveryAction | null): void => {
    if (a === null || seen.has(a.id)) return
    seen.add(a.id)
    out.push(a)
  }
  for (const t of info.recovery) add(materialize(t, i, vars, os))
  const defaults = defaultSnagActions(i.step, i.failure, { hasSession: i.hasSession, hints: [...i.hints] })
  const close = defaults.filter((a) => a.kind === 'close_run')
  const resumes = out.some((a) => a.kind === 'resume')
  for (const a of defaults) {
    // The category's own Resume (with its continuation) replaces the default resume retry.
    if (a.kind === 'close_run' || (resumes && a.id === `${i.step}:resume`)) continue
    add(a)
  }
  // "Diagnose with AI" for a known category (unknown has it first already; `never` categories do not offer it).
  if (info.heal === 'offer' && isAgentStep(i.step))
    add({ id: `${i.step}:heal`, label: 'Diagnose with AI', kind: 'heal' })
  for (const a of close) add(a)
  return out
}
