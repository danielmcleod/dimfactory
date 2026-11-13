// The project a Settings section looks at (config layers: a project's `.dimfactory/` overrides the user's
// settings; General, Profiles' Set as default and Prompts' scope can target either). One line
// names the chosen folder with [Choose folder…] and [Clear]; the line under it lists recent folders (core's
// folders.recent, else the folders of the runs in the store) as chips. Both lines are always there at their own height
// ("None chosen", "No recent folders yet"), so choosing moves nothing. Recent folders are read once the section has
// been open for LOAD_DELAY_MS, so a section switch costs no IPC (performance.spec.ts).
import { FolderOpen, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Platform } from '@shared/ipc.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { useAppInfo } from '../../../state/selectors.ts'
import { useStore } from '../../../state/store.ts'
import {
  folderBaseName,
  normalizeFolder,
  RECENT_FOLDER_CHIPS,
  recentFolders,
} from '../../dashboard/composer-model.ts'

/** How long a section is open before it reads anything. */
export const LOAD_DELAY_MS = 150

export const NO_FOLDER = 'None chosen'

interface Chip {
  folder: string
  exists: boolean
}

function useRecentFolderChips(platform: Platform): Chip[] {
  const fromRuns = useStore(
    useShallow((s) =>
      recentFolders(
        s.summaries.order.map((id) => s.summaries.byId[id]).filter((x) => x !== undefined),
        platform,
      ),
    ),
  )
  const [fromCore, setFromCore] = useState<Chip[] | null>(null)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('folders.recent').then((r) => {
        if (alive && r.ok) setFromCore(r.value.map((f) => ({ folder: f.folder, exists: f.exists })))
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [])
  if (fromCore !== null && fromCore.length > 0) return fromCore.slice(0, RECENT_FOLDER_CHIPS)
  return fromRuns.map((folder) => ({ folder, exists: true }))
}

export interface ProjectFolderProps {
  folder: string | null
  onChange: (folder: string | null) => void
  /** Prefix of the test ids (`<testId>`, `<testId>-choose`, `<testId>-clear`, `<testId>-chips`). */
  testId: string
  /** The label before the path. */
  label?: string
}

export function ProjectFolder({
  folder,
  onChange,
  testId,
  label = 'Project',
}: ProjectFolderProps): React.JSX.Element {
  const platform = useAppInfo()?.platform ?? 'win32'
  const chips = useRecentFolderChips(platform)
  const [choosing, setChoosing] = useState(false)
  const current = folder !== null ? normalizeFolder(folder, platform) : null

  const choose = async (): Promise<void> => {
    setChoosing(true)
    const r = await invoke('dialog.pickFolder', folder !== null ? { defaultPath: folder } : {})
    setChoosing(false)
    if (r.ok && r.value !== null) onChange(r.value)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
        <span
          data-testid={`${testId}-path`}
          title={folder ?? undefined}
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            folder === null && 'font-sans text-muted-foreground',
          )}
        >
          {folder ?? NO_FOLDER}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid={`${testId}-choose`}
            icon={<FolderOpen aria-hidden />}
            loading={choosing}
            onClick={() => void choose()}
          >
            Choose folder…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testId}-clear`}
            icon={<X aria-hidden />}
            disabled={folder === null}
            aria-label="Clear the project"
            onClick={() => onChange(null)}
          >
            Clear
          </Button>
        </div>
      </div>
      {chips.length === 0 ? (
        <p
          data-testid={`${testId}-chips`}
          className="flex h-6 items-center pl-16 text-xs whitespace-nowrap text-muted-foreground"
        >
          No recent folders yet
        </p>
      ) : (
        <ul
          aria-label="Recent folders"
          data-testid={`${testId}-chips`}
          className="flex h-6 min-w-0 flex-nowrap gap-1.5 pl-16"
        >
          {chips.map((c) => {
            const selected = current !== null && normalizeFolder(c.folder, platform) === current
            return (
              <li key={c.folder} className="flex min-w-10 shrink">
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Use folder ${c.folder}`}
                  title={c.exists ? c.folder : `${c.folder} · this folder no longer exists`}
                  onClick={() => onChange(c.folder)}
                  className={cn(
                    'inline-flex h-6 max-w-56 min-w-0 items-center rounded-full border px-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                    selected ? 'border-primary/60 bg-accent text-foreground' : 'text-muted-foreground',
                    !c.exists && 'line-through opacity-60',
                  )}
                >
                  <span className="truncate">{folderBaseName(c.folder)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
