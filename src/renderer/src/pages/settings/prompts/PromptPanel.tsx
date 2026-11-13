// One pass's or optional step's prompt in Settings → Prompts. Top to bottom: the
// template in use and its source badge (built-in, yours, this project's) with where a save goes; the placeholder chips;
// Implement's word count; the actions (Save, Discard changes, Reset to the default, Show changes from the default) with
// the save state beside them; the issues core found (a refused save's line-numbered errors, or the saved text's
// warnings); the text box, in the page flow and as tall as its text (no scroller of its own); and the changes from the
// built-in default when shown. Everything that changes size sits below what the user is working with, or follows a
// click. Until core's template arrives the panel is one "Reading the template…" line (it is the last thing in the
// section), so the explanation, the chips and the required placeholders, whose length depends on the template, never
// push the actions and the text box down once it is read.
import { Eye, RotateCcw, Save, Undo2 } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { PromptIssue, PromptView } from '@shared/ipc.ts'
import type { EditablePromptName } from '@shared/ipc.ts'
import { Badge } from '../../../components/ui/Badge.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
import { StableLabel } from '../../../components/ui/StableLabel.tsx'
import { Textarea } from '../../../components/ui/Textarea.tsx'
import { cn } from '../../../lib/cn.ts'
import { diffLines } from '../../../lib/linediff.ts'
import { settingFieldProps } from '../index.ts'
import {
  IMPLEMENT_WORD_LIMIT,
  insertAt,
  issueText,
  offsetOf,
  overWordLimit,
  placeholderTag,
  promptLabel,
  SOURCE_LABEL,
  sourceExplanation,
  wordCount,
  wordCountText,
} from './model.ts'
import type { PromptScope } from './model.ts'
import { PlaceholderChips } from './PlaceholderChips.tsx'
import { PromptDiff } from './PromptDiff.tsx'

export const SAVE_LABELS: Readonly<Record<PromptScope, string>> = {
  user: 'Save for you',
  project: 'Save for this project',
}
export const RESET_LABEL = 'Reset to the default'
export const DIFF_LABELS = ['Show changes from the default', 'Hide changes from the default'] as const
const SOURCE_LABELS = Object.values(SOURCE_LABEL)
const STATUS_LABELS = ['Unsaved changes', 'Saving…', 'Saved', 'No changes']

export interface PromptPanelProps {
  pass: EditablePromptName
  scope: PromptScope
  /** The project's display name (project scope). */
  project: string
  /** null while it loads (or before a project is chosen). */
  view: PromptView | null
  /** Why nothing can be edited yet (no project chosen, or the read failed), else null. */
  unavailable: string | null
  text: string
  dirty: boolean
  busy: 'save' | 'reset' | null
  saved: boolean
  /** A refused save's issues for this text. */
  issues: PromptIssue[] | null
  showDiff: boolean
  onText: (text: string) => void
  onSave: () => void
  onDiscard: () => void
  onReset: () => void
  onToggleDiff: () => void
}

export function PromptPanel(p: PromptPanelProps): React.JSX.Element {
  const statusId = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const label = promptLabel(p.pass)
  const view = p.view
  const ready = view !== null && p.unavailable === null
  const words = wordCount(p.text)
  const over = overWordLimit(p.pass, words)
  const diff = useMemo(
    () => (p.showDiff && view !== null ? diffLines(view.defaultText, p.text) : null),
    [p.showDiff, view, p.text],
  )

  // After a chip inserted its placeholder, the cursor goes after it (the box keeps focus; the page does not move).
  useLayoutEffect(() => {
    const el = box.current
    const at = caret.current
    if (el === null || at === null) return
    caret.current = null
    el.focus({ preventScroll: true })
    el.setSelectionRange(at, at)
  }, [p.text])

  const insert = (name: string): void => {
    const el = box.current
    const start = el !== null && document.activeElement === el ? el.selectionStart : p.text.length
    const end = el !== null && document.activeElement === el ? el.selectionEnd : start
    const next = insertAt(p.text, start, end, placeholderTag(name))
    caret.current = next.caret
    p.onText(next.text)
  }

  /** A click on an issue puts the cursor on its line (the user asked: the browser may bring it into view). */
  const goTo = (i: PromptIssue): void => {
    const el = box.current
    if (el === null || i.line === undefined) return
    const at = offsetOf(p.text, i.line, i.col)
    el.focus()
    el.setSelectionRange(at, at)
  }

  const resetBlocked =
    view === null || view.source !== p.scope
      ? p.scope === 'user'
        ? `You have no ${label} template of your own.`
        : `This project has no ${label} template of its own.`
      : null
  const savedWarnings =
    !p.dirty && p.issues === null ? (view?.issues ?? []).filter((i) => i.severity === 'warning') : []
  const status =
    p.busy === 'save'
      ? 'Saving…'
      : p.dirty
        ? 'Unsaved changes'
        : p.saved
          ? 'Saved'
          : ready
            ? 'No changes'
            : ''

  const saveButton = (
    <Button
      size="sm"
      data-testid="prompt-save"
      icon={<Save aria-hidden />}
      labels={Object.values(SAVE_LABELS)}
      loading={p.busy === 'save'}
      disabled={!ready || !p.dirty}
      aria-describedby={statusId}
      onClick={p.onSave}
    >
      {SAVE_LABELS[p.scope]}
    </Button>
  )
  const discardButton = (
    <Button
      size="sm"
      variant="ghost"
      data-testid="prompt-discard"
      icon={<Undo2 aria-hidden />}
      disabled={!p.dirty}
      onClick={p.onDiscard}
    >
      Discard changes
    </Button>
  )
  const resetButton = (
    <Button
      size="sm"
      variant="outline"
      data-testid="prompt-reset"
      icon={<RotateCcw aria-hidden />}
      loading={p.busy === 'reset'}
      disabled={!ready || resetBlocked !== null}
      onClick={p.onReset}
    >
      {RESET_LABEL}
    </Button>
  )

  if (view === null && p.unavailable === null) {
    return (
      <div className="flex flex-col gap-3" data-testid={`prompt-panel-${p.pass}`} aria-busy="true">
        <p role="status" data-testid="prompt-explain" className="text-xs text-muted-foreground">
          Reading the template…
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`prompt-panel-${p.pass}`}>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">In use now:</span>
          <Badge
            variant="outline"
            data-testid="prompt-source"
            data-source={view?.source ?? ''}
            className={cn(
              'px-1.5 py-0 text-xs font-normal',
              view?.source === 'project' ? 'border-info/50 text-info' : 'text-foreground',
            )}
          >
            <StableLabel labels={[...SOURCE_LABELS, 'Loading…']}>
              {view !== null ? SOURCE_LABEL[view.source] : p.unavailable !== null ? 'None' : 'Loading…'}
            </StableLabel>
          </Badge>
        </div>
        <p data-testid="prompt-explain" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {p.unavailable ??
            (view !== null ? sourceExplanation(view, p.scope, p.project) : 'Reading the template…')}
        </p>
      </div>

      <PlaceholderChips
        allowed={view?.allowed ?? []}
        required={view?.required ?? []}
        disabled={!ready}
        onInsert={insert}
      />

      {p.pass === 'implement' && (
        <p
          data-testid="prompt-words"
          data-over={over || undefined}
          className={cn('text-xs tabular-nums', over ? 'text-warning' : 'text-muted-foreground')}
        >
          {over
            ? `${wordCountText(words)}: over ${IMPLEMENT_WORD_LIMIT}. The built-in Implement prompt stays under ${IMPLEMENT_WORD_LIMIT} words so the task and the plan lead.`
            : `${wordCountText(words)} (the built-in one stays under ${IMPLEMENT_WORD_LIMIT})`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Save keeps one place in the page while it turns on and off (its focus survives a save); the state beside
            the row says why it is off. */}
        {saveButton}
        {discardButton}
        <span {...settingFieldProps('reset')} className="inline-flex">
          {ready && resetBlocked !== null ? (
            <DisabledHint reason={resetBlocked}>{resetButton}</DisabledHint>
          ) : (
            resetButton
          )}
        </span>
        <span {...settingFieldProps('diff')} className="inline-flex">
          <Button
            size="sm"
            variant="ghost"
            data-testid="prompt-diff-toggle"
            icon={<Eye aria-hidden />}
            labels={DIFF_LABELS}
            aria-expanded={p.showDiff}
            aria-controls="prompt-diff"
            disabled={!ready}
            onClick={p.onToggleDiff}
          >
            {p.showDiff ? DIFF_LABELS[1] : DIFF_LABELS[0]}
          </Button>
        </span>
        <span
          id={statusId}
          role="status"
          data-testid="prompt-status"
          className="text-xs text-muted-foreground"
        >
          <StableLabel labels={STATUS_LABELS} align="start">
            {status}
          </StableLabel>
        </span>
      </div>

      {p.issues !== null && p.issues.length > 0 && (
        <div
          role="alert"
          data-testid="prompt-issues"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
        >
          <p className="text-xs font-medium text-destructive">
            Not saved: fix {p.issues.length === 1 ? 'this' : 'these'} first.
          </p>
          <ul className="flex flex-col gap-0.5">
            {p.issues.map((i, n) => (
              <li key={n} className="text-xs [overflow-wrap:anywhere]">
                {i.line !== undefined ? (
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    className="text-left text-destructive underline-offset-4 hover:underline"
                  >
                    {issueText(i)}
                  </button>
                ) : (
                  <span className="text-destructive">{issueText(i)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {savedWarnings.length > 0 && (
        <ul data-testid="prompt-warnings" className="flex flex-col gap-0.5">
          {savedWarnings.map((i, n) => (
            <li key={n} className="text-xs text-warning [overflow-wrap:anywhere]">
              {issueText(i)}
            </li>
          ))}
        </ul>
      )}

      <Textarea
        ref={box}
        mono
        {...settingFieldProps('template')}
        data-testid="prompt-editor"
        aria-label={`${label} prompt`}
        value={p.text}
        disabled={!ready}
        placeholder={p.unavailable ?? (view === null ? 'Loading…' : undefined)}
        spellCheck={false}
        onChange={(e) => p.onText(e.currentTarget.value)}
        // In the page flow: as tall as the text (field-sizing), never a scroller of its own; it grows only as the user
        // types. No resize handle: its height is the text's.
        className="min-h-48 resize-none [field-sizing:content]"
      />

      {diff !== null && (
        <div id="prompt-diff">
          <PromptDiff diff={diff} testId="prompt-diff" />
        </div>
      )}
    </div>
  )
}
