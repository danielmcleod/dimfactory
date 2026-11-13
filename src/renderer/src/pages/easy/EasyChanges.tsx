// Easy mode's Apply panel, in plain words, for a run that worked in a copy of the user's folder (an isolated run):
//  - the finalize card as "Your changes are ready": Keep these changes (core's Apply) or Throw them away (core's
//    Discard, after a plain confirmation; the copy is deleted 10 s later unless undone). Core's Keep for later is not
//    offered: leaving the screen keeps the copy anyway.
//  - one line of what happened since, from core's finalize view: kept (with Undo: the apply's own undo), thrown away
//    (with Undo while the deletion waits), or still waiting in the copy (with the same two buttons, through
//    worktree.apply and worktree.discard once the run has ended).
// Nothing is decided here: core does the apply, its undo and the deletion; this only words them.
// UI standards: the line keeps its height whatever it says; the buttons keep their labels.
import { Check, Trash2, Undo2 } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState } from 'react'
import type { CardView, RunSnapshot } from '@shared/run.ts'
import { FINALIZE_CHOICE } from '../../components/cards/payload.ts'
import { useResolve } from '../../components/cards/resolve.ts'
import { finalizeInfoOf } from '../../components/run/isolation.ts'
import type { FinalizeInfo } from '../../components/run/isolation.ts'
import { UNDO_LABEL } from '../../components/run/revert.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import {
  CHANGES_BUSY,
  CHANGES_CONFLICTS,
  CHANGES_LABELS,
  CHANGES_NONE,
  CHANGES_READY_TITLE,
  CHANGES_THROW_UNDONE,
  CHANGES_THROWING,
  CHANGES_THROWN,
  CHANGES_UNDONE,
  CHANGES_WAITING,
  KEEP_CHANGES,
  THROW_AWAY,
  THROW_CONFIRM,
  THROW_CONFIRM_TEXT,
  THROW_LABELS,
  THROW_NO,
  changesKeptText,
  changesReadyText,
} from './text.ts'

/** "Throw them away", confirmed in a plain dialog before anything is deleted. */
function ThrowAway({
  busy,
  disabled,
  onConfirm,
}: {
  busy: boolean
  disabled: boolean
  onConfirm: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          variant="outline"
          labels={CHANGES_LABELS}
          icon={<Trash2 aria-hidden />}
          loading={busy}
          disabled={disabled}
          data-testid="easy-throw-away"
        >
          {THROW_AWAY}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="easy-throw-dialog"
          className="fixed top-[30vh] left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-base font-semibold">{THROW_CONFIRM}</Dialog.Title>
          <Dialog.Description className="text-sm">{THROW_CONFIRM_TEXT}</Dialog.Description>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" labels={THROW_LABELS} data-testid="easy-throw-no">
                {THROW_NO}
              </Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              labels={THROW_LABELS}
              loading={sending}
              data-testid="easy-throw-yes"
              onClick={() => {
                setSending(true)
                void onConfirm().finally(() => {
                  setSending(false)
                  setOpen(false)
                })
              }}
            >
              {THROW_AWAY}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The finalize card in plain words: Keep these changes or Throw them away (core's Apply and Discard choices). */
export function PlainFinalize({
  runId,
  card,
  snap,
}: {
  runId: string
  card: CardView
  snap: RunSnapshot
}): React.JSX.Element {
  const resolver = useResolve(runId, card)
  const info = finalizeInfoOf(snap.steps.finalize)
  const busy = resolver.busy !== null
  const can = (id: string): boolean => card.choices.some((c) => c.id === id)
  return (
    <section
      data-testid="easy-card-finalize"
      aria-label={CHANGES_READY_TITLE}
      className="flex flex-col gap-3 rounded-lg border border-st-waiting/50 bg-card p-4"
    >
      <h2 className="text-base font-semibold">{CHANGES_READY_TITLE}</h2>
      <p className="text-sm" data-testid="easy-finalize-body">
        {changesReadyText(info.files)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          labels={CHANGES_LABELS}
          icon={<Check aria-hidden />}
          loading={resolver.busy === FINALIZE_CHOICE.apply}
          disabled={busy || !can(FINALIZE_CHOICE.apply)}
          data-testid="easy-keep-changes"
          onClick={() => resolver.resolve(FINALIZE_CHOICE.apply)}
        >
          {KEEP_CHANGES}
        </Button>
        <ThrowAway
          busy={resolver.busy === FINALIZE_CHOICE.discard}
          disabled={busy || !can(FINALIZE_CHOICE.discard)}
          onConfirm={async () => {
            resolver.resolve(FINALIZE_CHOICE.discard)
            await Promise.resolve()
          }}
        />
      </div>
    </section>
  )
}

/** The line's words for core's finalize view (null: nothing to say yet). */
export function changesText(info: FinalizeInfo, notApplied: boolean): string | null {
  switch (info.state) {
    case 'applied':
      return changesKeptText(info.applied ?? info.files)
    case 'applying':
    case 'waiting':
    case 'undoing':
      return CHANGES_BUSY
    case 'discarding':
      return CHANGES_THROWING
    case 'discarded':
      return CHANGES_THROWN
    case 'conflicts':
    case 'interrupted':
      return CHANGES_CONFLICTS
    case 'kept':
      return info.files === 0 ? CHANGES_NONE : notApplied ? CHANGES_WAITING : null
    case 'pending':
    case 'preview':
    case null:
      return null
  }
}

async function undoApply(runId: string, token: string): Promise<void> {
  const r = await invoke('worktree.undoApply', { runId, undoToken: token })
  void fetchSnapshot(runId)
  toast({ level: r.ok ? 'info' : 'error', message: r.ok ? CHANGES_UNDONE : r.error.message })
}

async function undoDiscard(runId: string, token: string): Promise<void> {
  const r = await invoke('worktree.undoDiscard', { runId, undoToken: token })
  void fetchSnapshot(runId)
  toast({ level: r.ok ? 'info' : 'error', message: r.ok ? CHANGES_THROW_UNDONE : r.error.message })
}

/**
 * What became of the copy's changes, one line with its Undo; once the run has ended and the changes still wait in the
 * copy, Keep these changes and Throw them away again.
 */
export function ChangesLine({ snap, ended }: { snap: RunSnapshot; ended: boolean }): React.JSX.Element {
  const runId = snap.summary.runId
  const info = finalizeInfoOf(snap.steps.finalize)
  const notApplied = snap.summary.worktree?.notApplied === true
  const text = changesText(info, notApplied)
  const [busy, run] = useBusy()
  const undo =
    info.state === 'discarding' && info.discardToken !== null
      ? { kind: 'discard' as const, token: info.discardToken }
      : info.state === 'applied' && info.undoToken !== null
        ? { kind: 'apply' as const, token: info.undoToken }
        : null
  const choose = ended && info.state === 'kept' && notApplied && info.files !== 0
  return (
    <div className="flex flex-col gap-2" data-testid="easy-changes">
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <p
          role="status"
          className="min-w-0 flex-1 text-sm"
          data-testid="easy-changes-state"
          data-state={info.state ?? undefined}
        >
          {text ?? ''}
        </p>
        {undo !== null && (
          <Button
            variant="outline"
            icon={<Undo2 aria-hidden />}
            loading={busy === 'undo'}
            data-testid={`easy-changes-undo-${undo.kind}`}
            onClick={() =>
              run('undo', () =>
                undo.kind === 'apply' ? undoApply(runId, undo.token) : undoDiscard(runId, undo.token),
              )
            }
          >
            {UNDO_LABEL}
          </Button>
        )}
      </div>
      {choose && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            labels={CHANGES_LABELS}
            icon={<Check aria-hidden />}
            loading={busy === 'keep'}
            disabled={busy !== null && busy !== 'keep'}
            data-testid="easy-keep-changes"
            onClick={() =>
              run('keep', async () => {
                const r = await invoke('worktree.apply', { runId })
                void fetchSnapshot(runId)
                if (!r.ok) toast({ level: 'error', message: r.error.message })
              })
            }
          >
            {KEEP_CHANGES}
          </Button>
          <ThrowAway
            busy={busy === 'throw'}
            disabled={busy !== null && busy !== 'throw'}
            onConfirm={() =>
              new Promise<void>((resolve) => {
                run('throw', async () => {
                  const r = await invoke('worktree.discard', { runId })
                  void fetchSnapshot(runId)
                  if (!r.ok) toast({ level: 'error', message: r.error.message })
                  resolve()
                })
              })
            }
          />
        </div>
      )}
    </div>
  )
}
