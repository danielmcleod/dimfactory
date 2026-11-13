// finalizeConflicts card (Apply: a file whose folder content is neither the run's base nor its new
// version is a conflict, never overwritten without [Take run's]; no 3-way merge, no conflict markers).
// Core lists the files and offers its [Keep mine] / [Take run's] choices, each taking the paths it applies to
// (`input: 'paths'`; every listed file when sent without). Each file has its own pair of buttons (sending that one
// path), core's reason, and on a click the run's change to it (diff.file on the Combined segment) in the page flow.
// The card's own row holds core's choices for every file at once. Nothing is chosen by default: a file stays the
// user's until they take the run's version.
import { ChevronDown, ChevronRight, FileWarning } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CardChoice, CardView } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { conflictChoices, conflictsOf, KEEP_MINE, TAKE_RUNS } from '../run/isolation.ts'
import type { ConflictFile } from '../run/isolation.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { Button } from '../ui/Button.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { paragraphs } from './payload.ts'
import type { CardResolver } from './resolve.ts'

/** The most lines of a file's change the card shows (the Diff tab has the whole file). */
export const CONFLICT_DIFF_LINES = 200

const MINUS = '−'

export const SHOW_CHANGE = "Show the run's change"
export const HIDE_CHANGE = "Hide the run's change"
export const KEEP_MINE_ALL = 'Keep mine for all'
export const TAKE_RUNS_ALL = "Take run's for all"

/** Core's Keep mine / Take run's for every file at once, said so; other choices keep core's label. */
function forAllLabel(
  c: CardChoice,
  choices: Partial<Record<'mine' | 'theirs', CardChoice>>,
): string | undefined {
  if (c === choices.mine) return KEEP_MINE_ALL
  if (c === choices.theirs) return TAKE_RUNS_ALL
  return undefined
}

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; lines: string[]; cut: boolean } | { kind: 'error'; message: string }

/** The body lines of a unified patch (hunk headers kept, file headers dropped). */
export function patchLines(patch: string): string[] {
  const out: string[] = []
  let inHunk = false
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    if (!inHunk) continue
    if (line.startsWith('\\ No newline')) continue
    out.push(line)
  }
  while (out.length > 0 && out.at(-1) === '') out.pop()
  return out
}

function ConflictDiff({ runId, path }: { runId: string; path: string }): React.JSX.Element {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    void invoke('diff.file', { runId, seg: 'combined', path }).then((r) => {
      if (!live) return
      if (!r.ok) {
        setState({ kind: 'error', message: r.error.message })
        return
      }
      const lines = patchLines(r.value.patch)
      setState({
        kind: 'ready',
        lines: lines.slice(0, CONFLICT_DIFF_LINES),
        cut: r.value.truncated || lines.length > CONFLICT_DIFF_LINES,
      })
    })
    return () => {
      live = false
    }
  }, [runId, path])
  if (state.kind === 'loading') return <p className="text-xs text-muted-foreground">Loading the change…</p>
  if (state.kind === 'error')
    return <p className="text-xs text-destructive">The change could not be read: {state.message}</p>
  if (state.lines.length === 0)
    return <p className="text-xs text-muted-foreground">No line changes to show.</p>
  return (
    <div className="flex flex-col gap-1">
      <div
        role="list"
        aria-label={`The run's change to ${path}`}
        data-testid="conflict-diff"
        className="stream-text rounded-md border bg-background py-0.5 text-xs"
      >
        {state.lines.map((l, i) => {
          const op = l.startsWith('+')
            ? 'add'
            : l.startsWith('-')
              ? 'del'
              : l.startsWith('@@')
                ? 'hunk'
                : 'same'
          return (
            <div
              key={i}
              role="listitem"
              data-op={op}
              className={cn(
                'flex gap-2 px-2 whitespace-pre-wrap',
                op === 'add' && 'bg-diff-add-bg text-diff-add',
                op === 'del' && 'bg-diff-del-bg text-diff-del',
                op === 'hunk' && 'text-muted-foreground',
              )}
            >
              <span aria-hidden className="w-3 shrink-0">
                {op === 'add' ? '+' : op === 'del' ? MINUS : ' '}
              </span>
              <span className="min-w-0 break-words">
                <span className="sr-only">{op === 'add' ? 'Added: ' : op === 'del' ? 'Removed: ' : ''}</span>
                {op === 'hunk' ? l : l.slice(1)}
              </span>
            </div>
          )
        })}
      </div>
      {state.cut && (
        <p className="text-xs text-muted-foreground">
          Showing the first lines only. The Diff tab has the whole file.
        </p>
      )}
    </div>
  )
}

function ConflictRow({
  runId,
  card,
  file,
  index,
  resolver,
  pressed,
  buttons,
  onPress,
}: {
  runId: string
  card: CardView
  file: ConflictFile
  index: number
  resolver: CardResolver
  pressed: string | null
  /** The file has its own Keep mine / Take run's (more than one file on the card). */
  buttons: boolean
  onPress: (side: 'mine' | 'theirs') => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const choices = conflictChoices(card)
  const testId = `conflict-${index}`
  const busy = resolver.busy !== null
  return (
    <li data-testid={testId} data-path={file.path} className="flex min-w-0 flex-col gap-1 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <FileWarning aria-hidden className="size-4 shrink-0 text-warning" />
        <code className="min-w-0 flex-1 basis-48 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </code>
        <div className="flex shrink-0 items-center gap-2">
          {buttons && choices.mine !== undefined && (
            <Button
              size="sm"
              variant="outline"
              data-testid={`${testId}-mine`}
              disabled={busy}
              aria-busy={(busy && pressed === `mine:${file.path}`) || undefined}
              aria-label={`${KEEP_MINE}: ${file.path}`}
              onClick={() => onPress('mine')}
            >
              {KEEP_MINE}
            </Button>
          )}
          {buttons && choices.theirs !== undefined && (
            <Button
              size="sm"
              variant="outline"
              data-testid={`${testId}-theirs`}
              disabled={busy}
              aria-busy={(busy && pressed === `theirs:${file.path}`) || undefined}
              aria-label={`${TAKE_RUNS}: ${file.path}`}
              onClick={() => onPress('theirs')}
            >
              {TAKE_RUNS}
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-6 text-xs">
        {file.reason !== null && (
          <span className="min-w-0 truncate text-muted-foreground" title={file.reason}>
            {file.reason}
          </span>
        )}
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${testId}-toggle`}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1 rounded text-primary hover:underline"
        >
          {open ? (
            <ChevronDown aria-hidden className="size-3" />
          ) : (
            <ChevronRight aria-hidden className="size-3" />
          )}
          <StableLabel labels={[SHOW_CHANGE, HIDE_CHANGE]} align="start">
            {open ? HIDE_CHANGE : SHOW_CHANGE}
          </StableLabel>
        </button>
      </div>
      {open && (
        <div className="pl-6">
          <ConflictDiff runId={runId} path={file.path} />
        </div>
      )}
    </li>
  )
}

export function ConflictsBody({
  runId,
  card,
  resolver,
}: {
  runId: string
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const files = conflictsOf(card)
  const choices = conflictChoices(card)
  // With one file, core's two choices are the file's own; with more, each file has its pair and core's choices are
  // for every file at once. Decided when the card opens: a file core settles later never changes a button's label.
  const [perFile] = useState(files.length > 1)
  const [pressed, setPressed] = useState<string | null>(null)
  const paras = paragraphs(card.body)
  // With the files shown from the payload, core's list of them in the body is not repeated.
  const lead = files.length > 0 ? ((paras[0] ?? '').split('\n')[0]?.trim() ?? '') : card.body
  const closing = files.length > 0 && paras.length > 1 ? (paras.at(-1) ?? '') : ''
  const press = (file: ConflictFile, side: 'mine' | 'theirs'): void => {
    const c = choices[side]
    if (c === undefined) return
    setPressed(`${side}:${file.path}`)
    resolver.resolve(c.id, [file.path])
  }
  return (
    <div className="flex flex-col gap-3">
      {lead !== '' && <LightMarkdown text={lead} className="text-sm" />}
      {files.length > 0 && (
        <ul
          aria-label="Files that changed in your folder too"
          className="flex flex-col divide-y"
          data-testid="conflict-files"
        >
          {files.map((f, i) => (
            <ConflictRow
              key={f.path}
              runId={runId}
              card={card}
              file={f}
              index={i}
              resolver={resolver}
              pressed={pressed}
              buttons={perFile}
              onPress={(side) => press(f, side)}
            />
          ))}
        </ul>
      )}
      {closing !== '' && <p className="text-sm text-muted-foreground">{closing}</p>}
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => {
          const all = perFile ? forAllLabel(c, choices) : undefined
          return (
            <ChoiceButton
              key={c.id}
              card={card}
              choice={c}
              busy={resolver.busy}
              {...(all !== undefined ? { label: all } : {})}
              onChoose={() => {
                setPressed(null)
                resolver.resolve(c.id)
              }}
            />
          )
        })}
      </ChoiceRow>
    </div>
  )
}
