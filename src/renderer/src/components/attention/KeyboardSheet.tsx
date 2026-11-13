// The keyboard sheet (`?` opens it; keyboard.spec.ts). The app's key table with this
// platform's modifiers. Not a modal (the ⌘/Ctrl+K palette is the only one): a panel that takes focus when it opens,
// gives it back when it closes (Escape, `?` again or Close), and never traps it. `?` is ignored while typing.
import { Keyboard, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { formatCombo, KEYS, useShortcut } from '../../lib/keys.ts'
import { Button } from '../ui/Button.tsx'

export interface KeyRow {
  combos: readonly string[]
  action: string
  /** Shown after the action while the binding arrives in a later version. */
  later?: boolean
}

/** The app's key table, in its order. */
export const KEY_TABLE: readonly KeyRow[] = [
  { combos: [KEYS.runOrApprove], action: 'Run / approve' },
  { combos: [KEYS.palette], action: 'Command palette' },
  {
    combos: [KEYS.allowOnce, KEYS.allowForRun, KEYS.deny],
    action: 'Answer the focused ask: allow once, allow for this run, deny',
  },
  { combos: [KEYS.dashboard, KEYS.runs, KEYS.settings], action: 'Switch screens: Dashboard, Runs, Settings' },
  { combos: [KEYS.stop], action: 'Stop the run' },
  { combos: [KEYS.openDiff], action: 'Open the diff' },
  {
    combos: [KEYS.diffNext, KEYS.diffPrev, KEYS.diffReviewed, KEYS.diffLayout],
    action: 'Diff: next file, previous file, mark reviewed, split or stacked',
  },
  { combos: [KEYS.keyboardSheet], action: 'Show or hide this sheet' },
]

export function KeyboardSheet(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useShortcut(
    KEYS.keyboardSheet,
    () => {
      if (!open) {
        const active = document.activeElement
        returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
      }
      setOpen((o) => !o)
    },
    { description: 'Keyboard shortcuts' },
  )

  useEffect(() => {
    if (open) {
      ref.current?.focus({ preventScroll: true })
      return
    }
    const back = returnTo.current
    returnTo.current = null
    if (back !== null && back.isConnected) back.focus({ preventScroll: true })
  }, [open])

  if (!open) return null
  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="keyboard-sheet"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
        }
      }}
      className="fixed right-4 bottom-4 z-50 flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* A div, not a <header>: the sheet sits outside <main>, where a header is the page's banner landmark. */}
      <div className="flex items-center gap-2">
        <Keyboard aria-hidden className="size-4 text-muted-foreground" />
        <h2 id={titleId} className="text-sm font-semibold">
          Keyboard shortcuts
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-7"
          aria-label="Close keyboard shortcuts"
          onClick={() => setOpen(false)}
        >
          <X aria-hidden />
        </Button>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {KEY_TABLE.map((row) => (
            <tr key={row.action} className="border-t first:border-t-0">
              <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                {row.combos.map((c, i) => (
                  <span key={c}>
                    {i > 0 && <span className="px-0.5 text-muted-foreground">/</span>}
                    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] font-medium">
                      {formatCombo(c)}
                    </kbd>
                  </span>
                ))}
              </td>
              <td className="py-1.5 align-top">
                {row.action}
                {row.later === true && (
                  <span className="text-xs text-muted-foreground"> · in a later version</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Single keys work only while focus is in the place they belong to, never while you type.
      </p>
    </section>
  )
}
