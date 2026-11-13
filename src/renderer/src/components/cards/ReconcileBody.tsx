// reconcile card (paths beside core-built choices, from core's reconciliation table; state rows
// R5/R6/R7/R10/P15). Core checks the folder at a pass boundary and says what it found: each table row that
// applies, in plain words, with its copyable commands (a block's `git <op> --abort`); the files changed outside the run
// (those the run changed too first), the first few with "and N more" and the full list in a disclosure; and core's
// choices, the default as the primary button (Auto takes it; a block has none and waits). "I ran it → Re-check" on a
// copied command takes the card's own Recheck.
import { Info, OctagonX, TriangleAlert } from 'lucide-react'
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { CopyCommands } from '../recovery/CopyCommands.tsx'
import { RecoveryActions } from '../recovery/RecoveryActions.tsx'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { PathList } from './PathList.tsx'
import { CHOICE, choicesWithDefault, reconcileOf } from './payload.ts'
import type { ReconcileSeverity } from './payload.ts'
import type { CardResolver } from './resolve.ts'

/** What the overlapping and the other external files are called. */
export const OVERLAP_LABEL = 'Changed by the run and edited outside it'
export const EXTERNAL_LABEL = 'Edited outside the run'

const SEVERITY_ICON = { block: OctagonX, choice: TriangleAlert, info: Info } as const
const SEVERITY_TONE: Readonly<Record<ReconcileSeverity, string>> = {
  block: 'text-destructive',
  choice: 'text-warning',
  info: 'text-info',
}
/**
 * What core's body says before its list of reasons ("Dim Factory checked the folder before Review."): the reasons
 * themselves are shown from the payload, each with its commands, so the body's list is not repeated.
 */
export function bodyLead(body: string): string {
  const lines = body.split('\n')
  const end = lines.findIndex((l) => l.trimStart().startsWith('- '))
  return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim()
}

/** Read out before a reason, so its weight does not rest on the icon's colour alone. */
const SEVERITY_WORD: Readonly<Record<ReconcileSeverity, string>> = {
  block: 'Blocks the run: ',
  choice: 'Needs your choice: ',
  info: 'Note: ',
}

export function ReconcileBody({
  runId,
  card,
  resolver,
}: {
  runId: string
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const view = reconcileOf(card)
  const overlap = new Set(view.overlapping)
  const others = view.external.filter((p) => !overlap.has(p))
  const canRecheck = card.choices.some((c) => c.id === CHOICE.recheck)
  const recheck = canRecheck ? () => resolver.resolve(CHOICE.recheck) : undefined
  const lead = bodyLead(card.body)
  return (
    <div className="flex flex-col gap-3">
      {view.reasons.length === 0
        ? card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />
        : lead !== '' && (
            <p data-testid="reconcile-lead" className="text-sm text-muted-foreground">
              {lead}
            </p>
          )}
      {view.reasons.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="reconcile-reasons">
          {view.reasons.map((r, i) => {
            const Icon = SEVERITY_ICON[r.severity]
            return (
              <li
                key={`${r.row}-${i}`}
                data-testid={`reconcile-reason-${r.row !== '' ? r.row : i}`}
                data-severity={r.severity}
                className="flex items-start gap-2"
              >
                <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', SEVERITY_TONE[r.severity])} />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div>
                    <p className="text-sm font-medium">
                      <span className="sr-only">{SEVERITY_WORD[r.severity]}</span>
                      {r.title}
                    </p>
                    {r.detail !== '' && (
                      <p className="text-sm break-words text-muted-foreground">{r.detail}</p>
                    )}
                  </div>
                  <RecoveryActions
                    actions={r.actions}
                    runId={runId}
                    onRecheck={recheck}
                    layout="commands"
                    check={{ title: r.title, detail: r.detail }}
                  />
                  <CopyCommands commands={r.commands} testId={`reconcile-commands-${i}`} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <PathList label={OVERLAP_LABEL} paths={view.overlapping} testId="reconcile-overlapping" />
      <PathList label={EXTERNAL_LABEL} paths={others} testId="reconcile-external" />
      <RecoveryActions actions={view.actions} runId={runId} onRecheck={recheck} layout="commands" />
      <ChoiceRow busy={resolver.busy}>
        {choicesWithDefault(card).map((c) => (
          <ChoiceButton
            key={c.id}
            card={card}
            choice={c}
            busy={resolver.busy}
            onChoose={() => resolver.resolve(c.id)}
          />
        ))}
      </ChoiceRow>
    </div>
  )
}
