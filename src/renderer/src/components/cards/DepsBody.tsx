// depsConsent and depsFailed cards (an isolated run's Prepare step installs its dependencies; each card shows the
// command and its streamed output; failure category deps_missing). An isolated run installs its dependencies in its
// copy only with a `deps` trust grant: with `install:'ask'` and no grant, depsConsent offers [Install] (which writes the
// grant) [Edit command] [Skip install]; a failed install opens depsFailed [Retry] [Edit command] [Skip install]
// [Cancel]. Core builds both; this shows the command, where it runs and what it was found from, and for a failure what
// went wrong with the end of the install's output (an inner region with a fixed maximum height; the whole stream is the
// PrepareCard's). [Edit command] opens an editor in place: the line is split as core splits it and shell syntax is
// refused before anything is sent (one error line reserved, so typing moves nothing); [Use this command] sends core's
// edit choice with the line. Every other choice is core's, as core labels it.
import { Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { parseInstallCommand } from '../../pages/settings/isolation/installCommand.ts'
import { REGION } from '../run/follow.tsx'
import { depsOf, editCommandChoice } from '../run/isolation.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { VERIFY_REGION_MAX } from '../run/VerifyOutput.tsx'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { paragraphs } from './payload.ts'
import type { CardResolver } from './resolve.ts'

export const USE_COMMAND_LABEL = 'Use this command'
export const CANCEL_EDIT_LABEL = 'Keep the command'

/** Where the install runs, in words. */
export function installWhere(cwdRel: string): string {
  return cwdRel === '.' || cwdRel === '' ? 'In the isolated copy' : `In ${cwdRel}, in the isolated copy`
}

/** Where the command came from: the lockfile core read, the project's settings, or the user's edit. */
export function installSource(d: {
  lockfile: string | null
  manager: string | null
  source: 'detected' | 'config' | 'edited' | null
}): string {
  if (d.source === 'config') return "From the project's settings (installCommand)"
  if (d.source === 'edited') return 'As you edited it'
  if (d.lockfile !== null) return `Found from ${d.lockfile}`
  if (d.manager !== null && d.manager !== 'custom') return `Found for ${d.manager}`
  return ''
}

/** What went wrong with an install: core's reason, else that it timed out, else its exit code. */
export function installWhy(d: { reason: string | null; exitCode: number | null; timedOut: boolean }): string {
  if (d.reason !== null) return d.reason
  if (d.timedOut) return 'It ran for 15 minutes without finishing, so Dim Factory stopped it.'
  return d.exitCode !== null ? `It exited with code ${d.exitCode}.` : 'It did not finish.'
}

export function DepsBody({ card, resolver }: { card: CardView; resolver: CardResolver }): React.JSX.Element {
  const d = depsOf(card)
  const failed = card.kind === 'depsFailed'
  const paras = paragraphs(card.body)
  // Core's words around what the card shows itself: all but its closing line before the command (depsFailed: only the
  // first, since "What went wrong" says core's reason), the closing line after it.
  const closing = paras.length > 1 ? (paras.at(-1) ?? '') : ''
  const before = paras.length > 1 ? paras.slice(0, -1) : paras
  const lead = failed && d.reason !== null ? before.slice(0, 1) : before
  const edit = editCommandChoice(card)
  const [editing, setEditing] = useState(false)
  const [line, setLine] = useState(d.command)
  const [tried, setTried] = useState(false)
  const id = useId()
  const parsed = parseInstallCommand(line)
  const lineError = !tried && line.trim() === '' ? null : parsed.ok ? null : parsed.message
  const source = installSource(d)

  const submitCommand = (): void => {
    setTried(true)
    if (!parsed.ok || edit === undefined) return
    resolver.resolve(edit.id, line.trim())
  }

  return (
    <div className="flex flex-col gap-3" data-deps={card.kind}>
      {lead.map((p, i) => (
        <LightMarkdown key={i} text={p} className="text-sm" />
      ))}
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Command</dt>
          <dd className="min-w-0">
            <code data-testid="deps-command" className="font-mono text-xs break-all">
              {d.command !== '' ? d.command : 'No command'}
            </code>
            <span className="block text-xs text-muted-foreground" data-testid="deps-where">
              {installWhere(d.cwdRel)}
              {source !== '' && ` · ${source}`}
            </span>
          </dd>
        </div>
        {failed && (
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">What went wrong</dt>
            <dd className="flex min-w-0 flex-col gap-1">
              <p className="text-sm text-warning" data-testid="deps-why">
                {installWhy(d)}
              </p>
              {d.excerpt !== null && (
                <pre
                  tabIndex={0}
                  aria-label="End of the install's output"
                  data-testid="deps-excerpt"
                  data-scroll-region="prepare-output"
                  className={cn(
                    'stream-text rounded-md border bg-muted/40 px-2 py-1 text-xs break-words whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    REGION,
                    VERIFY_REGION_MAX,
                  )}
                >
                  {d.excerpt}
                </pre>
              )}
            </dd>
          </div>
        )}
      </dl>
      {editing && edit !== undefined && (
        <form
          data-testid="deps-edit"
          aria-label="Edit the install command"
          className="flex flex-col gap-1 rounded-md border bg-background p-2"
          onSubmit={(e) => {
            e.preventDefault()
            submitCommand()
          }}
        >
          <label htmlFor={`${id}-line`} className="text-xs font-medium text-muted-foreground">
            Install command (no shell: a pipe or redirect needs a package script)
          </label>
          <Input
            id={`${id}-line`}
            data-testid="deps-edit-line"
            value={line}
            spellCheck={false}
            aria-invalid={lineError !== null || undefined}
            aria-describedby={`${id}-error`}
            onChange={(e) => setLine(e.currentTarget.value)}
            className="h-8 font-mono text-xs"
          />
          <p
            id={`${id}-error`}
            data-testid="deps-edit-error"
            role={lineError !== null ? 'alert' : undefined}
            className="min-h-4 text-xs text-destructive"
          >
            {lineError ?? ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid="deps-edit-use"
              disabled={resolver.busy !== null}
              aria-busy={resolver.busy === edit.id || undefined}
            >
              {USE_COMMAND_LABEL}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="deps-edit-cancel"
              disabled={resolver.busy !== null}
              onClick={() => {
                setEditing(false)
                setLine(d.command)
                setTried(false)
              }}
            >
              {CANCEL_EDIT_LABEL}
            </Button>
          </div>
        </form>
      )}
      {closing !== '' && <p className="text-sm text-muted-foreground">{closing}</p>}
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) =>
          c === edit ? (
            <Button
              key={c.id}
              size="sm"
              variant="outline"
              icon={<Pencil aria-hidden />}
              data-testid={`card-choice-${c.id}`}
              aria-expanded={editing}
              disabled={resolver.busy !== null}
              onClick={() => setEditing((v) => !v)}
            >
              {c.label}
            </Button>
          ) : (
            <ChoiceButton
              key={c.id}
              card={card}
              choice={c}
              busy={resolver.busy}
              onChoose={() => resolver.resolve(c.id)}
            />
          ),
        )}
      </ChoiceRow>
    </div>
  )
}
