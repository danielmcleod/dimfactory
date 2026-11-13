// Building blocks of Settings → General (UI control standards): a
// setting row marked with its Settings-index field id (index.ts), with room under its label for where the value comes
// from in a chosen project and for a value the schema would refuse; a number box that commits on Enter or blur (Escape
// puts the saved value back); and a picker's place while the values load, drawn like the Select trigger at its size.
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '../../../components/ui/Input.tsx'
import { cn } from '../../../lib/cn.ts'
import { settingFieldProps } from '../index.ts'

export function GeneralRow({
  field,
  label,
  description,
  note,
  error,
  errorId,
  children,
}: {
  /** The Settings-index field id (a JSON pointer). */
  field: string
  label: string
  description?: string
  /** What a chosen project does with this setting. */
  note?: string | null
  error?: string | null
  /** The id the control's aria-describedby names for the error. */
  errorId?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      {...settingFieldProps(field)}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 border-b py-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description !== undefined && <span className="text-xs text-muted-foreground">{description}</span>}
        {note != null && note !== '' && (
          <span className="text-xs text-info" data-testid={`general-note-${field}`}>
            {note}
          </span>
        )}
        {error != null && error !== '' && (
          <span id={errorId} role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export interface NumberFieldProps {
  /** The value as saved (core's), already formatted for the box; null while it loads. */
  value: string | null
  /** The control's accessible name. */
  label: string
  suffix: string
  testId: string
  disabled?: boolean
  errorId?: string
  invalid?: boolean
  /** Commit what was typed; resolves to false when it was refused (the box then keeps the text to correct). */
  onCommit: (text: string) => Promise<boolean> | boolean
  /** The user typed again or put the saved value back: clear the error. */
  onEdit?: () => void
}

/** A number box's place while the values load: the same size, so nothing moves when the box arrives. */
function NumberPlaceholder({ suffix }: { suffix: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="h-7 w-20 rounded-md border border-input bg-background opacity-50" />
      <span className="w-8 text-xs text-muted-foreground">{suffix}</span>
    </span>
  )
}

export function NumberField(p: NumberFieldProps): React.JSX.Element {
  if (p.value === null) return <NumberPlaceholder suffix={p.suffix} />
  return <NumberBox {...p} value={p.value} />
}

function NumberBox(p: NumberFieldProps & { value: string }): React.JSX.Element {
  const unitId = useId()
  const [text, setText] = useState(p.value)
  // A new value from core (a reload, an Undo) replaces what the box shows.
  useEffect(() => {
    setText(p.value)
  }, [p.value])

  const commit = async (): Promise<void> => {
    if (text.trim() === p.value) {
      if (text !== p.value) setText(p.value)
      p.onEdit?.()
      return
    }
    await p.onCommit(text)
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        data-testid={p.testId}
        aria-label={p.label}
        aria-describedby={[unitId, p.invalid === true ? p.errorId : undefined].filter(Boolean).join(' ')}
        aria-invalid={p.invalid === true || undefined}
        inputMode="decimal"
        spellCheck={false}
        value={text}
        disabled={p.disabled === true}
        onChange={(e) => {
          setText(e.target.value)
          p.onEdit?.()
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            setText(p.value)
            p.onEdit?.()
          }
        }}
        className="h-7 w-20 text-right text-xs tabular-nums"
      />
      <span id={unitId} className="w-8 text-xs text-muted-foreground">
        {p.suffix}
      </span>
    </span>
  )
}

/**
 * A picker's place while the values load: drawn like the Select trigger at the same size, disabled. The Radix Select
 * mounts once there is a value to show, so opening the section stays quick (performance.spec.ts) and nothing moves when it does.
 */
export function PickerPlaceholder({
  testId,
  label,
  className,
}: {
  testId: string
  label: string
  className: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled
      data-testid={testId}
      aria-label={label}
      className={cn(
        'flex h-7 max-w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-xs whitespace-nowrap text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span className="truncate">Loading…</span>
      <ChevronDown aria-hidden className="size-4 shrink-0 opacity-60" />
    </button>
  )
}
