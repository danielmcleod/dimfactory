// gate:beforeFix (findings must-first with checkboxes and filters · "Fix will receive 3 must ·
// 2 should" · reverted-file notes · [Continue with N] [Skip Fix] [Cancel]; state row R9). Continue sends the ticked
// finding ids (in core's order) as the choice's `input`; none ticked completes the run with findings open. Continue's
// count changes with every tick, so the button keeps the width of its widest count (UI control standard).
// One scroll region per screen: the findings list reads in the page flow, and "Fix will receive …" with the choices
// stays at the bottom of the reading area while the card is on screen (StickyActions).
import { Anchor, FlaskConical, ListChecks } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isSecurityFinding } from '@shared/findings.ts'
import type { Finding } from '@shared/findings.ts'
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { KEYS, useShortcut } from '../../lib/keys.ts'
import { renderInline } from '../run/LightMarkdown.tsx'
import { SecurityLevelChip } from '../run/SecurityCard.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { gateFindings } from './payload.ts'
import type { CardResolver } from './resolve.ts'
import { StickyActions } from './StickyActions.tsx'

type Filter = 'all' | 'must' | 'should' | 'grounding'

/** The chip of a finding from a failing verify command. */
export const VERIFY_SOURCE_LABEL = 'Verify'
/** The chip of a finding from Test-first's check that Implement left the tests whole. */
export const TESTS_SOURCE_LABEL = 'Tests'
/** A verify command that already failed before the run (the baseline check). */
export const PREEXISTING_LABEL = 'Already failing before this run'
/** The chip of a finding from Dim Factory's grounding checks (what the AI said against what the run shows). */
export const GROUNDING_SOURCE_LABEL = 'Grounding'
/** A failure or claim that points to something the AI made up (a module, an API, a package). */
export const HALLUCINATION_LABEL = 'Possible hallucination'
/** A finding the optional AI judge raised. */
export const AI_JUDGED_LABEL = 'AI-judged'

/** A grounding finding: the grounding checks', or a reviewer's marked `(grounding)`. */
export function isGroundingFinding(f: Pick<Finding, 'source' | 'flags'>): boolean {
  return f.source === 'grounding' || (Array.isArray(f.flags) && f.flags.includes('grounding'))
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** One finding with its checkbox (also the rows of Re-run from Fix's picker, components/run/FixPicker.tsx). */
export function FindingRow({
  f,
  checked,
  onChange,
  idPrefix = 'finding',
}: {
  f: Finding
  checked: boolean
  onChange: (on: boolean) => void
  /** The checkbox's DOM id and the row's test id start with it (pickers of several runs can be on one page). */
  idPrefix?: string
}): React.JSX.Element {
  const id = `${idPrefix}-${f.id}`
  return (
    <li className="flex items-start gap-2 py-1" data-testid={id} data-severity={f.severity}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <Badge variant={f.severity === 'must' ? 'failed' : 'secondary'} className="uppercase">
            {f.severity}
          </Badge>
          <span className="text-muted-foreground tabular-nums">F{f.n}</span>
          <span className="min-w-0 font-medium break-words">{renderInline(f.title)}</span>
          {f.source === 'verify' ? (
            // A failing verify command, not a reviewer's opinion (`source:'verify'`).
            <Badge variant="outline" className="gap-1 font-normal" data-testid={`finding-source-${f.id}`}>
              <ListChecks aria-hidden className="size-3" />
              {VERIFY_SOURCE_LABEL}
            </Badge>
          ) : f.source === 'grounding' ? (
            // Dim Factory's own grounding checks: the AI's claims against the run (`source:'grounding'`).
            <Badge variant="outline" className="gap-1 font-normal" data-testid={`finding-source-${f.id}`}>
              <Anchor aria-hidden className="size-3" />
              {GROUNDING_SOURCE_LABEL}
            </Badge>
          ) : f.source === 'tests' ? (
            // Test-first's guard: Implement weakened a test written before it (`source:'tests'`).
            <Badge variant="outline" className="gap-1 font-normal" data-testid={`finding-source-${f.id}`}>
              <FlaskConical aria-hidden className="size-3" />
              {TESTS_SOURCE_LABEL}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid={`finding-source-${f.id}`}>
              {f.source === 'scan'
                ? 'from the security scan'
                : f.source === 'acceptance'
                  ? 'from the acceptance review'
                  : `from ${f.source}`}
            </span>
          )}
          {/* The security advisor's findings (its reviewer's and its scanners'): the level they were raised at. */}
          {isSecurityFinding(f) && <SecurityLevelChip level={f.level} testId={`finding-security-${f.id}`} />}
          {f.source !== 'grounding' && Array.isArray(f.flags) && f.flags.includes('grounding') && (
            <Badge variant="outline" className="font-normal" data-testid={`finding-grounding-${f.id}`}>
              {GROUNDING_SOURCE_LABEL}
            </Badge>
          )}
          {Array.isArray(f.flags) && f.flags.includes('possible-hallucination') && (
            <Badge
              variant="outline"
              className="border-warning/60 font-normal text-foreground"
              data-testid={`finding-hallucination-${f.id}`}
            >
              {HALLUCINATION_LABEL}
            </Badge>
          )}
          {Array.isArray(f.flags) && f.flags.includes('ai-judged') && (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
              data-testid={`finding-judged-${f.id}`}
            >
              {AI_JUDGED_LABEL}
            </Badge>
          )}
          {Array.isArray(f.flags) && f.flags.includes('preexisting') && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {PREEXISTING_LABEL}
            </Badge>
          )}
        </label>
        {f.body.trim() !== '' && (
          <details className="mt-0.5 text-xs">
            <summary className="cursor-pointer text-muted-foreground select-none">Details</summary>
            <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">{f.body}</p>
          </details>
        )}
      </div>
    </li>
  )
}

export function BeforeFixBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const { findings, selected: initial, notes } = useMemo(() => gateFindings(card), [card])
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial))
  const [filter, setFilter] = useState<Filter>('all')

  const counts = {
    must: findings.filter((f) => f.severity === 'must').length,
    should: findings.filter((f) => f.severity === 'should').length,
    grounding: findings.filter(isGroundingFinding).length,
  }
  const picked = findings.filter((f) => selected.has(f.id))
  const pickedMust = picked.filter((f) => f.severity === 'must').length
  const shown =
    filter === 'all'
      ? findings
      : filter === 'grounding'
        ? findings.filter(isGroundingFinding)
        : findings.filter((f) => f.severity === filter)

  const go = card.choices.find((c) => c.input === 'findings')
  const others = card.choices.filter((c) => c !== go)
  const doContinue = (): void => {
    if (go === undefined || resolver.busy !== null) return
    resolver.resolve(
      go.id,
      picked.map((f) => f.id),
    )
  }
  useShortcut(KEYS.runOrApprove, doContinue, { description: 'Continue to Fix', enabled: go !== undefined })

  const toggle = (id: string, on: boolean): void =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const setMany = (ids: readonly string[], on: boolean): void =>
    setSelected((cur) => {
      const next = new Set(cur)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: `All ${findings.length}` },
    { id: 'must', label: `Must ${counts.must}` },
    { id: 'should', label: `Should ${counts.should}` },
    // The grounding filter is there only when a grounding finding is (the card never changes while it is open).
    ...(counts.grounding > 0 ? [{ id: 'grounding' as const, label: `Grounding ${counts.grounding}` }] : []),
  ]

  return (
    <div className="flex flex-col gap-3">
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Show findings" className="inline-flex rounded-md border p-0.5">
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                data-testid={`findings-filter-${f.id}`}
                onClick={() => setFilter(f.id)}
                // Selection is the background only: a bolder label would widen the segment and move its neighbours.
                className={cn(
                  'rounded px-2 py-0.5 text-xs tabular-nums',
                  filter === f.id ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-xs text-primary underline-offset-4 hover:underline"
            onClick={() =>
              setMany(
                shown.map((f) => f.id),
                true,
              )
            }
          >
            Tick shown
          </button>
          <button
            type="button"
            className="text-xs text-primary underline-offset-4 hover:underline"
            onClick={() =>
              setMany(
                shown.map((f) => f.id),
                false,
              )
            }
          >
            Untick shown
          </button>
        </div>
      )}
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {card.body !== '' ? card.body : 'There are no findings.'}
        </p>
      ) : (
        <ul className="flex flex-col" aria-label="Findings">
          {shown.map((f) => (
            <FindingRow key={f.id} f={f} checked={selected.has(f.id)} onChange={(on) => toggle(f.id, on)} />
          ))}
        </ul>
      )}
      <StickyActions testId="before-fix-actions">
        <p className="text-sm" data-testid="fix-receives" aria-live="polite">
          Fix will receive {pickedMust} must · {picked.length - pickedMust} should
        </p>
        <ChoiceRow busy={resolver.busy}>
          {go !== undefined && (
            <ChoiceButton
              card={card}
              choice={go}
              busy={resolver.busy}
              onChoose={doContinue}
              label={`Continue with ${plural(picked.length, 'finding')}`}
              // Every count up to all findings fits: as many zeros as the total has digits (tabular figures).
              labels={[`Continue with ${'0'.repeat(String(findings.length).length)} findings`]}
              combo={KEYS.runOrApprove}
            />
          )}
          {others.map((c) => (
            <ChoiceButton
              key={c.id}
              card={card}
              choice={c}
              busy={resolver.busy}
              onChoose={() => resolver.resolve(c.id)}
            />
          ))}
        </ChoiceRow>
      </StickyActions>
    </div>
  )
}
