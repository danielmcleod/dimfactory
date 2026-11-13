// Building blocks of the Settings sections (UI for unbuilt backends renders but is blocked): a labelled setting row, a group heading, and the disabled controls of sections that
// arrive in a later version, each named with "Available in a later version" (LaterHint). Nothing here fetches: a
// section switch renders at once (performance.spec.ts).
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { LATER_VERSION } from '../../components/ui/DisabledHint.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { cn } from '../../lib/cn.ts'

/** The text a section that is not built yet shows once, above its disabled controls. */
export const LATER_SECTION = 'Arrives in a later version'

export function LaterNotice({ about }: { about: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-dashed p-3" data-testid="settings-later">
      <p className="text-sm font-medium">{LATER_SECTION}</p>
      <p className="text-sm text-muted-foreground">{about} The controls below show what it will hold.</p>
    </div>
  )
}

/**
 * A titled group of settings. `field` marks it in the Settings index (index.ts) like a SettingRow's; `testId` names it
 * for tests.
 */
export function Group({
  title,
  description,
  children,
  className,
  field,
  testId,
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
  field?: string
  testId?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      data-setting-field={field}
      data-testid={testId}
      className={cn('flex flex-col gap-3', className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * One setting: label (and what it does) on the left, its control on the right. `field` is the row's id in the Settings
 * index (index.ts): a deep link `?field=<id>` focuses the row's first enabled control.
 */
export function SettingRow({
  label,
  description,
  field,
  children,
}: {
  label: string
  description?: string
  field?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      data-setting-field={field}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 border-b py-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description !== undefined && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

// ---- disabled controls (later versions) ----------------------------------------------------------------------

/**
 * DisabledHint's contract (one focusable group named "<control> Available in a later version") with the browser's
 * own tooltip instead of a Radix one: a skeleton section has dozens of these, and a section switch must render in
 * under 200 ms (performance.spec.ts). `reason` replaces "Available in a later version" for a control disabled for another reason.
 */
export function LaterHint({
  children,
  reason = LATER_VERSION,
}: {
  children: ReactNode
  reason?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <span
      tabIndex={0}
      role="group"
      aria-labelledby={`${id}-control ${id}-reason`}
      title={reason}
      data-disabled-hint=""
      className="inline-flex cursor-not-allowed rounded-md focus-visible:outline-2"
    >
      <span id={`${id}-control`} className="contents">
        {children}
      </span>
      <span id={`${id}-reason`} className="sr-only">
        {reason}
      </span>
    </span>
  )
}

/** An off switch that cannot be turned on yet (drawn like ui/Switch, without its Radix state machine). */
export function LaterSwitch({ label }: { label: string }): React.JSX.Element {
  return (
    <LaterHint>
      <button
        type="button"
        role="switch"
        aria-checked="false"
        aria-label={label}
        disabled
        className="inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full border-2 border-transparent bg-input opacity-50"
      >
        <span className="block size-4 rounded-full bg-background shadow-sm" />
      </button>
    </LaterHint>
  )
}

/** A dropdown that cannot open yet: drawn like the Select trigger, named by its label (not its placeholder). */
export function LaterSelect({
  label,
  placeholder,
  className,
}: {
  label: string
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <LaterHint>
      <button
        type="button"
        disabled
        aria-label={label}
        className={cn(
          'flex h-7 w-44 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-xs whitespace-nowrap text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        {/* The hint's group is named from this content: the label, not the placeholder. */}
        <span className="sr-only">{label}</span>
        <span aria-hidden className="truncate">
          {placeholder}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 opacity-60" />
      </button>
    </LaterHint>
  )
}

export function LaterInput({
  label,
  placeholder,
  suffix,
  className,
}: {
  label: string
  placeholder?: string
  suffix?: string
  className?: string
}): React.JSX.Element {
  return (
    <LaterHint>
      <span className="inline-flex items-center gap-1.5">
        {/* An input adds its value, not its label, to the hint's name: say the label once, out of sight. */}
        <span className="sr-only">{label}</span>
        <Input
          disabled
          aria-label={suffix !== undefined ? `${label} (${suffix})` : label}
          placeholder={placeholder}
          className={cn('h-7 w-24 text-xs', className)}
        />
        {suffix !== undefined && (
          <span aria-hidden className="text-xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </span>
    </LaterHint>
  )
}

export function LaterButton({
  children,
  variant = 'outline',
}: {
  children: ReactNode
  variant?: 'default' | 'outline' | 'ghost' | 'destructive'
}): React.JSX.Element {
  return (
    <LaterHint>
      <Button size="sm" variant={variant} disabled>
        {children}
      </Button>
    </LaterHint>
  )
}

/**
 * A settings table's frame and cells: never a scroller of its own, downwards or sideways (one scroll region per screen,
 * at any page zoom). The table takes its column's width, its columns share it (table-fixed), and a header or value too
 * long for its cell wraps, breaking a word only where it must.
 */
export const SETTINGS_TABLE = {
  frame: 'overflow-clip rounded-md border',
  table: 'w-full table-fixed text-left text-xs',
  cell: 'px-2 py-1.5 align-top [overflow-wrap:anywhere]',
} as const

/** A read-only table header with an empty body: the shape of a list that is filled in a later version. */
export function LaterTable({
  label,
  columns,
  empty,
}: {
  label: string
  columns: readonly string[]
  empty: string
}): React.JSX.Element {
  return (
    <div className={SETTINGS_TABLE.frame}>
      <table aria-label={label} className={SETTINGS_TABLE.table}>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={columns.length} className="px-2 py-3 text-muted-foreground">
              {empty}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/**
 * A choice tile: a label around a visually hidden radio (Appearance's theme, accent and font size, Config file's
 * scope). The checked tile is marked by its border and background only: a weight change would widen it and move the
 * others.
 */
export const TILE_CLASS =
  'relative flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50'
