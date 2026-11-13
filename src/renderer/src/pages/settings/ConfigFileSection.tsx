// Settings → Config file (a read-only view with error markers, and Restore last good; errors report file:line:col
// with a "did you mean"; Restore last good puts back the
// last copy Dim Factory loaded without errors, else the newest backup that loads). The user's dimfactory.json, or a
// project's (`<folder>/.dimfactory/dimfactory.json`) once a folder is chosen, exactly as Dim Factory reads it
// (config.read): read-only, monospace, numbered lines, each problem marked on its line with its message and listed
// above the file as `file:line:col` (a click there brings the line into view). Restore last good offers Undo (core's
// backup of the text it replaced); "Open in editor" opens the file with the system's editor (shell.open).
//
// The file is read once the section has been open a moment (performance.spec.ts), and again after any config change; the last answer
// stays on screen meanwhile. The file view is the last thing in the section, so its length never moves anything.
// Deep links: core's config_invalid fixes (`?field=<pointer of the problem>` and `?field=/backups/last-good`); a link
// about a project's file also names it (`&folder=<folder>`), and the section opens that project's file.
import { AlertTriangle, CircleX, FileText, History } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { ConfigScope } from '@shared/config-schema.ts'
import type { ConfigIssue, ConfigReadResult, ConfigWriteResult, Result } from '@shared/ipc.ts'
import { useMainScroller } from '../../components/shell/mainScroll.ts'
import { jumpTo } from '../../components/run/follow.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { Group, LaterHint, TILE_CLASS } from './kit.tsx'
import { useLinkFocus, useSectionData } from './sectionData.ts'

/** Core's settings_link to Restore last good (heal/categories.ts config_invalid). */
export const LAST_GOOD_POINTER = '/backups/last-good'
export const RESTORE_LABEL = 'Restore the last good copy'
export const OPEN_LABEL = 'Open in editor'
const UNDO_TOAST = 'config-file-restore'
const NO_COPY = 'No earlier copy of this file is saved yet'
const NO_FILE = 'The file does not exist yet'

/** `C:\home\dimfactory.json:3:5`, as core and the CLI write a problem's place. */
export function issueLocation(i: Pick<ConfigIssue, 'file' | 'line' | 'col'>): string {
  return `${i.file}:${i.line}:${i.col}`
}

/** The file's lines as Dim Factory read them (a final line break makes no extra empty line). */
export function fileLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** The [start, end) character ranges an issue marks on line `n` (1-based), merged; an empty range marks one place. */
export function markedRanges(issues: readonly ConfigIssue[], n: number, length: number): [number, number][] {
  const ranges: [number, number][] = []
  for (const i of issues) {
    if (i.line !== n) continue
    const start = Math.min(Math.max(0, i.col - 1), length)
    const end = i.endLine === i.line ? Math.min(Math.max(start, i.endCol - 1), length) : length
    ranges.push([start, end > start ? end : Math.min(start + 1, Math.max(length, start + 1))])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of ranges) {
    const last = out.at(-1)
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

function countText(issues: readonly ConfigIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  return parts.join(' · ')
}

// ---- the file view ---------------------------------------------------------------------------------------------------

function LineText({ text, ranges, warn }: { text: string; ranges: [number, number][]; warn: boolean }) {
  if (ranges.length === 0) return <>{text === '' ? ' ' : text}</>
  const out: React.ReactNode[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s > at) out.push(text.slice(at, s))
    out.push(
      <mark
        key={s}
        data-issue-mark=""
        className={cn(
          'rounded-sm bg-transparent text-inherit underline decoration-wavy decoration-2 underline-offset-4',
          warn ? 'decoration-warning' : 'decoration-destructive',
        )}
      >
        {/* A problem at the end of a line (a missing value) marks the place itself. */}
        {s < text.length ? text.slice(s, e) : ' '}
      </mark>,
    )
    at = e
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function FileView({
  file,
  lineIdPrefix,
}: {
  file: ConfigReadResult
  lineIdPrefix: string
}): React.JSX.Element {
  const lines = fileLines(file.text)
  const gutter = `${String(lines.length).length + 1}ch`
  const byLine = new Map<number, ConfigIssue[]>()
  for (const i of file.issues) byLine.set(i.line, [...(byLine.get(i.line) ?? []), i])
  // A problem past the last line (the file ends too early) is shown on the last line.
  for (const [n, list] of [...byLine]) {
    if (n > lines.length && lines.length > 0) {
      byLine.delete(n)
      byLine.set(lines.length, [...(byLine.get(lines.length) ?? []), ...list])
    }
  }
  return (
    <ol
      aria-label={`${file.path} as Dim Factory reads it`}
      data-testid="config-file-lines"
      style={{ '--gutter': gutter } as React.CSSProperties}
      className="flex flex-col rounded-md border bg-muted/40 py-2 font-mono text-xs leading-5"
    >
      {lines.map((text, idx) => {
        const n = idx + 1
        const issues = byLine.get(n) ?? []
        const hasError = issues.some((i) => i.severity === 'error')
        return (
          <li
            key={n}
            id={`${lineIdPrefix}-${n}`}
            tabIndex={issues.length > 0 ? -1 : undefined}
            data-testid={`config-line-${n}`}
            data-issue={issues.length > 0 ? (hasError ? 'error' : 'warning') : undefined}
            className={cn(
              'grid scroll-mt-4 grid-cols-[var(--gutter)_minmax(0,1fr)] gap-x-3 border-l-2 pr-3 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              issues.length === 0
                ? 'border-transparent'
                : hasError
                  ? 'border-destructive bg-destructive/5'
                  : 'border-warning bg-warning/5',
            )}
          >
            <span aria-hidden className="text-right text-muted-foreground select-none">
              {n}
            </span>
            <code className="whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]">
              <LineText
                text={text}
                ranges={markedRanges(issues, n, text.length)}
                warn={issues.length > 0 && !hasError}
              />
            </code>
            {issues.map((i, k) => (
              <span
                key={k}
                role="note"
                data-testid={`config-line-issue-${n}`}
                className={cn(
                  'col-start-2 flex items-start gap-1.5 py-0.5 font-sans',
                  i.severity === 'error' ? 'text-destructive' : 'text-warning',
                )}
              >
                {i.severity === 'error' ? (
                  <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span className="[overflow-wrap:anywhere]">
                  Column {i.col}: {i.message}
                </span>
              </span>
            ))}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * What the problems mean for runs (an invalid user file blocks runs, an invalid project file blocks that
 * folder only; warnings block nothing).
 */
export function issueSummary(issues: readonly ConfigIssue[], projectScope: boolean): string {
  const blocking = issues.some((i) => i.severity === 'error')
  const effect = !blocking
    ? 'Runs are not blocked.'
    : projectScope
      ? 'Runs in this folder are blocked until they are fixed.'
      : 'Runs are blocked until they are fixed.'
  return `${countText(issues)}. ${effect}`
}

function IssueList({
  issues,
  lineIdPrefix,
  projectScope,
  field,
  ready,
}: {
  issues: readonly ConfigIssue[]
  lineIdPrefix: string
  projectScope: boolean
  /** The deep link's field, when it names a problem's pointer (core's config_invalid fix). */
  field: string | null
  ready: unknown
}): React.JSX.Element {
  const blocking = issues.some((i) => i.severity === 'error')
  const main = useMainScroller()
  const listRef = useRef<HTMLUListElement>(null)
  // A link to a problem's pointer focuses that problem's entry, else the first one.
  useLinkFocus(
    () => field !== null,
    () => {
      const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-pointer]') ?? [])]
      return items.find((b) => b.dataset['pointer'] === field) ?? items[0] ?? null
    },
    ready,
  )
  return (
    <div className="flex flex-col gap-1.5" data-testid="config-issues">
      <p className={cn('text-sm font-medium', blocking ? 'text-destructive' : 'text-warning')}>
        {issueSummary(issues, projectScope)}
      </p>
      <ul ref={listRef} className="flex flex-col gap-1">
        {issues.map((i, k) => (
          <li key={k}>
            <button
              type="button"
              data-pointer={i.pointer}
              data-testid="config-issue"
              className="flex w-full items-start gap-1.5 rounded-sm text-left text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                const line = document.getElementById(`${lineIdPrefix}-${i.line}`)
                if (line !== null) jumpTo(main, line, 16)
              }}
            >
              {i.severity === 'error' ? (
                <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
              )}
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-mono">{issueLocation(i)}</span> {i.message}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- the section --------------------------------------------------------------------------------------------------

type Target = { scope: 'user' } | { scope: 'project'; folder: string }

function targetReq(t: Target): { scope: ConfigScope; folder?: string } {
  return t.scope === 'user' ? { scope: 'user' } : { scope: 'project', folder: t.folder }
}

/** A deep link's field that names a problem: core's config_invalid fix links to the problem's JSON pointer. */
function issueField(route: Route): string | null {
  const field = route.name === 'settings' ? route.query['field'] : undefined
  return field !== undefined && field.startsWith('/') && field !== LAST_GOOD_POINTER ? field : null
}

const NOT_CHOSEN: Result<ConfigReadResult> = {
  ok: false,
  error: { code: 'VALIDATION', message: 'Choose a folder first.' },
}

/** The project a deep link names (`?folder=`), or null for the user's file. */
export function linkedFolder(route: Route): string | null {
  const folder = route.name === 'settings' ? (route.query['folder'] ?? '') : ''
  return folder !== '' ? folder : null
}

export function ConfigFileSection(): React.JSX.Element {
  const route = useRoute()
  const initial = linkedFolder(route)
  // A link to another project's file starts the section again on that file.
  return <ConfigFileBody key={initial ?? ''} initialFolder={initial} />
}

function ConfigFileBody({ initialFolder }: { initialFolder: string | null }): React.JSX.Element {
  const epoch = useConfigEpoch()
  const route = useRoute()
  const [scope, setScope] = useState<ConfigScope>(initialFolder !== null ? 'project' : 'user')
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const [restoring, setRestoring] = useState(false)
  const restoreRef = useRef<HTMLButtonElement>(null)
  const lineIdPrefix = `config-line${useId().replace(/[^A-Za-z0-9_-]/g, '')}`

  const target: Target | null =
    scope === 'user' ? { scope: 'user' } : folder !== null ? { scope: 'project', folder } : null
  const key = target === null ? null : target.scope === 'user' ? 'user' : `project:${target.folder}`
  const file = useSectionData<ConfigReadResult>(
    key,
    () => (target === null ? Promise.resolve(NOT_CHOSEN) : invoke('config.read', targetReq(target))),
    epoch,
  )
  const f = file.value

  // core's "Restore last good config" link: the button once it can be used, else its reason (the hint around it).
  useLinkFocus(
    (field) => field === LAST_GOOD_POINTER,
    () => {
      const b = restoreRef.current
      if (b === null || f === null) return null
      return b.disabled ? (b.closest<HTMLElement>('[data-disabled-hint]') ?? b) : b
    },
    f,
  )

  const restorable = f !== null && (f.restorable ?? f.backups.length > 0)
  const restoreReason = f === null ? null : !f.exists && !restorable ? NO_FILE : !restorable ? NO_COPY : null

  const undo = async (t: Target, res: ConfigWriteResult): Promise<void> => {
    if (res.backupId === null) return
    const r = await invoke('config.restoreBackup', { ...targetReq(t), backupId: res.backupId })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    file.reload()
  }

  const restore = async (): Promise<void> => {
    if (target === null) return
    const t = target
    setRestoring(true)
    const r = await invoke('config.restoreBackup', { ...targetReq(t), backupId: 'last-good' })
    setRestoring(false)
    file.reload()
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    const res = r.value
    if (!res.changed) {
      toast({ id: UNDO_TOAST, level: 'info', message: 'This file already matches the last good copy.' })
      return
    }
    toast({
      id: UNDO_TOAST,
      level: 'info',
      message: 'Restored the last good copy of dimfactory.json.',
      ...(res.backupId !== null ? { action: { label: 'Undo', onClick: () => undo(t, res) } } : {}),
    })
  }

  const openInEditor = async (): Promise<void> => {
    if (target === null) return
    const r = await invoke(
      'shell.open',
      target.scope === 'user'
        ? { target: 'configFile', scope: 'user' }
        : { target: 'configFile', scope: 'project', folder: target.folder },
    )
    if (!r.ok) toast({ level: 'error', message: r.error.message })
  }

  const restoreButton = (
    <Button
      ref={restoreRef}
      size="sm"
      variant={f !== null && f.issues.some((i) => i.severity === 'error') ? 'default' : 'outline'}
      data-testid="config-restore"
      data-setting-field="restore"
      icon={<History aria-hidden />}
      loading={restoring}
      disabled={f === null || restoreReason !== null}
      onClick={() => void restore()}
    >
      {RESTORE_LABEL}
    </Button>
  )
  const openButton = (
    <Button
      size="sm"
      variant="outline"
      data-testid="config-open"
      icon={<FileText aria-hidden />}
      disabled={f === null || !f.exists}
      onClick={() => void openInEditor()}
    >
      {OPEN_LABEL}
    </Button>
  )

  return (
    <div className="flex flex-col gap-6" data-testid="settings-config">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">File</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['user', 'Your settings'],
              ['project', "A project's settings"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={TILE_CLASS} data-testid={`config-scope-${value}`}>
              <input
                type="radio"
                name="config-scope"
                value={value}
                className="sr-only"
                checked={scope === value}
                onChange={() => setScope(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {scope === 'user'
            ? 'dimfactory.json in your Dim Factory data folder: your defaults for every folder.'
            : '.dimfactory/dimfactory.json in a project: it overrides your settings for that folder.'}
        </p>
      </fieldset>

      {scope === 'project' && (
        <ProjectFolder folder={folder} onChange={setFolder} testId="config-project" label="Folder" />
      )}

      <Group
        title="dimfactory.json"
        description="As Dim Factory reads it. Read-only here: edit it in your editor, and this view follows."
        field="file"
        testId="config-file"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {f !== null && f.exists === false ? (
              <LaterHint reason={NO_FILE}>{openButton}</LaterHint>
            ) : (
              openButton
            )}
            {restoreReason !== null ? (
              <LaterHint reason={restoreReason}>{restoreButton}</LaterHint>
            ) : (
              restoreButton
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Dim Factory keeps the last copy it read without errors, and a backup before each change it makes.
            Restoring keeps a backup of the file as it is now, so you can undo it.
          </p>
        </div>
        {/* The path sits right above the file: a long one that wraps when it arrives moves nothing already shown. */}
        <p data-testid="config-path" className="min-h-4 font-mono text-xs break-all text-muted-foreground">
          {target === null
            ? 'Choose a folder to see its project file.'
            : f !== null
              ? f.path
              : file.error !== null
                ? 'Not known'
                : 'Loading…'}
        </p>
        {target !== null && (
          <FileBody
            file={f}
            error={file.error}
            lineIdPrefix={lineIdPrefix}
            projectScope={scope === 'project'}
            field={issueField(route)}
          />
        )}
      </Group>
    </div>
  )
}

function FileBody({
  file,
  error,
  lineIdPrefix,
  projectScope,
  field,
}: {
  file: ConfigReadResult | null
  error: string | null
  lineIdPrefix: string
  projectScope: boolean
  field: string | null
}): React.JSX.Element | null {
  if (file === null) {
    // While it loads, the path line above says so.
    if (error === null) return null
    return (
      <p data-testid="config-file-state" className="text-xs text-destructive">
        The file could not be read: {error}
      </p>
    )
  }
  if (!file.exists) {
    return (
      <p data-testid="config-file-state" className="text-xs text-muted-foreground">
        {projectScope
          ? 'This folder has no project file. Your settings apply to it as they are.'
          : 'You have no dimfactory.json yet. Dim Factory uses its built-in settings until you change one.'}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {file.issues.length > 0 && (
        <IssueList
          issues={file.issues}
          lineIdPrefix={lineIdPrefix}
          projectScope={projectScope}
          field={field}
          ready={file}
        />
      )}
      {file.text === '' ? (
        <p data-testid="config-file-state" className="text-xs text-muted-foreground">
          The file is empty.
        </p>
      ) : (
        <FileView file={file} lineIdPrefix={lineIdPrefix} />
      )}
    </div>
  )
}
