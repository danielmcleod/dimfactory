// Easy mode's home, "What do you want to make?": one idea box with Next (disabled with its reason until there is text),
// Help me think it through (EasyThink.tsx: a few read-only rounds that end in a brief for the box, only on a click),
// Add files (optional: a spreadsheet, notes, a logo; core checks each one, they are copied into the new project when it
// is made, and the privacy line says they go to Claude or Codex), the two other ways in ("Work on something I already
// have": pick a folder; "Make several things overnight"), six examples that fill the box (editable; clicking one never
// starts anything; each with a small picture drawn in the app, one fixed size), and the user's projects (every folder
// with runs, Easy's and Full's) with Open and Make a change (for a folder Easy did not make: its folder screen). The
// projects page is the list alone.
// UI standards: one scroll region (the page, in <main>); the examples keep one height whatever their text; the project
// list arrives from core last on the page, so nothing above it moves; the file list grows only when the user adds or
// removes a file; buttons keep one label.
import {
  ArrowRight,
  BookOpen,
  ClipboardList,
  FileBarChart,
  FilePlus,
  FolderOpen,
  Gamepad2,
  Globe,
  Lightbulb,
  MoonStar,
  Smartphone,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { EASY_IDEA_MAX, isEasyPhotoName } from '@shared/easy.ts'
import type { EasyKind, EasyProjectView } from '@shared/easy.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { href, navigate } from '../../lib/router.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { draftNow, setDraft, useDraft, withIdea } from './draft.ts'
import type { EasyDraft } from './draft.ts'
import { projectTitle } from './model.ts'
import { EasyThink } from './EasyThink.tsx'
import { ExampleThumbnail } from './Thumbnails.tsx'
import {
  ADD_FILES,
  ADD_FILES_LABEL,
  ADD_FILES_NOTE,
  ATTACH_NOTE_TEXT,
  PHOTO_PRIVACY_LINE,
  PRIVACY_LINE,
  REMOVE_FILE,
  attachLineText,
  EXAMPLES,
  EXAMPLES_TITLE,
  EXAMPLE_USE,
  HOME_TITLE,
  IDEA_HINT,
  IDEA_LABEL,
  IDEA_PLACEHOLDER,
  KIND_TEXT,
  MAKE_CHANGE_SHORT,
  NEXT_DISABLED,
  OVERNIGHT_LINK,
  OVERNIGHT_LINK_NOTE,
  WORK_EXISTING,
  WORK_EXISTING_NOTE,
  NEXT_LABEL,
  OPEN_LABEL,
  PROJECTS_EMPTY,
  PROJECTS_PAGE_TITLE,
  PROJECTS_TITLE,
  PROJECT_LABELS,
  BUSY_FOLDER,
  projectStatusText,
} from './text.ts'

export const KIND_ICON: Readonly<Record<EasyKind, LucideIcon>> = {
  app: Smartphone,
  website: Globe,
  document: BookOpen,
  data: FileBarChart,
  research: Lightbulb,
  checklist: ClipboardList,
  game: Gamepad2,
}

const ACTIVE = new Set(['queued', 'running', 'waiting', 'paused'])

/** Core's project list, asked again whenever a run starts, changes status or ends. */
function useProjects(): EasyProjectView[] | null {
  const key = useStore((s) =>
    s.summaries.order.map((id) => `${id}:${s.summaries.byId[id]?.status ?? ''}`).join('|'),
  )
  const [list, setList] = useState<EasyProjectView[] | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('easy.projects').then((r) => {
      if (alive && r.ok) setList(r.value)
    })
    return () => {
      alive = false
    }
  }, [key])
  return list
}

function ProjectRow({ p }: { p: EasyProjectView }): React.JSX.Element {
  const Icon = p.kind !== undefined ? KIND_ICON[p.kind] : Lightbulb
  const busy = ACTIVE.has(p.lastStatus)
  const open = (): void => navigate({ name: 'easyRun', runId: p.lastRunId })
  // A project Easy made changes on its Done screen; any other folder goes through "Work on something I already
  // have" (an isolated copy when it has commits, never the project permission).
  const change = (): void =>
    p.kind !== undefined
      ? navigate({ name: 'easyRun', runId: p.lastRunId, query: { change: '1' } })
      : navigate({ name: 'easy', page: 'existing', query: { folder: p.folder } })
  return (
    <li
      data-testid={`easy-project-${p.lastRunId}`}
      className="flex h-16 items-center gap-3 rounded-md border px-3"
    >
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium" title={p.folder}>
          {projectTitle(p.folder, p.title)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {p.kind !== undefined ? `${KIND_TEXT[p.kind]} · ` : ''}
          {projectStatusText(p.lastStatus, p.lastOutcome)}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        labels={PROJECT_LABELS}
        onClick={open}
        data-testid="easy-project-open"
      >
        {OPEN_LABEL}
      </Button>
      {busy ? (
        <DisabledHint reason={BUSY_FOLDER}>
          <Button size="sm" variant="outline" labels={PROJECT_LABELS} disabled>
            {MAKE_CHANGE_SHORT}
          </Button>
        </DisabledHint>
      ) : (
        <Button
          size="sm"
          variant="outline"
          labels={PROJECT_LABELS}
          onClick={change}
          data-testid="easy-project-change"
        >
          {MAKE_CHANGE_SHORT}
        </Button>
      )}
    </li>
  )
}

export function ProjectList({ heading = 'h2' }: { heading?: 'h1' | 'h2' }): React.JSX.Element {
  const list = useProjects()
  const headingId = useId()
  const H = heading
  return (
    <section aria-labelledby={headingId} data-testid="easy-projects" className="flex flex-col gap-2">
      <H id={headingId} className={heading === 'h1' ? 'text-xl font-semibold' : 'text-base font-semibold'}>
        {heading === 'h1' ? PROJECTS_PAGE_TITLE : PROJECTS_TITLE}
      </H>
      {list !== null && list.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="easy-projects-empty">
          {PROJECTS_EMPTY}
        </p>
      )}
      {list !== null && list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((p) => (
            <ProjectRow key={p.folder} p={p} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Add files: pick, have core check them (with the ones already added), keep them in the draft. */
function AddFiles({ draft }: { draft: EasyDraft }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const headingId = useId()
  const files = draft.attachments ?? []
  const ok = files.filter((f) => f.error === undefined)
  const check = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) {
      setDraft({ ...draftNow(), attachments: [] })
      return
    }
    const r = await invoke('easy.attachCheck', { paths })
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    setDraft({ ...draftNow(), attachments: r.value })
  }
  const add = (): void => {
    setBusy(true)
    void (async () => {
      try {
        const r = await invoke('dialog.pickFiles', {})
        if (!r.ok || r.value.length === 0) return
        const have = files.map((f) => f.path)
        await check([...have, ...r.value.filter((p) => !have.includes(p))])
      } finally {
        setBusy(false)
      }
    })()
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid="easy-attach">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-sm font-semibold">
          {ADD_FILES_LABEL}
        </h2>
        <Button
          size="sm"
          variant="outline"
          icon={<FilePlus aria-hidden />}
          loading={busy}
          onClick={add}
          data-testid="easy-attach-add"
        >
          {ADD_FILES}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{ADD_FILES_NOTE}</p>
      {files.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="easy-attach-list">
          {files.map((f) => (
            <li
              key={f.path}
              data-testid="easy-attach-row"
              data-error={f.error !== undefined || undefined}
              className="flex min-h-9 min-w-0 items-center gap-3 rounded-md border px-3 py-1"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={f.path}>
                  {f.name}
                </span>
                <span
                  className={
                    f.error !== undefined ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                  }
                >
                  {f.error ?? attachLineText(f.dest, f.bytes, f.folder)}
                </span>
                {f.error === undefined && f.note !== undefined && (
                  <span className="text-xs" data-testid="easy-attach-note" data-note={f.note}>
                    {ATTACH_NOTE_TEXT[f.note]}
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<X aria-hidden />}
                aria-label={`${REMOVE_FILE}: ${f.name}`}
                data-testid="easy-attach-remove"
                onClick={() =>
                  setDraft({
                    ...draftNow(),
                    attachments: files.filter((x) => x.path !== f.path),
                  })
                }
              >
                {REMOVE_FILE}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {ok.length > 0 && !ok.every((f) => !f.folder && isEasyPhotoName(f.name)) && (
        <p className="text-sm font-medium" role="note" data-testid="easy-privacy">
          {PRIVACY_LINE}
        </p>
      )}
      {ok.some((f) => !f.folder && isEasyPhotoName(f.name)) && (
        <p className="text-sm font-medium" role="note" data-testid="easy-photo-privacy">
          {PHOTO_PRIVACY_LINE}
        </p>
      )}
    </section>
  )
}

/** "Work on something I already have": pick a folder, then the screen that says how it would work there. */
export async function pickExistingFolder(): Promise<void> {
  const r = await invoke('dialog.pickFolder', {})
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return
  }
  if (r.value !== null) navigate({ name: 'easy', page: 'existing', query: { folder: r.value } })
}

/** The two other ways in: a folder the user already has, and several ideas made overnight. */
function OtherWays(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="easy-other-ways">
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Button
          variant="outline"
          icon={<FolderOpen aria-hidden />}
          loading={busy}
          data-testid="easy-work-existing"
          onClick={() => {
            setBusy(true)
            void pickExistingFolder().finally(() => setBusy(false))
          }}
        >
          {WORK_EXISTING}
        </Button>
        <p className="text-xs text-muted-foreground">{WORK_EXISTING_NOTE}</p>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Button asChild variant="outline" data-testid="easy-overnight-link">
          <a href={href({ name: 'easy', page: 'overnight' })}>
            <MoonStar aria-hidden />
            {OVERNIGHT_LINK}
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">{OVERNIGHT_LINK_NOTE}</p>
      </div>
    </div>
  )
}

export function EasyHomePage(): React.JSX.Element {
  const draft = useDraft()
  const [idea, setIdea] = useState(draft.idea)
  const ideaId = useId()
  const hintId = useId()
  const examplesId = useId()
  const empty = idea.trim() === ''
  const next = (): void => {
    if (empty) return
    // A new idea is detected afresh; the same idea keeps the kind the user picked; added files stay.
    setDraft(withIdea(draft, idea))
    navigate({ name: 'easy', page: 'new' })
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8" data-testid="easy-home">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{HOME_TITLE}</h1>
        <label htmlFor={ideaId} className="sr-only">
          {IDEA_LABEL}
        </label>
        <Textarea
          id={ideaId}
          data-testid="easy-idea"
          rows={4}
          maxLength={EASY_IDEA_MAX}
          className="h-32 resize-none text-base"
          placeholder={IDEA_PLACEHOLDER}
          aria-describedby={hintId}
          value={idea}
          onChange={(e) => {
            const v = e.currentTarget.value
            setIdea(v)
            setDraft(withIdea(draft, v))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              next()
            }
          }}
        />
        <div className="flex items-center gap-3">
          <p id={hintId} className="min-w-0 flex-1 text-sm text-muted-foreground">
            {IDEA_HINT}
          </p>
          {empty ? (
            <DisabledHint reason={NEXT_DISABLED}>
              <Button disabled data-testid="easy-next" icon={<ArrowRight aria-hidden />}>
                {NEXT_LABEL}
              </Button>
            </DisabledHint>
          ) : (
            <Button data-testid="easy-next" icon={<ArrowRight aria-hidden />} onClick={next}>
              {NEXT_LABEL}
            </Button>
          )}
        </div>
        <EasyThink
          idea={idea}
          onBrief={(brief, kind) => {
            setIdea(brief)
            const next = withIdea(draftNow(), brief)
            setDraft(kind !== undefined ? { ...next, kind } : next)
          }}
        />
        <AddFiles draft={draft} />
        <OtherWays />
      </section>
      <section aria-labelledby={examplesId} className="flex flex-col gap-3">
        <h2 id={examplesId} className="text-base font-semibold">
          {EXAMPLES_TITLE}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {EXAMPLES.map((ex) => {
            const Icon = KIND_ICON[ex.kind]
            return (
              <li key={ex.id ?? ex.kind}>
                <button
                  type="button"
                  data-testid={`easy-example-${ex.id ?? ex.kind}`}
                  aria-label={`${EXAMPLE_USE}: ${ex.title}`}
                  onClick={() => {
                    setIdea(ex.text)
                    setDraft(withIdea(draft, ex.text))
                  }}
                  className="flex h-36 w-full flex-col gap-1.5 overflow-hidden rounded-lg border bg-card p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExampleThumbnail kind={ex.kind} photos={ex.id === 'game-photos'} />
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    {ex.title}
                  </span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">{ex.text}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      <ProjectList />
    </div>
  )
}

export function EasyProjectsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8" data-testid="easy-projects-page">
      <ProjectList heading="h1" />
    </div>
  )
}
