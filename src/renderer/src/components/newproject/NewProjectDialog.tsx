// The New project dialog (the Dashboard's New project… button, the palette's New project action): where the project
// goes (a parent folder and a name), what to start from (the templates, grouped by category, from templates.list),
// "What should it do?" (optional, added to the template's task) and the template's official starter command as a
// copyable step (Dim Factory never runs it). Create project calls project.create (core creates the folder, initializes
// git without a commit and saves the template's Brief for it), then hands the folder, the task, the Brief and the
// recipe to the quick composer, which puts the focus on Run: the user reads the checks and the estimate and presses it.
// Errors show inline, above the buttons.
//
// One scroll region per screen: the dialog has one height whatever it lists, its body is its only scroll region, and
// the buttons stay in its footer. Nothing moves on its own: the starter row and the error line keep their height, and
// the template list, which arrives from core, is the last thing in the body, so nothing below it can move.
import { Check, Copy, FolderOpen, FolderPlus, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import type { Platform } from '@shared/ipc.ts'
import type { TemplatesList } from '@shared/templates.ts'
import { getDimFactory, invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { navigate } from '../../lib/router.ts'
import { isAbsoluteFolder, loadLastFolder } from '../../pages/dashboard/composer-model.ts'
import { useAppInfo } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { requestComposer } from '../palette/composerIntent.ts'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import {
  COPIED_LABEL,
  COPY_LABEL,
  COPY_LABELS,
  CREATE_LABEL,
  GOAL_LABEL,
  GOAL_PLACEHOLDER,
  NEW_PROJECT_DESCRIPTION,
  NEW_PROJECT_TITLE,
  NO_STARTER_TEXT,
  STARTER_HINT,
  createProblem,
  groupTemplates,
  parentOf,
  projectFolder,
} from './model.ts'
import { closeNewProject, useNewProjectOpen } from './open.ts'

function usePlatform(): Platform {
  const info = useAppInfo()
  return info?.platform ?? getDimFactory()?.platform ?? 'linux'
}

type Loaded =
  { status: 'loading' } | { status: 'ready'; list: TemplatesList } | { status: 'error'; message: string }

/** The dialog's content, mounted only while it is open (so every visit starts fresh). */
function NewProjectBody(): React.JSX.Element {
  const platform = usePlatform()
  const [parent, setParent] = useState(() => parentOf(loadLastFolder()))
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    void invoke('templates.list').then((r) => {
      if (!mounted.current) return
      if (!r.ok) {
        setLoaded({ status: 'error', message: r.error.message })
        return
      }
      setLoaded({ status: 'ready', list: r.value })
      setTemplateId((cur) => cur ?? r.value.templates[0]?.template.id ?? null)
    })
  }, [])

  const list = loaded.status === 'ready' ? loaded.list : null
  const groups = list !== null ? groupTemplates(list) : []
  const chosen = list?.templates.find((v) => v.template.id === templateId)?.template
  const folder = projectFolder(parent, name, platform)
  const problem = createProblem(parent, name, templateId, loaded.status === 'loading')

  const chooseParent = async (): Promise<void> => {
    const r = await invoke(
      'dialog.pickFolder',
      isAbsoluteFolder(parent) ? { defaultPath: parent.trim() } : {},
    )
    if (!mounted.current) return
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    if (r.value !== null) setParent(r.value)
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setError('Dim Factory could not use the clipboard.')
      return
    }
    setCopied(true)
    setTimeout(() => {
      if (mounted.current) setCopied(false)
    }, 1500)
  }

  const create = async (): Promise<void> => {
    if (problem !== null || creating || templateId === null || folder === '') return
    setCreating(true)
    setError(null)
    const r = await invoke('project.create', {
      folder,
      templateId,
      ...(goal.trim() !== '' ? { goal: goal.trim() } : {}),
    })
    if (!mounted.current) return
    setCreating(false)
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    const made = r.value
    closeNewProject()
    requestComposer({ folder: made.folder, task: made.task, brief: made.brief, recipe: made.recipe })
    navigate({ name: 'dashboard' })
    toast({
      level: 'info',
      message: `Created ${made.folder}. Check the task and the Brief, then press Run.`,
    })
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <FolderPlus aria-hidden className="size-4 text-muted-foreground" />
        <Dialog.Title className="text-sm font-semibold">{NEW_PROJECT_TITLE}</Dialog.Title>
        <Dialog.Close
          aria-label="Close New project"
          data-testid="new-project-close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </Dialog.Close>
      </div>
      <div
        data-testid="new-project-body"
        data-scroll-region="new-project"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
      >
        <Dialog.Description className="text-xs text-muted-foreground">
          {NEW_PROJECT_DESCRIPTION}
        </Dialog.Description>
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <label
              htmlFor="new-project-parent"
              className="w-24 shrink-0 text-xs font-medium text-muted-foreground"
            >
              Parent folder
            </label>
            <Input
              id="new-project-parent"
              data-testid="new-project-parent"
              value={parent}
              spellCheck={false}
              placeholder={platform === 'win32' ? 'C:\\Users\\you\\code' : '/home/you/code'}
              onChange={(e) => setParent(e.target.value)}
              className="h-8 min-w-40 flex-1 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              data-testid="new-project-choose"
              icon={<FolderOpen aria-hidden />}
              onClick={() => void chooseParent()}
              className="h-8 shrink-0"
            >
              Choose…
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <label
              htmlFor="new-project-name"
              className="w-24 shrink-0 text-xs font-medium text-muted-foreground"
            >
              Project name
            </label>
            <Input
              id="new-project-name"
              data-testid="new-project-name"
              value={name}
              spellCheck={false}
              placeholder="my-app"
              onChange={(e) => setName(e.target.value)}
              className="h-8 min-w-40 flex-1 font-mono text-xs"
            />
          </div>
          <p
            data-testid="new-project-path"
            title={folder !== '' ? folder : undefined}
            className="h-4 truncate pl-26 text-xs text-muted-foreground"
          >
            {folder !== '' ? `Creates ${folder}` : 'A new folder, or an empty one that already exists.'}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-project-goal" className="text-xs font-medium text-muted-foreground">
            {GOAL_LABEL}
          </label>
          <Textarea
            id="new-project-goal"
            data-testid="new-project-goal"
            value={goal}
            rows={2}
            placeholder={GOAL_PLACEHOLDER}
            onChange={(e) => setGoal(e.target.value)}
            className="h-16 resize-none"
          />
        </div>
        {/* The starter row keeps one height whatever the template says. */}
        <div data-testid="new-project-starter" className="flex h-16 shrink-0 flex-col justify-center gap-1">
          {chosen?.create !== undefined ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <code
                  data-testid="new-project-command"
                  title={chosen.create.command}
                  className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs"
                >
                  {chosen.create.command}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="new-project-copy"
                  icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  labels={COPY_LABELS}
                  aria-label={`Copy the starter command: ${chosen.create.command}`}
                  onClick={() => void copy(chosen.create?.command ?? '')}
                >
                  {copied ? COPIED_LABEL : COPY_LABEL}
                </Button>
              </div>
              <p
                className="truncate text-xs text-muted-foreground"
                title={chosen.create.note ?? STARTER_HINT}
              >
                {chosen.create.note ?? STARTER_HINT}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {chosen !== undefined ? NO_STARTER_TEXT : 'Choose a template to see how it starts.'}
            </p>
          )}
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Template</legend>
          {loaded.status === 'loading' && (
            <p className="text-xs text-muted-foreground">Loading the templates…</p>
          )}
          {loaded.status === 'error' && (
            <p role="alert" className="text-xs text-destructive">
              {loaded.message}
            </p>
          )}
          {groups.map((g) => (
            <div
              key={g.pack.id}
              data-testid={`new-project-group-${g.pack.id}`}
              className="flex flex-col gap-1"
            >
              <h3 className="text-xs font-semibold">{g.pack.label}</h3>
              {g.templates.map(({ template: t }) => (
                <label
                  key={t.id}
                  data-testid={`new-project-template-${t.id}`}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring',
                    t.id === templateId
                      ? 'border-primary/60 bg-accent'
                      : 'border-transparent hover:bg-accent/50',
                  )}
                >
                  <input
                    type="radio"
                    name="new-project-template"
                    value={t.id}
                    checked={t.id === templateId}
                    onChange={() => setTemplateId(t.id)}
                    className="mt-0.5 shrink-0 accent-[var(--color-primary)]"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.description}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          {list !== null && list.issues.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Skipped{' '}
              {list.issues.length === 1 ? 'one template file' : `${list.issues.length} template files`}:{' '}
              {list.issues.map((i) => `${i.file} (${i.message})`).join(' · ')}
            </p>
          )}
        </fieldset>
      </div>
      <div className="flex h-14 shrink-0 items-center gap-2 border-t px-4">
        <p
          data-testid="new-project-error"
          role={error !== null ? 'alert' : undefined}
          title={error ?? problem ?? undefined}
          className={cn(
            'line-clamp-2 min-w-0 flex-1 text-xs',
            error !== null ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {error ?? (problem !== null && loaded.status !== 'loading' ? problem : '')}
        </p>
        <Button size="sm" variant="outline" data-testid="new-project-cancel" onClick={closeNewProject}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          data-testid="new-project-create"
          icon={<FolderPlus aria-hidden />}
          loading={creating}
          disabled={problem !== null}
        >
          {CREATE_LABEL}
        </Button>
      </div>
    </form>
  )
}

export function NewProjectDialog(): React.JSX.Element {
  const open = useNewProjectOpen()
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? undefined : closeNewProject())}>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="new-project-overlay" className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="new-project"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            document
              .querySelector<HTMLElement>('[data-testid="new-project-name"]')
              ?.focus({ preventScroll: true })
          }}
          // The dialog is modal: its keys never reach the app's shortcuts behind it (Ctrl+Enter would start a run).
          onKeyDown={(e) => e.nativeEvent.stopPropagation()}
          className="fixed top-[8vh] left-1/2 z-50 flex h-[min(40rem,84vh)] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none"
        >
          <NewProjectBody />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
