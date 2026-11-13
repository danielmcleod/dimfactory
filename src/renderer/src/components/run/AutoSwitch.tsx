// Switch a running run to Auto (runs.switchToAuto): the Run header's [Auto ▾] (an icon in the compact header) and
// the ask card's [Switch to Auto ▾]. A menu like Re-run's, never a confirm dialog: its one item says what Auto does
// before the click that turns it on. Core decides whether the run can switch (finished, in Auto already, a guardrail
// against full access) and says why in its error toast. The trigger keeps its label; the spinner takes its icon slot.
import { ChevronDown, Zap } from 'lucide-react'
import type { RunSummary } from '@shared/run.ts'
import { Button } from '../ui/Button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { runCommand, useBusy } from './commands.ts'

export const AUTO_SWITCH_LABEL = 'Switch to Auto'

/** What the switch does, as the menu item says it. */
export const AUTO_SWITCH_HINT =
  'Implement and Fix approve everything from now on, including the request waiting now, and the gates ahead are off. Every tool call is still logged. Auto stays on for the rest of this run.'

const TOOLTIP = 'Stop asking: switch this run to Auto'

/** Whether a run is offered the switch: it goes on, and it is not in Auto. */
export function canSwitchToAuto(s: Pick<RunSummary, 'auto' | 'status'>): boolean {
  return !s.auto && s.status !== 'completed' && s.status !== 'cancelled'
}

const ICON = <Zap aria-hidden />

export function AutoSwitchMenu({
  runId,
  form,
}: {
  runId: string
  /** `header`: [Auto ▾]; `compact`: an icon button; `ask`: [Switch to Auto ▾] on the ask card. */
  form: 'header' | 'compact' | 'ask'
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const loading = busy !== null
  return (
    <DropdownMenu>
      <Tooltip content={TOOLTIP}>
        <DropdownMenuTrigger asChild>
          {form === 'compact' ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="auto-switch"
              aria-label={AUTO_SWITCH_LABEL}
              className="gap-0.5 px-1.5"
              loading={loading}
              icon={ICON}
            >
              <ChevronDown aria-hidden />
            </Button>
          ) : (
            <Button
              size="sm"
              variant={form === 'ask' ? 'ghost' : 'outline'}
              data-testid={form === 'ask' ? 'ask-auto-switch' : 'auto-switch'}
              loading={loading}
              icon={ICON}
            >
              {form === 'ask' ? AUTO_SWITCH_LABEL : 'Auto'}
              <ChevronDown aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuItem
          data-testid="auto-switch-confirm"
          className="flex-col items-start gap-0"
          onSelect={() => run('auto', () => runCommand(runId, 'runs.switchToAuto', { runId }))}
        >
          <span className="flex items-center gap-2 font-medium">
            <Zap aria-hidden className="text-auto" />
            {AUTO_SWITCH_LABEL}
          </span>
          <span className="pl-6 text-xs text-muted-foreground">{AUTO_SWITCH_HINT}</span>
        </DropdownMenuItem>
        <DropdownMenuLabel className="font-normal">
          To start every run this way, turn on AUTO in the composer.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
