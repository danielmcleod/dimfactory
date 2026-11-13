// Settings → Profiles (a list with a scope chip, user or project; built-ins read-only, Duplicate to edit;
// duplicate / rename / delete with undo; Set as default for user or project; PassRowsEditor; config layers). The list has the five built-in profiles, yours (your dimfactory.json) and, with a project
// chosen, the project's own (its .dimfactory/dimfactory.json, shared with whoever has the project). Selecting one shows
// its passes: a built-in reads as a table; yours and a project's are edited in place. Every action is one config.patch
// in the profile's own file with an Undo toast. A deep link `#/settings/profiles/<name>` selects that profile (and
// `?folder=` chooses the project); nothing scrolls on its own. Nothing moves on its own either: until the files are
// read, the list and the profile's detail are one "Reading your profiles…" line at the end of the section (a list of
// the built-ins alone would grow, and its selection jump, when yours arrive), and the first selection is made from
// what was read.
import { Copy, FolderInput, Pencil, Star, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { Badge } from '../../components/ui/Badge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { cn } from '../../lib/cn.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useProbes } from '../../state/selectors.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { writeConfig } from './general/configWrite.ts'
import type { ConfigTarget } from './general/configWrite.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { settingFieldProps } from './index.ts'
import { Group } from './kit.tsx'
import { BUILTIN_PROFILE_NAMES } from './profiles/builtins.ts'
import {
  copyName,
  defaultOps,
  deleteBlocked,
  deleteOps,
  duplicateOps,
  fileDefault,
  nameError,
  profileEntries,
  projectDefaultBlocked,
  projectDuplicateBlocked,
  renameBlocked,
  renameOps,
  SCOPE_LABEL,
  userDefaultBlocked,
} from './profiles/model.ts'
import type { ProfileEntry, ProfileFacts } from './profiles/model.ts'
import { PassRowsEditor } from './profiles/PassRowsEditor.tsx'
import { StepsEditor } from './profiles/StepsEditor.tsx'
import { useProfilesData } from './profiles/useProfilesData.ts'

const UNDO_TOAST = 'profiles-undo'

export const USER_DEFAULT_LABEL = 'Make it my default'
export const PROJECT_DEFAULT_LABEL = "Make it this project's default"

/** The deep link's key: the section remounts with the link's choices when another link opens it. */
function linkKey(route: Route): string {
  if (route.name !== 'settings') return ''
  return `${route.subpath.join('/')}?${new URLSearchParams(route.query).toString()}`
}

export function ProfilesSection(): React.JSX.Element {
  const route = useRoute()
  const sub = route.name === 'settings' ? route.subpath[0] : undefined
  const folder = route.name === 'settings' ? (route.query['folder'] ?? '') : ''
  return (
    <ProfilesBody
      key={linkKey(route)}
      initialProfile={sub !== undefined && sub !== '' ? sub : null}
      initialFolder={folder !== '' ? folder : null}
    />
  )
}

/**
 * A button, or the same button disabled with the reason as its tooltip. While the profiles are read it is only
 * disabled (a deep link waits for it instead of landing on the hint).
 */
function Action({
  blocked,
  children,
  ...props
}: {
  /** Why it cannot be used now; LOADING while the profiles are read. */
  blocked: string | null
  children: ReactNode
  testId: string
  icon: ReactNode
  busy?: boolean
  variant?: 'outline' | 'ghost'
  onClick: () => void
}): React.JSX.Element {
  const button = (
    <Button
      size="sm"
      variant={props.variant ?? 'outline'}
      data-testid={props.testId}
      icon={props.icon}
      loading={props.busy === true}
      disabled={blocked !== null}
      onClick={props.onClick}
    >
      {children}
    </Button>
  )
  return blocked !== null && blocked !== LOADING ? (
    <DisabledHint reason={blocked}>{button}</DisabledHint>
  ) : (
    button
  )
}

const LOADING = 'Reading your profiles…'

function ScopeChip({ entry, testId }: { entry: ProfileEntry; testId: string }): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      data-scope={entry.scope}
      className={cn(
        'px-1 py-0 text-[10px] font-normal',
        entry.scope === 'project' ? 'border-info/50 text-info' : 'text-muted-foreground',
      )}
    >
      {SCOPE_LABEL[entry.scope]}
    </Badge>
  )
}

function DefaultChip({ testId, children }: { testId: string; children: string }): React.JSX.Element {
  return (
    <Badge variant="secondary" data-testid={testId} className="gap-1 px-1 py-0 text-[10px] font-normal">
      <Star aria-hidden />
      {children}
    </Badge>
  )
}

function whereText(entry: ProfileEntry, userPath: string | null, projectPath: string | null): string {
  switch (entry.scope) {
    case 'builtin':
      return 'Built-in: read-only. Duplicate it to make a profile you can change.'
    case 'user':
      return `Yours, in every project${userPath !== null ? `: ${userPath}` : ''}.`
    case 'project':
      return `This project's own, shared with everyone who has the project${projectPath !== null ? `: ${projectPath}` : ''}.`
  }
}

function ProfilesBody({
  initialProfile,
  initialFolder,
}: {
  initialProfile: string | null
  initialFolder: string | null
}): React.JSX.Element {
  const listName = useId()
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const [selected, setSelected] = useState<string | null>(initialProfile)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const data = useProfilesData(folder)
  const probes = useProbes()

  const userValue = data.user?.value ?? {}
  const projectValue = folder !== null ? (data.project?.value ?? {}) : null
  const entries = profileEntries(userValue, projectValue)
  const names = entries.map((e) => e.name)
  const userDefault = data.resolved?.config.profile ?? null
  const userFileDefault = fileDefault(userValue)
  const projectDefault = projectValue !== null ? fileDefault(projectValue) : null

  const found = selected !== null ? entries.find((e) => e.name === selected) : undefined
  const entry =
    found ??
    entries.find((e) => e.name === userDefault) ??
    entries.find((e) => e.name === BUILTIN_PROFILE_NAMES[0])
  const facts: ProfileFacts | null =
    entry !== undefined ? { entry, userDefault, userFileDefault, projectDefault, folder } : null

  const targetOf = (e: ProfileEntry): ConfigTarget =>
    e.scope === 'project' && folder !== null ? { scope: 'project', folder } : { scope: 'user' }
  const beforeOf = (t: ConfigTarget): unknown => (t.scope === 'project' ? (projectValue ?? {}) : userValue)

  const write = async (
    target: ConfigTarget,
    ops: JsonPatchOp[],
    message: string,
    key: string,
  ): Promise<boolean> => {
    setBusy(key)
    const res = await writeConfig({
      target,
      ops,
      before: beforeOf(target),
      message,
      toastId: UNDO_TOAST,
      onSettled: data.reload,
    })
    setBusy(null)
    return res !== null
  }

  const projectName = folder !== null ? folderBaseName(folder) : ''

  const duplicate = async (into: 'user' | 'project'): Promise<void> => {
    if (entry === undefined) return
    const name = copyName(entry.name, names)
    const target: ConfigTarget =
      into === 'project' && folder !== null ? { scope: 'project', folder } : { scope: 'user' }
    const where = target.scope === 'project' ? projectName : 'your profiles'
    const ok = await write(
      target,
      duplicateOps(name, entry.definition),
      `Duplicated ${entry.name} as ${name} in ${where}.`,
      into === 'project' ? 'duplicate-project' : 'duplicate',
    )
    if (ok) setSelected(name)
  }

  const startRename = (): void => {
    if (entry === undefined) return
    setRenaming(entry.name)
    setRenameError(null)
  }

  const saveRename = async (next: string): Promise<void> => {
    if (entry === undefined || entry.own === null) return
    const trimmed = next.trim()
    if (trimmed === entry.name) {
      setRenaming(null)
      return
    }
    const err = nameError(trimmed, names, entry.name)
    if (err !== null) {
      setRenameError(err)
      return
    }
    const target = targetOf(entry)
    const own: ProfileConfig = entry.own
    const ok = await write(
      target,
      renameOps(entry.name, trimmed, own, fileDefault(beforeOf(target))),
      `Renamed ${entry.name} to ${trimmed}.`,
      'rename',
    )
    if (ok) {
      setRenaming(null)
      setSelected(trimmed)
    }
  }

  const remove = async (): Promise<void> => {
    if (entry === undefined) return
    // The selection stays on the name: Undo brings the profile back selected.
    await write(targetOf(entry), deleteOps(entry.name), `Deleted the profile ${entry.name}.`, 'delete')
  }

  const makeDefault = async (scope: 'user' | 'project'): Promise<void> => {
    if (entry === undefined) return
    if (scope === 'project') {
      if (folder === null) return
      await write(
        { scope: 'project', folder },
        defaultOps(entry.name),
        `${entry.name} is now the default profile of ${projectName}.`,
        'default-project',
      )
      return
    }
    await write(
      { scope: 'user' },
      defaultOps(entry.name),
      `${entry.name} is now your default profile.`,
      'default-user',
    )
  }

  const loaded = data.loaded
  const editable = entry !== undefined && entry.scope !== 'builtin' && entry.own !== null && loaded
  const off = (reason: string | null): string | null => (loaded ? reason : LOADING)

  return (
    <div className="flex flex-col gap-6" data-testid="settings-profiles" aria-busy={!loaded || undefined}>
      <p className="text-sm text-muted-foreground">
        A profile says which vendor and model run each pass. A new run starts from your default profile; a
        project can set its own default. Built-in profiles are read-only: duplicate one to change it.
      </p>
      {data.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          Your settings could not be read: {data.error}
        </p>
      )}
      <Group
        title="Project"
        description="Choose a project to list its own profiles and to set its default profile."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="profiles-folder" />
        <p
          role="status"
          className="min-h-4 text-xs text-muted-foreground"
          data-testid="profiles-folder-status"
        >
          {folder === null
            ? ''
            : data.projectError !== null
              ? `This project's settings could not be read: ${data.projectError}`
              : !loaded
                ? 'Reading the project…'
                : projectDefault !== null
                  ? `${projectName} starts its runs from ${projectDefault}.`
                  : `${projectName} sets no default profile: runs there start from yours.`}
        </p>
      </Group>

      {!loaded || entry === undefined || facts === null ? (
        // The last thing in the section until the files are read, so what replaces it moves nothing.
        <p className="text-sm text-muted-foreground" data-testid="profiles-detail" role="status">
          {LOADING}
        </p>
      ) : (
        <>
          <Group
            title="Profile list"
            description="Built-in, yours (every project) and the chosen project's own."
            className="min-w-0"
          >
            <div {...settingFieldProps('list')}>
              <div
                role="radiogroup"
                aria-label="Profiles"
                data-testid="profiles-list"
                className="flex flex-col overflow-clip rounded-md border"
              >
                {entries.map((e) => {
                  const active = e.name === entry?.name
                  return (
                    <label
                      key={e.name}
                      className={cn(
                        'flex min-h-8 w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset',
                        active && 'bg-accent text-accent-foreground',
                      )}
                    >
                      {/* Native radios: arrow keys move the choice, and a section switch stays quick (performance.spec.ts). */}
                      <input
                        type="radio"
                        name={listName}
                        value={e.name}
                        checked={active}
                        data-testid={`profile-item-${e.name}`}
                        onChange={() => {
                          setSelected(e.name)
                          setRenaming(null)
                        }}
                        className="size-3.5 shrink-0 accent-primary outline-none"
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{e.name}</span>
                      <ScopeChip entry={e} testId={`profile-scope-${e.name}`} />
                      {e.name === userDefault && (
                        <DefaultChip testId={`profile-default-user-${e.name}`}>Your default</DefaultChip>
                      )}
                      {e.name === projectDefault && (
                        <DefaultChip testId={`profile-default-project-${e.name}`}>
                          Project default
                        </DefaultChip>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>
          </Group>

          <section
            aria-labelledby="profile-detail-title"
            data-testid="profiles-detail"
            data-profile={entry.name}
            className="flex flex-col gap-3"
          >
            <div className="flex min-h-7 flex-wrap items-center gap-2">
              {renaming === entry.name ? (
                <RenameBox
                  initial={entry.name}
                  error={renameError}
                  busy={busy === 'rename'}
                  onEdit={() => setRenameError(null)}
                  onSave={(v) => void saveRename(v)}
                  onCancel={() => {
                    setRenaming(null)
                    setRenameError(null)
                  }}
                />
              ) : (
                <h3 id="profile-detail-title" className="text-sm font-semibold [overflow-wrap:anywhere]">
                  {entry.name}
                </h3>
              )}
              <ScopeChip entry={entry} testId="profile-detail-scope" />
            </div>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="profile-where">
              {whereText(entry, data.user?.path ?? null, data.project?.path ?? null)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Action
                testId="profile-duplicate"
                icon={<Copy aria-hidden />}
                blocked={off(null)}
                busy={busy === 'duplicate'}
                onClick={() => void duplicate('user')}
              >
                Duplicate
              </Action>
              <Action
                testId="profile-duplicate-project"
                icon={<FolderInput aria-hidden />}
                blocked={off(projectDuplicateBlocked(folder))}
                busy={busy === 'duplicate-project'}
                onClick={() => void duplicate('project')}
              >
                Duplicate into project
              </Action>
              <Action
                testId="profile-rename"
                icon={<Pencil aria-hidden />}
                blocked={off(renameBlocked(facts))}
                onClick={startRename}
              >
                Rename
              </Action>
              <Action
                testId="profile-delete"
                icon={<Trash2 aria-hidden />}
                blocked={off(deleteBlocked(facts))}
                busy={busy === 'delete'}
                onClick={() => void remove()}
              >
                Delete
              </Action>
            </div>
            <div className="flex flex-wrap items-center gap-2" {...settingFieldProps('/profile')}>
              <Action
                testId="profile-default-user"
                icon={<Star aria-hidden />}
                blocked={off(userDefaultBlocked(facts))}
                busy={busy === 'default-user'}
                onClick={() => void makeDefault('user')}
              >
                {USER_DEFAULT_LABEL}
              </Action>
              <Action
                testId="profile-default-project"
                icon={<Star aria-hidden />}
                blocked={off(projectDefaultBlocked(facts))}
                busy={busy === 'default-project'}
                onClick={() => void makeDefault('project')}
              >
                {PROJECT_DEFAULT_LABEL}
              </Action>
            </div>
            <Group
              title="Passes"
              description={
                editable
                  ? 'Each change is saved at once, with Undo.'
                  : 'Which vendor, model and mode run each pass of this profile.'
              }
            >
              <div {...settingFieldProps('/passes')}>
                <PassRowsEditor
                  name={entry.name}
                  definition={entry.scope === 'builtin' ? entry.definition : (entry.own ?? entry.definition)}
                  editable={editable}
                  config={data.resolved?.config ?? null}
                  probes={probes}
                  writing={busy}
                  onWrite={(ops, message, key) => void write(targetOf(entry), ops, message, key)}
                />
              </div>
            </Group>
            <Group
              title="Steps"
              description={
                editable
                  ? 'The optional steps this profile runs. Each change is saved at once, with Undo.'
                  : 'The optional steps this profile runs.'
              }
            >
              <div {...settingFieldProps('/steps')}>
                <StepsEditor
                  name={entry.name}
                  definition={entry.scope === 'builtin' ? entry.definition : (entry.own ?? entry.definition)}
                  editable={editable}
                  writing={busy}
                  onWrite={(ops, message, key) => void write(targetOf(entry), ops, message, key)}
                />
              </div>
            </Group>
          </section>
        </>
      )}
    </div>
  )
}

function RenameBox({
  initial,
  error,
  busy,
  onEdit,
  onSave,
  onCancel,
}: {
  initial: string
  error: string | null
  busy: boolean
  onEdit: () => void
  onSave: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input
        data-testid="profile-rename-input"
        aria-label="New profile name"
        aria-invalid={error !== null || undefined}
        aria-describedby={error !== null ? 'profile-rename-error' : undefined}
        spellCheck={false}
        value={text}
        autoFocus
        onChange={(e) => {
          setText(e.target.value)
          onEdit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave(text)
          } else if (e.key === 'Escape') onCancel()
        }}
        className="h-7 w-56 font-mono text-xs"
      />
      <Button size="sm" data-testid="profile-rename-save" loading={busy} onClick={() => onSave(text)}>
        Save name
      </Button>
      <Button size="sm" variant="ghost" data-testid="profile-rename-cancel" onClick={onCancel}>
        Cancel
      </Button>
      {error !== null && (
        <p
          id="profile-rename-error"
          data-testid="profile-rename-error"
          role="alert"
          className="w-full text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
