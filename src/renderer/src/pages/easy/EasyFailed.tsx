// Easy mode's Done screen for a run that did not finish: why, in one plain line per kind of failure (signed out, a
// usage limit with when it resets, no internet, the tool missing, ...), what to do (the sign-in command to paste, or
// the steps to set the tool up again), the recovery core armed for the failed step as one button (try again, or wait
// for the limit to reset), and Carry on: a new run that picks up where this one stopped (easy.change with
// continueRunId), in the same folder.
// UI standards: the buttons keep their labels; the failure line is there from the start (the snapshot carries the
// failure; the recovery button joins it in its own reserved row).
import { RotateCcw } from 'lucide-react'
import type { RecoveryAction } from '@shared/failure.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { useBusy } from '../../components/run/commands.ts'
import { RecoveryActions } from '../../components/run/RecoveryActions.tsx'
import { useLastEnvelope } from '../../components/run/runLog.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { useAppInfo } from '../../state/selectors.ts'
import { useEasyState } from '../../state/experience.ts'
import { toast } from '../../state/toasts.ts'
import { CommandLine, VendorSetup } from './EasySetup.tsx'
import {
  CARRY_ON,
  CARRY_ON_TEXT,
  SETUP_CATEGORIES,
  SIGN_IN_CATEGORIES,
  SIGN_IN_LABEL,
  failureText,
} from './text.ts'

/** The kinds of recovery Easy offers as its one button: try the step again, or wait for a limit to reset. */
const EASY_RECOVERY: ReadonlySet<RecoveryAction['kind']> = new Set(['wait_until', 'retry', 'resume'])

/** The recovery core armed for the failed step, as Easy's one button: a wait for a reset first, else a retry. */
export function armedAction(actions: readonly RecoveryAction[]): RecoveryAction | undefined {
  return (
    actions.find((a) => a.kind === 'wait_until' && a.disabledReason === undefined) ??
    actions.find((a) => EASY_RECOVERY.has(a.kind) && a.disabledReason === undefined)
  )
}

/** The plain line for a failed run: its category's, with the vendor and the reset time when core knows them. */
export function failedLine(snap: RunSnapshot): string {
  const f = snap.summary.failure
  if (f === undefined) return failureText('unknown')
  const view = snap.steps[f.step]
  return failureText(f.category, view.vendor, view.failure?.resetsAt)
}

export function EasyFailed({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const s = snap.summary
  const runId = s.runId
  const f = s.failure
  const view = f !== undefined ? snap.steps[f.step] : undefined
  const category = f?.category ?? 'unknown'
  const snag = useLastEnvelope(runId, 'snag', (b) => f !== undefined && b.step === f.step, {
    enabled: f !== undefined,
    key: `${view?.attempt ?? 0}:${category}`,
  })
  const actions = snag?.body.actions ?? []
  const signIn = SIGN_IN_CATEGORIES.includes(category)
    ? actions.find((a): a is Extract<RecoveryAction, { kind: 'shell_copy' }> => a.kind === 'shell_copy')
    : undefined
  const armed = armedAction(actions)
  const platform = useAppInfo()?.platform ?? 'win32'
  const settings = useEasyState()?.settings
  const [busy, run] = useBusy()
  const carryOn = (): void =>
    run('carry', async () => {
      const r = await invoke('easy.change', {
        folder: s.folder,
        continueRunId: runId,
        limits: { maxCostUsd: settings?.maxCostUsd ?? null, maxMinutes: settings?.maxMinutes ?? null },
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      navigate({ name: 'easyRun', runId: r.value.runId })
    })
  return (
    <div className="flex flex-col gap-3" data-testid="easy-failed" data-category={category}>
      <p className="text-sm" data-testid="easy-failure-line">
        {failedLine(snap)}
      </p>
      {signIn !== undefined && (
        <CommandLine label={SIGN_IN_LABEL} command={signIn.command} testId="easy-sign-in" />
      )}
      {SETUP_CATEGORIES.includes(category) && (
        <VendorSetup
          platform={platform}
          ready={null}
          onChecked={async () => {
            const r = await invoke('vendors.list')
            return r.ok && r.value.some((v) => v.health === 'ready')
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2" data-testid="easy-failed-actions">
        <Button
          icon={<RotateCcw aria-hidden />}
          loading={busy === 'carry'}
          disabled={busy !== null && busy !== 'carry'}
          onClick={carryOn}
          data-testid="easy-carry-on"
        >
          {CARRY_ON}
        </Button>
        {armed !== undefined && f !== undefined && (
          <RecoveryActions
            actions={[armed]}
            runId={runId}
            step={f.step}
            wait={view?.wait}
            primaryFirst={false}
            size="md"
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground">{CARRY_ON_TEXT}</p>
    </div>
  )
}
