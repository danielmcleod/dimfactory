// One card choice as a button (core builds the choices, with primary and
// danger flags). A choice this build cannot carry out is shown disabled with its reason, never hidden.
// UI control standard: a choice never changes size. While one is being sent, every choice keeps
// its label (the pressed one is aria-busy, all are disabled) and ChoiceRow says so beside the buttons; a label that
// changes with the card (Approve → Approve edited plan, Continue with N findings) reserves its widest form.
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CardChoice, CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { ariaKeyShortcuts } from '../../lib/keys.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { useLaterChoice } from './resolve.ts'

/** What a card's choice row says while core takes the pressed choice. */
export const SENDING_CHOICE = 'Sending your choice…'

/** The key chip on a choice, quieter than the default chip (it sits on a primary button). */
const KBD_ON_CHOICE =
  '[&_kbd]:ml-1 [&_kbd]:border-transparent [&_kbd]:bg-primary-foreground/15 [&_kbd]:text-current'

export interface ChoiceButtonProps {
  card: CardView
  choice: CardChoice
  busy: string | null
  onChoose: () => void
  /** Overrides core's label (e.g. "Continue with 3 findings" after the selection changed). */
  label?: string
  /** Every other label the button can show (with `label`): the button keeps the widest one's width. */
  labels?: readonly string[]
  /** A keyboard shortcut shown on the button (lib/keys combo). */
  combo?: string
  disabled?: boolean
  disabledReason?: string
}

export function ChoiceButton({
  card,
  choice,
  busy,
  onChoose,
  label,
  labels,
  combo,
  disabled = false,
  disabledReason,
}: ChoiceButtonProps): React.JSX.Element {
  const later = useLaterChoice(card.kind, choice.id)
  const text = label ?? choice.label
  const shared = {
    size: 'sm',
    variant: choice.primary === true ? 'default' : 'outline',
    className: cn(
      choice.danger === true && 'text-destructive hover:text-destructive',
      combo !== undefined && KBD_ON_CHOICE,
      labels !== undefined && 'tabular-nums',
    ),
    'data-testid': `card-choice-${choice.id}`,
    // The same slots in both branches, so a choice that becomes available keeps its width.
    ...(labels !== undefined ? { labels: [text, ...labels] } : {}),
    ...(combo !== undefined ? { kbd: combo } : {}),
  } as const
  if (later || disabledReason !== undefined) {
    return (
      <DisabledHint {...(disabledReason !== undefined ? { reason: disabledReason } : {})}>
        <Button {...shared} disabled>
          {text}
        </Button>
      </DisabledHint>
    )
  }
  return (
    <Button
      {...shared}
      aria-busy={busy === choice.id || undefined}
      disabled={disabled || busy !== null}
      onClick={onChoose}
      {...(combo !== undefined ? { 'aria-keyshortcuts': ariaKeyShortcuts(combo) } : {})}
    >
      {text}
    </Button>
  )
}

/**
 * A card's row of choices, with the busy state beside them: "Sending your choice…" after the last button while core
 * takes the pressed one. The status is always in the DOM (a polite live region), empty while idle.
 */
export function ChoiceRow({
  busy,
  children,
}: {
  busy: string | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <span
        role="status"
        data-testid="card-choice-status"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        {busy !== null && (
          <>
            <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            {SENDING_CHOICE}
          </>
        )}
      </span>
    </div>
  )
}
