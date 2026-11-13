// The placeholders a prompt may use (allowed and required per template; core's PromptView
// `allowed` / `required`), as chips that insert `{{name}}` at the text box's cursor. A required one is marked: without
// it Dim Factory appends the default template's section for it (a warning, not an error).
import { cn } from '../../../lib/cn.ts'
import { placeholderTag } from './model.ts'

export function PlaceholderChips({
  allowed,
  required,
  disabled,
  onInsert,
}: {
  allowed: readonly string[]
  required: readonly string[]
  disabled: boolean
  onInsert: (name: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {/* As tall as a chip even with none, so the row never grows when the chips come. */}
      <div className="flex min-h-6 flex-wrap items-center gap-1.5" role="group" aria-label="Placeholders">
        <span className="text-xs text-muted-foreground">Placeholders</span>
        {allowed.map((name) => {
          const req = required.includes(name)
          return (
            <button
              key={name}
              type="button"
              data-testid={`prompt-chip-${name}`}
              data-required={req || undefined}
              disabled={disabled}
              title="Insert at the cursor"
              aria-label={`Insert ${placeholderTag(name)}${req ? ' (required)' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(name)}
              className={cn(
                'inline-flex h-6 items-center rounded-full border px-2 font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                req ? 'border-primary/60 text-foreground' : 'text-muted-foreground',
              )}
            >
              {placeholderTag(name)}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="prompt-required">
        {required.length === 0
          ? 'Click one to insert it at the cursor.'
          : `Click one to insert it at the cursor. Required: ${required.map(placeholderTag).join(', ')}; without it Dim Factory adds the default's section for it.`}
      </p>
    </div>
  )
}
