// Easy mode's setup for the AI tools, without leaving Easy: when neither Claude Code nor Codex is ready (the confirm
// screen, the folder screen) or a run failed because one is missing or signed out (the Done screen), plain steps with
// the vendors' own install and sign-in commands to paste (Copy puts one on the clipboard; Dim Factory never runs them)
// and Check again, which asks core to look for the tools afresh.
// UI standards: Copy and Check again keep their labels and widths; the status line keeps its height.
import { ClipboardCopy, RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import {
  COPIED,
  COPY_LABEL,
  SETUP_CHECK,
  SETUP_CHECKING,
  SETUP_CLAUDE,
  SETUP_CODEX,
  SETUP_INTRO,
  SETUP_READY,
  SETUP_STILL,
  SETUP_TITLE,
  setupCommands,
  setupSteps,
} from './text.ts'

/** One command to paste, with Copy (a note on one reserved line says it was copied). */
export function CommandLine({
  command,
  label,
  testId,
}: {
  command: string
  label?: string
  testId?: string
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const copy = (): void => {
    void navigator.clipboard
      .writeText(command)
      .then(() => setNote(COPIED))
      .catch(() => setNote(command))
  }
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {label !== undefined && <p className="text-sm">{label}</p>}
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]">
          {command}
        </code>
        <Button size="sm" variant="outline" icon={<ClipboardCopy aria-hidden />} onClick={copy}>
          {COPY_LABEL}
        </Button>
      </div>
      <p className="min-h-4 text-xs text-muted-foreground" role="status">
        {note}
      </p>
    </div>
  )
}

/**
 * The steps to set up Claude Code or Codex, and Check again (core looks for them afresh; `onChecked` then reads the
 * screen again, with whether one is ready now).
 */
export function VendorSetup({
  platform,
  ready,
  onChecked,
}: {
  platform: string
  /** Whether a vendor is ready, as the screen last read it (null: not known). */
  ready: boolean | null
  /** Read the screen again after core looked for the tools: whether one is ready now. */
  onChecked: () => Promise<boolean>
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [checked, setChecked] = useState<boolean | null>(ready === true ? true : null)
  const headingId = useId()
  const cmds = { claude: setupCommands(platform, 'claude'), codex: setupCommands(platform, 'codex') }
  const check = (): void =>
    run('check', async () => {
      await invoke('vendors.probe', { force: true })
      setChecked(await onChecked())
    })
  return (
    <section
      aria-labelledby={headingId}
      data-testid="easy-setup"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {SETUP_TITLE}
      </h3>
      <p className="text-sm">{SETUP_INTRO}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
        {setupSteps(platform).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1" data-testid="easy-setup-claude">
          <p className="text-sm font-medium">{SETUP_CLAUDE}</p>
          {cmds.claude.map((c) => (
            <CommandLine key={c} command={c} />
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1" data-testid="easy-setup-codex">
          <p className="text-sm font-medium">{SETUP_CODEX}</p>
          {cmds.codex.map((c) => (
            <CommandLine key={c} command={c} />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          icon={<RefreshCw aria-hidden />}
          loading={busy === 'check'}
          data-testid="easy-setup-check"
          onClick={check}
        >
          {SETUP_CHECK}
        </Button>
        <p className="min-h-5 text-sm" role="status" data-testid="easy-setup-status">
          {busy === 'check' ? SETUP_CHECKING : checked === null ? '' : checked ? SETUP_READY : SETUP_STILL}
        </p>
      </div>
    </section>
  )
}
