// A command core wrote for the user to run (a run's end otherwise offers copyable commands; the
// reconcile card's copyable `git <op> --abort`) when it came as text, without a recovery action of its own: the
// command on its line and [Copy], which puts it on the clipboard. Dim Factory never runs it. Commands that come as
// `shell_copy` actions go through RecoveryActions instead (core copies them and Re-check follows).
import { Copy } from 'lucide-react'
import { cn } from '../../lib/cn.ts'
import { copyText, useBusy } from '../run/commands.ts'
import { Button } from '../ui/Button.tsx'

export function CopyCommands({
  commands,
  testId,
  className,
}: {
  commands: readonly string[]
  testId: string
  className?: string
}): React.JSX.Element | null {
  const [busy, run] = useBusy()
  if (commands.length === 0) return null
  return (
    <ul data-testid={testId} className={cn('flex flex-col gap-1.5', className)}>
      {commands.map((c, i) => (
        <li key={i} className="flex items-start gap-2">
          <code
            data-testid={`${testId}-command`}
            className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs wrap-anywhere select-all"
          >
            {c}
          </code>
          <Button
            size="sm"
            variant="outline"
            data-testid={`${testId}-copy`}
            aria-label={`Copy: ${c}`}
            icon={<Copy aria-hidden />}
            loading={busy === String(i)}
            disabled={busy !== null && busy !== String(i)}
            onClick={() => run(String(i), () => copyText(c, 'Command'))}
          >
            Copy
          </Button>
        </li>
      ))}
    </ul>
  )
}
