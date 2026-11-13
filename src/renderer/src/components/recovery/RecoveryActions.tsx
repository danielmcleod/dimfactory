// Recovery buttons, shared by every surface that shows core's RecoveryAction[]: snag cards, preflight cards, the composer's preflight
// strip, the setup card and Settings → Vendors. Core's order is kept and the first action is the one primary button.
//
// Stable API (other pages import this file):
//   <RecoveryActions actions={check.recovery} runId? folder? step? onRecheck? layout? size? primaryFirst? check?
//                    handlers? pendingIds? wait? onOverrides? />
//   - runId / folder: the context recovery.execute gets (a run's snag or card; a composer folder); neither for a
//     vendor probe's checks. `step`: a snag's failed step (the older-core fallback, and wait_until's Retry now).
//   - shell_copy: main copies the command → toast "Copied. Run it in a terminal." → the same button now reads
//     [I ran it → Re-check] (data-testid `recheck-<actionId>`), which re-probes the vendor named by the action's
//     `recheck` check id (`vendors.probe {vendor, force:true}`) and then calls `onRecheck` (re-run your preflight).
//     The button reserves the widest of its labels (StableLabel), and its icon slot cycles Copy → RotateCw → spinner,
//     so it never changes size (UI control standard).
//   - settings_link navigates to core's route; open_docs toasts "Opened in your browser"; retry / skip_pass /
//     close_run / resume / switch_vendor / grant / heal run through recovery.execute too.
//   - config_patch: one block per fix with its change previewed and [Apply to this run] [Apply and save to
//     project|user] (ConfigPatchControl; core offers the save as a second action with the same ops and `persist`).
//   - wait_until: a block with core's countdown and [Arm|Re-arm|Disarm] [Retry now] (WaitUntilControl; `wait`
//     is core's StepView.wait).
//   - grant: a button with what it trusts written under the row. heal outside a run: the outcome shows under
//     the row (HealDiagnosis). A vendorFolder grant (Gemini's trust, e.g. a trust_required snag) runs too; core's
//     detail is written under the row, else what trusting means in plain words (folderTrust.ts trustMeans).
//   - vendor_setup: a block of its own, [label] with the setup's progress and core's answer on one line beside
//     it (VendorSetupControl; one setup per vendor, components/recovery/sandboxSetup.ts). An elevated command's note
//     adds that Windows asks for permission (UAC_NOTE).
//   - Disabled with the reason: core's `disabledReason`, a switch to a vendor that is not ready, and any kind this
//     build's core answers UNSUPPORTED for ("Available in a later version").
//     Errors are toasts with core's message. Every kind has a leading icon, which a busy action swaps for the spinner.
//   - handlers: actions the caller carries out itself, by id (the snag card's diagnosis request, a Close run core did
//     not list); pendingIds: ids whose work goes on elsewhere (a diagnosis core is running), shown busy.
//   - layout 'buttons' (default): rows of buttons with the blocks in core's order, the shell commands listed under
//     them. 'commands': each shell command on its own line with a [Copy] button named "Copy: <label>", other actions
//     below.
//   - Every control has data-testid `recovery-<actionId>` and `data-kind`.
import {
  ArrowLeftRight,
  CircleX,
  Copy,
  ExternalLink,
  Hourglass,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  ShieldCheck,
  ShieldPlus,
  SkipForward,
  Sparkles,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HealView, JsonPatchOp, RecoveryAction, RecoveryActionKind } from '@shared/failure.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { StepKey, WaitView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { vendorName } from '../../lib/format.ts'
import { useProbe } from '../../state/selectors.ts'
import { bumpTrustEpoch } from '../../state/trust.ts'
import { useBusy } from '../run/commands.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../ui/DisabledHint.tsx'
import { ConfigPatchControl, patchGroupOf, patchGroups } from './ConfigPatchControl.tsx'
import type { ConfigPatchAction, PatchGroup } from './ConfigPatchControl.tsx'
import {
  canRecheck,
  ELEVATED_NOTE,
  execute,
  laterReason,
  RECHECK_LABEL,
  recheck,
  resolveSettingsLink,
  UAC_NOTE,
  useKindSupport,
} from './execute.ts'
import type { RecoveryContext } from './execute.ts'
import { trustMeans, trustVendorName } from './folderTrust.ts'
import { healLabel } from './heal.ts'
import { HealDiagnosis } from './HealDiagnosis.tsx'
import type { VendorSetupAction } from './sandboxSetup.ts'
import { VendorSetupControl } from './VendorSetupControl.tsx'
import { WaitUntilControl } from './WaitUntilControl.tsx'

export { RECHECK_LABEL, resetRecoveryForTests } from './execute.ts'
export type { RecoveryContext } from './execute.ts'

export interface RecoveryActionsProps {
  /** Core's actions in core's order. */
  actions: readonly RecoveryAction[]
  /** The run the actions belong to (snag, run preflight card). */
  runId?: string | undefined
  /** The folder of a live preflight (composer). */
  folder?: string | undefined
  /** A snag's failed step (the retry fallback when this build's core has no executor; wait_until's Retry now). */
  step?: StepKey | undefined
  /** After "I ran it → Re-check" re-probed the vendor, or a grant was written: re-run whatever showed these actions. */
  onRecheck?: (() => unknown) | undefined
  layout?: 'buttons' | 'commands'
  size?: 'sm' | 'md'
  /** The first action is the primary button (default true). */
  primaryFirst?: boolean
  /**
   * The action that is the primary button, wherever it sits (overrides `primaryFirst`; null: none). A card whose
   * buttons keep their places moves the primary by changing variants only (UI standard: nothing moves on its own).
   */
  primaryId?: string | null | undefined
  /** The check the actions fix: a shell command's reason is left out when it only repeats the check's text. */
  check?: Pick<CheckResult, 'title' | 'detail'> | undefined
  className?: string
  /** Actions the caller carries out itself, by id, instead of recovery.execute. */
  handlers?: Readonly<Record<string, () => Promise<unknown>>> | undefined
  /** Ids whose work goes on outside this component (a diagnosis core is running): shown busy. */
  pendingIds?: ReadonlySet<string> | undefined
  /** wait_until: core's view of the step's wait (StepView.wait). */
  wait?: WaitView | undefined
  /** config_patch `runOverrides` outside a run: apply core's checked ops to the composer's run overrides. */
  onOverrides?: ((ops: JsonPatchOp[]) => unknown) | undefined
}

type ShellCopy = Extract<RecoveryAction, { kind: 'shell_copy' }>
type Grant = Extract<RecoveryAction, { kind: 'grant' }>
type Run = (tag: string, fn: () => Promise<unknown>) => void

interface Common {
  ctx: RecoveryContext
  size: 'sm' | 'md'
  busy: string | null
  run: Run
  setCopied: (id: string, copied: boolean) => void
  onRecheck: (() => unknown) | undefined
  handlers: RecoveryActionsProps['handlers']
  pendingIds: RecoveryActionsProps['pendingIds']
  /** A run-less heal answered with its outcome. */
  onHealed: (h: HealView) => void
}

interface ControlProps extends Common {
  action: RecoveryAction
  variant: 'default' | 'outline'
  copied: boolean
  /** 'commands' layout: the copy button only says "Copy", and this is its accessible name. */
  copyName?: string
}

/** The leading icon of each kind: a busy action shows its spinner in this slot instead (never extra width). */
const KIND_ICON: Readonly<Record<RecoveryActionKind, LucideIcon>> = {
  shell_copy: Copy,
  settings_link: Settings,
  open_docs: ExternalLink,
  retry: RotateCcw,
  resume: Play,
  skip_pass: SkipForward,
  close_run: CircleX,
  config_patch: Wrench,
  vendor_setup: ShieldPlus,
  switch_vendor: ArrowLeftRight,
  grant: ShieldCheck,
  wait_until: Hourglass,
  heal: Sparkles,
}

const CHECKING_LABEL = 'Checking…'
const COPY_LABEL = 'Copy'

function KindIcon({ kind }: { kind: RecoveryActionKind }): React.JSX.Element {
  const Icon = KIND_ICON[kind]
  return <Icon aria-hidden />
}

function Disabled({
  action,
  label,
  size,
  variant,
  reason,
}: Pick<ControlProps, 'action' | 'size' | 'variant'> & { label: string; reason: string }): React.JSX.Element {
  return (
    <DisabledHint reason={reason}>
      <Button
        size={size}
        variant={variant}
        disabled
        icon={<KindIcon kind={action.kind} />}
        data-testid={`recovery-${action.id}`}
        data-kind={action.kind}
      >
        {label}
      </Button>
    </DisabledHint>
  )
}

/**
 * Why an action cannot run now (core's reason, a kind this build lacks, a vendor not ready), or null. A kind this build's
 * core has no executor for is "Available in a later version" too, unless the caller runs the action itself.
 */
function useReason(a: RecoveryAction, handled = false, ctx?: RecoveryContext): string | null {
  const support = useKindSupport(a.kind)
  const probe = useProbe(a.kind === 'switch_vendor' ? a.to : '')
  return (
    laterReason(a, probe) ??
    (ctx !== undefined ? switchHere(a, ctx) : null) ??
    (support === 'no' && !handled ? LATER_VERSION : null)
  )
}

/**
 * A switch to another vendor changes a run (a snag, a run's card) or the composer's run overrides; shown
 * anywhere else (the setup card, Settings → Vendors) it has nothing to change, so it is disabled with what to do.
 */
export function switchHere(a: RecoveryAction, ctx: RecoveryContext): string | null {
  if (a.kind !== 'switch_vendor' || ctx.runId !== undefined || ctx.onOverrides !== undefined) return null
  return `Choose ${vendorName(a.to)} for each pass in the composer`
}

/**
 * One action as one button. A copied shell command becomes [I ran it → Re-check] on the SAME button (its testid
 * switches to `recheck-<id>`), and "Checking…" while that runs: every label is reserved, so the width never changes.
 */
function ActionControl(p: ControlProps): React.JSX.Element {
  const { action: a, ctx, size, variant, busy, run } = p
  const support = useKindSupport(a.kind)
  const handler = p.handlers?.[a.id]
  const reason = useReason(a, handler !== undefined, ctx)
  const pending = a.kind === 'settings_link' && support === 'unknown' && handler === undefined
  useEffect(() => {
    if (pending) void resolveSettingsLink(a, ctx)
    // The action and its context are identified by these; a new array from the same data must not re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, a.id, ctx.runId, ctx.folder])

  const label = a.kind === 'heal' ? healLabel(a) : a.label
  if (reason !== null)
    return <Disabled action={a} label={label} size={size} variant={variant} reason={reason} />

  const copyLabel = p.copyName !== undefined ? COPY_LABEL : label
  const rechecks = a.kind === 'shell_copy' && canRecheck(a, p.onRecheck)
  const labels = rechecks ? [copyLabel, RECHECK_LABEL, CHECKING_LABEL] : undefined

  if (a.kind === 'shell_copy' && rechecks && p.copied) {
    const tag = `recheck:${a.id}`
    const checking = busy === tag
    return (
      <Button
        size={size}
        variant={variant}
        data-testid={`recheck-${a.id}`}
        data-kind={a.kind}
        icon={<RotateCw aria-hidden />}
        labels={labels}
        loading={checking}
        disabled={busy !== null && !checking}
        onClick={() =>
          run(tag, async () => {
            await recheck(a, p.onRecheck)
            p.setCopied(a.id, false)
          })
        }
      >
        {checking ? CHECKING_LABEL : RECHECK_LABEL}
      </Button>
    )
  }

  const elsewhere = p.pendingIds?.has(a.id) === true
  const working = busy === a.id || elsewhere
  return (
    <Button
      size={size}
      variant={variant}
      data-testid={`recovery-${a.id}`}
      data-kind={a.kind}
      aria-label={p.copyName}
      // Passed explicitly: this prop would otherwise override the one Button sets while loading.
      aria-busy={pending || working || undefined}
      icon={<KindIcon kind={a.kind} />}
      labels={labels}
      loading={working}
      disabled={pending || (busy !== null && busy !== a.id)}
      onClick={() =>
        run(a.id, async () => {
          if (handler !== undefined) {
            await handler()
            return
          }
          const { outcome, result } = await execute(a, ctx)
          if (outcome === 'copied') p.setCopied(a.id, true)
          if (outcome === 'done' && a.kind === 'heal' && result?.heal !== undefined) p.onHealed(result.heal)
          // A folder trusted for a vendor: whatever shows core's trust answers asks again.
          if (outcome === 'done' && a.kind === 'grant' && a.grant === 'vendorFolder') bumpTrustEpoch()
          // A grant changes what the checks see: let whoever showed it check again (a run's snag refetches itself).
          if (outcome === 'done' && a.kind === 'grant' && ctx.runId === undefined) await p.onRecheck?.()
        })
      }
    >
      {copyLabel}
    </Button>
  )
}

/** The reason under a command, unless it only repeats the check's own text. */
function reasonOf(a: ShellCopy, check: RecoveryActionsProps['check']): string | null {
  const reason = a.reason.trim()
  if (reason === '') return null
  if (check !== undefined && (check.title.includes(reason) || check.detail.includes(reason))) return null
  return reason
}

function CommandNote({
  a,
  check,
  withLabel,
}: {
  a: ShellCopy
  check: RecoveryActionsProps['check']
  withLabel: boolean
}) {
  const reason = reasonOf(a, check)
  // An elevated PowerShell command brings up Windows' permission prompt (e.g. the Codex sandbox's elevated setup).
  const elevated = a.elevated === true ? [ELEVATED_NOTE, ...(a.shell === 'powershell' ? [UAC_NOTE] : [])] : []
  const parts = [withLabel ? a.label : null, reason, ...elevated].filter((x): x is string => x !== null)
  if (parts.length === 0) return null
  return <span className="text-xs text-muted-foreground">{parts.join(' · ')}</span>
}

/**
 * What a grant trusts: core's detail, and the command a `command` grant names. A vendorFolder grant core gave no
 * words for says what trusting means.
 */
function GrantNote({ a }: { a: Grant }): React.JSX.Element | null {
  const said = a.detail.trim()
  const detail =
    said === '' && a.grant === 'vendorFolder' ? trustMeans(trustVendorName(a.vendor ?? '')) : said
  const argv = a.command?.argv ?? []
  if (detail === '' && argv.length === 0) return null
  return (
    <div data-testid={`grant-note-${a.id}`} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {detail !== '' && <span className="break-words">{detail}</span>}
      {argv.length > 0 && (
        <code className="self-start rounded bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere text-foreground select-all">
          {argv.join(' ')}
          {a.command !== undefined && a.command.cwdRel !== '.' && a.command.cwdRel !== ''
            ? ` (in ${a.command.cwdRel})`
            : ''}
        </code>
      )}
    </div>
  )
}

type Segment =
  | { kind: 'row'; items: { a: RecoveryAction; i: number }[] }
  | { kind: 'patch'; group: PatchGroup; i: number }
  | { kind: 'wait'; a: Extract<RecoveryAction, { kind: 'wait_until' }>; i: number }
  | { kind: 'setup'; a: VendorSetupAction; i: number }

/** Core's actions in core's order: runs of plain buttons, and a block for each config fix, wait and sandbox setup. */
function segmentsOf(actions: readonly RecoveryAction[]): Segment[] {
  const groups = patchGroups(actions)
  const out: Segment[] = []
  actions.forEach((a, i) => {
    if (a.kind === 'config_patch') {
      const g = patchGroupOf(groups, a)
      if (g !== undefined && g.first === a) out.push({ kind: 'patch', group: g, i })
      return
    }
    if (a.kind === 'wait_until') {
      out.push({ kind: 'wait', a, i })
      return
    }
    if (a.kind === 'vendor_setup') {
      out.push({ kind: 'setup', a, i })
      return
    }
    const last = out.at(-1)
    if (last?.kind === 'row') last.items.push({ a, i })
    else out.push({ kind: 'row', items: [{ a, i }] })
  })
  return out
}

function PatchSegment({
  group,
  primary,
  common,
}: {
  group: PatchGroup
  primary: boolean
  common: Common
}): React.JSX.Element {
  const support = useKindSupport('config_patch')
  const reasonOf = (a: ConfigPatchAction): string | null =>
    laterReason(a, undefined) ?? (support === 'no' ? LATER_VERSION : null)
  return (
    <ConfigPatchControl
      group={group}
      inRun={common.ctx.runId !== undefined}
      primary={primary}
      size={common.size}
      busy={common.busy}
      onExecute={(a) => common.run(a.id, () => execute(a, common.ctx))}
      reasonOf={reasonOf}
    />
  )
}

function WaitSegment({
  a,
  primary,
  wait,
  common,
}: {
  a: Extract<RecoveryAction, { kind: 'wait_until' }>
  primary: boolean
  wait: WaitView | undefined
  common: Common
}): React.JSX.Element {
  const reason = useReason(a)
  return (
    <WaitUntilControl
      action={a}
      wait={wait}
      ctx={common.ctx}
      primary={primary}
      size={common.size}
      busy={common.busy}
      run={common.run}
      reason={reason}
    />
  )
}

function SetupSegment({
  a,
  primary,
  common,
}: {
  a: VendorSetupAction
  primary: boolean
  common: Common
}): React.JSX.Element {
  const reason = useReason(a)
  return (
    <VendorSetupControl
      action={a}
      ctx={common.ctx}
      onRecheck={common.onRecheck}
      size={common.size}
      variant={primary ? 'default' : 'outline'}
      reason={reason}
    />
  )
}

function Segments({
  segments,
  common,
  variantAt,
  copied,
  wait,
}: {
  segments: readonly Segment[]
  common: Common
  variantAt: (i: number) => 'default' | 'outline'
  copied: ReadonlySet<string>
  wait: WaitView | undefined
}): React.JSX.Element {
  return (
    <>
      {segments.map((s) =>
        s.kind === 'row' ? (
          <div key={`row:${s.items[0]?.a.id ?? ''}`} className="flex flex-wrap gap-2">
            {s.items.map(({ a, i }) => (
              <ActionControl
                key={a.id}
                {...common}
                action={a}
                variant={variantAt(i)}
                copied={copied.has(a.id)}
              />
            ))}
          </div>
        ) : s.kind === 'patch' ? (
          <PatchSegment
            key={`patch:${s.group.first.id}`}
            group={s.group}
            primary={variantAt(s.i) === 'default'}
            common={common}
          />
        ) : s.kind === 'setup' ? (
          <SetupSegment
            key={`setup:${s.a.id}`}
            a={s.a}
            primary={variantAt(s.i) === 'default'}
            common={common}
          />
        ) : (
          <WaitSegment
            key={`wait:${s.a.id}`}
            a={s.a}
            primary={variantAt(s.i) === 'default'}
            wait={wait}
            common={common}
          />
        ),
      )}
    </>
  )
}

export function RecoveryActions({
  actions,
  runId,
  folder,
  step,
  onRecheck,
  layout = 'buttons',
  size = 'sm',
  primaryFirst = true,
  primaryId,
  check,
  className,
  handlers,
  pendingIds,
  wait,
  onOverrides,
}: RecoveryActionsProps): React.JSX.Element | null {
  const [busy, run] = useBusy()
  const [copied, setCopiedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [healed, setHealed] = useState<HealView | null>(null)
  if (actions.length === 0) return null
  const ctx: RecoveryContext = {
    ...(runId !== undefined ? { runId } : {}),
    ...(folder !== undefined ? { folder } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(onOverrides !== undefined ? { onOverrides } : {}),
  }
  const setCopied = (id: string, on: boolean): void =>
    setCopiedIds((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const common: Common = {
    ctx,
    size,
    busy,
    run,
    setCopied,
    onRecheck,
    handlers,
    pendingIds,
    onHealed: setHealed,
  }
  const variantAt = (i: number): 'default' | 'outline' =>
    primaryId !== undefined
      ? actions[i]?.id === primaryId
        ? 'default'
        : 'outline'
      : primaryFirst && i === 0
        ? 'default'
        : 'outline'
  const healBusy = actions.some((a) => a.kind === 'heal' && busy === a.id && handlers?.[a.id] === undefined)
  const grants = actions.filter((a): a is Grant => a.kind === 'grant')
  const outcome =
    healBusy || healed !== null ? (
      <HealDiagnosis heal={healed ?? undefined} pending={healBusy} testId="recovery-heal" />
    ) : null

  if (layout === 'commands') {
    const commands = actions.filter((a): a is ShellCopy => a.kind === 'shell_copy')
    const others = actions.filter((a) => a.kind !== 'shell_copy')
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {commands.length > 0 && (
          <ul className="flex flex-col gap-2">
            {commands.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs wrap-anywhere select-all">
                    {a.command}
                  </code>
                  <ActionControl
                    {...common}
                    action={a}
                    variant="outline"
                    copied={copied.has(a.id)}
                    copyName={`Copy: ${a.label}`}
                  />
                </div>
                <CommandNote a={a} check={check} withLabel />
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <Segments
            segments={segmentsOf(others)}
            common={common}
            variantAt={(i) => (commands.length === 0 ? variantAt(i) : 'outline')}
            copied={copied}
            wait={wait}
          />
        )}
        {grants.map((a) => (
          <GrantNote key={a.id} a={a} />
        ))}
        {outcome}
      </div>
    )
  }

  const commands = actions.filter((a): a is ShellCopy => a.kind === 'shell_copy')
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Segments
        segments={segmentsOf(actions)}
        common={common}
        variantAt={variantAt}
        copied={copied}
        wait={wait}
      />
      {commands.map((a) => (
        <div key={a.id} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <code className="self-start rounded bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere text-foreground select-all">
            {a.command}
          </code>
          <CommandNote a={a} check={check} withLabel={false} />
        </div>
      ))}
      {grants.map((a) => (
        <GrantNote key={a.id} a={a} />
      ))}
      {outcome}
    </div>
  )
}
