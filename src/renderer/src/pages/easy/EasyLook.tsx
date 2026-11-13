// Easy mode's "Look it over" on the Done screen of a website, an app or a game: an optional, read-only look at a
// picture of the page (the smoke check's screenshot; taken first when there is none) by a vendor that takes pictures.
// Core says who would look, or honestly why nobody can (then the button is off and the reason is shown).
// The look happens only on the click, says first that the picture is sent and about what it costs, and its findings
// (`[should]` findings of the run's preview check) are listed with "Fix these" (a change run with them).
// UI standards: the section is there from the first frame (the Done screen waits for core's answer); its result line
// keeps its height; buttons keep their labels.
import { Eye, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EasyVisualFinding, EasyVisualState } from '@shared/easy.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { useEasyState } from '../../state/experience.ts'
import { upsertPreviewSessions } from '../../state/previews.ts'
import { toast } from '../../state/toasts.ts'
import { fixLooksChange, openTargetOf } from './model.ts'
import {
  FIX_THESE,
  LOOK_FOUND,
  LOOK_LABEL,
  LOOK_NONE,
  LOOK_TEXT,
  LOOK_TITLE,
  OPEN_NOTHING,
  LOOK_GAME_TEXT,
  OPEN_TRUST_FIRST,
  lookGamePrivacyText,
  lookPrivacyText,
} from './text.ts'

/** Core's answer for the run's page (null: none, 'loading' until then). */
export function useVisual(runId: string, enabled: boolean): EasyVisualState | null | 'loading' {
  const [v, setV] = useState<EasyVisualState | null | 'loading'>('loading')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void invoke('easy.visual', { runId }).then((r) => {
      if (alive) setV(r.ok ? r.value : null)
    })
    return () => {
      alive = false
    }
  }, [runId, enabled])
  return v
}

/** A picture of the run's page: its preview (Dim Factory's own static server, or a trusted one) and the smoke check. */
async function takePicture(runId: string): Promise<string | null> {
  const d = await invoke('preview.detect', { runId })
  if (!d.ok) return d.error.message
  upsertPreviewSessions(d.value.sessions)
  const t = openTargetOf(d.value)
  if (t.kind === 'none' || t.kind === 'document') return OPEN_NOTHING
  if (t.kind === 'command') return OPEN_TRUST_FIRST
  let session = d.value.sessions.find((s) => s.commandId === t.commandId && s.status === 'running')
  if (session === undefined) {
    const s = await invoke('preview.start', { runId, commandId: t.commandId })
    if (!s.ok) return s.error.message
    upsertPreviewSessions([s.value])
    session = s.value
  }
  const smoke = await invoke('preview.smoke', { sessionId: session.id })
  return smoke.ok ? null : smoke.error.message
}

export function LookItOver({
  runId,
  folder,
  state,
  photos = false,
}: {
  runId: string
  folder: string
  state: EasyVisualState | null
  /** A game made with the user's own photos: the privacy line says the pictures may show them. */
  photos?: boolean
}): React.JSX.Element {
  const game = state?.game === true
  const [findings, setFindings] = useState<EasyVisualFinding[] | null>(
    state !== null && state.findings.length > 0 ? state.findings : null,
  )
  const [note, setNote] = useState('')
  const [busy, run] = useBusy()
  const settings = useEasyState()?.settings
  const vendor = state?.vendor ?? null
  const look = (): void =>
    run('look', async () => {
      setNote('')
      if (state?.picture !== true) {
        const problem = await takePicture(runId)
        if (problem !== null) {
          setNote(problem)
          return
        }
      }
      const r = await invoke('easy.visualReview', { runId })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      setFindings(r.value.findings)
      setNote(r.value.findings.length === 0 ? LOOK_NONE : '')
    })
  const fix = (): void =>
    run('fix', async () => {
      if (findings === null || findings.length === 0) return
      const r = await invoke('easy.change', {
        folder,
        change: fixLooksChange(findings),
        limits: { maxCostUsd: settings?.changeMaxCostUsd ?? null, maxMinutes: settings?.maxMinutes ?? null },
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      navigate({ name: 'easyRun', runId: r.value.runId })
    })
  const button = (
    <Button
      variant="outline"
      icon={<Eye aria-hidden />}
      loading={busy === 'look'}
      disabled={vendor === null || (busy !== null && busy !== 'look')}
      onClick={look}
      data-testid="easy-look"
    >
      {LOOK_LABEL}
    </Button>
  )
  return (
    <section className="flex flex-col gap-2 border-t pt-4" data-testid="easy-done-look">
      <h2 className="text-base font-semibold">{LOOK_TITLE}</h2>
      <p className="text-sm">{game ? LOOK_GAME_TEXT : LOOK_TEXT}</p>
      <p className="text-sm text-muted-foreground" data-testid="easy-look-who">
        {vendor !== null
          ? game
            ? lookGamePrivacyText(vendor, state?.usd ?? null, photos)
            : lookPrivacyText(vendor, state?.usd ?? null)
          : (state?.reason ?? '')}
      </p>
      <div>
        {vendor === null ? (
          <DisabledHint reason={state?.reason ?? LOOK_LABEL}>{button}</DisabledHint>
        ) : (
          button
        )}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-look-note">
        {note}
      </p>
      {findings !== null && findings.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="easy-look-findings">
          <p className="text-sm font-medium">{LOOK_FOUND}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {findings.map((f) => (
              <li key={f.id} className="break-words">
                <span className="font-medium">{f.title}</span>
                {f.detail !== '' && <span className="text-muted-foreground"> {f.detail}</span>}
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="outline"
              icon={<Wrench aria-hidden />}
              loading={busy === 'fix'}
              disabled={busy !== null && busy !== 'fix'}
              onClick={fix}
              data-testid="easy-look-fix"
            >
              {FIX_THESE}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
