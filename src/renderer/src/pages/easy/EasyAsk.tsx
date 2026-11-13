// A project's Done screen: "Ask about it", one question about the project ("how do I change the colours?") answered in
// plain words. Only on the click (which says first who reads the files and about what it costs), one read-only call on the
// vendor's cheapest model reads the project and answers; nothing in the project is changed. Core says who would answer,
// or honestly why nobody can (then the button is off and the reason is shown).
// UI standards: the section is there from the first frame; its cost and status lines keep their height; the button
// keeps its label (busy: `loading`).
import { MessageCircleQuestion } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { EASY_ASK_MAX } from '@shared/easy.ts'
import type { EasyHelperCost } from '@shared/easy.ts'
import { LightMarkdown } from '../../components/run/LightMarkdown.tsx'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import {
  ASK,
  ASK_DISABLED,
  ASK_LABEL,
  ASK_PLACEHOLDER,
  ASK_TEXT,
  ASK_TITLE,
  ASK_WAITING,
  askCostText,
} from './text.ts'

export function EasyAsk({ runId }: { runId: string }): React.JSX.Element {
  const [cost, setCost] = useState<EasyHelperCost | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, run] = useBusy()
  const id = useId()
  const headingId = useId()
  useEffect(() => {
    let alive = true
    void invoke('easy.helperCost', { helper: 'ask', runId }).then((r) => {
      if (alive) setCost(r.ok ? r.value : { helper: null })
    })
    return () => {
      alive = false
    }
  }, [runId])
  const helper = cost?.helper ?? null
  const go = (): void =>
    run('ask', async () => {
      setNote(ASK_WAITING)
      const r = await invoke('easy.ask', { runId, question: question.trim() })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      setNote('')
      setAnswer(r.value.answer)
    })
  const reason = helper === null ? (cost?.reason ?? ASK_TITLE) : question.trim() === '' ? ASK_DISABLED : null
  const button = (
    <Button
      variant="outline"
      icon={<MessageCircleQuestion aria-hidden />}
      loading={busy === 'ask'}
      disabled={reason !== null}
      onClick={go}
      data-testid="easy-ask"
    >
      {ASK}
    </Button>
  )
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 border-t pt-4"
      data-testid="easy-done-ask"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {ASK_TITLE}
      </h2>
      <p className="text-sm">{ASK_TEXT}</p>
      <label htmlFor={id} className="sr-only">
        {ASK_LABEL}
      </label>
      <Textarea
        id={id}
        rows={2}
        maxLength={EASY_ASK_MAX}
        className="h-16 resize-none"
        placeholder={ASK_PLACEHOLDER}
        value={question}
        onChange={(e) => setQuestion(e.currentTarget.value)}
        data-testid="easy-ask-question"
      />
      <p className="h-5 truncate text-xs text-muted-foreground" data-testid="easy-ask-cost">
        {helper !== null ? askCostText(helper.vendor, helper.usd) : (cost?.reason ?? '')}
      </p>
      <div>{reason !== null ? <DisabledHint reason={reason}>{button}</DisabledHint> : button}</div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-ask-note">
        {note}
      </p>
      {answer !== null && (
        <div className="rounded-md border bg-card p-3" data-testid="easy-ask-answer">
          <LightMarkdown text={answer} className="text-sm" />
        </div>
      )}
    </section>
  )
}
