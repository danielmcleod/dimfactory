// A pass's Extensions level (config `passes.<p>.extensions`): None, Allowed list or Pass through, with what that means
// for the pass's vendor under it (shared extensionsCopy, the one source of that copy). On a read-only pass (Plan,
// Review, Critic) Pass through is never set by picking it alone: the warning that its MCP tools and hooks may act
// outside the sandbox shows first, with [Use Pass through] and [Cancel]; only the confirm sets it. Used by the composer's
// pass rows, the Profiles editor and Settings > Extensions.
// UI standards: the trigger keeps one width whatever it shows, the confirm's buttons keep fixed labels, and the
// confirm appears only as the direct result of the user's pick (nothing moves on its own).
import { useState } from 'react'
import type { ExtensionLevel } from '@shared/extensions.ts'
import {
  EXTENSION_LEVELS,
  EXTENSION_LEVEL_LABEL,
  PASSTHROUGH_READONLY_WARNING,
  extensionsCopy,
  isReadOnlyExtensionsPass,
} from '@shared/extensions.ts'
import type { PassName } from '@shared/run.ts'
import { Button } from '../../../components/ui/Button.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { cn } from '../../../lib/cn.ts'

export interface ExtensionsSelectProps {
  /** `data-testid` suffix (`pass-extensions-<id>`). */
  id: string
  pass: PassName
  /** Accessible name, e.g. "Review extensions". */
  label: string
  value: ExtensionLevel
  disabled?: boolean
  onChange: (level: ExtensionLevel) => void
  className?: string
}

export function ExtensionsSelect({
  id,
  pass,
  label,
  value,
  disabled,
  onChange,
  className,
}: ExtensionsSelectProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const readOnly = isReadOnlyExtensionsPass(pass)
  return (
    <span className="inline-flex flex-col gap-1.5">
      <Select
        value={value}
        disabled={disabled === true}
        onValueChange={(v) => {
          const next = v as ExtensionLevel
          if (next === value) return
          // A read-only pass needs the user's explicit yes to the warning first.
          if (next === 'passthrough' && readOnly) {
            setConfirming(true)
            return
          }
          setConfirming(false)
          onChange(next)
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid={`pass-extensions-${id}`}
          aria-label={label}
          title="Which of your MCP servers, skills, plugins and hooks this pass may use"
          className={cn('w-36', className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXTENSION_LEVELS.map((level) => (
            <SelectItem
              key={level}
              value={level}
              data-testid={`pass-extensions-${id}-${level}`}
              {...(level === 'passthrough' && readOnly ? { title: PASSTHROUGH_READONLY_WARNING } : {})}
            >
              {EXTENSION_LEVEL_LABEL[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {confirming && (
        <span
          role="alertdialog"
          aria-label={`Let ${label.replace(/ extensions$/, '')} use every extension?`}
          data-testid={`pass-extensions-confirm-${id}`}
          className="flex max-w-md flex-col gap-1.5 rounded-md border border-warning/50 p-2 text-xs"
        >
          <span className="text-warning">{PASSTHROUGH_READONLY_WARNING}</span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid={`pass-extensions-confirm-yes-${id}`}
              onClick={() => {
                setConfirming(false)
                onChange('passthrough')
              }}
            >
              Use Pass through
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`pass-extensions-confirm-no-${id}`}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </span>
        </span>
      )}
    </span>
  )
}

/** What the level means for the pass's vendor, with the read-only warning at Pass through. */
export function ExtensionsCopy({
  id,
  pass,
  vendor,
  value,
  className,
}: {
  id: string
  pass: PassName
  vendor: string
  value: ExtensionLevel
  className?: string
}): React.JSX.Element {
  const warn = value === 'passthrough' && isReadOnlyExtensionsPass(pass)
  return (
    <p
      data-testid={`pass-extensions-copy-${id}`}
      data-warning={warn || undefined}
      className={cn('text-xs', warn ? 'text-warning' : 'text-muted-foreground', className)}
    >
      {extensionsCopy(vendor, value)}
      {warn ? ` ${PASSTHROUGH_READONLY_WARNING}` : ''}
    </p>
  )
}
