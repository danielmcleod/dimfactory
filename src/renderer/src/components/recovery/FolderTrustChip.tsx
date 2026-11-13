// The folder trust chip (the readiness check `trust`, trust.json `vendorFolder`, the grant executor; shown in the
// Dashboard's preflight strip and setup card; gemini-trust.spec.ts: the trust chip clears the block).
import { Shield, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { CheckResult } from '@shared/preflight.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useKeptHeight } from '../../lib/keptHeight.ts'
import { useTrustEpoch } from '../../state/trust.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import type { RecoveryContext } from './execute.ts'
import {
  grantFolderTrust,
  hasVendorGrant,
  trustActionOf,
  trustedMeans,
  trustLabel,
  trustMeans,
  trustStatusText,
  trustVendorName,
  useTrustRun,
} from './folderTrust.ts'
import type { TrustPhase, TrustRun } from './folderTrust.ts'

/** The status line's icon in each phase: one slot, so the words after it never move when it changes. */
export const TRUST_PHASE_ICON: Readonly<Record<TrustPhase, LucideIcon>> = {
  'no-folder': ShieldQuestion,
  checking: Shield,
  needed: ShieldAlert,
  running: Shield,
  trusted: ShieldCheck,
  failed: ShieldX,
}

/** Why the button cannot run now. */
export const NO_FOLDER_REASON = 'Choose a folder in the composer first'

/** What core answered for the folder (trust.get), for the chip that has no check to go by: null until it answered. */
function useFolderGrant(vendor: string, folder: string | null, enabled: boolean): boolean | null {
  const epoch = useTrustEpoch()
  const [known, setKnown] = useState<{ folder: string; trusted: boolean } | null>(null)
  useEffect(() => {
    if (!enabled || folder === null) return
    let alive = true
    void invoke('trust.get', { folder }).then((r) => {
      // A folder core cannot read is not trusted: the button then shows core's own error if it refuses too.
      if (alive) setKnown({ folder, trusted: r.ok && hasVendorGrant(r.value, vendor) })
    })
    return () => {
      alive = false
    }
  }, [vendor, folder, enabled, epoch])
  return known !== null && known.folder === folder ? known.trusted : null
}

/**
 * What the chip shows: no folder; a grant running; then, for a check's chip, needed until a grant made after the check
 * landed (or failed); for the folder's chip, core's trust.get answer (checking until then), a failed grant showing its
 * words until core says the folder is trusted.
 */
export function trustPhase(
  folder: string | null,
  run: TrustRun | undefined,
  check: Pick<CheckResult, 'at'> | undefined,
  known: boolean | null,
): TrustPhase {
  if (folder === null) return 'no-folder'
  if (run?.state === 'running') return 'running'
  if (check !== undefined) {
    if (run?.state === 'trusted' && run.at >= check.at) return 'trusted'
    if (run?.state === 'failed') return 'failed'
    return 'needed'
  }
  if (known === true) return 'trusted'
  if (known === null) return run?.state === 'trusted' ? 'trusted' : 'checking'
  return run?.state === 'failed' ? 'failed' : 'needed'
}

export interface FolderTrustChipProps {
  /** The vendor to trust the folder for (Gemini). */
  vendor: string
  /** The folder to trust (absolute), or null while the composer has none. */
  folder: string | null
  /**
   * The check that offered the grant (the composer's preflight strip): trust is needed, and its grant action runs
   * through recovery.execute. Absent: the chip asks core with trust.get and grants with trust.set (the setup card).
   */
  check?: CheckResult | undefined
  /** Where the actions were offered (a composer folder), for recovery.execute. */
  ctx?: RecoveryContext | undefined
  /** After a grant: re-run whatever showed the chip (the composer's live preflight). */
  onRecheck?: (() => unknown) | undefined
  /** Name the folder by its path in the status line (the setup card) instead of "this folder". */
  showPath?: boolean
  /** Say what trusting means (default); false where core's own words for it are shown just above (an open strip chip). */
  withMeans?: boolean
  testId: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * One control for the composer's preflight strip and the setup card: a status line says whether the vendor may work in
 * the folder, a sentence says plainly what trusting means (the vendor may read and act in this folder without its own
 * trust prompt), and [Trust this folder for Gemini] runs the grant on the click only (folderTrust.ts). In the strip the
 * chip stands for core's readiness check and runs its grant action; in the setup card it is about the folder the
 * composer checks, read with trust.get and granted with trust.set.
 *
 * Nothing moves on its own (UI control standard): the status line comes first, one line of one
 * height, its icon swapping in one slot; the button keeps its label and width (a spinner takes its icon slot); the
 * chip keeps the tallest height it reached, so a grant that lands (the line alone, "Gemini trusted in this folder")
 * leaves its room. While core has not answered whether the folder is trusted (the setup card's first trust.get) the
 * chip is its status line alone; the sentence and the button come with core's answer. Test ids (`testId` = the
 * button): `<testId>-chip` (`data-phase`, `data-vendor`), `<testId>-line` holding `<testId>-status`, `<testId>-means`.
 */
export function FolderTrustChip({
  vendor,
  folder,
  check,
  ctx,
  onRecheck,
  showPath = false,
  withMeans = true,
  testId,
  size = 'sm',
  className,
}: FolderTrustChipProps): React.JSX.Element {
  const statusId = useId()
  const [keptRef, kept] = useKeptHeight<HTMLDivElement>()
  const run = useTrustRun(vendor, folder)
  const known = useFolderGrant(vendor, folder, check === undefined)
  const phase = trustPhase(folder, run, check, known)
  const action = trustActionOf(check)
  const name = trustVendorName(vendor)
  const where = showPath && folder !== null ? folder : 'this folder'
  const text = trustStatusText(phase, name, where, run?.state === 'failed' ? run.message : '')
  const Icon = TRUST_PHASE_ICON[phase]
  const label = action !== undefined && action.label.trim() !== '' ? action.label : trustLabel(name)
  const offer = phase === 'no-folder' || phase === 'needed' || phase === 'running' || phase === 'failed'
  const means = !withMeans ? null : phase === 'trusted' ? trustedMeans(name) : offer ? trustMeans(name) : null
  const running = phase === 'running'

  const button = (
    <Button
      size={size}
      variant={phase === 'needed' || phase === 'failed' ? 'default' : 'outline'}
      data-testid={testId}
      data-kind="grant"
      icon={<ShieldCheck aria-hidden />}
      loading={running}
      disabled={folder === null}
      aria-describedby={statusId}
      onClick={() => {
        if (folder === null) return
        void grantFolderTrust({ vendor, folder, action, ctx, onRecheck })
      }}
    >
      {label}
    </Button>
  )
  return (
    <div
      ref={keptRef}
      style={kept}
      data-testid={`${testId}-chip`}
      data-phase={phase}
      data-vendor={vendor}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      {/* First, on its own line of one height: the same place in every phase (cut with an ellipsis, whole in its
          title). */}
      <div
        data-testid={`${testId}-line`}
        className={cn(
          'flex h-4 min-w-0 items-center gap-1.5 text-xs',
          phase === 'trusted'
            ? 'text-success'
            : phase === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden data-phase-icon={phase} className="size-3.5 shrink-0" />
        <p
          id={statusId}
          role="status"
          data-testid={`${testId}-status`}
          title={text}
          className="min-w-0 flex-1 truncate"
        >
          {text}
        </p>
      </div>
      {means !== null && (
        <p data-testid={`${testId}-means`} className="text-xs text-muted-foreground">
          {means}
        </p>
      )}
      {offer && (
        <div className="flex min-w-0 items-center">
          {folder === null ? (
            <DisabledHint reason={NO_FOLDER_REASON} className="shrink-0">
              {button}
            </DisabledHint>
          ) : (
            button
          )}
        </div>
      )}
    </div>
  )
}
