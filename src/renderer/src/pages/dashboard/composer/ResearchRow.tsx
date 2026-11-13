// The composer's Research row: a switch ("Research first"), a Lenses menu (the generic lenses and the brief pack's,
// ticked ones sent as passes.plan.researchLenses) and a one-line note (what it does, its cost from the estimate, a
// suggestion when the task looks like new work, and no web for a Plan vendor without web search). UI standard: the row
// is always there and one line high; the switch, the constant "Lenses" button and the cut note never change its size.
import { ChevronDown } from 'lucide-react'
import type { ResearchLensOption } from '@shared/research.ts'
import { Button } from '../../../components/ui/Button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../../components/ui/DropdownMenu.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'

export function ResearchRow({
  checked,
  disabled,
  note,
  options,
  ticked,
  web,
  onChange,
  onLens,
}: {
  checked: boolean
  disabled: boolean
  note: string
  options: readonly ResearchLensOption[]
  ticked: readonly string[]
  /** The Plan vendor can search the web (false: the web lenses are left out of the run). */
  web: boolean | undefined
  onChange: (v: boolean) => void
  onLens: (id: string, on: boolean) => void
}): React.JSX.Element {
  const id = 'composer-research'
  return (
    <div data-testid={`${id}-row`} className="flex min-h-6 min-w-0 items-center gap-2">
      <label className="flex shrink-0 cursor-pointer items-center gap-2">
        <Switch
          data-testid={id}
          aria-label="Research first"
          aria-describedby={`${id}-note`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
        <span className="text-xs font-medium text-muted-foreground">Research first</span>
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`${id}-lenses`}
            className="h-6 shrink-0 gap-1 px-1.5 text-xs"
            disabled={disabled || !checked || options.length === 0}
          >
            Lenses
            <ChevronDown aria-hidden className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" data-testid={`${id}-lens-menu`}>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            What Research looks into
          </DropdownMenuLabel>
          {options.map((l) => {
            const on = ticked.includes(l.id)
            const offWeb = web === false && l.web
            return (
              <DropdownMenuCheckboxItem
                key={l.id}
                data-testid={`${id}-lens-${l.id}`}
                checked={on}
                // The last ticked lens stays ticked: Research always has something to look into.
                disabled={on && ticked.length <= 1}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(v) => onLens(l.id, v === true)}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{l.label}</span>
                  {offWeb && (
                    <span className="text-xs text-muted-foreground">Needs web search: left out</span>
                  )}
                </span>
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <p
        id={`${id}-note`}
        data-testid={`${id}-note`}
        title={note}
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >
        {note}
      </p>
    </div>
  )
}
