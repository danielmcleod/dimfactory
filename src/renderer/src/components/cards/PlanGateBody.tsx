// gate:afterPlan (Markdown → [Edit] textarea → "Edited · view changes" diff · [Approve ⌘↵]
// [Cancel] · checkbox "Don't stop after plan for this project" via config.patch with undo; state row R4, plan-edit.spec.ts). An
// edited plan goes to core as Approve's `input`; an unchanged one is approved as is.
// UI control standard: Edit/Preview, View/Hide changes and Approve/Approve edited plan each reserve their widest
// label, and the edit counts (which change with every keystroke) are status text at the end of the row.
// UI standard, one scroll region per screen: the plan reads in the page flow (the editor too, sized to the plan), with
// no scroller of its own; the actions (Approve, Cancel, Edit and, once the plan is edited, the edit links) are one row
// that stays at the bottom of the reading area while the card is on screen (StickyActions), so a long plan never
// hides Approve. The "Don't stop after plan" checkbox follows the row in the card's flow: a setting for later runs,
// not an answer to this plan, it would only take more of a short window's reading area if it stuck with the row
// (two lines there once the window is narrow).
import { Eye, Pencil } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import type { CardView } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { KEYS, useShortcut } from '../../lib/keys.ts'
import { diffLines } from '../../lib/linediff.ts'
import { toast } from '../../state/toasts.ts'
import { runCommand } from '../run/commands.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Button } from '../ui/Button.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { PlanDiff, editCounts } from './PlanDiff.tsx'
import { planOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'
import { StickyActions } from './StickyActions.tsx'

const PLAN_VIEW_LABELS = ['Edit', 'Preview'] as const
const CHANGES_LABELS = ['View changes', 'Hide changes'] as const

/** The project-config key the checkbox writes (config-schema `gates.afterPlan`). */
export const AFTER_PLAN_POINTER = '/gates/afterPlan'

function readGate(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const gates = (value as { gates?: unknown }).gates
  if (typeof gates !== 'object' || gates === null) return undefined
  return (gates as { afterPlan?: unknown }).afterPlan
}

/** Turn the plan gate off for the project; resolves to an undo that restores the previous value, or null. */
async function gateOff(folder: string): Promise<(() => Promise<boolean>) | null> {
  const before = await invoke('config.read', { scope: 'project', folder })
  const prev = before.ok ? readGate(before.value.value) : undefined
  const r = await runCommand(null, 'config.patch', {
    scope: 'project',
    folder,
    ops: [{ op: 'replace', path: AFTER_PLAN_POINTER, value: false }],
  })
  if (!r.ok) return null
  return async () => {
    const undo = await runCommand(null, 'config.patch', {
      scope: 'project',
      folder,
      ops:
        prev === undefined
          ? [{ op: 'remove', path: AFTER_PLAN_POINTER }]
          : [{ op: 'replace', path: AFTER_PLAN_POINTER, value: prev }],
    })
    return undo.ok
  }
}

export function PlanGateBody({
  card,
  folder,
  resolver,
}: {
  card: CardView
  folder: string
  resolver: CardResolver
}): React.JSX.Element {
  const plan = planOf(card)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(plan)
  const [showDiff, setShowDiff] = useState(false)
  const [skipGate, setSkipGate] = useState(false)
  const [gateBusy, setGateBusy] = useState(false)
  const undoRef = useRef<(() => Promise<boolean>) | null>(null)
  const checkboxId = useId()
  const diffId = useId()
  const edited = text.trim() !== plan.trim()
  const diff = useMemo(() => (edited ? diffLines(plan, text) : null), [edited, plan, text])

  const approve = card.choices.find((c) => c.input === 'plan') ?? card.choices.find((c) => c.primary === true)
  const others = card.choices.filter((c) => c !== approve)
  const doApprove = (): void => {
    if (approve === undefined || resolver.busy !== null) return
    resolver.resolve(approve.id, edited && approve.input === 'plan' ? text : undefined)
  }
  useShortcut(KEYS.runOrApprove, doApprove, {
    description: 'Approve the plan',
    enabled: approve !== undefined,
  })

  const restore = async (): Promise<void> => {
    const undo = undoRef.current
    if (undo === null) return
    setGateBusy(true)
    try {
      if (await undo()) {
        undoRef.current = null
        setSkipGate(false)
      }
    } finally {
      setGateBusy(false)
    }
  }

  const onSkipGate = async (on: boolean): Promise<void> => {
    if (!on) {
      await restore()
      return
    }
    setGateBusy(true)
    try {
      const undo = await gateOff(folder)
      if (undo === null) return
      undoRef.current = undo
      setSkipGate(true)
      toast({
        id: `plan-gate-off:${folder}`,
        level: 'info',
        message: 'Runs in this project will no longer stop after the plan.',
        action: { label: 'Undo', onClick: restore },
      })
    } finally {
      setGateBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {editing ? (
        <Textarea
          mono
          data-testid="plan-editor"
          aria-label="Plan"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          rows={8}
          // In the page flow: as tall as the plan (field-sizing), never a scroller of its own; it grows only as the
          // user types. No resize handle: its height is the plan's.
          className="min-h-48 resize-none [field-sizing:content]"
        />
      ) : (
        <div data-testid="plan-preview" className="rounded-md border bg-background p-3">
          <LightMarkdown text={text} className="text-sm" />
        </div>
      )}
      {showDiff && diff !== null && (
        <div id={diffId}>
          <PlanDiff diff={diff} testId="plan-gate-diff" />
        </div>
      )}
      <StickyActions testId="plan-gate-actions">
        <ChoiceRow busy={resolver.busy}>
          {approve !== undefined && (
            <ChoiceButton
              card={card}
              choice={approve}
              busy={resolver.busy}
              onChoose={doApprove}
              label={edited ? `${approve.label} edited plan` : approve.label}
              labels={[approve.label, `${approve.label} edited plan`]}
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
          <Button
            size="sm"
            variant="outline"
            data-testid="plan-edit"
            icon={editing ? <Eye aria-hidden /> : <Pencil aria-hidden />}
            labels={PLAN_VIEW_LABELS}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Preview' : 'Edit'}
          </Button>
        </ChoiceRow>
        {edited && diff !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              data-testid="plan-view-changes"
              aria-expanded={showDiff}
              aria-controls={diffId}
              onClick={() => setShowDiff((v) => !v)}
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              <StableLabel labels={CHANGES_LABELS} align="start">
                {showDiff ? 'Hide changes' : 'View changes'}
              </StableLabel>
            </button>
            <button
              type="button"
              onClick={() => {
                setText(plan)
                setShowDiff(false)
              }}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Undo my edits
            </button>
            <span data-testid="plan-edit-counts" className="text-xs text-muted-foreground tabular-nums">
              Edited · {editCounts(diff)}
            </span>
          </div>
        )}
      </StickyActions>
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          data-testid="plan-gate-skip"
          checked={skipGate}
          disabled={gateBusy}
          onCheckedChange={(v) => void onSkipGate(v === true)}
        />
        <label htmlFor={checkboxId} className="text-sm">
          Don&apos;t stop after plan for this project
          <span className="ml-1 text-xs text-muted-foreground">
            (later runs in this folder approve the plan)
          </span>
        </label>
      </div>
    </div>
  )
}
