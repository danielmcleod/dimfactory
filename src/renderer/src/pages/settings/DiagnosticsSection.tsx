// Settings → Diagnostics (versions, paths, storage sizes, Clear snapshots, Copy diagnostics with raw lines opt-in;
// interaction rules: Clear snapshots is the one inline two-step confirm, every other change offers Undo). Versions and paths come from AppInfo (no fetch); sizes from
// storage.usage once the section has been open a moment (performance.spec.ts); the report through diagnostics.copy / .save, with
// diagnostics.build telling how many items of each kind were redacted. Clear snapshots is per folder and disabled,
// with core's reason (StorageUsage.shadows[].busy, the same check core refuses with), while a run uses that folder;
// the sizes are read again when a run's status or folder lock changes, so the reason comes and goes with the run.
//
// Nothing moves when data arrives: the sizes table has its rows from the start ("Loading…"), the report's outcome
// keeps two one-line rows (cut, with the full text as a tooltip), and the per-folder list, whose length is not known
// until core answers, is the last thing in the section.
import { ClipboardCopy, FolderOpen, Save } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DiagnosticsRequest, ShellOpenRequest, StorageUsage } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useAppInfo } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { Group, SETTINGS_TABLE } from './kit.tsx'
import { formatBytes, useLinkFocus, useSectionData } from './sectionData.ts'

export const INCLUDE_RAW_LABEL = 'Include raw log lines'
export const CLEAR_LABEL = 'Clear snapshots'
export const CONFIRM_CLEAR_LABEL = 'Confirm clear'
export const NO_SNAPSHOTS = 'No snapshots yet.'
/** Core's settings_link for Clear snapshots (heal/categories.ts): `#/settings/storage?field=/storage/shadow`. */
export const SNAPSHOTS_POINTER = '/storage/shadow'
/** Core's other link there: preflight's low-disk fix "Free space: clear old snapshots" (`?field=/storage`). */
export const STORAGE_POINTER = '/storage'
const LOADING = 'Loading…'
const NOT_KNOWN = 'Not known'

// ---- versions and paths ------------------------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 gap-2 py-0.5">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

async function open(req: ShellOpenRequest): Promise<void> {
  const r = await invoke('shell.open', req)
  if (!r.ok) toast({ level: 'error', message: r.error.message })
}

function VersionsGroup(): React.JSX.Element {
  const info = useAppInfo()
  return (
    <Group title="Versions and paths" field="versions">
      {info === null ? (
        <p className="text-xs text-muted-foreground">Not known yet.</p>
      ) : (
        <dl className="flex flex-col text-xs" data-testid="diagnostics-versions">
          <InfoRow label="Dim Factory" value={`${info.version}${info.packaged ? '' : ' (development)'}`} />
          {info.versions.electron !== null && <InfoRow label="Electron" value={info.versions.electron} />}
          {info.versions.chrome !== null && <InfoRow label="Chromium" value={info.versions.chrome} />}
          <InfoRow label="Node" value={info.versions.node} />
          <InfoRow
            label="Git"
            value={info.git !== null ? `${info.git.version} · ${info.git.path}` : 'Not found'}
          />
          <InfoRow label="Platform" value={`${info.platform} ${info.arch}`} />
          <InfoRow label="Data folder" value={info.home} />
          <InfoRow label="Logs" value={info.logsDir} />
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="diagnostics-open-home"
          icon={<FolderOpen aria-hidden />}
          onClick={() => void open({ target: 'home' })}
        >
          Open data folder
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="diagnostics-open-logs"
          icon={<FolderOpen aria-hidden />}
          onClick={() => void open({ target: 'logs' })}
        >
          Open logs folder
        </Button>
      </div>
    </Group>
  )
}

// ---- the report ----------------------------------------------------------------------------------------------------

/** What each redaction rule (shared/redact.ts) removed, in words: [one, many]. */
const REDACTION_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  pem: ['private key', 'private keys'],
  'anthropic-key': ['API key', 'API keys'],
  'openai-key': ['API key', 'API keys'],
  'google-key': ['API key', 'API keys'],
  'xai-key': ['API key', 'API keys'],
  'aws-key': ['API key', 'API keys'],
  'github-token': ['GitHub token', 'GitHub tokens'],
  'github-pat': ['GitHub token', 'GitHub tokens'],
  jwt: ['access token', 'access tokens'],
  bearer: ['access token', 'access tokens'],
  'url-credentials': ['password in a link', 'passwords in links'],
  email: ['email address', 'email addresses'],
  'secret-key': ['secret setting', 'secret settings'],
  'account-key': ['account detail', 'account details'],
  home: ['home folder path', 'home folder paths'],
  username: ['user name', 'user names'],
  hostname: ['computer name', 'computer names'],
  cwd: ['folder path', 'folder paths'],
}

/** `2 API keys · 1 email address`, most first; rules this build does not know keep their id. */
export function redactionText(counts: Readonly<Record<string, number>>): string {
  const byWords = new Map<string, { n: number; words: readonly [string, string] }>()
  for (const [id, n] of Object.entries(counts)) {
    if (!(n > 0)) continue
    const words = REDACTION_WORDS[id] ?? [`item matching "${id}"`, `items matching "${id}"`]
    const prev = byWords.get(words[0])
    byWords.set(words[0], { n: (prev?.n ?? 0) + n, words })
  }
  const parts = [...byWords.values()].sort((a, b) => b.n - a.n)
  if (parts.length === 0) return 'Nothing needed removing.'
  return `Removed first: ${parts.map((p) => `${p.n} ${p.n === 1 ? p.words[0] : p.words[1]}`).join(' · ')}.`
}

interface ReportOutcome {
  /** What happened, or null when the save dialog was closed. */
  said: string | null
  redactions: string | null
  error: boolean
}

function ReportGroup(): React.JSX.Element {
  const [includeRaw, setIncludeRaw] = useState(false)
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null)
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null)
  const rawId = useId()

  const run = async (what: 'copy' | 'save'): Promise<void> => {
    const req: DiagnosticsRequest = includeRaw ? { includeRaw: true } : {}
    setBusy(what)
    // The report the main process copies or saves is built the same way as this one, so its counts are the same.
    const [done, built] = await Promise.all([
      what === 'copy' ? invoke('diagnostics.copy', req) : invoke('diagnostics.save', req),
      invoke('diagnostics.build', req),
    ])
    setBusy(null)
    if (!done.ok) {
      setOutcome({ said: done.error.message, redactions: null, error: true })
      return
    }
    const redactions = built.ok ? redactionText(built.value.redactions) : null
    if (what === 'copy') setOutcome({ said: 'Copied to the clipboard.', redactions, error: false })
    else {
      const saved = done.value as { path: string } | null | undefined
      setOutcome(
        saved === null || saved === undefined
          ? { said: null, redactions: null, error: false }
          : { said: `Saved to ${saved.path}.`, redactions, error: false },
      )
    }
  }

  return (
    <Group
      title="Diagnostics for a bug report"
      description="Versions, settings and recent errors as text. Keys, tokens, email addresses, your user name and your home folder are removed first."
    >
      <div className="flex items-start gap-2">
        <Checkbox
          id={rawId}
          data-testid="diagnostics-include-raw"
          className="mt-0.5"
          checked={includeRaw}
          onCheckedChange={(v) => setIncludeRaw(v === true)}
        />
        <label htmlFor={rawId} className="flex flex-col gap-0.5">
          <span className="text-sm">{INCLUDE_RAW_LABEL}</span>
          <span className="text-xs text-muted-foreground">
            The vendors' own output, redacted the same way. It can quote your code and your task.
          </span>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="diagnostics-copy"
          data-setting-field="copy"
          icon={<ClipboardCopy aria-hidden />}
          loading={busy === 'copy'}
          disabled={busy !== null}
          onClick={() => void run('copy')}
        >
          Copy diagnostics
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="diagnostics-save"
          data-setting-field="save"
          icon={<Save aria-hidden />}
          loading={busy === 'save'}
          disabled={busy !== null}
          onClick={() => void run('save')}
        >
          Save diagnostics…
        </Button>
      </div>
      {/* Two one-line rows kept for the outcome (what happened, what was removed), so no answer moves what is below
          it; a line too long for its row is cut, with the whole of it as its tooltip. */}
      <div role="status" data-testid="diagnostics-outcome" className="flex h-8 min-w-0 flex-col text-xs">
        <span
          title={outcome?.said ?? undefined}
          data-testid="diagnostics-said"
          className={cn(
            'h-4 truncate leading-4',
            outcome?.error === true ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {outcome?.said ?? ''}
        </span>
        <span
          title={outcome?.redactions ?? undefined}
          data-testid="diagnostics-redactions"
          className="h-4 truncate leading-4 text-muted-foreground"
        >
          {outcome?.redactions ?? ''}
        </span>
      </div>
    </Group>
  )
}

// ---- storage ---------------------------------------------------------------------------------------------------------

type Shadow = StorageUsage['shadows'][number]

/**
 * What can change whether a folder's snapshots may be cleared: each run's status and folder lock (core republishes a
 * run's summary when its lock is released). Only a trigger to ask core again; the reason itself is core's.
 */
function useRunLockKey(): string {
  const parts = useStore(
    useShallow((s) =>
      s.summaries.order.map((id) => {
        const sum = s.summaries.byId[id]
        return sum === undefined ? id : `${id}:${sum.folderKey}:${sum.status}:${sum.lock ?? ''}`
      }),
    ),
  )
  return parts.join('|')
}

function sizeRows(u: StorageUsage | null): { what: string; size: string; testId: string }[] {
  const size = (n: number | undefined): string => (u === null || n === undefined ? LOADING : formatBytes(n))
  const snapshots = u?.shadows.reduce((sum, s) => sum + s.bytes, 0)
  return [
    { testId: 'runs', what: u === null ? 'Runs' : `Runs (${u.runs.count})`, size: size(u?.runs.bytes) },
    {
      testId: 'snapshots',
      what:
        u === null
          ? 'Snapshots'
          : `Snapshots (${u.shadows.length} ${u.shadows.length === 1 ? 'folder' : 'folders'})`,
      size: size(snapshots),
    },
    {
      testId: 'worktrees',
      what: u === null ? 'Isolated copies' : `Isolated copies (${u.worktrees.count})`,
      size: size(u?.worktrees.bytes),
    },
    { testId: 'catalog', what: 'Model catalog', size: size(u?.catalogBytes) },
    { testId: 'logs', what: 'Logs', size: size(u?.logsBytes) },
    { testId: 'total', what: 'Total', size: size(u?.totalBytes) },
    {
      testId: 'free',
      what: 'Free on this drive',
      size: u === null ? LOADING : u.freeBytes === null ? NOT_KNOWN : formatBytes(u.freeBytes),
    },
  ]
}

function ShadowRow({
  shadow,
  armed,
  clearing,
  onClear,
  onCancel,
}: {
  shadow: Shadow
  armed: boolean
  clearing: boolean
  onClear: () => void
  onCancel: () => void
}): React.JSX.Element {
  const noteId = useId()
  const reason = shadow.busy ?? ''
  const blocked = reason !== ''
  const name = shadow.path ?? `A folder Dim Factory no longer knows (${shadow.folderKey})`
  const note = blocked
    ? reason
    : armed
      ? 'Deletes these snapshots. Runs from this folder keep their diffs, but their changes can no longer be reverted.'
      : null
  return (
    <li
      data-testid={`shadow-row-${shadow.folderKey}`}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b py-2 last:border-b-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation()
          onCancel()
        }
      }}
      onBlur={(e) => {
        if (armed && !e.currentTarget.contains(e.relatedTarget)) onCancel()
      }}
    >
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span
          className={cn('text-xs break-all', shadow.path !== null && 'font-mono')}
          data-testid={`shadow-path-${shadow.folderKey}`}
        >
          {name}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(shadow.bytes)}</span>
        {note !== null && (
          <span
            id={noteId}
            data-testid={`shadow-note-${shadow.folderKey}`}
            className={cn('text-xs', armed && !blocked ? 'text-destructive' : 'text-muted-foreground')}
          >
            {note}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant={armed ? 'destructive' : 'outline'}
          data-testid={`shadow-clear-${shadow.folderKey}`}
          labels={[CLEAR_LABEL, CONFIRM_CLEAR_LABEL]}
          disabled={blocked || clearing}
          aria-busy={clearing || undefined}
          aria-describedby={note !== null ? noteId : undefined}
          onClick={onClear}
        >
          {armed ? CONFIRM_CLEAR_LABEL : CLEAR_LABEL}
        </Button>
        {/* Kept in place while hidden, so arming the clear moves nothing in the row. */}
        <Button
          size="sm"
          variant="ghost"
          data-testid={`shadow-cancel-${shadow.folderKey}`}
          className={cn(!armed && 'invisible')}
          disabled={!armed || clearing}
          aria-hidden={!armed || undefined}
          tabIndex={armed ? undefined : -1}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </li>
  )
}

function StorageGroup(): React.JSX.Element {
  const usage = useSectionData<StorageUsage>('storage', () => invoke('storage.usage'), useRunLockKey())
  const [armed, setArmed] = useState<string | null>(null)
  const [clearing, setClearing] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const u = usage.value

  useLinkFocus(
    (f) => f === SNAPSHOTS_POINTER || f === STORAGE_POINTER,
    () => (u !== null ? listRef.current : null),
    u !== null,
  )

  const clear = useCallback(
    async (s: Shadow): Promise<void> => {
      if (armed !== s.folderKey) {
        setArmed(s.folderKey)
        return
      }
      setClearing(s.folderKey)
      const r = await invoke('storage.clearShadow', { folderKey: s.folderKey })
      setClearing(null)
      setArmed(null)
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      usage.set(r.value)
      // The row may be gone now: focus stays in the list, never lost to the page.
      listRef.current?.focus({ preventScroll: true })
      toast({
        level: 'info',
        message: `Cleared the snapshots of ${s.path ?? 'a folder Dim Factory no longer knows'} (${formatBytes(s.bytes)}).`,
      })
    },
    [armed, usage],
  )

  return (
    <Group
      title="Storage"
      description="What Dim Factory keeps in its data folder."
      field="storage"
      testId="diagnostics-storage"
    >
      <div className={SETTINGS_TABLE.frame}>
        <table aria-label="Storage use" data-testid="storage-table" className={SETTINGS_TABLE.table}>
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                What
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'w-1/3 font-medium')}>
                Size
              </th>
            </tr>
          </thead>
          <tbody>
            {sizeRows(u).map((row) => (
              <tr key={row.testId} className="border-t">
                <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
                  {row.what}
                </th>
                <td
                  data-testid={`storage-size-${row.testId}`}
                  className={cn(SETTINGS_TABLE.cell, 'tabular-nums', u === null && 'text-muted-foreground')}
                >
                  {row.size}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Kept as a line, so an error later moves nothing. */}
      <p role="status" data-testid="storage-error" className="min-h-4 text-xs text-destructive">
        {usage.error !== null ? `The sizes could not be read: ${usage.error}` : ''}
      </p>
      <div
        ref={listRef}
        tabIndex={-1}
        data-setting-field="clearSnapshots"
        data-testid="storage-shadows"
        aria-labelledby="storage-snapshots-title"
        className="flex flex-col gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <h4 id="storage-snapshots-title" className="text-sm font-medium">
          Snapshots by folder
        </h4>
        <p className="text-xs text-muted-foreground">
          Dim Factory snapshots a folder before and after each pass, to show a run's changes and revert them.
        </p>
        {u === null ? (
          <p className="py-2 text-xs text-muted-foreground">{usage.error !== null ? NOT_KNOWN : LOADING}</p>
        ) : u.shadows.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{NO_SNAPSHOTS}</p>
        ) : (
          <ul aria-label="Snapshots by folder" className="flex flex-col">
            {u.shadows.map((s) => (
              <ShadowRow
                key={s.folderKey}
                shadow={s}
                armed={armed === s.folderKey}
                clearing={clearing === s.folderKey}
                onClear={() => void clear(s)}
                onCancel={() => setArmed((a) => (a === s.folderKey ? null : a))}
              />
            ))}
          </ul>
        )}
      </div>
    </Group>
  )
}

export function DiagnosticsSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="settings-diagnostics">
      <VersionsGroup />
      <ReportGroup />
      <StorageGroup />
    </div>
  )
}
