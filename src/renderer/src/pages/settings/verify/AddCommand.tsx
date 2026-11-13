// Settings → Isolation & Verify: add a verify command of your own (argv only, no shell). Name, the command line and an optional folder inside the project; the line is split as core splits it and
// shell syntax is refused with core's words before anything is written (argv.ts). A new command is not trusted until
// the user trusts it in the table. The form opens on a click; its errors have a line of their own from the start, so
// typing never moves what follows.
import { Plus } from 'lucide-react'
import { useId, useState } from 'react'
import type { VerifyCommandConfig } from '@shared/config-schema.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import { LaterHint } from '../kit.tsx'
import { tokenizeCommand } from './argv.ts'
import { folderProblem, nameProblem } from './model.ts'

export interface AddCommandProps {
  /** The configured list (names must be unique). */
  list: readonly VerifyCommandConfig[]
  /** Why nothing can be added now (no project chosen, the list not read yet). */
  disabledReason: string | null
  /** Write the new entry; resolves true once core took it. */
  onAdd: (entry: VerifyCommandConfig) => Promise<boolean>
}

export function AddCommand({ list, disabledReason, onAdd }: AddCommandProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [line, setLine] = useState('')
  const [folder, setFolder] = useState('')
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const id = useId()

  const parsed = tokenizeCommand(line)
  const lineError = line.trim() === '' && !tried ? null : parsed.ok ? null : parsed.message
  const nameError = name === '' && !tried ? null : nameProblem(name, list)
  const folderError = folderProblem(folder)

  const submit = async (): Promise<void> => {
    setTried(true)
    if (!parsed.ok || nameProblem(name, list) !== null || folderError !== null) return
    const cwd = folder.trim().replace(/\\/g, '/')
    const entry: VerifyCommandConfig = {
      name: name.trim(),
      run: parsed.argv,
      ...(cwd !== '' && cwd !== '.' ? { cwd } : {}),
    }
    setSaving(true)
    const ok = await onAdd(entry)
    setSaving(false)
    if (ok) {
      setName('')
      setLine('')
      setFolder('')
      setTried(false)
      setOpen(false)
    }
  }

  if (!open || disabledReason !== null) {
    const button = (
      <Button
        size="sm"
        variant="outline"
        icon={<Plus aria-hidden />}
        data-testid="verify-add-open"
        disabled={disabledReason !== null}
        onClick={() => setOpen(true)}
      >
        Add a command
      </Button>
    )
    return (
      <div>{disabledReason !== null ? <LaterHint reason={disabledReason}>{button}</LaterHint> : button}</div>
    )
  }
  const err = (text: string | null, testId: string): React.JSX.Element => (
    <p
      data-testid={testId}
      role={text !== null ? 'alert' : undefined}
      className="min-h-4 text-xs text-destructive"
    >
      {text ?? ''}
    </p>
  )
  return (
    <form
      data-testid="verify-add"
      aria-label="Add a verify command"
      className="flex flex-col gap-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs font-medium text-muted-foreground">
          Name
        </label>
        <Input
          id={`${id}-name`}
          data-testid="verify-add-name"
          value={name}
          maxLength={40}
          placeholder="e.g. test"
          aria-invalid={nameError !== null || undefined}
          onChange={(e) => setName(e.currentTarget.value)}
          className="h-8 text-sm @min-[37.5rem]:w-72"
        />
        {err(nameError, 'verify-add-name-error')}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-line`} className="text-xs font-medium text-muted-foreground">
          Command
        </label>
        <Input
          id={`${id}-line`}
          data-testid="verify-add-line"
          value={line}
          placeholder="e.g. pnpm run test"
          spellCheck={false}
          aria-invalid={lineError !== null || undefined}
          onChange={(e) => setLine(e.currentTarget.value)}
          className="h-8 font-mono text-xs"
        />
        {err(lineError, 'verify-add-line-error')}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-folder`} className="text-xs font-medium text-muted-foreground">
          Folder (inside the project; leave empty for the project folder)
        </label>
        <Input
          id={`${id}-folder`}
          data-testid="verify-add-folder"
          value={folder}
          placeholder="."
          spellCheck={false}
          aria-invalid={folderError !== null || undefined}
          onChange={(e) => setFolder(e.currentTarget.value)}
          className="h-8 font-mono text-xs @min-[37.5rem]:w-72"
        />
        {err(folderError, 'verify-add-folder-error')}
      </div>
      <p className="text-xs text-muted-foreground">
        It runs without a shell, as you type it here. It is not trusted until you trust it in the list below.
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="submit"
          data-testid="verify-add-save"
          loading={saving}
          icon={<Plus aria-hidden />}
        >
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          data-testid="verify-add-cancel"
          disabled={saving}
          onClick={() => {
            setOpen(false)
            setTried(false)
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
