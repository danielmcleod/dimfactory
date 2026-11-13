// Run it (`#/preview?folder=…`): Run & Preview on demand for a folder, outside a run. The folder is typed or chosen
// (dialog.pickFolder) and goes into the route, so the page can be linked and comes back as it was; the Run it panel
// (components/run/RunItPanel.tsx) does the rest. A smoke check here is a note only (no run to keep findings with).
import { FolderOpen, Search } from 'lucide-react'
import { useState } from 'react'
import { RunItPanel } from '../../components/run/RunItPanel.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'

export const PREVIEW_PAGE_TITLE = 'Run it'
export const PREVIEW_PAGE_INTRO =
  'Pick a folder to see how Dim Factory would run it. Nothing starts until you press Start, and every preview stops when Dim Factory quits.'

export function PreviewPage({ folder }: { folder: string | null }): React.JSX.Element {
  const [draft, setDraft] = useState(folder ?? '')
  const go = (f: string): void => {
    const t = f.trim()
    if (t !== '') navigate({ name: 'preview', query: { folder: t } }, { replace: true })
  }
  const choose = async (): Promise<void> => {
    const r = await invoke('dialog.pickFolder', folder !== null ? { defaultPath: folder } : {})
    if (r.ok && r.value !== null) {
      setDraft(r.value)
      go(r.value)
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5" data-testid="preview-page">
      <h1 className="text-lg font-semibold">{PREVIEW_PAGE_TITLE}</h1>
      <p className="text-sm text-muted-foreground">{PREVIEW_PAGE_INTRO}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          go(draft)
        }}
      >
        <label htmlFor="preview-folder" className="sr-only">
          Folder
        </label>
        <Input
          id="preview-folder"
          data-testid="preview-folder-input"
          placeholder="Folder to run"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-w-48 flex-1 font-mono text-xs"
        />
        <Button type="submit" variant="outline" icon={<Search aria-hidden />} data-testid="preview-folder-go">
          Look
        </Button>
        <Button
          variant="outline"
          icon={<FolderOpen aria-hidden />}
          data-testid="preview-folder-choose"
          onClick={() => void choose()}
        >
          Choose folder…
        </Button>
      </form>
      {folder !== null && <RunItPanel key={folder} target={{ folder }} />}
    </div>
  )
}
