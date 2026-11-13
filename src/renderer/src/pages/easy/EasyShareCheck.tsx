// A website's, an app's or a document's Done screen: "Before I share it", one check in plain words with no model and no
// cost (shared/share-check.ts). Core reads the project's files for passwords, keys and people's details (only pointed
// out, never sent anywhere); for a page, main also opens it in a hidden window at a phone's width with no internet. Each
// line says what was checked and how it stands, what it cannot know is said up front, and the problems a change can fix
// go to Make a change with "Fix these" (never the personal details: those are the person's to decide).
// UI standards: the section is there from the first frame; the status line keeps its height; the buttons keep their labels.
import { ShieldCheck, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { ShareFilesReport, ShareLine, SharePageReport } from '@shared/share-check.ts'
import { shareFileLines, shareFixes, sharePageLines } from '@shared/share-check.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { openSession } from './session.ts'
import {
  SHARE_CHECK,
  SHARE_CHECK_CANNOT,
  SHARE_CHECK_DOC_TEXT,
  SHARE_CHECK_FIX,
  SHARE_CHECK_TEXT,
  SHARE_CHECK_TITLE,
  SHARE_CHECK_WAITING,
  SHARE_STATUS_WORD,
  shareCheckAsked,
  shareCheckSummary,
} from './text.ts'

const STATUS_CLASS: Readonly<Record<ShareLine['status'], string>> = {
  ok: 'w-12 shrink-0 font-medium text-st-done',
  problem: 'w-12 shrink-0 font-medium text-st-failed',
  unknown: 'w-12 shrink-0 font-medium text-muted-foreground',
}

export function EasyShareCheck({
  runId,
  document,
  onFix,
}: {
  runId: string
  /** A document, memo or checklist: its files only (Dim Factory draws its page, so there is no page of its own). */
  document: boolean
  /** Hands what a change can fix to Make a change. */
  onFix: (asked: string) => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [lines, setLines] = useState<ShareLine[] | null>(null)
  const [note, setNote] = useState('')
  const go = (): void =>
    run('share', async () => {
      setNote(SHARE_CHECK_WAITING)
      const filesAsk = invoke('easy.shareFiles', { runId })
      let page: SharePageReport | null = null
      let pageWhy: string | null = null
      if (!document) {
        const s = await openSession(runId, false)
        if (typeof s === 'string') pageWhy = s
        else {
          const r = await invoke('preview.shareCheck', { sessionId: s.sessionId })
          if (r.ok) page = r.value
          else pageWhy = r.error.message
        }
      }
      const f = await filesAsk
      const files: ShareFilesReport | null = f.ok ? f.value : null
      const all = [
        ...(document ? [] : sharePageLines(page, pageWhy)),
        ...shareFileLines(files, f.ok ? null : f.error.message, document),
      ]
      setLines(all)
      setNote(
        shareCheckSummary(
          all.filter((l) => l.status === 'problem').length,
          all.filter((l) => l.status === 'unknown').length,
        ),
      )
    })
  const fixes = lines !== null ? shareFixes(lines) : []
  return (
    <section className="flex flex-col gap-2 border-t pt-4" data-testid="easy-done-share-check">
      <h2 className="text-base font-semibold">{SHARE_CHECK_TITLE}</h2>
      <p className="text-sm">{document ? SHARE_CHECK_DOC_TEXT : SHARE_CHECK_TEXT}</p>
      <p className="text-xs text-muted-foreground">{SHARE_CHECK_CANNOT}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          icon={<ShieldCheck aria-hidden />}
          loading={busy === 'share'}
          onClick={go}
          data-testid="easy-share-check"
        >
          {SHARE_CHECK}
        </Button>
        {fixes.length > 0 && (
          <Button
            variant="outline"
            icon={<Wrench aria-hidden />}
            disabled={busy !== null}
            onClick={() => onFix(shareCheckAsked(fixes))}
            data-testid="easy-share-check-fix"
          >
            {SHARE_CHECK_FIX}
          </Button>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-share-check-note">
        {note}
      </p>
      {lines !== null && (
        <ul className="flex flex-col gap-1.5" data-testid="easy-share-check-lines">
          {lines.map((l, i) => (
            <li
              key={`${l.id}-${i}`}
              className="flex items-start gap-2 text-sm"
              data-status={l.status}
              data-check={l.id}
            >
              <span className={STATUS_CLASS[l.status]}>{SHARE_STATUS_WORD[l.status]}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="break-words">{l.text}</span>
                {l.details !== undefined && l.details.length > 0 && (
                  <span className="flex flex-col text-xs break-all text-muted-foreground">
                    {l.details.map((d) => (
                      <span key={d}>{d}</span>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
