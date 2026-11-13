// StableLabel: a label whose box never changes size when its text changes (UI control standard: buttons never
// change size when their text or state changes).
//
// Every label the control can show is stacked in ONE grid cell. Only the current label is real text; each reserved
// label is an empty, aria-hidden, `visibility: hidden` span whose text is CSS generated content
// (`::after { content: attr(data-label) }`). So the cell is always as wide as the widest label, while `textContent`,
// the accessible name and Testing Library / Playwright text queries see only the current label.
//
// API
//   <StableLabel labels={['Copy', 'Copied']} current={copied ? 'Copied' : 'Copy'} />
//   <StableLabel labels={['Run', 'Queue']}>{label}</StableLabel>          // children instead of `current`
//   <StableLabel labels={['✓ 00 checks ok']} className="tabular-nums">{`✓ ${n} checks ok`}</StableLabel>
//   <Button labels={['Pause for 1 hour', 'Resume']}>{paused ? 'Resume' : 'Pause for 1 hour'}</Button>  // Button prop
//
// - `labels`: every label the control can show (the current one may be included or not; duplicates are fine).
//   For a count, reserve the widest plausible value written with zeros (e.g. '(000)') and add `tabular-nums`, so every
//   count with at most that many digits fits.
// - `current` / `children`: what is shown now. A string is the usual case; a ReactNode is allowed, but only strings
//   can be reserved, so keep any non-text decoration outside.
// - `align`: where a shorter current label sits inside the reserved width (default 'center', right for a button;
//   'start' for status text that reads left to right, 'end' for text anchored to the right).
//
// Spinners never go in here: a busy state takes the button's icon slot (Button `icon` + `loading`), never width.
//
// Prefer a CONSTANT label with the state as text beside the button where the change is a status ("Fix 1 issue to
// run", "Checking…", "Folder busy"): put the text on the side away from the button's neighbours (left of a
// right-anchored button, or at the end of a row), give it an id, and point the button's aria-describedby at it
// (pages/dashboard/QuickComposer.tsx's Run is the model). Reserve labels only where the label itself must change.
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export type StableLabelProps = {
  /** Every label the control can show; the box is as wide as the widest. */
  labels: readonly string[]
  /** The label shown now (or pass it as children). */
  current?: ReactNode
  children?: ReactNode
  align?: 'start' | 'center' | 'end' | undefined
  className?: string | undefined
}

const ALIGN = {
  start: 'justify-items-start',
  center: 'justify-items-center',
  end: 'justify-items-end',
} as const

export function StableLabel({
  labels,
  current,
  children,
  align = 'center',
  className,
}: StableLabelProps): React.JSX.Element {
  const shown = current ?? children
  const reserve = [...new Set(labels)]
  return (
    <span
      data-stable-label=""
      className={cn('inline-grid whitespace-nowrap *:col-start-1 *:row-start-1', ALIGN[align], className)}
    >
      <span>{shown}</span>
      {reserve.map((l) => (
        <span
          key={l}
          aria-hidden
          data-label={l}
          className="pointer-events-none invisible select-none after:content-[attr(data-label)]"
        />
      ))}
    </span>
  )
}
