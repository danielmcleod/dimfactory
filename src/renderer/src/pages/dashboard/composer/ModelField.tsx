// A pass row's model box (the CLI's list plus the catalog's, or free text, with a 'no pricing' chip). Suggestions come from core (vendors.models, else the probe's list); any id the config accepts may be
// typed. Empty = the CLI's default model. The value is committed on Enter, on blur and as ⌘/Ctrl+Enter starts the
// run (so the run gets it); Escape puts the current one back.
import { useEffect, useId, useState } from 'react'
import type { ModelOption } from '@shared/vendors.ts'
import { Badge } from '../../../components/ui/Badge.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { pickerOptions } from '../../../lib/modelOptions.ts'
import { parseModelInput } from './model.ts'

export interface ModelFieldProps {
  pass: string
  label: string
  /** The resolved model (core's answer). */
  value: string | null
  options: readonly ModelOption[] | null
  noPricing: boolean
  disabled?: boolean
  onCommit: (model: string | null) => void
  /** Ask for the vendor's list (first focus). */
  onWantOptions?: () => void
  /** What an empty box means (default "CLI default"; for a local preset, its own model). */
  placeholder?: string
}

export function ModelField({
  pass,
  label,
  value,
  options,
  noPricing,
  disabled,
  onCommit,
  onWantOptions,
  placeholder = 'CLI default',
}: ModelFieldProps): React.JSX.Element {
  const listId = useId()
  const errorId = useId()
  const [text, setText] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)
  // A new answer from core (another vendor, a reset) replaces what the box shows.
  useEffect(() => {
    setText(value ?? '')
    setError(null)
  }, [value])

  /** Commit what the box holds; false when it is not a model id the config accepts. */
  const commit = (): boolean => {
    const parsed = parseModelInput(text)
    if (!parsed.ok) {
      setError(parsed.message)
      return false
    }
    setError(null)
    if (parsed.model !== value) onCommit(parsed.model)
    return true
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          data-testid={`pass-model-${pass}`}
          aria-label={label}
          list={listId}
          value={text}
          disabled={disabled}
          spellCheck={false}
          placeholder={placeholder}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          onFocus={() => onWantOptions?.()}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              // ⌘/Ctrl+Enter runs (the global shortcut, after this handler): commit first so the run gets the typed
              // model; an id the config would refuse stops the key here, with its message, instead of running.
              if (!commit()) {
                e.preventDefault()
                e.stopPropagation()
              }
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              setText(value ?? '')
              setError(null)
            }
          }}
          className="h-7 w-44 font-mono text-xs"
        />
        <datalist id={listId}>
          {/* The CLI's models first, then the catalog's (lib/modelOptions.ts). */}
          {pickerOptions(options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {[
                o.label,
                o.isDefault === true ? 'default' : null,
                o.hasPricing === false ? 'no pricing' : null,
              ]
                .filter((x): x is string => x !== null && x !== undefined && x !== o.id)
                .join(' · ')}
            </option>
          ))}
        </datalist>
        {noPricing && (
          <Tooltip content="No price is known for this model, so its cost cannot be estimated">
            <span tabIndex={0} className="inline-flex rounded-md" data-testid={`pass-no-pricing-${pass}`}>
              <Badge variant="outline" className="text-[10px] font-normal text-warning">
                no pricing
              </Badge>
            </span>
          </Tooltip>
        )}
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
