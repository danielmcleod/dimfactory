// [Revert all] as a button (disabled while the folder is busy; R13): the
// run's changes out of the folder through diff.revert, with the Undo toast (revert.ts). Disabled-not-hidden: while the
// folder is busy, or while this build's core cannot revert, the button stays in its place with the reason as its
// tooltip and accessible name. Its label never changes; a spinner takes the icon slot while core reverts.
import { Undo2 } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../ui/DisabledHint.tsx'
import { useBusy } from './commands.ts'
import { REVERT_ALL_LABEL, revertAll, useFolderBusyReason, useRevertSupported } from './revert.ts'

export function RevertAllButton({
  runId,
  disabledReason,
  testId = 'revert-all',
  size = 'sm',
  onDone,
}: {
  runId: string
  /** A reason of the caller's own (the run made no changes), shown before the folder's. */
  disabledReason?: string | undefined
  testId?: string
  size?: 'sm' | 'md'
  /** After the revert and after its Undo (the Diff tab reads its list again). */
  onDone?: () => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const folderBusy = useFolderBusyReason(runId)
  const supported = useRevertSupported()
  const reason = !supported ? LATER_VERSION : (disabledReason ?? folderBusy)
  const icon = <Undo2 aria-hidden />
  if (reason !== undefined && busy === null) {
    return (
      <DisabledHint reason={reason}>
        <Button size={size} variant="outline" disabled data-testid={testId} icon={icon}>
          {REVERT_ALL_LABEL}
        </Button>
      </DisabledHint>
    )
  }
  return (
    <Button
      size={size}
      variant="outline"
      data-testid={testId}
      icon={icon}
      loading={busy !== null}
      onClick={() => run('revert', () => revertAll(runId, onDone))}
    >
      {REVERT_ALL_LABEL}
    </Button>
  )
}
