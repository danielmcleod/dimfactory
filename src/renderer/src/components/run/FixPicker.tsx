// Re-run from Fix's findings picker (a new run carrying the selected findings, from Runs history and the Run view's
// [Re-run ▾]). Inline, never a dialog (the palette is the only modal): in the Run
// view it is the last thing in the Flow tab, on the Runs page it opens under its row. The findings are core's
// (findings.json), must first, each with its checkbox as at the gate before Fix (FindingRow). The ticks start as core
// says (rerunFromFix.findingIds: every must, plus the shoulds chosen at the run's gate before Fix), or all of them, as
// the gate starts, from a core that does not say. Continue sends runs.rerun{from:'fix', findingIds} with the ticked
// ids in core's order.
// UI control standards: the start button keeps the width of its widest count, and its state is text beside it.
import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import type { Finding } from '@shared/findings.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { FindingRow } from '../cards/BeforeFixBody.tsx'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { useBusy } from './commands.ts'
import {
  closeFixPicker,
  fixPickerTestId,
  readRerunFromFix,
  rerunFix,
  rerunFromFixSessionText,
  rerunFromFixWhyOf,
  RERUN_FROM_FIX_LABEL,
  stopsSourceFirst,
  stopsSourceText,
  useFixPicker,
  vendorsOfSnapshot,
} from './rerun.ts'
import type { RerunFromFixFacts } from './rerun.ts'

export const PICK_ONE_REASON = 'Tick at least one finding for Fix'

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** "Re-run from Fix with 3 findings": the button's label for a count. */
export function fixPickerStartLabel(n: number): string {
  return `${RERUN_FROM_FIX_LABEL} with ${plural(n, 'finding')}`
}

/** The ticks the picker starts with: core's default (rerunFromFix.findingIds), else every finding (the gate's start). */
export function defaultSelection(
  findings: readonly Finding[],
  facts: Pick<RerunFromFixFacts, 'findingIds'> | null,
): ReadonlySet<string> {
  const ids = facts?.findingIds
  if (ids === undefined) return new Set(findings.map((f) => f.id))
  const want = new Set(ids)
  return new Set(findings.filter((f) => want.has(f.id)).map((f) => f.id))
}

export interface FixPickerProps {
  runId: string
  displayNo: number
  findings: readonly Finding[]
  /** Core's rerunFromFix (the session line); null while not known. */
  facts: RerunFromFixFacts | null
  /** The "Why?" of a fresh start (rerunFromFixWhyOf). */
  why: string | null
  /** The source still holds its folder: it is stopped when the new run starts. */
  stopsSource: boolean
  onCancel: () => void
  /** DOM ids and test ids of the rows start with it (several pickers on one page). */
  idPrefix?: string
  testId?: string
}

export function FixPicker({
  runId,
  displayNo,
  findings,
  facts,
  why,
  stopsSource,
  onCancel,
  idPrefix,
  testId,
}: FixPickerProps): React.JSX.Element {
  const headingId = useId()
  const prefix = idPrefix ?? `fix-${runId}`
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => defaultSelection(findings, facts))
  const [busy, run] = useBusy()
  const picked = findings.filter((f) => selected.has(f.id))
  const pickedMust = picked.filter((f) => f.severity === 'must').length
  const toggle = (id: string, on: boolean): void =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const setAll = (on: boolean): void => setSelected(on ? new Set(findings.map((f) => f.id)) : new Set())
  const start = (): void => {
    if (picked.length === 0) return
    run('start', () =>
      rerunFix(
        runId,
        picked.map((f) => f.id),
      ),
    )
  }
  const label = fixPickerStartLabel(picked.length)
  // Every count up to all findings fits: as many zeros as the total has digits (tabular figures).
  const widest = `${RERUN_FROM_FIX_LABEL} with ${'0'.repeat(String(findings.length).length)} findings`
  const icon = <RotateCcw aria-hidden />

  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId ?? fixPickerTestId(runId)}
      data-run-id={runId}
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {RERUN_FROM_FIX_LABEL}
      </h3>
      <p className="text-sm">
        A new run starts at Fix with the findings you tick. Plan, Implement, Review and Critic are carried
        over from run #{displayNo}, not run again.
      </p>
      {facts !== null && (
        <p className="text-sm text-muted-foreground" data-testid="fix-picker-session">
          {rerunFromFixSessionText(facts)}.{why !== null ? ` ${why}` : ''}
        </p>
      )}
      {stopsSource && (
        <p className="text-sm text-warning" data-testid="fix-picker-stops-source">
          {stopsSourceText(displayNo)}
        </p>
      )}
      {findings.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="text-xs text-primary underline-offset-4 hover:underline"
              data-testid="fix-picker-tick-all"
              onClick={() => setAll(true)}
            >
              Tick all
            </button>
            <button
              type="button"
              className="text-xs text-primary underline-offset-4 hover:underline"
              data-testid="fix-picker-untick-all"
              onClick={() => setAll(false)}
            >
              Untick all
            </button>
          </div>
          <ul className="flex flex-col" aria-label="Findings">
            {findings.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                checked={selected.has(f.id)}
                onChange={(on) => toggle(f.id, on)}
                idPrefix={prefix}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">This run has no findings for Fix.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-48 text-sm" data-testid="fix-picker-receives" aria-live="polite">
          Fix will receive {pickedMust} must · {picked.length - pickedMust} should
        </p>
        {picked.length === 0 ? (
          <DisabledHint reason={PICK_ONE_REASON}>
            <Button size="sm" disabled data-testid="fix-picker-start" icon={icon} labels={[widest, label]}>
              {label}
            </Button>
          </DisabledHint>
        ) : (
          <Button
            size="sm"
            data-testid="fix-picker-start"
            icon={icon}
            labels={[widest, label]}
            loading={busy === 'start'}
            onClick={start}
          >
            {label}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-testid="fix-picker-cancel"
          disabled={busy !== null}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </section>
  )
}

/** The Run view's picker: the last thing in the Flow tab while it is open (rerun.ts openFixPicker). */
export function RunFixPicker({ snap }: { snap: RunSnapshot }): React.JSX.Element | null {
  const runId = snap.summary.runId
  const entry = useFixPicker(runId)
  if (entry === null) return null
  const facts = readRerunFromFix(snap.rerunFromFix)
  return (
    <FixPicker
      runId={runId}
      displayNo={snap.summary.displayNo}
      findings={entry.findings}
      facts={facts}
      why={rerunFromFixWhyOf(facts, vendorsOfSnapshot(snap))}
      stopsSource={stopsSourceFirst(snap.summary)}
      onCancel={() => closeFixPicker(runId)}
    />
  )
}
