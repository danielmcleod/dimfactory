// Settings → General (default profile, timeouts, ask.denyPauses, close-to-tray, storage retention; built-in
// defaults, semantic rules and provenance). Values are core's: config.resolve without a
// folder (the built-in defaults and your settings), read once the section has been open for LOAD_DELAY_MS and again on
// every config change. Each control writes your dimfactory.json with config.patch and offers Undo (writeConfig). A value
// the schema would refuse (a bound, or a stall limit not shorter than the hard stop) is named next to its field and
// nothing is written. Each value shows where it comes from; with a project chosen (`?folder=` deep link, or the
// folder line), config.resolve for that folder says which of them the project overrides, and with what.
import { useCallback, useEffect, useId, useState } from 'react'
import type { Provenance, ResolvedConfig, Timeouts } from '@shared/config-schema.ts'
import type { Platform, ResolvedWithProvenance } from '@shared/ipc.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useAppInfo, useConfigEpoch } from '../../state/selectors.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { writeConfig } from './general/configWrite.ts'
import { GeneralRow, NumberField, PickerPlaceholder } from './general/controls.tsx'
import { formatMinutes, minutesText, parseCount, parseMinutes, timeoutOrderError } from './general/limits.ts'
import type { StorageKey, TimeoutKey } from './general/limits.ts'
import { LOAD_DELAY_MS, ProjectFolder } from './general/ProjectFolder.tsx'
import { SourceBadge, valueSource } from './general/SourceBadge.tsx'
import { Group } from './kit.tsx'
import { ExperienceSwitch } from '../../components/shell/ExperienceSwitch.tsx'
import { EXPERIENCE_ROW_NOTE, SWITCH_GROUP_LABEL } from '../easy/text.ts'

const UNDO_TOAST = 'general-undo'
/** A switch's place while the values load (drawn like ui/Switch, off): the Radix switch mounts with its value. */
const SWITCH_PLACEHOLDER = 'inline-flex h-5 w-9 shrink-0 rounded-full bg-input opacity-50'

export const DENY_PAUSES_LABEL = 'A denied request pauses the run'
export const CLOSE_LABEL = 'Closing the window'

type CloseChoice = 'auto' | 'tray' | 'quit'
type CloseToTray = ResolvedConfig['ui']['closeToTray']

const closeChoice = (v: CloseToTray): CloseChoice => (v === 'auto' ? 'auto' : v ? 'tray' : 'quit')
const closeValue = (c: CloseChoice): CloseToTray => (c === 'auto' ? 'auto' : c === 'tray')

/** What closing the window does, per choice, on this platform (main's decideClose). */
export function closeLabel(c: CloseChoice, platform: Platform): string {
  switch (c) {
    case 'auto':
      return platform === 'linux' ? 'Automatic: minimize the window' : 'Automatic: keep running in the tray'
    case 'tray':
      return 'Keep running in the tray'
    case 'quit':
      return platform === 'darwin' ? 'Close the window (the app stays open)' : 'Quit Dim Factory'
  }
}

export const TIMEOUT_ROWS: readonly {
  key: TimeoutKey
  label: string
  control: string
  description: string
}[] = [
  {
    key: 'stallMs',
    label: 'Warn when a pass is silent for',
    control: 'Stall warning',
    description: 'The pass shows a card where you choose to keep waiting or stop it.',
  },
  {
    key: 'hardKillMs',
    label: 'Stop a pass that is silent for',
    control: 'Hard stop',
    description: 'Longer than the stall warning and the tool limit.',
  },
  {
    key: 'toolStallMs',
    label: 'Allow a running tool to be silent for',
    control: 'Tool stall',
    description: 'While the vendor runs a tool, such as a build or the tests.',
  },
  {
    key: 'askMs',
    label: 'Wait for an answer to a request for',
    control: 'Request timeout',
    description: 'Then the pass pauses until you answer.',
  },
]

export const STORAGE_ROWS: readonly {
  key: StorageKey
  label: string
  control: string
  suffix: string
  description: string
}[] = [
  {
    key: 'keepRuns',
    label: 'Keep at most',
    control: 'Runs kept',
    suffix: 'runs',
    description: 'The newest runs are kept, up to this many.',
  },
  {
    key: 'keepDays',
    label: 'Remove runs older than',
    control: 'Days kept',
    suffix: 'days',
    description: 'Only runs beyond the newest ones kept above.',
  },
  {
    key: 'rawLogDays',
    label: 'Keep raw vendor logs for',
    control: 'Raw log days',
    suffix: 'days',
    description: 'The vendor output exactly as received, for bug reports.',
  },
]

/** config.resolve (the user layer without a folder, or a project's view with one); null until it answers. */
function useResolvedView(
  folder: string | null,
  enabled: boolean,
): {
  view: ResolvedWithProvenance | null
  error: string | null
  setView: (v: ResolvedWithProvenance) => void
  reload: () => void
} {
  const epoch = useConfigEpoch()
  const [state, setState] = useState<{
    folder: string | null
    view: ResolvedWithProvenance | null
    error: string | null
  }>({ folder, view: null, error: null })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const t = setTimeout(() => {
      void invoke('config.resolve', folder !== null ? { folder } : {}).then((r) => {
        if (!alive) return
        setState(
          r.ok ? { folder, view: r.value, error: null } : { folder, view: null, error: r.error.message },
        )
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [folder, enabled, epoch, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setView = useCallback((v: ResolvedWithProvenance) => setState((s) => ({ ...s, view: v })), [])
  // A view read for another folder is not this folder's.
  const mine = enabled && state.folder === folder
  return { view: mine ? state.view : null, error: mine ? state.error : null, setView, reload }
}

/** The deep link's key: the section remounts with the link's folder when another link opens it. */
function linkKey(route: Route): string {
  if (route.name !== 'settings') return ''
  return `${route.subpath.join('/')}?${new URLSearchParams(route.query).toString()}`
}

export function GeneralSection(): React.JSX.Element {
  const route = useRoute()
  const folder = route.name === 'settings' ? (route.query['folder'] ?? null) : null
  return <GeneralBody key={linkKey(route)} initialFolder={folder !== '' ? folder : null} />
}

function GeneralBody({ initialFolder }: { initialFolder: string | null }): React.JSX.Element {
  const info = useAppInfo()
  const platform = info?.platform ?? 'win32'
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const user = useResolvedView(null, true)
  const project = useResolvedView(folder, folder !== null)
  const [writing, setWriting] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const errorBase = useId()

  const config = user.view?.config ?? null
  const off = config === null
  const reloadAll = (): void => {
    user.reload()
    project.reload()
  }
  const setError = (ptr: string, message: string | null): void =>
    setErrors((cur) => {
      if (message === null) {
        if (cur[ptr] === undefined) return cur
        const { [ptr]: _gone, ...rest } = cur
        return rest
      }
      return { ...cur, [ptr]: message }
    })

  /** Where the value at `ptr` comes from: the chosen project's view when there is one. */
  const provenance = (ptr: string): Provenance | undefined => (project.view ?? user.view)?.provenance[ptr]

  /** "<project> sets this to …": only when the chosen project overrides the value. */
  const overrideNote = (ptr: string, text: (c: ResolvedConfig) => string): string | null => {
    if (folder === null) return null
    if (project.error !== null) return null
    const p = project.view
    if (p === null || valueSource(p.provenance[ptr]) !== 'project') return null
    return `${folderBaseName(folder)} sets this to ${text(p.config)}, so runs there use that.`
  }

  const write = async (
    ptr: string,
    value: unknown,
    message: string,
    apply: (c: ResolvedConfig) => ResolvedConfig,
  ): Promise<boolean> => {
    const before = user.view
    if (before === null) return false
    user.setView({ ...before, config: apply(before.config) })
    setWriting(ptr)
    const res = await writeConfig({
      target: { scope: 'user' },
      ops: [{ op: 'replace', path: ptr, value }],
      message,
      toastId: UNDO_TOAST,
      onSettled: reloadAll,
    })
    setWriting(null)
    if (res === null) user.setView(before)
    return res !== null
  }

  const commitTimeout = async (key: TimeoutKey, label: string, text: string): Promise<boolean> => {
    const ptr = `/timeouts/${key}`
    if (config === null) return false
    const parsed = parseMinutes(text, key)
    if (!parsed.ok) {
      setError(ptr, parsed.message)
      return false
    }
    const next: Timeouts = { ...config.timeouts, [key]: parsed.value }
    const order = timeoutOrderError(key, next)
    if (order !== null) {
      setError(ptr, order)
      return false
    }
    setError(ptr, null)
    return write(ptr, parsed.value, `${label}: ${minutesText(parsed.value)}`, (c) => ({
      ...c,
      timeouts: next,
    }))
  }

  const commitStorage = async (key: StorageKey, label: string, text: string): Promise<boolean> => {
    const ptr = `/storage/${key}`
    if (config === null) return false
    const parsed = parseCount(text, key)
    if (!parsed.ok) {
      setError(ptr, parsed.message)
      return false
    }
    setError(ptr, null)
    return write(ptr, parsed.value, `${label}: ${parsed.value}`, (c) => ({
      ...c,
      storage: { ...c.storage, [key]: parsed.value },
    }))
  }

  const profiles = user.view?.profiles ?? (config !== null ? [config.profile] : [])
  const profileOptions =
    config !== null && !profiles.includes(config.profile) ? [config.profile, ...profiles] : profiles

  return (
    <div className="flex flex-col gap-6" data-testid="settings-general" aria-busy={off || undefined}>
      <p className="text-sm text-muted-foreground">
        How runs behave and how long Dim Factory keeps them. These are your settings, used in every project; a
        project can override the run settings in its own dimfactory.json.
      </p>
      {user.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          Your settings could not be read: {user.error}
        </p>
      )}
      <Group
        title="Check a project"
        description="Choose a project to see which of these settings it overrides. Changes here are always saved to your settings."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="general-folder" />
        <p
          role="status"
          data-testid="general-folder-status"
          className="min-h-4 text-xs text-muted-foreground"
        >
          {folder === null
            ? ''
            : project.error !== null
              ? `This project's settings could not be read: ${project.error}`
              : project.view === null
                ? 'Reading the project…'
                : projectSummary(project.view, folderBaseName(folder))}
        </p>
      </Group>

      <Group title="Runs">
        <div>
          <GeneralRow
            field="/profile"
            label="Default profile"
            description="The profile a new run starts from."
            note={overrideNote('/profile', (c) => c.profile)}
          >
            {config === null ? (
              <PickerPlaceholder testId="general-profile" label="Default profile" className="w-44" />
            ) : (
              <Select
                value={config.profile}
                disabled={writing === '/profile'}
                onValueChange={(v) => {
                  if (v === config.profile) return
                  void write('/profile', v, `Default profile: ${v}`, (c) => ({ ...c, profile: v }))
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-44 max-w-full"
                  data-testid="general-profile"
                  aria-label="Default profile"
                  title={config.profile}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profileOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <SourceBadge loading={off} provenance={provenance('/profile')} testId="general-source-/profile" />
          </GeneralRow>
          <GeneralRow
            field="/ask/denyPauses"
            label={DENY_PAUSES_LABEL}
            description="Otherwise the vendor is told no and the pass carries on."
            note={overrideNote('/ask/denyPauses', (c) => (c.ask.denyPauses ? 'on' : 'off'))}
          >
            {config === null ? (
              <span aria-hidden className={SWITCH_PLACEHOLDER} />
            ) : (
              <Switch
                data-testid="general-deny-pauses"
                aria-label={DENY_PAUSES_LABEL}
                checked={config.ask.denyPauses}
                disabled={writing === '/ask/denyPauses'}
                onCheckedChange={(v) =>
                  void write('/ask/denyPauses', v, `${DENY_PAUSES_LABEL}: ${v ? 'on' : 'off'}`, (c) => ({
                    ...c,
                    ask: { denyPauses: v },
                  }))
                }
              />
            )}
            <SourceBadge
              loading={off}
              provenance={provenance('/ask/denyPauses')}
              testId="general-source-/ask/denyPauses"
            />
          </GeneralRow>
          <GeneralRow
            field="/ui/closeToTray"
            label={CLOSE_LABEL}
            description="Your settings only: a project cannot change it."
          >
            {config === null ? (
              <PickerPlaceholder testId="general-close" label={CLOSE_LABEL} className="w-64" />
            ) : (
              <Select
                value={closeChoice(config.ui.closeToTray)}
                disabled={writing === '/ui/closeToTray'}
                onValueChange={(v) => {
                  const c = v as CloseChoice
                  if (c === closeChoice(config.ui.closeToTray)) return
                  void write(
                    '/ui/closeToTray',
                    closeValue(c),
                    `${CLOSE_LABEL}: ${closeLabel(c, platform)}`,
                    (cur) => ({ ...cur, ui: { ...cur.ui, closeToTray: closeValue(c) } }),
                  )
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-64 max-w-full"
                  data-testid="general-close"
                  aria-label={CLOSE_LABEL}
                  // The whole choice where a wide font or the zoom cuts it.
                  title={closeLabel(closeChoice(config.ui.closeToTray), platform)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['auto', 'tray', 'quit'] as const).map((c) => (
                    <SelectItem key={c} value={c}>
                      {closeLabel(c, platform)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <SourceBadge
              loading={off}
              provenance={provenance('/ui/closeToTray')}
              testId="general-source-/ui/closeToTray"
            />
          </GeneralRow>
          <GeneralRow field="/ui/experience" label={SWITCH_GROUP_LABEL} description={EXPERIENCE_ROW_NOTE}>
            <div className="w-48">
              <ExperienceSwitch />
            </div>
          </GeneralRow>
        </div>
      </Group>

      <Group
        title="Timeouts"
        description="Counted from the last output, never from the start of a pass. In minutes."
      >
        <div>
          {TIMEOUT_ROWS.map((row) => {
            const ptr = `/timeouts/${row.key}`
            const errorId = `${errorBase}-${row.key}`
            return (
              <GeneralRow
                key={row.key}
                field={ptr}
                label={row.label}
                description={row.description}
                note={overrideNote(ptr, (c) => minutesText(c.timeouts[row.key]))}
                error={errors[ptr] ?? null}
                errorId={errorId}
              >
                <NumberField
                  testId={`general-timeout-${row.key}`}
                  label={row.control}
                  suffix="min"
                  value={config !== null ? formatMinutes(config.timeouts[row.key]) : null}
                  disabled={writing === ptr}
                  invalid={errors[ptr] !== undefined}
                  errorId={errorId}
                  onEdit={() => setError(ptr, null)}
                  onCommit={(text) => commitTimeout(row.key, row.control, text)}
                />
                <SourceBadge loading={off} provenance={provenance(ptr)} testId={`general-source-${ptr}`} />
              </GeneralRow>
            )
          })}
        </div>
      </Group>

      <Group
        title="Run history"
        description="Your settings only. Removing old runs arrives in a later version; these limits are saved for it."
      >
        <div>
          {STORAGE_ROWS.map((row) => {
            const ptr = `/storage/${row.key}`
            const errorId = `${errorBase}-${row.key}`
            return (
              <GeneralRow
                key={row.key}
                field={ptr}
                label={row.label}
                description={row.description}
                error={errors[ptr] ?? null}
                errorId={errorId}
              >
                <NumberField
                  testId={`general-storage-${row.key}`}
                  label={row.control}
                  suffix={row.suffix}
                  value={config !== null ? String(config.storage[row.key]) : null}
                  disabled={writing === ptr}
                  invalid={errors[ptr] !== undefined}
                  errorId={errorId}
                  onEdit={() => setError(ptr, null)}
                  onCommit={(text) => commitStorage(row.key, row.control, text)}
                />
                <SourceBadge loading={off} provenance={provenance(ptr)} testId={`general-source-${ptr}`} />
              </GeneralRow>
            )
          })}
        </div>
      </Group>
    </div>
  )
}

const PROJECT_POINTERS = [
  '/profile',
  '/ask/denyPauses',
  '/timeouts/stallMs',
  '/timeouts/hardKillMs',
  '/timeouts/toolStallMs',
  '/timeouts/askMs',
] as const

/** "<project> overrides 2 of these settings (marked Project)." or "… uses your settings for all of these." */
export function projectSummary(view: ResolvedWithProvenance, name: string): string {
  const n = PROJECT_POINTERS.filter((p) => valueSource(view.provenance[p]) === 'project').length
  if (n === 0) return `${name} uses your settings for all of these.`
  return `${name} overrides ${n === 1 ? '1 of these settings' : `${n} of these settings`} (marked Project).`
}
