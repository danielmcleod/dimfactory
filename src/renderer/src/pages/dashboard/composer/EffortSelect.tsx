// A pass's effort level next to its model (config `passes.<p>.effort`, or `vendors.<id>.defaultEffort`): "Default
// effort" (null: the vendor decides), then the levels the chosen model lists, else every level the vendor's models list
// (shared effortsFor). A level set by hand that no model lists stays a choice. The trigger keeps one width whatever it
// shows (UI standard: controls never change size), and the levels load into the open list only, so nothing around it
// moves when they arrive. Only vendors with an effort setting (shared supportsEffort) get one; the caller hides it
// for the others.
import type { ModelInfo } from '@shared/vendors.ts'
import { effortsFor } from '@shared/vendors.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { cn } from '../../../lib/cn.ts'

/** What the levels are read from: a model list entry (vendors.models, a probe's models). */
export type EffortSource = Pick<ModelInfo, 'id' | 'aliases' | 'isDefault' | 'efforts'>

/** Select value for "no effort level: the vendor's default" (Radix Select reserves the empty string). */
export const DEFAULT_EFFORT = '__default_effort__'
export const DEFAULT_EFFORT_TEXT = 'Default effort'

/** The levels the list offers: the model's (or every listed model's), plus a level in use that none lists. */
export function effortChoices(
  options: readonly EffortSource[] | null,
  model: string | null,
  value: string | null,
): string[] {
  const levels = effortsFor(options ?? [], model)
  return value !== null && !levels.includes(value) ? [...levels, value] : levels
}

export interface EffortSelectProps {
  /** `data-testid` suffix (`pass-effort-<id>`). */
  id: string
  /** Accessible name, e.g. "Plan effort". */
  label: string
  model: string | null
  value: string | null
  options: readonly EffortSource[] | null
  disabled?: boolean
  onChange: (effort: string | null) => void
  /** Ask for the vendor's model list (the levels come with it), on first open. */
  onWantOptions?: () => void
  className?: string
}

export function EffortSelect({
  id,
  label,
  model,
  value,
  options,
  disabled,
  onChange,
  onWantOptions,
  className,
}: EffortSelectProps): React.JSX.Element {
  const levels = effortChoices(options, model, value)
  const shown = value ?? DEFAULT_EFFORT
  return (
    <Select
      value={shown}
      disabled={disabled === true}
      onOpenChange={(open) => {
        if (open) onWantOptions?.()
      }}
      onValueChange={(v) => {
        const next = v === DEFAULT_EFFORT ? null : v
        if (next !== value) onChange(next)
      }}
    >
      <SelectTrigger
        size="sm"
        data-testid={`pass-effort-${id}`}
        aria-label={label}
        title="How hard the model thinks: more effort is slower and uses more of your plan"
        className={cn('w-36', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_EFFORT}>{DEFAULT_EFFORT_TEXT}</SelectItem>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
