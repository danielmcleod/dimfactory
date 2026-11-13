// Deploy (`#/deploy?folder=…`): the Deploy helper on demand for a folder, outside a run. The folder is typed or chosen
// (dialog.pickFolder) and goes into the route, so the page can be linked and comes back as it was; the Deploy panel
// (components/deploy/DeployPanel.tsx) does the rest. Writing the missing config is a run's Deploy step: [Write the
// config in a run] opens the composer for this folder with the step on.
import { FolderOpen, Search } from 'lucide-react'
import { useState } from 'react'
import { DeployPanel } from '../../components/deploy/DeployPanel.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'

export const DEPLOY_PAGE_TITLE = 'Deploy'
export const DEPLOY_PAGE_INTRO =
  'Pick a folder to see what it ships as, where it could go, what to check first and the commands to copy. Dim Factory never deploys, never signs in to a provider and never stores a token.'
export const DEPLOY_RUN_HINT =
  'To have the missing deploy config written and reviewed like any change, start a run with "Deploy config" on in the composer.'

export function DeployPage({ folder }: { folder: string | null }): React.JSX.Element {
  const [draft, setDraft] = useState(folder ?? '')
  const go = (f: string): void => {
    const t = f.trim()
    if (t !== '') navigate({ name: 'deploy', query: { folder: t } }, { replace: true })
  }
  const choose = async (): Promise<void> => {
    const r = await invoke('dialog.pickFolder', folder !== null ? { defaultPath: folder } : {})
    if (r.ok && r.value !== null) {
      setDraft(r.value)
      go(r.value)
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5" data-testid="deploy-page">
      <h1 className="text-lg font-semibold">{DEPLOY_PAGE_TITLE}</h1>
      <p className="text-sm text-muted-foreground">{DEPLOY_PAGE_INTRO}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          go(draft)
        }}
      >
        <label htmlFor="deploy-folder" className="sr-only">
          Folder
        </label>
        <Input
          id="deploy-folder"
          data-testid="deploy-folder-input"
          placeholder="Folder to deploy"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-w-48 flex-1 font-mono text-xs"
        />
        <Button type="submit" variant="outline" icon={<Search aria-hidden />} data-testid="deploy-folder-go">
          Look
        </Button>
        <Button
          variant="outline"
          icon={<FolderOpen aria-hidden />}
          data-testid="deploy-folder-choose"
          onClick={() => void choose()}
        >
          Choose folder…
        </Button>
      </form>
      {folder !== null && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="deploy-run-hint">
            {DEPLOY_RUN_HINT}
          </p>
          <DeployPanel key={folder} target={{ folder }} />
        </>
      )}
    </div>
  )
}
