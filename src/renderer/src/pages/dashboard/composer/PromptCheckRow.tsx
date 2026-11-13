// The composer's prompt check row, under the task box: what the task as typed might leave out, in one line of one
// height that is there from the start, so core's answer arriving or changing moves nothing. It never blocks Run. Hide
// puts the hints away until they change. "Sharpen it" (only on the click, its cost in the tooltip first) asks one
// read-only model call for a clearer wording and opens a panel of fixed size below the row: the proposal lands in a
// box the person can edit, then "Use this" puts it in the task box or "Keep mine" closes the panel. The task is never
// changed on its own.
// UI standards: the row keeps its height and the buttons their widths; the panel opens only on the user's click and
// keeps its size while the answer is on its way.
import { Lightbulb, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { promptCheckLine, promptHintLine, promptHintsKey } from '@shared/prompt-check.ts'
import type { PromptCheckView, PromptSharpenHelper } from '@shared/prompt-check.ts'
import { useBusy } from '../../../components/run/commands.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Textarea } from '../../../components/ui/Textarea.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { vendorName } from '../../../lib/format.ts'

export const PROMPT_CHECK_LABEL = 'Prompt check'
export const PROMPT_CHECK_NO_FOLDER =
  'Looks at the task for what it might leave out, once you choose a folder.'
export const PROMPT_CHECK_IDLE = 'Looks at the task for what it might leave out, before anything is spent.'
export const PROMPT_CHECK_CLEAR = 'Nothing stands out as missing.'
export const PROMPT_CHECK_HIDDEN = 'Hints hidden for this task.'
export const SHARPEN_LABEL = 'Sharpen it'
export const SHARPEN_NOTHING = 'There is nothing to sharpen yet'
export const SHARPEN_USE = 'Use this'
export const SHARPEN_KEEP = 'Keep mine'
export const SHARPEN_BOX_LABEL = 'Sharpened task'
export const SHARPEN_READY =
  'Edit it here if you like. Parts in [brackets] are for you to fill in. Your task changes only if you use this.'
const HIDE_LABELS = ['Hide', 'Show'] as const

/** What Sharpen it sends and costs, said before the click. */
export function sharpenCostText(s: PromptSharpenHelper): string {
  const cost =
    typeof s.usd !== 'number'
      ? ''
      : s.usd < 0.01
        ? ' It costs less than $0.01.'
        : ` It costs about $${s.usd.toFixed(2)}.`
  return `Sends your task to ${vendorName(s.vendor)} once, on its cheapest model, for a clearer wording.${cost} Your task changes only if you use the answer.`
}

export function sharpenWaitingText(vendor: string): string {
  return `Asking ${vendorName(vendor)} for a clearer wording…`
}

/** The row's line: the first hint (and how many more), or what the check is doing. */
export function promptCheckRowText(
  view: PromptCheckView | null,
  o: { hasFolder: boolean; blank: boolean; hidden: boolean },
): string {
  if (!o.hasFolder) return PROMPT_CHECK_NO_FOLDER
  if (o.blank || view === null) return PROMPT_CHECK_IDLE
  if (view.hints.length === 0) return PROMPT_CHECK_CLEAR
  return o.hidden ? PROMPT_CHECK_HIDDEN : promptCheckLine(view.hints)
}

export function PromptCheckRow({
  view,
  folder,
  task,
  recipe,
  onUse,
}: {
  /** Core's answer for this folder (null: none yet, or not available). */
  view: PromptCheckView | null
  folder: string | null
  task: string
  recipe?: string | undefined
  /** "Use this": the sharpened task goes into the task box. */
  onUse: (task: string) => void
}): React.JSX.Element {
  const hints = view?.hints ?? []
  const key = promptHintsKey(hints)
  const [hiddenKey, setHiddenKey] = useState<string | null>(null)
  const hidden = hints.length > 0 && hiddenKey === key
  const blank = task.trim() === ''
  const text = promptCheckRowText(view, { hasFolder: folder !== null, blank, hidden })
  const shown = hints.length > 0 && !hidden && !blank
  const all = shown ? hints.map(promptHintLine).join('\n') : text

  const [open, setOpen] = useState(false)
  const [proposal, setProposal] = useState('')
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: '', error: false })
  const [busy, run] = useBusy()
  const hintId = useId()
  const helper = view?.sharpen ?? null
  const sharpenOff =
    folder === null || blank || hints.length === 0
      ? SHARPEN_NOTHING
      : helper === null
        ? (view?.sharpenReason ?? SHARPEN_NOTHING)
        : null
  const sharpenTip = sharpenOff ?? (helper !== null ? sharpenCostText(helper) : '')

  const sharpen = (): void => {
    if (folder === null || helper === null) return
    setOpen(true)
    setProposal('')
    setNote({ text: sharpenWaitingText(helper.vendor), error: false })
    run('sharpen', async () => {
      const r = await invoke('task.sharpen', { folder, task, ...(recipe !== undefined ? { recipe } : {}) })
      if (!r.ok) {
        setNote({ text: r.error.message, error: true })
        return
      }
      setProposal(r.value.task)
      setNote({ text: SHARPEN_READY, error: false })
    })
  }
  const close = (): void => {
    setOpen(false)
    setProposal('')
    setNote({ text: '', error: false })
  }

  return (
    <div className="flex flex-col gap-2" data-testid="composer-prompt-check">
      <div data-testid="composer-prompt-check-row" className="flex h-7 min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{PROMPT_CHECK_LABEL}</span>
        <Lightbulb
          aria-hidden
          className={cn('size-3.5 shrink-0', shown ? 'text-foreground' : 'text-muted-foreground/40')}
        />
        <p
          data-testid="composer-prompt-check-line"
          data-hints={shown ? key : ''}
          title={all}
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            shown ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {text}
        </p>
        <Tooltip content={sharpenTip}>
          {/* The wrapper takes the tooltip while the button is disabled (a disabled button gets no pointer events). */}
          <span className="inline-flex shrink-0">
            <Button
              size="sm"
              variant="outline"
              data-testid="composer-sharpen"
              icon={<Sparkles aria-hidden />}
              loading={busy === 'sharpen'}
              disabled={sharpenOff !== null}
              aria-describedby={hintId}
              onClick={sharpen}
            >
              {SHARPEN_LABEL}
            </Button>
          </span>
        </Tooltip>
        <span id={hintId} className="sr-only">
          {sharpenTip}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="composer-prompt-check-hide"
          labels={HIDE_LABELS}
          disabled={hints.length === 0 || blank}
          aria-pressed={hidden}
          onClick={() => setHiddenKey(hidden ? null : key)}
        >
          {hidden ? HIDE_LABELS[1] : HIDE_LABELS[0]}
        </Button>
      </div>
      {open && (
        <section
          aria-label={SHARPEN_BOX_LABEL}
          data-testid="composer-sharpen-panel"
          className="flex flex-col gap-2 rounded-md border bg-card p-3"
        >
          <p
            role="status"
            aria-live="polite"
            data-testid="composer-sharpen-note"
            title={note.text !== '' ? note.text : undefined}
            className={cn('h-5 truncate text-xs', note.error ? 'text-destructive' : 'text-muted-foreground')}
          >
            {note.text}
          </p>
          <Textarea
            aria-label={SHARPEN_BOX_LABEL}
            data-testid="composer-sharpen-text"
            data-scroll-region="sharpen-text"
            value={proposal}
            readOnly={busy !== null}
            onChange={(e) => setProposal(e.target.value)}
            className="h-28 resize-none scroll-region"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="composer-sharpen-use"
              disabled={busy !== null || proposal.trim() === ''}
              onClick={() => {
                onUse(proposal.trim())
                close()
              }}
            >
              {SHARPEN_USE}
            </Button>
            <Button size="sm" variant="ghost" data-testid="composer-sharpen-keep" onClick={close}>
              {SHARPEN_KEEP}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
