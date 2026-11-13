// Settings → Isolation & Verify, the Isolation half (the `isolation` keys: mode, branch, worktree {copy,
// install, installCommand, autoApply}; copy-ins are ignored or untracked files only, the
// deps install runs only with a `deps` grant, autoApply + Auto + no conflicts applies without the card). Each control writes one config.patch with Undo through the section's `write` (the chosen project's
// dimfactory.json, else your settings), and shows the value just written at once.
// UI control standards: every row is the same height before and after core's values arrive (the controls are
// disabled until then), the copy list is one summary line until the user opens its editor, and the install command is
// one box with one error line kept for it, so nothing moves on its own. An install command is split as core splits it
// and shell syntax is refused before anything is written (installCommand.ts).
import { Plus, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ProvenanceMap, ResolvedConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { SourceBadge } from '../general/SourceBadge.tsx'
import { Group, SettingRow } from '../kit.tsx'
import { installCommandLine, parseInstallCommand } from './installCommand.ts'

export type IsolationSettings = ResolvedConfig['isolation']
type InstallPolicy = IsolationSettings['worktree']['install']

export const RUN_LOCATION_LABEL = 'Run location'
export const NEW_BRANCH_LABEL = 'New run branch'
export const INSTALL_LABEL = 'Install dependencies'
export const INSTALL_COMMAND_LABEL = 'Install command'
export const AUTO_APPLY_LABEL = 'Apply automatically'
export const COPY_LABEL = 'Files to copy in'

export const MODE_TEXT: Readonly<Record<IsolationSettings['mode'], string>> = {
  inPlace: 'In place',
  worktree: 'Isolated run',
}

export const INSTALL_TEXT: Readonly<Record<InstallPolicy, string>> = {
  ask: 'Ask first',
  auto: 'When trusted',
  never: 'Never',
}

/** What the toast says each value now does. */
const MODE_DONE: Readonly<Record<IsolationSettings['mode'], string>> = {
  inPlace: 'Runs work in place by default',
  worktree: 'Runs work in an isolated copy by default',
}
const INSTALL_DONE: Readonly<Record<InstallPolicy, string>> = {
  ask: 'Isolated runs ask before installing dependencies',
  auto: 'Isolated runs install dependencies you trusted',
  never: 'Isolated runs never install dependencies',
}

export const NO_COPY = 'Nothing is copied in: the copy has only what git tracks.'
export const INSTALL_DETECTED = 'Detected from the project (its lockfile)'
export const MAX_COPY = 50

/** The copy editor's toggle keeps one width (Edit, Done). */
export const COPY_EDIT_LABELS: readonly string[] = ['Edit', 'Done']

/** Why a copy pattern cannot be added (the schema's limits: 1 to 260 characters, at most 50, each once). */
export function copyProblem(glob: string, list: readonly string[]): string | null {
  const g = glob.trim()
  if (g === '') return 'Type a file name or a pattern such as .env or config/*.local.json.'
  if (g.length > 260) return 'A pattern can be at most 260 characters.'
  if (list.includes(g)) return 'That pattern is already in the list.'
  if (list.length >= MAX_COPY) return `At most ${MAX_COPY} patterns.`
  return null
}

/** The one-line summary of the copy list. */
export function copySummary(list: readonly string[]): string {
  return list.length === 0 ? NO_COPY : list.join(', ')
}

export interface IsolationGroupProps {
  /** core's resolved `isolation` with the values just written on top; null while it loads. */
  iso: IsolationSettings | null
  provenance: ProvenanceMap | undefined
  busy: string | null
  /** One config.patch with Undo; `shown` is the value to show at once under `key`. */
  write: (key: string, ops: JsonPatchOp[], message: string, shown?: unknown) => Promise<boolean>
}

function Radios<T extends string>({
  name,
  label,
  options,
  value,
  disabled,
  onChange,
  testId,
}: {
  name: string
  label: string
  options: readonly { value: T; text: string }[]
  value: T | undefined
  disabled: boolean
  onChange: (v: T) => void
  testId: string
}): React.JSX.Element {
  return (
    <fieldset
      disabled={disabled}
      data-testid={testId}
      className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 disabled:opacity-60"
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="radio"
            name={name}
            value={o.value}
            data-testid={`${testId}-${o.value}`}
            disabled={disabled}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          {o.text}
        </label>
      ))}
    </fieldset>
  )
}

function InstallCommandField({
  value,
  disabled,
  onSave,
}: {
  /** core's installCommand (argv or a line), null: detected. undefined while loading. */
  value: IsolationSettings['worktree']['installCommand'] | undefined
  disabled: boolean
  onSave: (argv: string[] | null) => Promise<boolean>
}): React.JSX.Element {
  const id = useId()
  const saved = value === undefined || value === null ? '' : installCommandLine(value)
  const [text, setText] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  // A new value from core (a reload, an Undo) replaces what the box shows.
  useEffect(() => {
    setText(saved)
    setError(null)
  }, [saved])
  const commit = async (): Promise<void> => {
    const line = text.trim()
    if (line === saved.trim()) return
    if (line === '') {
      await onSave(null)
      return
    }
    const parsed = parseInstallCommand(line)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }
    setError(null)
    await onSave(parsed.argv)
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-line`}
          data-testid="isolation-install-command"
          aria-label={INSTALL_COMMAND_LABEL}
          aria-invalid={error !== null || undefined}
          aria-describedby={`${id}-error`}
          spellCheck={false}
          value={text}
          placeholder={INSTALL_DETECTED}
          disabled={disabled}
          onChange={(e) => {
            setText(e.currentTarget.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit()
            } else if (e.key === 'Escape') {
              setText(saved)
              setError(null)
            }
          }}
          className="h-7 w-72 max-w-full font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="isolation-install-command-save"
          disabled={disabled || text.trim() === saved.trim()}
          onClick={() => void commit()}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="isolation-install-command-detect"
          disabled={disabled || saved === ''}
          onClick={() => void onSave(null)}
        >
          Use the detected command
        </Button>
      </div>
      <p
        id={`${id}-error`}
        data-testid="isolation-install-command-error"
        role={error !== null ? 'alert' : undefined}
        className="min-h-4 text-xs text-destructive"
      >
        {error ?? ''}
      </p>
    </div>
  )
}

function CopyList({
  list,
  disabled,
  onSave,
}: {
  list: readonly string[] | undefined
  disabled: boolean
  onSave: (next: string[], message: string) => Promise<boolean>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [glob, setGlob] = useState('')
  const [tried, setTried] = useState(false)
  const id = useId()
  const current = list ?? []
  const problem = copyProblem(glob, current)
  const shownProblem = !tried && glob.trim() === '' ? null : problem
  const summary = list === undefined ? 'Reading the settings…' : copySummary(current)
  const add = async (): Promise<void> => {
    setTried(true)
    if (problem !== null) return
    const g = glob.trim()
    if (await onSave([...current, g], `${g} is copied into isolated runs`)) {
      setGlob('')
      setTried(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <p
          data-testid="isolation-copy-summary"
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={summary}
        >
          {summary}
        </p>
        <Button
          size="sm"
          variant="outline"
          data-testid="isolation-copy-edit"
          aria-expanded={open}
          aria-controls={`${id}-editor`}
          disabled={disabled}
          labels={COPY_EDIT_LABELS}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Done' : 'Edit'}
        </Button>
      </div>
      {open && (
        <div
          id={`${id}-editor`}
          data-testid="isolation-copy-editor"
          className="flex flex-col gap-2 rounded-md border p-2"
        >
          {current.length > 0 && (
            <ul aria-label={COPY_LABEL} className="flex flex-col gap-1">
              {current.map((g) => (
                <li key={g} data-testid="isolation-copy-row" className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={g}>
                    {g}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Remove ${g}`}
                    data-testid="isolation-copy-remove"
                    disabled={disabled}
                    onClick={() =>
                      void onSave(
                        current.filter((x) => x !== g),
                        `${g} is no longer copied in`,
                      )
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            aria-label="Add a file or pattern to copy in"
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                data-testid="isolation-copy-input"
                aria-label="File or pattern to copy in"
                aria-invalid={shownProblem !== null || undefined}
                aria-describedby={`${id}-problem`}
                spellCheck={false}
                value={glob}
                placeholder="e.g. .env.local"
                disabled={disabled}
                onChange={(e) => setGlob(e.currentTarget.value)}
                className="h-7 w-64 max-w-full font-mono text-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                icon={<Plus aria-hidden />}
                data-testid="isolation-copy-add"
                disabled={disabled}
              >
                Add
              </Button>
            </div>
            <p
              id={`${id}-problem`}
              data-testid="isolation-copy-problem"
              role={shownProblem !== null ? 'alert' : undefined}
              className="min-h-4 text-xs text-destructive"
            >
              {shownProblem ?? ''}
            </p>
          </form>
        </div>
      )}
    </div>
  )
}

export function IsolationGroup({ iso, provenance, busy, write }: IsolationGroupProps): React.JSX.Element {
  const loading = iso === null
  const off = (key: string): boolean => loading || busy === key
  const name = useId()
  const replace = (path: string, value: unknown): JsonPatchOp[] => [{ op: 'replace', path, value }]
  return (
    <Group
      title="Isolation"
      description="Where runs make their changes. An isolated run works in its own copy of the repository and changes nothing in your folder until you apply it."
      testId="isolation-group"
    >
      <div>
        <SettingRow
          label="Where runs make changes"
          description="In the folder, or in an isolated copy (a git worktree) you apply when the run ends. The composer can change it for one run."
          field="/isolation/mode"
        >
          <SourceBadge
            provenance={provenance?.['/isolation/mode']}
            loading={loading}
            testId="isolation-mode-source"
          />
          <Radios
            name={`${name}-mode`}
            label={RUN_LOCATION_LABEL}
            testId="isolation-mode"
            options={[
              { value: 'inPlace', text: MODE_TEXT.inPlace },
              { value: 'worktree', text: MODE_TEXT.worktree },
            ]}
            value={iso?.mode}
            disabled={off('/isolation/mode')}
            onChange={(v) => void write('/isolation/mode', replace('/isolation/mode', v), MODE_DONE[v], v)}
          />
        </SettingRow>
        <SettingRow
          label="Start each run on a new branch"
          description="Before Implement, Dim Factory makes a branch from the one you are on and switches to it. It never commits."
          field="/isolation/branch"
        >
          <SourceBadge
            provenance={provenance?.['/isolation/branch']}
            loading={loading}
            testId="isolation-branch-source"
          />
          <Switch
            data-testid="isolation-branch"
            aria-label={NEW_BRANCH_LABEL}
            checked={iso?.branch === 'runBranch'}
            disabled={off('/isolation/branch')}
            onCheckedChange={(v) => {
              const value = v ? 'runBranch' : 'none'
              void write(
                '/isolation/branch',
                replace('/isolation/branch', value),
                v ? 'Runs start on a new branch' : 'Runs stay on your branch',
                value,
              )
            }}
          />
        </SettingRow>
        <div data-setting-field="/isolation/worktree/copy" className="flex flex-col gap-1.5 border-b py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm">Files to copy into an isolated copy</span>
            <span className="text-xs text-muted-foreground">
              Files git does not track (ignored or untracked), such as .env, copied from your folder when the
              copy is made. Tracked files always come from your last commit.
            </span>
          </div>
          <CopyList
            list={iso?.worktree.copy}
            disabled={off('/isolation/worktree/copy')}
            onSave={(next, message) =>
              write('/isolation/worktree/copy', replace('/isolation/worktree/copy', next), message, next)
            }
          />
        </div>
        <SettingRow
          label="Install dependencies in an isolated copy"
          description="Ask first shows the command before it runs; When trusted runs a command you trusted for the project without asking; Never leaves the copy without them."
          field="/isolation/worktree/install"
        >
          <SourceBadge
            provenance={provenance?.['/isolation/worktree/install']}
            loading={loading}
            testId="isolation-install-source"
          />
          <Radios
            name={`${name}-install`}
            label={INSTALL_LABEL}
            testId="isolation-install"
            options={(['ask', 'auto', 'never'] as const).map((v) => ({ value: v, text: INSTALL_TEXT[v] }))}
            value={iso?.worktree.install}
            disabled={off('/isolation/worktree/install')}
            onChange={(v) =>
              void write(
                '/isolation/worktree/install',
                replace('/isolation/worktree/install', v),
                INSTALL_DONE[v],
                v,
              )
            }
          />
        </SettingRow>
        <div
          data-setting-field="/isolation/worktree/installCommand"
          className="flex flex-col gap-1.5 border-b py-2"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm">Install command</span>
            <span className="text-xs text-muted-foreground">
              Leave it empty to use the command Dim Factory detects from the lockfile. A command set in a
              project file runs only once you trust it there. No shell: a pipe or a redirect needs a package
              script.
            </span>
          </div>
          <InstallCommandField
            value={iso === null ? undefined : iso.worktree.installCommand}
            disabled={off('/isolation/worktree/installCommand')}
            onSave={(argv) =>
              write(
                '/isolation/worktree/installCommand',
                replace('/isolation/worktree/installCommand', argv),
                argv === null
                  ? 'Isolated runs use the detected install command'
                  : 'Saved the install command',
                argv,
              )
            }
          />
        </div>
        <SettingRow
          label="Apply automatically in Auto"
          description="When a run in Auto ends and none of its files changed in your folder meanwhile, apply it without asking. You can still undo it."
          field="/isolation/worktree/autoApply"
        >
          <SourceBadge
            provenance={provenance?.['/isolation/worktree/autoApply']}
            loading={loading}
            testId="isolation-autoapply-source"
          />
          <Switch
            data-testid="isolation-autoapply"
            aria-label={AUTO_APPLY_LABEL}
            checked={iso?.worktree.autoApply === true}
            disabled={off('/isolation/worktree/autoApply')}
            onCheckedChange={(v) =>
              void write(
                '/isolation/worktree/autoApply',
                replace('/isolation/worktree/autoApply', v),
                v ? 'Auto runs apply on their own when nothing conflicts' : 'Auto runs wait for you to apply',
                v,
              )
            }
          />
        </SettingRow>
      </div>
    </Group>
  )
}
