// A page's Done screen: "Try it for me", a walk through the page in a hidden window (shared/try-it.ts) with no internet and
// no tokens. It says what it pressed and what went wrong, and a problem it found can go straight to "It's not working".
// UI standards: the section is there from the first frame; the status line keeps its height; the buttons keep their labels.
import { Bug, MousePointerClick } from 'lucide-react'
import { useState } from 'react'
import type { TryItReport } from '@shared/try-it.ts'
import { tryItProblems, tryItSummary } from '@shared/try-it.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { openSession } from './session.ts'
import {
  TRY_IT_FIX,
  TRY_IT,
  TRY_IT_LIMIT,
  TRY_IT_SKIPPED,
  TRY_IT_TEXT,
  TRY_IT_TITLE,
  tryItAsked,
} from './text.ts'

export function EasyTryIt({
  runId,
  onFix,
}: {
  runId: string
  /** Hands what was found to "It's not working". */
  onFix: (seen: string) => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [report, setReport] = useState<TryItReport | null>(null)
  const [note, setNote] = useState('')
  const go = (): void =>
    run('try', async () => {
      setNote('')
      const s = await openSession(runId, false)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      const r = await invoke('preview.tryIt', { sessionId: s.sessionId })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      setReport(r.value)
      setNote(tryItSummary(r.value))
    })
  const problems = report !== null ? tryItProblems(report) : []
  return (
    <section className="flex flex-col gap-2 border-t pt-4" data-testid="easy-done-tryit">
      <h2 className="text-base font-semibold">{TRY_IT_TITLE}</h2>
      <p className="text-sm">{TRY_IT_TEXT}</p>
      <p className="text-xs text-muted-foreground">{TRY_IT_LIMIT}</p>
      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="easy-tryit-problems">
          {problems.map((p, i) => (
            <li key={`${i}-${p}`} className="break-words">
              {p}
            </li>
          ))}
        </ul>
      )}
      {report !== null && report.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="easy-tryit-skipped">
          {TRY_IT_SKIPPED} {report.skipped.join(', ')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          icon={<MousePointerClick />}
          loading={busy === 'try'}
          onClick={go}
          data-testid="easy-try-it"
        >
          {TRY_IT}
        </Button>
        {problems.length > 0 && (
          <Button
            variant="outline"
            icon={<Bug />}
            onClick={() => {
              onFix(tryItAsked(problems))
            }}
            data-testid="easy-tryit-fix"
          >
            {TRY_IT_FIX}
          </Button>
        )}
      </div>
      <p className="min-h-5 text-sm text-muted-foreground" data-testid="easy-tryit-note">
        {note}
      </p>
    </section>
  )
}
