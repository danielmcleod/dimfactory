// The composer's folder line: the editable path, "Choose folder…", "New project…" (opens the New project dialog; it
// is always there, so it shifts nothing), recent
// folder chips (core's folders.recent; the runs the store holds when that is unavailable), the scope-root note
// ("Snapshots cover repo root <path>", from config.resolve) and the non-git notice with [Initialize git].
//
// Nothing here moves the page when core answers (UI standard: async content never shifts the page), and no room is kept for what may never come. The chips row is always there, one line at the chips' own
// height ("No recent folders yet" until there are some); the chips share it (each one gives way, its name cut with an
// ellipsis and whole in its tooltip). The scope-root note or the non-git notice, when core says one, sits at the end of
// that line, at its height, in the room the chips leave (the path keeps its width in the folder row above): it moves
// nothing on arrival, and without one there is no empty line. Where the line is short, the note gives way first
// (its text cut, whole in its title, [Initialize git] kept), down to its least width; only then do the chips.
import { FolderGit2, FolderOpen, FolderPlus, GitBranch, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Platform, RecentFolder } from '@shared/ipc.ts'
import { NEW_PROJECT_LABEL } from '../../../components/newproject/model.ts'
import { openNewProject } from '../../../components/newproject/open.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { useStore } from '../../../state/store.ts'
import { folderBaseName, normalizeFolder, RECENT_FOLDER_CHIPS, recentFolders } from '../composer-model.ts'

export interface FolderChip {
  folder: string
  /** False when core says the folder no longer exists. */
  exists: boolean
}

/** Recent folders: core's list when it answers, else the folders of the runs in the store (newest first). */
export function useRecentFolders(platform: Platform): FolderChip[] {
  const fromRuns = useStore(
    useShallow((s) =>
      recentFolders(
        s.summaries.order.map((id) => s.summaries.byId[id]).filter((x) => x !== undefined),
        platform,
      ),
    ),
  )
  const runCount = useStore((s) => s.summaries.order.length)
  const [fromCore, setFromCore] = useState<RecentFolder[] | null>(null)
  useEffect(() => {
    let live = true
    void invoke('folders.recent').then((r) => {
      if (live) setFromCore(r.ok ? r.value : null)
    })
    return () => {
      live = false
    }
  }, [runCount])
  if (fromCore === null || fromCore.length === 0) return fromRuns.map((folder) => ({ folder, exists: true }))
  return fromCore.slice(0, RECENT_FOLDER_CHIPS).map((f) => ({ folder: f.folder, exists: f.exists }))
}

function FolderChips({
  chips,
  current,
  platform,
  onPick,
}: {
  chips: FolderChip[]
  current: string
  platform: Platform
  onPick: (folder: string) => void
}): React.JSX.Element {
  if (chips.length === 0)
    return (
      <p
        data-testid="folder-chips"
        className="flex h-6 shrink-0 items-center text-xs whitespace-nowrap text-muted-foreground"
      >
        No recent folders yet
      </p>
    )
  const cur = normalizeFolder(current, platform)
  return (
    <ul
      aria-label="Recent folders"
      data-testid="folder-chips"
      className="flex h-6 min-w-0 flex-nowrap gap-1.5"
    >
      {chips.map(({ folder, exists }) => {
        const selected = normalizeFolder(folder, platform) === cur
        return (
          <li key={folder} className="flex min-w-10 shrink">
            <Tooltip content={exists ? folder : `${folder} · this folder no longer exists`}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Use folder ${folder}`}
                onClick={() => onPick(folder)}
                className={cn(
                  'inline-flex h-6 max-w-56 min-w-0 items-center gap-1 rounded-full border px-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  // Border and background only: a weight change would widen the chip and move the others.
                  selected ? 'border-primary/60 bg-accent text-foreground' : 'text-muted-foreground',
                  !exists && 'line-through opacity-60',
                )}
              >
                <span className="truncate">{folderBaseName(folder)}</span>
              </button>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

export interface FolderPickerProps {
  platform: Platform
  folder: string
  chips: FolderChip[]
  onChange: (text: string) => void
  /** Settle the typed path now (blur, Enter). */
  onCommit: () => void
  onPick: (folder: string) => void
  onChoose: () => void
  scopeNote: string | null
  /** Core says the committed folder is not a git repository. */
  notGit: boolean
  initializing: boolean
  onInitGit: () => void
}

const NOT_GIT_TEXT =
  'Not a git repository. Dim Factory tracks changes itself, so every run still gets snapshots and a diff.'

/**
 * The note at the end of the chips line: the non-git notice with [Initialize git], or the scope-root note, or nothing.
 * One line at the chips' height; it gives way before the chips (a far larger shrink factor), down to its least width.
 */
function FolderNote(p: FolderPickerProps): React.JSX.Element | null {
  if (p.notGit)
    return (
      <div
        data-testid="folder-note-line"
        className="ml-auto flex h-6 max-w-[34rem] min-w-52 shrink-[100] items-center text-xs"
      >
        <div data-testid="non-git-banner" className="flex min-w-0 flex-1 items-center gap-1.5">
          <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-info" />
          <span className="min-w-0 flex-1 truncate" title={NOT_GIT_TEXT}>
            {NOT_GIT_TEXT}
          </span>
          <Tooltip content="Runs git init in this folder. Dim Factory makes no commit; remove the .git folder to undo it.">
            <Button
              size="sm"
              variant="outline"
              data-testid="init-git"
              icon={<GitBranch aria-hidden />}
              loading={p.initializing}
              onClick={p.onInitGit}
              className="h-6"
            >
              Initialize git
            </Button>
          </Tooltip>
        </div>
      </div>
    )
  if (p.scopeNote === null) return null
  return (
    <div
      data-testid="folder-note-line"
      className="ml-auto flex h-6 max-w-[34rem] min-w-24 shrink-[100] items-center"
    >
      <p
        data-testid="scope-root-note"
        title={p.scopeNote}
        className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      >
        <Info aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{p.scopeNote}</span>
      </p>
    </div>
  )
}

export function FolderPicker(p: FolderPickerProps): React.JSX.Element {
  return (
    <>
      {/* One line: the path box takes the room the buttons leave, never wrapping them onto a new line. */}
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor="composer-folder" className="w-14 shrink-0 text-xs font-medium text-muted-foreground">
          Folder
        </label>
        <Input
          id="composer-folder"
          data-testid="composer-folder-input"
          value={p.folder}
          spellCheck={false}
          placeholder={p.platform === 'win32' ? 'C:\\path\\to\\project' : '/path/to/project'}
          onChange={(e) => p.onChange(e.target.value)}
          onBlur={p.onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) p.onCommit()
          }}
          className="h-8 min-w-40 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="composer-choose-folder"
          onClick={p.onChoose}
          className="h-8 shrink-0"
          icon={<FolderOpen aria-hidden />}
        >
          Choose folder…
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="composer-new-project"
          onClick={openNewProject}
          className="h-8 shrink-0"
          icon={<FolderPlus aria-hidden />}
        >
          {NEW_PROJECT_LABEL}
        </Button>
      </div>
      {/* The chips line: the recent folders, then the folder's note at its end. */}
      <div className="flex h-6 min-w-0 items-center gap-3 pl-16">
        <FolderChips chips={p.chips} current={p.folder} platform={p.platform} onPick={p.onPick} />
        <FolderNote {...p} />
      </div>
    </>
  )
}
