// trust card (the command and its body, a diff when it changed · [Trust for this project] [Skip]; in
// trust.json a grant's hash covers the command and its script body). Verify runs only
// commands the user trusted for the project; a command never trusted, or whose script changed since it was trusted,
// opens this card (non-Auto: Auto never implies trust, it skips the command with a [should] finding instead).
// Core's lead and closing words frame what the card shows itself: the command and where it runs, then the script, or
// what changed in it line by line (core's diff; the renderer's line diff when core sent none). Everything reads in the
// page flow (one scroll region per screen). Core's choices, its primary first.
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { diffLines } from '../../lib/linediff.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { choicesWithDefault, paragraphs, trustOf } from './payload.ts'
import type { BodyDiffLine } from './payload.ts'
import type { CardResolver } from './resolve.ts'

const MINUS = '−'

/** Where the command runs, in words. */
export function whereText(cwdRel: string): string {
  return cwdRel === '.' || cwdRel === '' ? 'In the project folder' : `In ${cwdRel}`
}

/** core's diff, else the renderer's line diff of the two bodies (no context lines dropped: scripts are short). */
export function scriptDiff(
  diff: readonly BodyDiffLine[],
  before: string | null,
  after: string | null,
): BodyDiffLine[] {
  if (diff.length > 0) return [...diff]
  const d = diffLines(before ?? '', after ?? '', { context: Number.MAX_SAFE_INTEGER })
  return d.hunks.flatMap((h) =>
    h.lines.map((l): BodyDiffLine => ({
      op: l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : 'same',
      text: l.text,
    })),
  )
}

/** A script's changes line by line, in the page flow (Settings → Isolation & Verify shows it too). */
export function BodyDiff({
  lines,
  testId = 'trust-diff',
}: {
  lines: readonly BodyDiffLine[]
  testId?: string
}): React.JSX.Element {
  const added = lines.filter((l) => l.op === 'add').length
  const removed = lines.filter((l) => l.op === 'del').length
  return (
    <div
      data-testid={testId}
      role="list"
      aria-label={`Script changes: ${added} added, ${removed} removed`}
      className="stream-text rounded-md border bg-background py-0.5 text-xs"
    >
      {lines.map((l, i) => (
        <div
          key={i}
          role="listitem"
          data-op={l.op}
          className={cn(
            'flex gap-2 px-2 whitespace-pre-wrap',
            l.op === 'add' && 'bg-diff-add-bg text-diff-add',
            l.op === 'del' && 'bg-diff-del-bg text-diff-del',
          )}
        >
          <span aria-hidden className="w-3 shrink-0">
            {l.op === 'add' ? '+' : l.op === 'del' ? MINUS : ' '}
          </span>
          <span className="min-w-0 break-words">
            <span className="sr-only">{l.op === 'add' ? 'Added: ' : l.op === 'del' ? 'Removed: ' : ''}</span>
            {l.text}
          </span>
        </div>
      ))}
    </div>
  )
}

export function TrustBody({ card, resolver }: { card: CardView; resolver: CardResolver }): React.JSX.Element {
  const t = trustOf(card)
  const paras = paragraphs(card.body)
  const lead = paras[0] ?? ''
  const closing = paras.length > 1 ? (paras.at(-1) ?? '') : ''
  const changed = t.trust === 'changed'
  const diff = changed ? scriptDiff(t.diff, t.grantedBody, t.body) : []
  return (
    <div className="flex flex-col gap-3" data-trust={t.trust}>
      {lead !== '' && <LightMarkdown text={lead} className="text-sm" />}
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Command</dt>
          <dd className="min-w-0">
            <code data-testid="trust-command" className="font-mono text-xs break-all">
              {t.command !== '' ? t.command : t.name}
            </code>
            <span className="block text-xs text-muted-foreground" data-testid="trust-where">
              {whereText(t.cwdRel)}
            </span>
          </dd>
        </div>
        {changed ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">What changed in its script</dt>
            <dd className="min-w-0">
              {diff.some((l) => l.op !== 'same') ? (
                <BodyDiff lines={diff} />
              ) : (
                <p className="text-xs text-muted-foreground">Dim Factory could not show the change.</p>
              )}
            </dd>
          </div>
        ) : (
          t.body !== null &&
          t.body !== '' && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Script</dt>
              <dd className="min-w-0">
                <pre
                  data-testid="trust-script"
                  className="stream-text rounded-md border bg-background px-2 py-1 text-xs break-words whitespace-pre-wrap"
                >
                  {t.body}
                </pre>
              </dd>
            </div>
          )
        )}
      </dl>
      {closing !== '' && <p className="text-sm text-muted-foreground">{closing}</p>}
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
