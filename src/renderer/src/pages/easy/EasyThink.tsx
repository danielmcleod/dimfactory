// Easy's home: "Help me think it through", for someone who does not yet know what they want. Only on the click (which
// says first what it sends and about what one round costs), each round is one read-only call (core easy/think.ts) that
// asks one question with 2 or 3 directions, each with its trade-off. The person picks one or says it their own way; after
// a few rounds, or on "Write the brief now", it writes a short brief that goes into the idea box on their click. Nothing
// is made. The conversation lives here only, and Stop forgets it. When the prompt check (no model, no tokens) finds the
// idea leaves out who it is for and what they can do, the button is filled in: the suggested next step, with no new
// text and no change of size.
// UI standards: the panel opens only on the user's click; the status line keeps its height; buttons keep their labels.
import { MessagesSquare, PenLine, Square, TextCursorInput } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { EASY_THINK_ANSWER_MAX, EASY_THINK_ROUNDS } from '@shared/easy.ts'
import type { EasyHelperCost, EasyKind, EasyThinkTurn } from '@shared/easy.ts'
import { checkPrompt } from '@shared/prompt-check.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import {
  THINK_BRIEF_LABEL,
  THINK_DISABLED,
  THINK_FINISH,
  THINK_LABEL,
  THINK_OWN_LABEL,
  THINK_OWN_PLACEHOLDER,
  THINK_PICK,
  THINK_SEND,
  THINK_STOP,
  THINK_TEXT,
  THINK_TITLE,
  THINK_USE,
  THINK_USED,
  THINK_WAITING,
  thinkCostText,
  thinkKindText,
  thinkRoundText,
} from './text.ts'

/** Who would answer and about what a round costs (null until core answers). */
function useThinkCost(): EasyHelperCost | null {
  const [cost, setCost] = useState<EasyHelperCost | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('easy.helperCost', { helper: 'think' }).then((r) => {
      if (alive) setCost(r.ok ? r.value : { helper: null })
    })
    return () => {
      alive = false
    }
  }, [])
  return cost
}

export function EasyThink({
  idea,
  onBrief,
}: {
  idea: string
  /** The brief goes into the idea box (with the kind it reads as, when it said one). */
  onBrief: (brief: string, kind: EasyKind | undefined) => void
}): React.JSX.Element {
  const cost = useThinkCost()
  const helper = cost?.helper ?? null
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<EasyThinkTurn[]>([])
  const [current, setCurrent] = useState<{ question: string; options: string[] } | null>(null)
  const [brief, setBrief] = useState<{ brief: string; kind?: EasyKind } | null>(null)
  const [own, setOwn] = useState('')
  const [note, setNote] = useState('')
  const [used, setUsed] = useState(false)
  const [busy, run] = useBusy()
  const ownId = useId()
  const headingId = useId()

  /** One round: the rounds so far go with it; the last one (or `finish`) always comes back as the brief. */
  const ask = (so: EasyThinkTurn[], finish: boolean): void =>
    run('think', async () => {
      setNote(THINK_WAITING)
      const r = await invoke('easy.think', {
        idea: idea.trim(),
        turns: so,
        ...(finish || so.length >= EASY_THINK_ROUNDS ? { finish: true } : {}),
      })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      setNote('')
      setTurns(so)
      setOwn('')
      if (r.value.step === 'brief') {
        setCurrent(null)
        setBrief({ brief: r.value.brief, ...(r.value.kind !== undefined ? { kind: r.value.kind } : {}) })
      } else {
        setCurrent({ question: r.value.question, options: r.value.options })
      }
    })
  const start = (): void => {
    setOpen(true)
    setTurns([])
    setCurrent(null)
    setBrief(null)
    setUsed(false)
    ask([], false)
  }
  const answer = (text: string): void => {
    if (current === null) return
    ask([...turns, { question: current.question, options: current.options, answer: text }], false)
  }
  const stop = (): void => {
    setOpen(false)
    setTurns([])
    setCurrent(null)
    setBrief(null)
    setNote('')
  }

  const off = helper === null ? (cost?.reason ?? '') : idea.trim() === '' ? THINK_DISABLED : open ? '' : null
  // An idea that might be too open to make well: thinking it through is the suggested next step.
  const suggested = off === null && checkPrompt({ task: idea, folder: 'new' }).length > 0
  const button = (
    <Button
      variant={suggested ? 'secondary' : 'outline'}
      data-suggested={suggested ? '' : undefined}
      icon={<MessagesSquare aria-hidden />}
      loading={busy === 'think' && turns.length === 0 && current === null}
      disabled={off !== null}
      onClick={start}
      data-testid="easy-think"
    >
      {THINK_LABEL}
    </Button>
  )
  return (
    <div className="flex flex-col gap-2" data-testid="easy-think-section">
      <div className="flex flex-wrap items-center gap-3">
        {off !== null && off !== '' ? <DisabledHint reason={off}>{button}</DisabledHint> : button}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{THINK_TEXT}</p>
      </div>
      <p className="h-5 truncate text-xs text-muted-foreground" data-testid="easy-think-cost">
        {helper !== null ? thinkCostText(helper.vendor, helper.usd, EASY_THINK_ROUNDS) : (cost?.reason ?? '')}
      </p>
      {open && (
        <section
          aria-labelledby={headingId}
          className="flex flex-col gap-3 rounded-lg border bg-card p-4"
          data-testid="easy-think-panel"
        >
          <h2 id={headingId} className="text-base font-semibold">
            {THINK_TITLE}
          </h2>
          {current !== null && (
            <div className="flex flex-col gap-2" data-testid="easy-think-question">
              <p className="text-xs text-muted-foreground">
                {thinkRoundText(turns.length + 1, EASY_THINK_ROUNDS)}
              </p>
              <p className="text-sm font-medium break-words">{current.question}</p>
              <p className="text-xs text-muted-foreground">{THINK_PICK}</p>
              <ul className="flex flex-col gap-2">
                {current.options.map((o, i) => (
                  <li key={`${i}-${o}`}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      data-testid={`easy-think-option-${i}`}
                      onClick={() => answer(o)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-left text-sm break-words outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      {o}
                    </button>
                  </li>
                ))}
              </ul>
              <label htmlFor={ownId} className="text-sm">
                {THINK_OWN_LABEL}
              </label>
              <Textarea
                id={ownId}
                rows={2}
                maxLength={EASY_THINK_ANSWER_MAX}
                className="h-16 resize-none"
                placeholder={THINK_OWN_PLACEHOLDER}
                value={own}
                onChange={(e) => setOwn(e.currentTarget.value)}
                data-testid="easy-think-own"
              />
            </div>
          )}
          {brief !== null && (
            <div className="flex flex-col gap-2" data-testid="easy-think-brief">
              <p className="text-sm font-medium">{THINK_BRIEF_LABEL}</p>
              <p className="text-sm break-words whitespace-pre-wrap" data-testid="easy-think-brief-text">
                {brief.brief}
              </p>
              {brief.kind !== undefined && (
                <p className="text-xs text-muted-foreground">{thinkKindText(brief.kind)}</p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {current !== null && (
              <>
                <Button
                  variant="outline"
                  icon={<TextCursorInput aria-hidden />}
                  loading={busy === 'think'}
                  disabled={own.trim() === ''}
                  onClick={() => answer(own.trim())}
                  data-testid="easy-think-send"
                >
                  {THINK_SEND}
                </Button>
                <Button
                  variant="outline"
                  icon={<PenLine aria-hidden />}
                  disabled={busy !== null}
                  onClick={() => ask(turns, true)}
                  data-testid="easy-think-finish"
                >
                  {THINK_FINISH}
                </Button>
              </>
            )}
            {brief !== null && (
              <Button
                icon={<PenLine aria-hidden />}
                disabled={used}
                onClick={() => {
                  onBrief(brief.brief, brief.kind)
                  setUsed(true)
                }}
                data-testid="easy-think-use"
              >
                {THINK_USE}
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<Square aria-hidden />}
              onClick={stop}
              data-testid="easy-think-stop"
            >
              {THINK_STOP}
            </Button>
          </div>
          <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-think-note">
            {used ? THINK_USED : note}
          </p>
        </section>
      )}
    </div>
  )
}
