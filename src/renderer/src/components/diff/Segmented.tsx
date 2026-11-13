// A segmented choice for the Diff tab's toolbar (Implement | Fix | Combined, Split |
// Stacked): a radio group of buttons, one tab stop, arrow keys move the choice. Every option keeps its own width (its
// label never changes), so choosing never moves the toolbar.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { cn } from '../../lib/cn.ts'
import { Tooltip } from '../ui/Tooltip.tsx'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  /** Tooltip. */
  hint?: string
}

export function Segmented<V extends string>({
  label,
  options,
  value,
  onChange,
  testId,
  keyShortcuts,
}: {
  /** The group's accessible name. */
  label: string
  options: readonly SegmentedOption<V>[]
  value: V
  onChange: (v: V) => void
  testId: string
  /** aria-keyshortcuts of the group (a key that switches it). */
  keyShortcuts?: string
}): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0 || options.length === 0) return
    e.preventDefault()
    const at = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    )
    const next = (at + step + options.length) % options.length
    const o = options[next]
    if (o === undefined) return
    onChange(o.value)
    refs.current[next]?.focus({ preventScroll: true })
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-keyshortcuts={keyShortcuts}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className="inline-flex h-7 shrink-0 items-center rounded-md border bg-muted p-0.5"
    >
      {options.map((o, i) => {
        const on = o.value === value
        const button = (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-value={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-full items-center rounded-[5px] px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
        return o.hint === undefined ? (
          button
        ) : (
          <Tooltip key={o.value} content={o.hint}>
            {button}
          </Tooltip>
        )
      })}
    </div>
  )
}
